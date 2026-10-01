/**
 * Decisões e DTO do monitor de cobrança (SPEC 076 §7.5, §7.6, §9).
 *
 * Lógica PURA, sem I/O: o que está vencido, quando tentar de novo e o que
 * cada papel enxerga. A orquestração (cache no banco, chamada à Graph,
 * single-flight) mora em `billing-server.ts`; aqui fica o que precisa de
 * teste sem Supabase nem `fetch`.
 *
 * Papéis (D-8): status de envio para todo membro; consumo e os carimbos
 * do episódio de pagamento só para admin+. Para agent/viewer as CHAVES
 * somem do objeto (não viram `null`): um campo `null` ainda diria "existe
 * e você não pode ver".
 */

import { canEditSettings, type AccountRole } from '@/lib/auth/roles';
import type {
  BillingErrorKind,
  WabaHealthEntity,
  WabaHealthValue,
  WhatsappBillingStatusRow,
} from '@/types';
import {
  HEALTH_TTL_MS,
  SPEND_TTL_MS,
  deriveSendState,
  isFresh,
  maskId,
  type SendState,
} from './billing-monitor';

// ============================================================
// Constantes (§7.6, §9.1)
// ============================================================

/** Teto do recuo por limite de taxa (§7.6). */
export const RATE_LIMIT_BACKOFF_CAP_MINUTES = 60;
/** Teto do recuo por falha transitória (§7.6). */
export const TRANSIENT_BACKOFF_CAP_MINUTES = 30;
/** Uma leitura FORÇADA por WABA a cada 60 s (§9.1). */
export const FORCE_REFRESH_COOLDOWN_MS = 60_000;

export type BillingReadField = 'health' | 'spend';

// ============================================================
// Recuo (§7.6)
// ============================================================

/** `2^n` minutos com o expoente limitado: `2 ** 1100` vira `Infinity`. */
function exponentialMinutes(failures: number): number {
  return 2 ** Math.min(Math.max(failures, 0), 16);
}

/**
 * Quando a leitura pode ser tentada de novo, ou `null` (sem recuo).
 *
 * `consecutiveFailures` é o valor PÓS-incremento desta falha (mesma
 * convenção de `notifications/backoff.ts`): a primeira falha espera 2 min.
 *
 *   - `rate_limit`: `max(estimated_time_to_regain_access, 2^n min)`,
 *     teto de 60 min. O teto vale para o resultado inteiro, como o §7.6
 *     escreve — quem pede mais que isso volta a ser tentado depois de 60
 *     min e, se a Meta ainda não liberou, recua de novo.
 *   - `transient`/`unknown`: `2^n min`, teto de 30 min. `unknown` entra
 *     aqui por desvio declarado do §7.6: ele não lista esse tipo, mas sem
 *     recuo um campo/versão errado (código 100) seria chamado a CADA
 *     abertura da tela — a falha não atualiza o carimbo, então o TTL
 *     nunca é "cumprido".
 *   - `auth`/`permission`: sem recuo automático (repetir não adianta); a
 *     leitura só volta com credencial nova ou leitura forçada.
 */
export function computeNextRetryAt(args: {
  kind: BillingErrorKind;
  consecutiveFailures: number;
  /** Pior `estimated_time_to_regain_access` do cabeçalho, em minutos. */
  usageMinutes?: number | null;
  now: Date;
}): Date | null {
  const { kind, consecutiveFailures, usageMinutes, now } = args;
  let minutes: number;
  switch (kind) {
    case 'auth':
    case 'permission':
      return null;
    case 'rate_limit':
      minutes = Math.min(
        Math.max(usageMinutes ?? 0, exponentialMinutes(consecutiveFailures)),
        RATE_LIMIT_BACKOFF_CAP_MINUTES
      );
      break;
    default:
      minutes = Math.min(
        exponentialMinutes(consecutiveFailures),
        TRANSIENT_BACKOFF_CAP_MINUTES
      );
  }
  return new Date(now.getTime() + minutes * 60_000);
}

// ============================================================
// Mês do consumo (§7.4)
// ============================================================

/** `YYYY-MM` do instante deslocado pelo fuso (`null` = UTC). */
export function localYearMonth(
  now: Date,
  offsetSeconds: number | null
): string {
  return new Date(now.getTime() + (offsetSeconds ?? 0) * 1000)
    .toISOString()
    .slice(0, 7);
}

/**
 * O consumo guardado é do mês local corrente? Virada de mês invalida o
 * retrato independente do TTL (§7.4) — e o valor antigo NUNCA é mostrado
 * como se fosse do mês novo.
 */
export function spendIsCurrentMonth(
  row: Pick<
    WhatsappBillingStatusRow,
    'spend_period_start' | 'spend_tz_offset_seconds'
  > | null,
  now: Date
): boolean {
  if (!row?.spend_period_start) return false;
  return (
    row.spend_period_start.slice(0, 7) ===
    localYearMonth(now, row.spend_tz_offset_seconds)
  );
}

// ============================================================
// O que está vencido (§7.5)
// ============================================================

export type ReadDecision =
  /** Retrato dentro do prazo: não chama a Meta. */
  | 'fresh'
  /** Vencido (ou forçado) e livre para chamar. */
  | 'due'
  /** `next_retry_at` no futuro: nem o botão "Atualizar" chama. */
  | 'backoff'
  /** Credencial/permissão recusada: repetir sozinho não adianta. */
  | 'blocked_auth';

function readFields(
  row: WhatsappBillingStatusRow | null,
  field: BillingReadField
) {
  if (!row) {
    return {
      checkedAt: null,
      errorKind: null as BillingErrorKind | null,
      nextRetryAt: null as string | null,
    };
  }
  return field === 'health'
    ? {
        checkedAt: row.health_checked_at,
        errorKind: row.health_error_kind,
        nextRetryAt: row.health_next_retry_at,
      }
    : {
        checkedAt: row.spend_checked_at,
        errorKind: row.spend_error_kind,
        nextRetryAt: row.spend_next_retry_at,
      };
}

/** `next_retry_at` ainda no futuro? Ilegível conta como "sem recuo". */
export function isInBackoff(nextRetryAt: string | null, now: Date): boolean {
  if (!nextRetryAt) return false;
  const ts = Date.parse(nextRetryAt);
  return !Number.isNaN(ts) && ts > now.getTime();
}

/**
 * Decide, POR CAMPO, se a leitura deve ir à Meta. Ordem:
 *
 *   1. recuo vigente → `backoff` (vence até o `force`);
 *   2. `force` → `due` (ignora TTL e o bloqueio por credencial: é a saída
 *      do `auth_error` sem salvar a credencial de novo, §7.6);
 *   3. erro de credencial/permissão sem leitura boa depois → `blocked_auth`;
 *   4. fora do TTL, ou (consumo) mês virado → `due`; senão `fresh`.
 */
export function decideRead(args: {
  row: WhatsappBillingStatusRow | null;
  field: BillingReadField;
  now: Date;
  force: boolean;
}): ReadDecision {
  const { row, field, now, force } = args;
  const f = readFields(row, field);

  if (isInBackoff(f.nextRetryAt, now)) return 'backoff';
  if (force) return 'due';
  if (f.errorKind === 'auth' || f.errorKind === 'permission') {
    return 'blocked_auth';
  }

  const ttl = field === 'health' ? HEALTH_TTL_MS : SPEND_TTL_MS;
  if (!isFresh(f.checkedAt, ttl, now)) return 'due';
  if (field === 'spend' && !spendIsCurrentMonth(row, now)) return 'due';
  return 'fresh';
}

// ============================================================
// DTO (§9.1)
// ============================================================

/**
 * Estado principal do canal a partir do retrato — UM recorte de
 * `SendStateSnapshot` para o painel e para a lista, que precisam concordar.
 * `wabaId` nulo = sem credencial utilizável (RF-12).
 */
function sendStateOf(
  row: WhatsappBillingStatusRow | null,
  wabaId: string | null
) {
  return deriveSendState({
    hasCredentials: Boolean(wabaId),
    healthOverall: row?.health_overall ?? null,
    healthCheckedAt: row?.health_checked_at ?? null,
    paymentPending: Boolean(row?.payment_blocked_since),
    healthErrorKind: row?.health_error_kind ?? null,
    healthErrorAt: row?.health_error_at ?? null,
  });
}

/** Moeda do WABA muda no meio do mês (F-5): a UI avisa em vez de somar. */
export interface BillingSpendDto {
  /** `false` = "Consumo indisponível" — nunca zero (RF-04). */
  available: boolean;
  currency: string | null;
  currency_changed: boolean;
  period_start: string | null;
  checked_at: string | null;
  total: number | null;
  by_category: Array<{
    category: string;
    volume: number;
    cost: number | null;
  }>;
}

export interface BillingErrorDto {
  /** Qual leitura falhou. */
  field: BillingReadField;
  kind: BillingErrorKind;
  code: number | null;
  at: string | null;
  /** Só admin+: mensagem da Meta, já saneada. */
  message?: string | null;
}

export interface ChannelBillingDto {
  channel_id: string;
  /** Mascarado (`****4821`). */
  waba_id: string | null;
  /** Números ativos da conta neste WABA, ele incluído. */
  shared_with_channels: number;
  state: SendState;
  stale: boolean;
  send_status: {
    overall: WabaHealthValue | null;
    checked_at: string | null;
    problems: WabaHealthEntity[];
  };
  payment: {
    pending: boolean;
    /** Só admin+. */
    since?: string | null;
    /** Só admin+. */
    last_error_at?: string | null;
  };
  /** Só admin+. */
  spend?: BillingSpendDto;
  billing_url: string | null;
  error: BillingErrorDto | null;
  next_retry_at: string | null;
}

const BILLING_HUB_URL = 'https://business.facebook.com/billing_hub/';

/**
 * Link de "Cobrança e pagamentos" (D-11). O `business_id` vem da Meta e só
 * entra na URL se for dígitos; sem ele, a raiz do Billing Hub. A URL
 * canônica ainda é a validação V-8.
 */
export function billingUrl(businessId: string | null | undefined): string {
  return businessId && /^\d+$/.test(businessId)
    ? `${BILLING_HUB_URL}accounts?business_id=${businessId}`
    : BILLING_HUB_URL;
}

function isProblem(entity: WabaHealthEntity): boolean {
  return (
    entity.can_send_message !== null &&
    entity.can_send_message.trim().toUpperCase() !== 'AVAILABLE'
  );
}

/** Número de `numeric` do PostgREST (number, ou string em alguns drivers). */
function toNumber(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function buildSpend(
  row: WhatsappBillingStatusRow | null,
  now: Date
): BillingSpendDto {
  const empty: BillingSpendDto = {
    available: false,
    currency: row?.spend_currency ?? row?.currency ?? null,
    currency_changed: false,
    period_start: null,
    checked_at: null,
    total: null,
    by_category: [],
  };
  // Sem leitura ou de OUTRO mês: indisponível, nunca o valor velho.
  if (!row || !row.spend_checked_at || !spendIsCurrentMonth(row, now)) {
    return empty;
  }

  const total = toNumber(row.spend_total);
  const byCategory = Object.entries(row.spend_by_category ?? {})
    .map(([category, v]) => ({
      category,
      volume: toNumber(v?.volume) ?? 0,
      cost: toNumber(v?.cost),
    }))
    .sort((a, b) => a.category.localeCompare(b.category));

  return {
    available: total !== null,
    currency: row.spend_currency ?? row.currency,
    currency_changed:
      row.spend_currency !== null &&
      row.currency !== null &&
      row.spend_currency !== row.currency,
    period_start: row.spend_period_start,
    checked_at: row.spend_checked_at,
    total,
    by_category: byCategory,
  };
}

function laterFutureRetry(
  row: WhatsappBillingStatusRow | null,
  now: Date
): string | null {
  const candidates = [row?.health_next_retry_at, row?.spend_next_retry_at]
    .filter((v): v is string => typeof v === 'string' && isInBackoff(v, now))
    .sort((a, b) => Date.parse(b) - Date.parse(a));
  return candidates[0] ?? null;
}

function buildError(
  row: WhatsappBillingStatusRow | null,
  isAdmin: boolean
): BillingErrorDto | null {
  if (!row) return null;
  // Erro do status de envio primeiro: é o que mexe no estado do canal.
  const field: BillingReadField | null = row.health_error_kind
    ? 'health'
    : row.spend_error_kind
      ? 'spend'
      : null;
  if (!field) return null;

  const dto: BillingErrorDto =
    field === 'health'
      ? {
          field,
          kind: row.health_error_kind as BillingErrorKind,
          code: row.health_error_code,
          at: row.health_error_at,
        }
      : {
          field,
          kind: row.spend_error_kind as BillingErrorKind,
          code: row.spend_error_code,
          at: row.spend_error_at,
        };
  // "Sem a mensagem crua para não-admins" (§9.1).
  if (isAdmin) {
    dto.message =
      field === 'health' ? row.health_error_message : row.spend_error_message;
  }
  return dto;
}

export interface ChannelBillingInput {
  channelId: string;
  /** `waba_id` real, da `whatsapp_config` da conta. */
  wabaId: string | null;
  sharedWithChannels: number;
  row: WhatsappBillingStatusRow | null;
  role: AccountRole;
  now: Date;
}

/**
 * Monta a resposta de `GET /api/whatsapp/billing?channel_id=` já filtrada
 * por papel. `wabaId` nulo = canal sem credencial utilizável (RF-12).
 */
export function buildChannelBillingDto(
  input: ChannelBillingInput
): ChannelBillingDto {
  const { channelId, wabaId, row, role, now } = input;
  const isAdmin = canEditSettings(role);

  const sendState = sendStateOf(row, wabaId);

  const problems = (row?.health_entities ?? []).filter(isProblem).map((e) => ({
    ...e,
    // O id de WABA/BUSINESS/app não precisa chegar ao navegador (§9.1).
    id: e.id ? maskId(e.id) : null,
  }));

  const dto: ChannelBillingDto = {
    channel_id: channelId,
    waba_id: wabaId ? maskId(wabaId) : null,
    shared_with_channels: input.sharedWithChannels,
    state: sendState.state,
    stale: sendState.stale,
    send_status: {
      overall: row?.health_overall ?? null,
      checked_at: row?.health_checked_at ?? null,
      problems,
    },
    payment: { pending: sendState.paymentPending },
    billing_url: billingUrl(row?.business_id),
    error: buildError(row, isAdmin),
    next_retry_at: laterFutureRetry(row, now),
  };

  if (isAdmin) {
    dto.payment.since = row?.payment_blocked_since ?? null;
    dto.payment.last_error_at = row?.last_payment_error_at ?? null;
    dto.spend = buildSpend(row, now);
  }
  return dto;
}

// ============================================================
// Resumo da lista (§9.2)
// ============================================================

export interface ChannelBillingSummaryDto {
  channel_id: string;
  state: SendState;
  stale: boolean;
  checked_at: string | null;
  /** Só admin+. */
  currency?: string | null;
  /** Só admin+; `null` = indisponível ou de outro mês. */
  spend_total?: number | null;
}

export interface ChannelBillingSummaryInput {
  channelId: string;
  wabaId: string | null;
  row: WhatsappBillingStatusRow | null;
  role: AccountRole;
  now: Date;
}

export function buildChannelSummary(
  input: ChannelBillingSummaryInput
): ChannelBillingSummaryDto {
  const { channelId, wabaId, row, role, now } = input;
  const sendState = sendStateOf(row, wabaId);

  const dto: ChannelBillingSummaryDto = {
    channel_id: channelId,
    state: sendState.state,
    stale: sendState.stale,
    checked_at: row?.health_checked_at ?? null,
  };
  if (canEditSettings(role)) {
    dto.currency = row?.spend_currency ?? row?.currency ?? null;
    dto.spend_total =
      row && row.spend_checked_at && spendIsCurrentMonth(row, now)
        ? toNumber(row.spend_total)
        : null;
  }
  return dto;
}

/**
 * Gravidade para o "pior estado" do tile (RF-14). `unknown` e
 * `no_credentials` NÃO são problema de envio: não empurram o tile para
 * longe de `ok` (o exemplo do §9.2 tem `ok` + `no_credentials` com
 * `worst_state: "ok"`).
 */
const SEVERITY: Record<SendState, number> = {
  payment_blocked: 6,
  blocked: 5,
  auth_error: 4,
  limited: 3,
  ok: 2,
  unknown: 1,
  no_credentials: 0,
};

/** Pior estado entre os canais, ou `null` se não há canal. */
export function worstState(states: readonly SendState[]): SendState | null {
  let worst: SendState | null = null;
  for (const s of states) {
    if (worst === null || SEVERITY[s] > SEVERITY[worst]) worst = s;
  }
  return worst;
}
