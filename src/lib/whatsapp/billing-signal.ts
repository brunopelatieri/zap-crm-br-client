/**
 * Sinal de pagamento do WhatsApp Cloud API (SPEC 076 F3, §6.3, §10).
 *
 * O que liga e o que limpa
 *
 *   `payment_error` — um 131042 ("problema na forma de pagamento"), vindo
 *   do webhook de status OU da resposta síncrona de um envio (RF-07).
 *   `billable_ok`   — um `sent`/`delivered` com `pricing.billable = true`:
 *   uma mensagem COBRÁVEL saiu, então o pagamento voltou a funcionar.
 *
 *   A regra inteira (COALESCE/GREATEST, "episódio novo só quando
 *   `payment_blocked_since` era nulo", limpeza só com ts posterior ao
 *   último erro, 131042 antigo depois de uma limpeza ignorado) mora na
 *   função SQL `apply_payment_signal` (migração 087), num passo atômico
 *   sob o lock da linha. Ler-e-depois-escrever daqui abriria corrida
 *   justamente na rajada de `failed` de um disparo em massa sem cartão —
 *   e corrida aqui é notificação em dobro. Este arquivo só resolve QUEM
 *   (conta, WABA, canais) e decide QUANDO chamar.
 *
 * Best-effort, sempre
 *
 *   Nada exportado daqui lança. Uma falha do sinal é logada e o chamador
 *   segue: o webhook continua espelhando o status em `messages` /
 *   `broadcast_recipients` e publicando `message.status_updated`
 *   (§10.4), e o envio síncrono devolve o MESMO erro ao seu chamador.
 *
 * Caminho quente (R-10)
 *
 *   Um webhook de status chega para TODA mensagem enviada, e a Meta
 *   costuma entregar um por POST — então memória por-POST não poupa
 *   nada. A conta/WABA do número e um retrato do estado de pagamento
 *   vivem num cache de PROCESSO (`SESSION_TTL_MS`), compartilhado entre
 *   o webhook e o envio síncrono. O retrato é só FILTRO para pular
 *   chamadas que não mudariam nada; quem decide é sempre a função SQL.
 *
 * Sem Graph aqui (RNF-05) e sem token em lugar nenhum (RNF-01): o sinal
 * só lê `whatsapp_config.account_id/waba_id/channel_id`.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { after } from 'next/server';

import { supabaseAdmin } from '@/lib/supabase/admin';
import {
  SCHEMA_RETRY_MS,
  errMsg,
  isSchemaMissingError,
  readBillingMonitorFlag,
} from './billing-schema';
import {
  PAYMENT_ERROR_CODE,
  maskId,
  readStatus,
  type ReadStatusResult,
  type WebhookStatusItem,
} from './billing-monitor';

export type PaymentSignalKind = 'payment_error' | 'billable_ok';

/**
 * Onde o sinal vale: o WABA de um número, resolvido SEMPRE pela
 * `whatsapp_config` (RNF-02) — nunca pelo `entry.id` do webhook nem por
 * nada que venha de requisição.
 */
export interface PaymentSignalTarget {
  accountId: string;
  wabaId: string;
  phoneNumberId: string;
}

export interface PaymentSignalResult {
  /** A função SQL rodou sem erro. */
  ok: boolean;
  /**
   * `payment_error`: abriu um episódio. `billable_ok`: limpou o
   * episódio pendente. `false` quando nada mudou de estado.
   */
  changed: boolean;
  /** Notificações criadas (só com o flag ligado). */
  notified: number;
}

const NO_OP: PaymentSignalResult = { ok: false, changed: false, notified: 0 };

// ============================================================
// Schema ausente (projeto sem a 086/087)
// ============================================================

/**
 * Ao ver um erro de schema ausente (vocabulário em `billing-schema.ts`,
 * comum com `billing-server.ts`), a peça correspondente é desligada por
 * {@link SCHEMA_RETRY_MS} neste processo e o motivo é logado UMA vez.
 */
type SchemaPiece = 'billing' | 'pricing';
const schemaUnavailableUntil: Record<SchemaPiece, number> = {
  billing: 0,
  pricing: 0,
};

function schemaAvailable(piece: SchemaPiece, now = Date.now()): boolean {
  return now >= schemaUnavailableUntil[piece];
}

/** Devolve `true` se o erro era de schema ausente (e já foi tratado). */
function noteSchemaMissing(piece: SchemaPiece, error: unknown): boolean {
  if (!isSchemaMissingError(error)) return false;
  const wasAvailable = schemaAvailable(piece);
  schemaUnavailableUntil[piece] = Date.now() + SCHEMA_RETRY_MS;
  if (wasAvailable) {
    console.warn(
      `[billing-signal] ${piece} schema missing (migration 086/087 not applied?) — skipping for ${SCHEMA_RETRY_MS / 60000} min:`,
      errMsg(error)
    );
  }
  return true;
}

// ============================================================
// Resolução do alvo
// ============================================================

type TargetLookup =
  | { kind: 'ok'; target: PaymentSignalTarget }
  /** Definitivo: número desconhecido, duplicado ou sem `waba_id`. */
  | { kind: 'none' }
  /** Transitório: a consulta falhou. Nunca vale a pena guardar. */
  | { kind: 'error' };

async function lookupTarget(
  db: SupabaseClient,
  input: { phoneNumberId: string; entryWabaId?: string | null }
): Promise<TargetLookup> {
  const { phoneNumberId, entryWabaId } = input;

  const { data, error } = await db
    .from('whatsapp_config')
    .select('account_id, waba_id')
    .eq('phone_number_id', phoneNumberId);
  if (error) {
    console.error(
      `[billing-signal] config lookup failed pnid=${maskId(phoneNumberId)}:`,
      errMsg(error)
    );
    return { kind: 'error' };
  }

  const rows = (data ?? []) as Array<{
    account_id: string;
    waba_id: string | null;
  }>;
  if (rows.length !== 1) {
    // 0: número desconhecido. ≥2: só sem a UNIQUE da 013 — o webhook de
    // mensagens loga o mesmo caso com detalhe.
    console.warn(
      `[billing-signal] skipped pnid=${maskId(phoneNumberId)} reason=${rows.length === 0 ? 'no_config' : 'multiple_configs'}`
    );
    return { kind: 'none' };
  }

  const row = rows[0]!;
  if (!row.waba_id) {
    console.warn(
      `[billing-signal] skipped pnid=${maskId(phoneNumberId)} reason=no_waba_id`
    );
    return { kind: 'none' };
  }

  if (entryWabaId && entryWabaId !== row.waba_id) {
    console.warn(
      `[billing-signal] waba mismatch pnid=${maskId(phoneNumberId)} entry=${maskId(entryWabaId)} config=${maskId(row.waba_id)} — using config`
    );
  }

  return {
    kind: 'ok',
    target: { accountId: row.account_id, wabaId: row.waba_id, phoneNumberId },
  };
}

/**
 * Conta + WABA de um número oficial, pela `whatsapp_config`
 * (`phone_number_id` é UNIQUE desde a 013).
 *
 * - `accountId`, quando informado, entra no filtro: defesa em
 *   profundidade, mesmo cuidado de `cloud-channels.ts`.
 * - `entryWabaId` (o `entry.id` do webhook) NUNCA decide nada: se
 *   divergir do `waba_id` da config, vale o da config e a divergência é
 *   logada (§7.8).
 * - Config sem `waba_id` (o campo é opcional) → `null`: sem WABA não há
 *   chave para a linha, e chutar o `entry.id` criaria uma linha que a F4
 *   nunca mostraria (o canal aparece como `no_credentials`). Logado.
 */
export async function resolvePaymentSignalTarget(
  db: SupabaseClient,
  input: {
    phoneNumberId: string;
    accountId?: string;
    entryWabaId?: string | null;
  }
): Promise<PaymentSignalTarget | null> {
  const found = await lookupTarget(db, input);
  if (found.kind !== 'ok') return null;
  if (input.accountId && found.target.accountId !== input.accountId) {
    console.warn(
      `[billing-signal] skipped pnid=${maskId(input.phoneNumberId)} reason=account_mismatch`
    );
    return null;
  }
  return found.target;
}

// ============================================================
// Sessão por número (cache de processo)
// ============================================================

/**
 * Conta/WABA + retrato local do estado de pagamento de UM número.
 * `target = null` é "este número não tem WABA conhecido" (definitivo).
 */
interface SessionState {
  target: PaymentSignalTarget | null;
  /** Retrato local do estado de pagamento — filtro, nunca verdade. */
  pending: boolean;
  lastErrorAtMs: number | null;
}

/**
 * Validade do retrato. Curta de propósito: o pior que um retrato velho
 * faz é pular UMA limpeza (a próxima mensagem cobrável limpa) ou chamar
 * a função SQL à toa (que não muda nada) — nunca decide estado.
 */
const SESSION_TTL_MS = 15 * 1000;

const sessionCache = new Map<
  string,
  { promise: Promise<SessionState | null>; expiresAt: number }
>();

async function loadSession(
  db: SupabaseClient,
  input: { phoneNumberId: string; entryWabaId?: string | null }
): Promise<SessionState | null> {
  const found = await lookupTarget(db, input);
  if (found.kind === 'error') return null;
  if (found.kind === 'none') {
    return { target: null, pending: false, lastErrorAtMs: null };
  }

  const { target } = found;
  const { data, error } = await db
    .from('whatsapp_billing_status')
    .select('payment_blocked_since, last_payment_error_at')
    .eq('account_id', target.accountId)
    .eq('waba_id', target.wabaId)
    .maybeSingle();
  if (error) {
    if (!noteSchemaMissing('billing', error)) {
      console.error(
        `[billing-signal] state lookup failed waba=${maskId(target.wabaId)}:`,
        errMsg(error)
      );
    }
    return null;
  }

  const lastMs = data?.last_payment_error_at
    ? Date.parse(data.last_payment_error_at as string)
    : NaN;
  return {
    target,
    pending: Boolean(data?.payment_blocked_since),
    lastErrorAtMs: Number.isFinite(lastMs) ? lastMs : null,
  };
}

/**
 * Sessão do número, do cache ou recém-lida. Falha transitória (`null`)
 * NUNCA fica guardada: o próximo sinal tenta de novo. Chamadas
 * concorrentes dividem a mesma leitura em andamento.
 */
function getSession(
  db: SupabaseClient,
  input: { phoneNumberId: string; entryWabaId?: string | null }
): Promise<SessionState | null> {
  const key = input.phoneNumberId;
  const now = Date.now();
  const hit = sessionCache.get(key);
  if (hit && hit.expiresAt > now) return hit.promise;

  const promise = loadSession(db, input).then(
    (state) => {
      if (!state && sessionCache.get(key)?.promise === promise) {
        sessionCache.delete(key);
      }
      return state;
    },
    (err) => {
      if (sessionCache.get(key)?.promise === promise) sessionCache.delete(key);
      throw err;
    }
  );
  sessionCache.set(key, { promise, expiresAt: now + SESSION_TTL_MS });
  return promise;
}

function invalidateSession(phoneNumberId: string): void {
  sessionCache.delete(phoneNumberId);
}

// ============================================================
// Notificação em falta (retry no processo)
// ============================================================

/**
 * WABAs cujo episódio abriu mas a notificação NÃO saiu por falha
 * transitória (leitura do flag, consulta de canais ou a própria função).
 *
 * A função SQL só devolve TRUE uma vez por episódio; sem isto, uma falha
 * nesse instante perderia o alerta do episódio inteiro. Enquanto o WABA
 * está aqui, todo 131042 seguinte tenta notificar de novo (a função de
 * notificação deduplica por usuário/canal não lido, então um retry que
 * encontra a linha já criada é inócuo). Vale por processo: outro
 * processo não herda — limite aceito, a rajada de um disparo em massa
 * costuma cair toda no mesmo.
 */
const unnotified = new Set<string>();

function notifyKey(t: PaymentSignalTarget): string {
  return `${t.accountId}:${t.wabaId}`;
}

/** Só para teste: zera o estado de processo deste módulo. */
export function __resetBillingSignalStateForTests(): void {
  schemaUnavailableUntil.billing = 0;
  schemaUnavailableUntil.pricing = 0;
  sessionCache.clear();
  unnotified.clear();
}

// ============================================================
// Aplicação
// ============================================================

/**
 * Aplica um sinal ao estado de pagamento do WABA e, num episódio NOVO
 * (ou com notificação pendente de retry), notifica owner/admin de cada
 * canal daquele WABA — se o flag estiver ligado; com ele desligado o
 * estado é gravado do mesmo jeito (D-10).
 *
 * Nunca lança.
 */
export async function applyPaymentSignal(
  db: SupabaseClient,
  input: {
    target: PaymentSignalTarget;
    kind: PaymentSignalKind;
    ts: Date;
    /** Só para log (o wamid não é segredo). */
    messageId?: string | null;
  }
): Promise<PaymentSignalResult> {
  const { target, kind, ts } = input;
  if (!schemaAvailable('billing')) return NO_OP;
  if (Number.isNaN(ts.getTime())) return NO_OP;

  try {
    const { data, error } = await db.rpc('apply_payment_signal', {
      p_account_id: target.accountId,
      p_waba_id: target.wabaId,
      p_kind: kind,
      p_ts: ts.toISOString(),
      p_phone_number_id: target.phoneNumberId,
    });

    if (error) {
      if (!noteSchemaMissing('billing', error)) {
        console.error(
          `[billing-signal] ${kind} failed waba=${maskId(target.wabaId)} pnid=${maskId(target.phoneNumberId)}:`,
          errMsg(error)
        );
      }
      return NO_OP;
    }

    const changed = data === true;
    let notified = 0;
    const key = notifyKey(target);
    if (kind === 'payment_error' && (changed || unnotified.has(key))) {
      const n = await notifyPaymentBlocked(db, target);
      notified = n.count;
      if (n.complete) unnotified.delete(key);
      else unnotified.add(key);
    }

    if (kind === 'payment_error' || changed) {
      console.log(
        `[billing-signal] ${kind} waba=${maskId(target.wabaId)} pnid=${maskId(target.phoneNumberId)} ts=${ts.toISOString()} msg=${input.messageId ?? '-'} ${kind === 'payment_error' ? 'new_episode' : 'cleared'}=${changed}${kind === 'payment_error' && (changed || notified > 0) ? ` notified=${notified}` : ''}`
      );
    }

    return { ok: true, changed, notified };
  } catch (err) {
    console.error(
      `[billing-signal] ${kind} threw waba=${maskId(target.wabaId)} pnid=${maskId(target.phoneNumberId)}:`,
      err instanceof Error ? err.message : err
    );
    return NO_OP;
  }
}

/**
 * Uma chamada de `notify_channel_payment_blocked` por CANAL do WABA
 * naquela conta (D-6): dois números no mesmo WABA bloqueiam juntos, e o
 * alerta cita o nome de cada um. Canal `disabled` fica de fora — não
 * envia nada, não há o que regularizar por ele.
 *
 * `complete = false` quando algo falhou de forma transitória — o
 * chamador guarda o WABA em {@link unnotified} para tentar de novo.
 * Flag desligado e "nenhum canal ativo" são `complete = true`: não há o
 * que repetir.
 */
async function notifyPaymentBlocked(
  db: SupabaseClient,
  target: PaymentSignalTarget
): Promise<{ count: number; complete: boolean }> {
  const enabled = await readBillingMonitorFlag(db, 'billing-signal');
  if (enabled === null) return { count: 0, complete: false };
  if (!enabled) {
    console.log(
      `[billing-signal] notification skipped waba=${maskId(target.wabaId)} reason=flag_off`
    );
    return { count: 0, complete: true };
  }

  const { data: configs, error: cfgErr } = await db
    .from('whatsapp_config')
    .select('channel_id')
    .eq('account_id', target.accountId)
    .eq('waba_id', target.wabaId);
  if (cfgErr) {
    console.error(
      `[billing-signal] channel lookup failed waba=${maskId(target.wabaId)}:`,
      errMsg(cfgErr)
    );
    return { count: 0, complete: false };
  }

  const candidateIds = [
    ...new Set(
      ((configs ?? []) as Array<{ channel_id: string | null }>)
        .map((c) => c.channel_id)
        .filter((id): id is string => typeof id === 'string' && id !== '')
    ),
  ];
  if (candidateIds.length === 0) return { count: 0, complete: true };

  const { data: channels, error: chErr } = await db
    .from('channels')
    .select('id')
    .eq('account_id', target.accountId)
    .eq('type', 'whatsapp_cloud')
    .neq('status', 'disabled')
    .in('id', candidateIds);
  if (chErr) {
    console.error(
      `[billing-signal] channel status lookup failed waba=${maskId(target.wabaId)}:`,
      errMsg(chErr)
    );
    return { count: 0, complete: false };
  }

  let total = 0;
  let complete = true;
  for (const ch of (channels ?? []) as Array<{ id: string }>) {
    const { data, error } = await db.rpc('notify_channel_payment_blocked', {
      p_account_id: target.accountId,
      p_channel_id: ch.id,
      p_waba_id: target.wabaId,
    });
    if (error) {
      console.error(
        `[billing-signal] notify failed waba=${maskId(target.wabaId)} channel=${ch.id}:`,
        errMsg(error)
      );
      complete = false;
      continue;
    }
    total += typeof data === 'number' ? data : 0;
  }
  return { count: total, complete };
}

// ============================================================
// Webhook (§10.2, §10.3)
// ============================================================

/**
 * `pricing.billable` / `pricing.category` para juntar ao UPDATE de
 * status de `messages` (D-7). Vazio quando o evento não trouxe `pricing`
 * (nunca grava nulo por cima) ou quando a 086 está ausente neste
 * projeto (ver {@link notePricingSchemaMissing}).
 */
export function pricingPatchFor(
  read: Pick<ReadStatusResult, 'billable' | 'category'>
): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  if (!schemaAvailable('pricing')) return patch;
  if (read.billable !== null) patch.pricing_billable = read.billable;
  if (read.category !== null) patch.pricing_category = read.category;
  return patch;
}

/**
 * O UPDATE de status que levou as colunas de pricing falhou: foi por a
 * 086 não existir? Se sim (`true`), o pricing fica desligado por 10 min
 * neste processo e o chamador REPETE o UPDATE só com o status — onde a
 * 086 falta, o espelho de status (sent/delivered/read) nunca pode cair
 * junto com as colunas novas.
 */
export function notePricingSchemaMissing(error: unknown): boolean {
  return noteSchemaMissing('pricing', error);
}

/** Que sinal (se algum) um item de status carrega — §10.3. */
export function signalKindForStatus(
  status: string | undefined,
  read: Pick<ReadStatusResult, 'billable' | 'paymentBlocked'>
): PaymentSignalKind | null {
  if (read.paymentBlocked) return 'payment_error';
  if (read.billable === true && (status === 'sent' || status === 'delivered')) {
    return 'billable_ok';
  }
  // billable=false (mensagem gratuita sai mesmo sem cartão) ou sem
  // pricing: nunca limpa.
  return null;
}

/** `timestamp` do status da Meta (segundos, string) → Date, ou `null`. */
export function parseMetaTimestamp(raw: unknown): Date | null {
  const n =
    typeof raw === 'number'
      ? raw
      : typeof raw === 'string' && raw.trim() !== ''
        ? Number(raw)
        : NaN;
  if (!Number.isFinite(n) || n <= 0) return null;
  return new Date(n * 1000);
}

/**
 * Aplica o sinal e mantém o retrato local coerente com o resultado.
 *
 * `ok` mas sem mudança de estado é ambíguo (já estava pendente por
 * outro processo, ou o erro era anterior a uma limpeza): em vez de
 * adivinhar, descarta o retrato e deixa o próximo sinal reler.
 */
async function applyToSession(
  db: SupabaseClient,
  session: SessionState & { target: PaymentSignalTarget },
  kind: PaymentSignalKind,
  ts: Date,
  messageId?: string | null
): Promise<PaymentSignalResult> {
  const r = await applyPaymentSignal(db, {
    target: session.target,
    kind,
    ts,
    messageId,
  });
  if (!r.ok) return r;

  if (kind === 'billable_ok') {
    if (r.changed) session.pending = false;
    else invalidateSession(session.target.phoneNumberId);
    return r;
  }

  if (r.changed) {
    session.pending = true;
    session.lastErrorAtMs = Math.max(session.lastErrorAtMs ?? 0, ts.getTime());
  } else if (session.pending) {
    session.lastErrorAtMs = Math.max(session.lastErrorAtMs ?? 0, ts.getTime());
  } else {
    invalidateSession(session.target.phoneNumberId);
  }
  return r;
}

export interface WebhookPaymentSignals {
  /** Processa UM item de status. Nunca lança. */
  handleStatus(
    status: WebhookStatusItem & { id?: string; timestamp?: string },
    read?: ReadStatusResult
  ): Promise<void>;
}

/**
 * Sinais de pagamento dos statuses de UM número.
 *
 * A sessão (conta + WABA + retrato) é lida preguiçosamente — só quando
 * um status carrega sinal (131042, ou cobrável `sent`/`delivered`) — e
 * vem do cache de processo (ver o cabeçalho). Barato de criar: o
 * chamador pode criar um por `change`.
 */
export function createWebhookPaymentSignals(
  db: SupabaseClient,
  input: { phoneNumberId: string; entryWabaId?: string | null }
): WebhookPaymentSignals {
  return {
    async handleStatus(status, preRead) {
      try {
        const read = preRead ?? readStatus(status);
        const kind = signalKindForStatus(status.status, read);
        if (!kind) return;

        const ts = parseMetaTimestamp(status.timestamp);
        if (!ts) {
          console.warn(
            `[billing-signal] ${kind} ignored — unreadable timestamp pnid=${maskId(input.phoneNumberId)}`
          );
          return;
        }
        const tsMs = ts.getTime();

        const session = await getSession(db, input);
        if (!session || !session.target) return;
        const ready = session as SessionState & {
          target: PaymentSignalTarget;
        };

        if (kind === 'billable_ok') {
          // Sem pendência, ou cobrável não posterior ao último erro: a
          // função SQL não mudaria nada.
          if (!ready.pending) return;
          if (ready.lastErrorAtMs !== null && tsMs <= ready.lastErrorAtMs) {
            return;
          }
          await applyToSession(db, ready, kind, ts, status.id);
          return;
        }

        // payment_error. Pendente com erro igual ou mais novo já gravado
        // (o reenvio da Meta, ou a rajada de um disparo): nada a mudar —
        // salvo notificação em falta, que precisa de nova tentativa.
        if (
          ready.pending &&
          ready.lastErrorAtMs !== null &&
          tsMs <= ready.lastErrorAtMs &&
          !unnotified.has(notifyKey(ready.target))
        ) {
          return;
        }
        await applyToSession(db, ready, kind, ts, status.id);
      } catch (err) {
        console.error(
          `[billing-signal] status signal threw pnid=${maskId(input.phoneNumberId)}:`,
          err instanceof Error ? err.message : err
        );
      }
    },
  };
}

// ============================================================
// Envio síncrono (RF-07)
// ============================================================

/**
 * O erro (ou a causa dele) é um 131042 da Meta?
 *
 * Por forma, não por `instanceof MetaApiError`: o adaptador Cloud deixa
 * o `MetaApiError` subir intacto hoje, mas um embrulho futuro
 * (`new Error(…, { cause })`) não pode calar o sinal. Só `code`
 * NUMÉRICO conta — erros de rede do Node têm `code` string.
 */
export function isPaymentMethodError(err: unknown, depth = 0): boolean {
  if (depth > 3 || typeof err !== 'object' || err === null) return false;
  const code = (err as { code?: unknown }).code;
  if (typeof code === 'number' && code === PAYMENT_ERROR_CODE) return true;
  return isPaymentMethodError((err as { cause?: unknown }).cause, depth + 1);
}

/**
 * Margem somada à hora do servidor no 131042 SÍNCRONO.
 *
 * `last_payment_error_at` é comparado com carimbos DA META (a limpeza
 * por mensagem cobrável). Um relógio nosso atrasado em relação ao da
 * Meta deixaria um `delivered` cobrável de ANTES da falha parecer
 * posterior a ela e limpar um episódio que continua valendo. A margem
 * pende para o lado seguro: no máximo atrasa a limpeza até a próxima
 * mensagem cobrável.
 */
const SYNC_CLOCK_SKEW_MS = 60 * 1000;

/**
 * Um disparo em massa sem cartão falha destinatário após destinatário
 * (cada um é best-effort e o laço não para). Com o episódio já aberto,
 * regravar `last_payment_error_at` a cada falha é uma ida ao banco por
 * destinatário para mudar o carimbo em segundos — então, com pendência
 * conhecida, só uma chamada por janela.
 */
const SYNC_COALESCE_MS = 10 * 1000;

export interface PaymentErrorFromSendInput {
  accountId: string;
  phoneNumberId: string | null | undefined;
  error: unknown;
  /** Para teste; o padrão é a hora do envio. */
  now?: Date;
}

/**
 * Gancho do envio síncrono: um envio pelo canal oficial falhou — se foi
 * por 131042, liga o estado de pagamento do WABA do número.
 *
 * A promessa nunca rejeita. Sem `db` de parâmetro de propósito: quem
 * envia pode estar com o cliente de SESSÃO, e a tabela só aceita
 * escrita de `service_role` (§8.1). Quem chama de dentro de um envio
 * deve usar {@link schedulePaymentErrorSignal}.
 */
export async function signalPaymentErrorFromSend(
  input: PaymentErrorFromSendInput
): Promise<void> {
  try {
    if (!isPaymentMethodError(input.error)) return;
    if (!input.accountId || !input.phoneNumberId) return;
    if (!schemaAvailable('billing')) return;

    const db = supabaseAdmin();
    const session = await getSession(db, {
      phoneNumberId: input.phoneNumberId,
    });
    const target = session?.target;
    if (!session || !target) return;
    // Defesa em profundidade (RNF-02): o número tem de ser DESTA conta.
    if (target.accountId !== input.accountId) {
      console.warn(
        `[billing-signal] skipped pnid=${maskId(input.phoneNumberId)} reason=account_mismatch`
      );
      return;
    }

    const ts = new Date(
      (input.now ?? new Date()).getTime() + SYNC_CLOCK_SKEW_MS
    );
    if (
      session.pending &&
      session.lastErrorAtMs !== null &&
      ts.getTime() - session.lastErrorAtMs < SYNC_COALESCE_MS &&
      !unnotified.has(notifyKey(target))
    ) {
      return;
    }
    // O MESMO objeto do cache: o retrato local acompanha o resultado.
    await applyToSession(
      db,
      session as SessionState & { target: PaymentSignalTarget },
      'payment_error',
      ts
    );
  } catch (err) {
    console.error(
      `[billing-signal] sync payment signal threw pnid=${maskId(input.phoneNumberId)}:`,
      err instanceof Error ? err.message : err
    );
  }
}

/**
 * Agenda {@link signalPaymentErrorFromSend} sem segurar o erro do envio
 * e SEM deixar a escrita para uma promessa solta: o runtime pode
 * congelar a função assim que a resposta sai e matar o RPC no meio
 * (mesma razão pela qual o webhook usa `after()` — issue #301). Fora do
 * ciclo de vida de uma requisição `after()` lança, e aí a promessa corre
 * solta como último recurso (mesmo desenho de `notifications/emit.ts`).
 *
 * Só agenda quando o erro é de fato um 131042: o caminho comum de erro
 * não paga `after()` nem toca o banco.
 */
export function schedulePaymentErrorSignal(
  input: PaymentErrorFromSendInput
): void {
  if (!isPaymentMethodError(input.error)) return;
  const run = () => signalPaymentErrorFromSend(input);
  try {
    after(run);
  } catch {
    void run();
  }
}
