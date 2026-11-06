/**
 * D-1 da SPEC 049 (§6.2) — ONDE o teto de envio frio verifica e
 * registra, e quem faz o quê.
 *
 * `cold-send-limit.ts` é o cálculo puro (parsing, veredito). Este
 * arquivo é a segunda metade do contrato do próprio cabeçalho daquele
 * módulo: "quem chama reúne o uso e executa a decisão".
 *
 * Só se aplica a canais sem `sessionWindow24h`
 *
 *   A Meta já regula o resto (janela, tier de mensagens) — contar de
 *   novo num canal Cloud confundiria a leitura da cota. `checkColdSend`
 *   devolve `applicable: false` e nunca toca o banco nesse caso.
 *
 * Três origens, três posturas (tabela da §6.2)
 *
 *   `engine`  (automação/flow/IA) — verifica E bloqueia. É a
 *             metralhadora que a §10.3 existe para frear.
 *   `human`   (inbox) — nunca bloqueia, só registra. Travar um agente
 *             no meio do atendimento é pior que o risco marginal de um
 *             envio manual.
 *   `api`     (API pública v1) — verifica E bloqueia com 429. Caminho
 *             automatizado por definição.
 *
 *   `checkColdSend` não sabe de origem — é o CHAMADOR (send.ts,
 *   send-message.ts) que decide o que fazer com a decisão. Isto mantém
 *   a postura de cada caminho legível no próprio caminho, em vez de
 *   escondida num parâmetro de comportamento aqui.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

import { supabaseAdmin } from '@/lib/supabase/admin';
import {
  isColdSend,
  evaluateColdSend,
  describeDenial,
  type ColdSendDecision,
} from './cold-send-limit';
import { resolveColdSendLimits } from './cold-send-resolve';
import type { LimitsCache } from '@/lib/limits/load';
import { loadColdSendUsage } from './cold-send-usage';
import { can } from './capabilities';
import type { ChannelType } from './types';

export type ColdSendOrigin = 'engine' | 'human' | 'api';

export interface ColdSendCheck {
  /** O canal tem teto de envio frio? (falso em canais com janela da Meta.) */
  applicable: boolean;
  /** Só é `true` quando `applicable` e o silêncio ultrapassa o limiar. */
  cold: boolean;
  /** `null` quando `!applicable` ou `!cold` — não há decisão a tomar. */
  decision: ColdSendDecision | null;
}

/**
 * Última mensagem DO CONTATO nesta conversa — o `lastInboundAt` que
 * `checkColdSend` espera.
 *
 * Por que não `conversations.last_customer_message_at`
 *
 *   Ele é a âncora da janela de 24h, e `ingest.ts` só o grava em canal
 *   COM janela (`shouldTrackSessionWindow`) — gravá-lo no QRCode poria a
 *   conversa no alcance do reengajamento. Ou seja: justamente nos canais
 *   onde o teto frio vale, ele é NULL para sempre, e NULL é "nunca
 *   escreveu" (`isColdSend` → frio). Lido dali, todo envio de motor no
 *   QRCode contava como frio, inclusive a resposta a quem acabou de
 *   escrever — e o aquecimento (piso de 5 no 1º dia) esgotava em
 *   minutos de conversa normal.
 *
 *   A própria mensagem do contato é a fonte que existe em todo canal.
 *   O índice `(conversation_id, created_at)` (068) cobre a leitura.
 *
 * Falha de leitura vira `null` (frio): é o lado conservador, e o mesmo
 * resultado de antes desta função existir.
 */
export async function loadLastInboundAt(
  db: SupabaseClient,
  conversationId: string
): Promise<Date | null> {
  const { data, error } = await db
    .from('messages')
    .select('created_at')
    .eq('conversation_id', conversationId)
    .eq('sender_type', 'customer')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    console.error(
      '[cold-send-wiring] failed to load last inbound message:',
      error.message
    );
    return null;
  }
  const createdAt = (data as { created_at?: string | null } | null)?.created_at;
  return createdAt ? new Date(createdAt) : null;
}

/**
 * Este envio É frio, e nesse caso ele pode sair agora? Avalia SEM
 * gravar nada — `recordColdSend` é a segunda metade, chamada depois da
 * entrega confirmada (§6.1 ponto 4: contar antes transformaria uma
 * falha de rede em cota consumida).
 */
export async function checkColdSend(
  db: SupabaseClient,
  input: {
    channelId: string;
    channelType: ChannelType;
    /**
     * Conta dona do canal. Opcional porque nem todo call site a tem em
     * mãos; sem ela o nível 1a (o teto comprado no plano) não participa
     * e a cascata resolve por instância, `.env` e padrão de código —
     * nunca "sem limite". Passe-a sempre que existir: é o que faz o
     * teto vendido ao cliente valer de fato.
     */
    accountId?: string | null;
    /**
     * Última mensagem DO CONTATO nesta conversa; `null` = nunca escreveu.
     * Use `loadLastInboundAt` — não `last_customer_message_at`, que é
     * NULL em todo canal onde este teto vale.
     */
    lastInboundAt: Date | null;
  },
  now: Date = new Date(),
  /** Cache de um ciclo (SPEC 069 §4.3) — o cron resolve os limites uma
   *  vez por instância, não uma vez por contato. */
  cache?: LimitsCache
): Promise<ColdSendCheck> {
  if (can(input.channelType, 'sessionWindow24h')) {
    return { applicable: false, cold: false, decision: null };
  }

  // SPEC 069 F2: os tetos passam a vir da cascata (instância > conta >
  // .env > código) em vez de direto do `.env`. Sem nada configurado o
  // resultado é idêntico ao de antes — é o que torna esta troca
  // invisível para quem não pediu nada.
  const { limits } = await resolveColdSendLimits(
    db,
    { accountId: input.accountId, channelId: input.channelId },
    cache
  );
  const cold = isColdSend(input.lastInboundAt, limits, now);
  if (!cold) return { applicable: true, cold: false, decision: null };

  const usage = await loadColdSendUsage(db, input.channelId, now);
  const decision = evaluateColdSend(limits, usage, now);
  return { applicable: true, cold: true, decision };
}

/**
 * Grava o consumo. Best-effort: a mensagem já foi entregue quando isto
 * roda — perder a linha subconta a cota, mas fingir que o envio falhou
 * seria o erro pior (mesmo princípio do INSERT em `sendAndPersistOutbound`).
 *
 * SEMPRE `supabaseAdmin()`, nunca um `db` de parâmetro: a 062 proíbe
 * QUALQUER policy de escrita em `channel_cold_sends` (só service_role),
 * então um `db` de sessão aqui é sempre "new row violates row-level
 * security policy" — foi exatamente o bug real que chegou em produção
 * quando os dois chamadores (envio pelo inbox, motor de automações)
 * passavam o próprio `db`. Escalar AQUI DENTRO, e não em cada call
 * site, é o que impede um terceiro chamador futuro de repetir o erro.
 *
 * O try/catch cobre não só o `.insert()` retornando `{error}` (already
 * handled abaixo) mas também `supabaseAdmin()` em si podendo LANÇAR na
 * construção do cliente (ex.: `SUPABASE_SERVICE_ROLE_KEY` ausente nesta
 * instância) — sem isso, best-effort vira "às vezes propaga", e a
 * mensagem já entregue voltaria como erro 500 pro chamador.
 */
export async function recordColdSend(input: {
  channelId: string;
  accountId: string;
  contactId: string | null;
  origin: ColdSendOrigin;
}): Promise<void> {
  try {
    const { error } = await supabaseAdmin().from('channel_cold_sends').insert({
      channel_id: input.channelId,
      account_id: input.accountId,
      contact_id: input.contactId,
      origin: input.origin,
    });
    if (error) {
      console.error(
        '[cold-send-wiring] failed to record cold send:',
        error.message
      );
    }
  } catch (err) {
    console.error(
      '[cold-send-wiring] failed to record cold send:',
      err instanceof Error ? err.message : err
    );
  }
}

/**
 * O teto negou. Motivo legível pronto para `automation_logs`
 * (`describeDenial`), classe própria para o motor distinguir "cota
 * estourada" (adiamento, PRD §10.3) de qualquer outra falha.
 */
export class ColdSendLimitError extends Error {
  readonly decision: ColdSendDecision;
  constructor(decision: ColdSendDecision) {
    super(describeDenial(decision));
    this.name = 'ColdSendLimitError';
    this.decision = decision;
  }
}
