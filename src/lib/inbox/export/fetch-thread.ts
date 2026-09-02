/**
 * Coleta da conversa para exportação (SPEC 067 §2).
 *
 * O cliente recebido AQUI é sempre o de SESSÃO — nunca `supabaseAdmin()`.
 * A autorização é linha a linha e já está escrita em SQL: `messages_select`
 * → `can_access_conversation(conversation_id)` (migração 039). Um agente
 * com a conversa atribuída a outro colega não enxerga aquelas mensagens, e
 * a exportação herda isso de graça. Trocar por service role aqui reabriria
 * exatamente o furo que a 039/040 fecharam.
 *
 * Duas fontes de estouro silencioso do teto de ~1000 linhas do PostgREST,
 * e como cada uma é evitada:
 *
 *   1. As mensagens — paginadas por `.range()` em lotes de 1000, com
 *      `created_at ASC, id ASC`. O desempate por `id` não é decoração:
 *      duas mensagens no mesmo milissegundo alternariam de ordem entre
 *      execuções e o PDF deixaria de ser reproduzível.
 *   2. As reações — mesma paginação, filtradas por lotes de ids de
 *      mensagem, nunca uma consulta por mensagem (N+1).
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  Channel,
  Contact,
  Conversation,
  Message,
  MessageReaction,
} from '@/types';
import type { ThreadExportData } from './model';

export interface ThreadExportScope {
  conversationId: string;
  /** ISO. Inclusivo. Ausente = desde a primeira mensagem. */
  from?: string;
  /**
   * ISO. Inclusivo. Quem converte "o dia 12/08 inteiro" para um instante
   * (23:59:59.999 no fuso de quem exporta, D-7) é a rota — aqui já chega
   * resolvido, para este módulo não ter opinião sobre fuso.
   */
  to?: string;
}

export const CONVERSATION_EXPORT_MAX_MESSAGES = 10_000;
export const CONVERSATION_EXPORT_BATCH = 1000;

/** Quantos ids de mensagem entram num único `.in()`. Mesmo motivo do
 *  `CONTACT_ID_CHUNK` da 051: 1000 UUIDs viram uma URL de ~36KB de puro
 *  filtro, o bastante para um proxy no meio do caminho derrubar a
 *  conexão antes de qualquer resposta do PostgREST. */
const MESSAGE_ID_CHUNK = 200;

/** O PostgREST devolve embed ausente como `null`; `Conversation` declara
 *  os dois como opcionais (`undefined`). Daí o `Omit` em vez de `extends`. */
type ConversationRow = Omit<Conversation, 'contact' | 'channel'> & {
  contact: Contact | null;
  channel: Channel | null;
};

function chunkArray<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

/** Pagina por `.range()` até o lote vir incompleto. `makeQuery` PRECISA
 *  de um `.order()` determinístico antes do `.range()` — OFFSET sem
 *  ORDER BY estável não garante a mesma fatia entre chamadas. */
async function fetchAllPaged<T>(
  makeQuery: (
    from: number,
    to: number
  ) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>
): Promise<T[]> {
  const rows: T[] = [];
  let from = 0;

  while (true) {
    const to = from + CONVERSATION_EXPORT_BATCH - 1;
    const { data, error } = await makeQuery(from, to);
    if (error) throw new Error(error.message);

    const batch = data ?? [];
    rows.push(...batch);

    if (batch.length < CONVERSATION_EXPORT_BATCH) break;
    from += CONVERSATION_EXPORT_BATCH;
  }

  return rows;
}

async function countMessages(
  supabase: SupabaseClient,
  scope: ThreadExportScope
): Promise<number> {
  let query = supabase
    .from('messages')
    .select('id', { count: 'exact', head: true })
    .eq('conversation_id', scope.conversationId);

  if (scope.from) query = query.gte('created_at', scope.from);
  if (scope.to) query = query.lte('created_at', scope.to);

  const { count, error } = await query;
  if (error) throw new Error(error.message);
  return count ?? 0;
}

async function fetchMessages(
  supabase: SupabaseClient,
  scope: ThreadExportScope
): Promise<Message[]> {
  return fetchAllPaged<Message>((from, to) => {
    let query = supabase
      .from('messages')
      // SPEC 057 F6 — o join traz o nome da campanha para o selo de
      // origem; mensagens sem `broadcast_id` resolvem `broadcast: null`
      // sem custo extra (LEFT JOIN implícito do PostgREST).
      .select('*, broadcast:broadcasts(name)')
      .eq('conversation_id', scope.conversationId);

    if (scope.from) query = query.gte('created_at', scope.from);
    if (scope.to) query = query.lte('created_at', scope.to);

    return query
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .range(from, to);
  });
}

async function fetchReactions(
  supabase: SupabaseClient,
  messageIds: string[]
): Promise<MessageReaction[]> {
  const reactions: MessageReaction[] = [];

  for (const chunk of chunkArray(messageIds, MESSAGE_ID_CHUNK)) {
    const rows = await fetchAllPaged<MessageReaction>((from, to) =>
      supabase
        .from('message_reactions')
        .select('*')
        .in('message_id', chunk)
        .order('created_at', { ascending: true })
        .order('id', { ascending: true })
        .range(from, to)
    );
    reactions.push(...rows);
  }

  return reactions;
}

/**
 * `user_id → nome`, só para os ids que aparecem no transcrito.
 *
 * Inclui o `actor_id` das reações de agente, não só o `sender_id` das
 * mensagens: o modelo nomeia quem reagiu com o mesmo mapa, e sem isto
 * uma reação de colega sairia como "agente removido".
 *
 * Quem não voltar da consulta (saiu da conta) simplesmente não entra no
 * mapa — `buildTranscript` resolve para o rótulo `unknownAgent`, e o
 * UUID nunca chega ao documento.
 */
async function fetchAgentNames(
  supabase: SupabaseClient,
  userIds: string[]
): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  if (userIds.length === 0) return names;

  for (const chunk of chunkArray(userIds, MESSAGE_ID_CHUNK)) {
    const { data, error } = await supabase
      .from('profiles')
      .select('user_id, full_name')
      .in('user_id', chunk);
    if (error) throw new Error(error.message);

    for (const row of (data ?? []) as {
      user_id: string;
      full_name: string | null;
    }[]) {
      const name = row.full_name?.trim();
      if (name) names.set(row.user_id, name);
    }
  }

  return names;
}

/**
 * Devolve `null` quando a conversa não existe **ou** não é visível para
 * quem chamou — a rota responde 404 genérico nos dois casos, sem
 * distinguir. Um 403 aqui confirmaria a existência da conversa para quem
 * sonda ids; é a mesma regra de `lib/inbox/assignment.ts` e da
 * rota-proxy de mídia.
 */
export async function fetchThreadForExport(
  supabase: SupabaseClient,
  scope: ThreadExportScope
): Promise<ThreadExportData | null> {
  const { data: conversation, error } = await supabase
    .from('conversations')
    .select('*, contact:contacts(*), channel:channels(*)')
    .eq('id', scope.conversationId)
    .maybeSingle();

  if (error) throw new Error(error.message);
  if (!conversation) return null;

  const row = conversation as ConversationRow;
  // Sem contato não há cabeçalho de identificação — e um contato que a
  // RLS esconde é o mesmo caso de "não é sua".
  if (!row.contact) return null;

  // Os embeds saem para campos próprios de `ThreadExportData`; o que
  // sobra é a linha de `conversations` pura.
  const { contact, channel, ...conversationRow } = row;

  const total = await countMessages(supabase, scope);
  if (total > CONVERSATION_EXPORT_MAX_MESSAGES) {
    // Não truncar em silêncio: a rota responde 413 com o total para o
    // diálogo sugerir um período menor. Um documento silenciosamente
    // incompleto é pior que um erro — mesma escolha da SPEC 051.
    return {
      conversation: conversationRow,
      contact,
      channel: channel ?? null,
      agentNames: new Map(),
      messages: [],
      reactions: [],
      truncated: true,
      total,
    };
  }

  const messages = await fetchMessages(supabase, scope);
  const messageIds = messages.map((m) => m.id);

  const reactions =
    messageIds.length > 0 ? await fetchReactions(supabase, messageIds) : [];

  const userIds = [
    ...new Set([
      ...messages
        .filter((m) => m.sender_type !== 'customer' && m.sender_id)
        .map((m) => m.sender_id as string),
      ...reactions
        .filter((r) => r.actor_type === 'agent' && r.actor_id)
        .map((r) => r.actor_id as string),
    ]),
  ];

  const agentNames = await fetchAgentNames(supabase, userIds);

  return {
    conversation: conversationRow,
    contact,
    channel: channel ?? null,
    agentNames,
    messages,
    reactions,
    truncated: false,
    total,
  };
}
