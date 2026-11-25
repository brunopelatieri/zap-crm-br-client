/**
 * De quem é a mensagem de um `statuses[].id` (achado B-1 da revisão de
 * segurança da SPEC 088).
 *
 * O `wamid` sozinho não prova nada: quem assina o webhook escolhe o valor.
 * Aqui a mensagem (ou o destinatário de disparo) é lida junto com a CONTA
 * dona, e só o que for da conta do número do `change` segue adiante. O que
 * existe em OUTRA conta volta como `foreign`, para o chamador não disparar
 * efeito nenhum (webhook de saída, número morto, pricing, cobrança).
 *
 * A conta vem de `conversations` / `broadcasts`, nunca de
 * `messages.channel_id`, que é nulo em todo o histórico com `message_id`.
 *
 * `accountId = null` é o `change` SEM número assinado pelo
 * `META_APP_SECRET`: sem conta para comparar, tudo é `own`, como antes.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

/** O webhook limita as linhas de log por POST; sem ele, o console. */
type LogError = (...message: unknown[]) => void;

type Embed<T> = T | T[] | null | undefined;

/** O PostgREST devolve o embed 1:1 como objeto ou lista, conforme o caso. */
function one<T>(embed: Embed<T>): T | null {
  return (Array.isArray(embed) ? embed[0] : embed) ?? null;
}

export interface ScopedStatusMessage {
  id: string;
  conversationId: string;
  accountId: string;
  channelId: string | null;
  channelType: string | null;
}

export interface StatusMessages {
  own: ScopedStatusMessage[];
  /** Existe linha com este `wamid` em outra conta. */
  foreign: boolean;
  /** A leitura falhou: não se sabe de quem é. */
  failed: boolean;
}

/**
 * Todas as linhas de `messages` com o `wamid` (não é único — migração
 * 009), separadas por conta. Um SELECT só serve ao UPDATE, ao
 * `message.status_updated` e à detecção de `wamid` alheio.
 */
export async function findStatusMessages(
  db: SupabaseClient,
  wamid: string,
  accountId: string | null,
  logError: LogError = console.error
): Promise<StatusMessages> {
  const { data, error } = await db
    .from('messages')
    .select(
      'id, conversation_id, conversations!inner(account_id, channel_id, channels(type))'
    )
    .eq('message_id', wamid);

  if (error) {
    logError('Error fetching message for status:', error);
    return { own: [], foreign: false, failed: true };
  }

  const own: ScopedStatusMessage[] = [];
  let foreign = false;
  for (const row of (data ?? []) as unknown as Array<{
    id: string;
    conversation_id: string;
    conversations: Embed<{
      account_id: string;
      channel_id: string | null;
      channels: Embed<{ type: string }>;
    }>;
  }>) {
    const conversation = one(row.conversations);
    if (
      !conversation ||
      (accountId !== null && conversation.account_id !== accountId)
    ) {
      foreign = true;
      continue;
    }
    own.push({
      id: row.id,
      conversationId: row.conversation_id,
      accountId: conversation.account_id,
      channelId: conversation.channel_id ?? null,
      channelType: one(conversation.channels)?.type ?? null,
    });
  }
  return { own, foreign, failed: false };
}

export interface ScopedStatusRecipient {
  id: string;
  status: string;
  /** Nulo também quando o contato é de outra conta (ver abaixo). */
  contactId: string | null;
}

export interface StatusRecipient {
  own: ScopedStatusRecipient | null;
  foreign: boolean;
  failed: boolean;
}

/**
 * O destinatário de disparo do `wamid` (`whatsapp_message_id` é único,
 * migração 003), se o disparo for da conta.
 *
 * O contato é conferido à parte: a RLS de `broadcast_recipients` só olha o
 * disparo, então um agente de A pode gravar num disparo de A um
 * `contact_id` de B, e um `failed`/131026 marcaria o contato de B como
 * inválido.
 */
export async function findStatusRecipient(
  db: SupabaseClient,
  wamid: string,
  accountId: string | null,
  logError: LogError = console.error
): Promise<StatusRecipient> {
  const { data, error } = await db
    .from('broadcast_recipients')
    .select(
      'id, status, contact_id, broadcasts!inner(account_id), contacts(account_id)'
    )
    .eq('whatsapp_message_id', wamid)
    .maybeSingle();

  if (error) {
    logError('Error fetching broadcast recipient:', error);
    return { own: null, foreign: false, failed: true };
  }
  if (!data) return { own: null, foreign: false, failed: false };

  const row = data as unknown as {
    id: string;
    status: string;
    contact_id: string | null;
    broadcasts: Embed<{ account_id: string }>;
    contacts: Embed<{ account_id: string }>;
  };
  const broadcast = one(row.broadcasts);
  if (
    !broadcast ||
    (accountId !== null && broadcast.account_id !== accountId)
  ) {
    return { own: null, foreign: true, failed: false };
  }

  const contactIsOurs = one(row.contacts)?.account_id === broadcast.account_id;
  return {
    own: {
      id: row.id,
      status: row.status,
      contactId: contactIsOurs ? row.contact_id : null,
    },
    foreign: false,
    failed: false,
  };
}
