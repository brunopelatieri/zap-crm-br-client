/**
 * Monitor de status de envio e consumo do WhatsApp Cloud API (SPEC 076).
 *
 * Lógica PURA, sem I/O: interpreta o que a Graph e o webhook devolvem e
 * decide o estado a mostrar. A chamada HTTP mora em `billing-graph.ts`,
 * a orquestração/cache em `billing-server.ts` (F4) e o sinal de pagamento
 * em `billing-signal.ts` (F3). Isto aqui é o que precisa de teste.
 *
 * O que o monitor NÃO é: não existe "saldo" na Cloud API direta. A
 * cobrança é pós-paga e o "Saldo atual" do Billing Hub é o valor A PAGAR
 * (SPEC §4.1, F-2). Por isso o consumo é sempre "estimado" e nunca
 * "saldo"/"crédito" — a regra de rótulo vale também para o nome das
 * coisas expostas daqui.
 */

import { MetaApiError } from './meta-api';
import type {
  BillingErrorKind,
  BillingSpendCategory,
  WabaHealthEntity,
  WabaHealthValue,
} from '@/types';

// ============================================================
// Constantes
// ============================================================

/** TTL do status de envio (`health_status` + moeda) — SPEC §7.5. */
export const HEALTH_TTL_MS = 5 * 60 * 1000;
/** TTL do consumo (`pricing_analytics`) — SPEC §7.5. */
export const SPEND_TTL_MS = 15 * 60 * 1000;

/** Código de erro da Meta para "problema na forma de pagamento" (F-4). */
export const PAYMENT_ERROR_CODE = 131042;

/** Teto do `last_error_message` gravado (CHECK da migração 086). */
export const MAX_ERROR_MESSAGE_LENGTH = 500;

const HEALTH_VALUES: readonly WabaHealthValue[] = [
  'AVAILABLE',
  'LIMITED',
  'BLOCKED',
];

// ============================================================
// Utilidades de leitura defensiva
// ============================================================

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Número finito vindo como number ou string numérica; senão `null`. */
function toFiniteNumber(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function toStringOrNull(v: unknown): string | null {
  return typeof v === 'string' && v !== '' ? v : null;
}

/** Normaliza para o vocabulário da Meta, ou `null` se estiver fora dele. */
function toHealthValue(v: unknown): WabaHealthValue | null {
  if (typeof v !== 'string') return null;
  const upper = v.trim().toUpperCase();
  return (HEALTH_VALUES as readonly string[]).includes(upper)
    ? (upper as WabaHealthValue)
    : null;
}

// ============================================================
// health_status
// ============================================================

export interface ParsedHealth {
  /** Moeda do WABA (ISO-4217), ou `null` se a Meta não devolveu. */
  currency: string | null;
  /**
   * `health_status.can_send_message`, ou `null` quando ausente OU fora do
   * vocabulário (a UI mostra `unknown`; nunca inventar um valor).
   */
  overall: WabaHealthValue | null;
  /** Todas as entidades, normalizadas — o que vai para `health_entities`. */
  entities: WabaHealthEntity[];
  /** Só as entidades com `can_send_message` presente e ≠ `AVAILABLE`. */
  problems: WabaHealthEntity[];
  /** Id da entidade `BUSINESS` (só dígitos), para o link do Billing Hub. */
  businessId: string | null;
}

function parseEntity(raw: unknown): WabaHealthEntity | null {
  if (!isRecord(raw)) return null;

  const errors = Array.isArray(raw.errors)
    ? raw.errors.filter(isRecord).map((e) => ({
        error_code: toFiniteNumber(e.error_code),
        error_description: toStringOrNull(e.error_description),
        possible_solution: toStringOrNull(e.possible_solution),
      }))
    : [];

  // O formato exato de `additional_info[]` ainda é a validação V-4 da
  // SPEC: aceita string ou objeto com um texto descritivo.
  const additionalInfo = Array.isArray(raw.additional_info)
    ? raw.additional_info
        .map((item) => {
          if (typeof item === 'string') return item;
          if (isRecord(item)) {
            return (
              toStringOrNull(item.description) ??
              toStringOrNull(item.message) ??
              toStringOrNull(item.title)
            );
          }
          return null;
        })
        .filter((s): s is string => s !== null && s !== '')
    : [];

  return {
    entity_type: toStringOrNull(raw.entity_type) ?? 'UNKNOWN',
    id: toStringOrNull(raw.id),
    can_send_message: toStringOrNull(raw.can_send_message),
    errors,
    additional_info: additionalInfo,
  };
}

/**
 * Interpreta a resposta de `GET /{WABA_ID}?fields=currency,health_status`.
 * Nunca lança: resposta fora do formato vira `overall = null` e listas
 * vazias.
 */
export function parseHealthStatus(raw: unknown): ParsedHealth {
  const body = isRecord(raw) ? raw : {};
  const health = isRecord(body.health_status) ? body.health_status : {};

  const entities = Array.isArray(health.entities)
    ? health.entities
        .map(parseEntity)
        .filter((e): e is WabaHealthEntity => e !== null)
    : [];

  const problems = entities.filter(
    (e) =>
      e.can_send_message !== null &&
      e.can_send_message.trim().toUpperCase() !== 'AVAILABLE'
  );

  // O id vai parar numa URL (D-11): só dígitos, venha o que vier da Meta.
  const business = entities.find(
    (e) => e.entity_type.toUpperCase() === 'BUSINESS'
  );
  const businessId =
    business?.id && /^\d+$/.test(business.id) ? business.id : null;

  const currency = toStringOrNull(body.currency);

  return {
    currency: currency ? currency.toUpperCase() : null,
    overall: toHealthValue(health.can_send_message),
    entities,
    problems,
    businessId,
  };
}

// ============================================================
// pricing_analytics — consumo do mês
// ============================================================

const DAY_SECONDS = 86_400;
const MICRO = 1_000_000;

export interface ParsedSpend {
  /** Dia 1 do mês LOCAL do WABA, `YYYY-MM-DD`. */
  periodStart: string;
  /**
   * Deslocamento do fuso do WABA inferido da resposta (§7.4), em segundos
   * (UTC−3 = −10800). `null` quando nenhum ponto veio: sem dado, não há
   * como inferir.
   */
  tzOffsetSeconds: number | null;
  /**
   * `false` quando algum ponto veio sem `cost` (F-11): o total não é
   * confiável e NUNCA vira zero (RF-04). O volume continua valendo.
   */
  available: boolean;
  /** Total do mês na moeda do WABA; `null` quando `available` é `false`. */
  total: number | null;
  /** Por categoria (valor cru da Meta, em MAIÚSCULAS). */
  byCategory: Record<string, BillingSpendCategory>;
}

/**
 * Deslocamento do fuso a partir do `start` de um ponto diário.
 *
 * Os dias do `pricing_analytics` seguem o fuso do WABA: um `start` pedido
 * como 00:00 UTC voltou como 03:00 UTC num WABA em UTC−3 (F-9). Logo
 * `start mod 86400` é a meia-noite local expressa em UTC, e o
 * deslocamento é o seu negativo, normalizado para [−12 h, +14 h].
 *
 * Os extremos colidem (+13/+14 h leem como −11/−10 h): irrelevante para o
 * público do produto, e a alternativa seria guardar `timezone_id` (V-7).
 */
export function inferTzOffsetSeconds(pointStart: number): number {
  const remainder = ((pointStart % DAY_SECONDS) + DAY_SECONDS) % DAY_SECONDS;
  // `0 - x` e não `-x`: para x = 0, `-x` dá -0 (que vazaria para o banco e
  // para `Object.is`).
  let offset = 0 - remainder;
  if (offset < -12 * 3600) offset += DAY_SECONDS;
  return offset;
}

/** `YYYY-MM` do instante deslocado pelo fuso. */
function localYearMonth(epochSeconds: number, offsetSeconds: number): string {
  return new Date((epochSeconds + offsetSeconds) * 1000)
    .toISOString()
    .slice(0, 7);
}

/**
 * Janela a pedir à Meta para o consumo do mês corrente, em segundos Unix.
 *
 * O fuso do WABA não é conhecido antes da resposta, então o início é
 * deliberadamente largo: dia 1 do mês UTC de `now − 12 h`, menos 1 dia.
 * Isso cobre o início do mês local em qualquer fuso (a folga de 1 dia é
 * maior que os 14 h do pior caso), inclusive na virada em que o mês UTC já
 * mudou e o local não (ou o contrário). O que sobra é descartado por
 * `parsePricingAnalytics`.
 */
export function monthSpendWindow(now: Date): {
  startSeconds: number;
  endSeconds: number;
} {
  const shifted = new Date(now.getTime() - 12 * 3600 * 1000);
  const monthStartUtc = Date.UTC(
    shifted.getUTCFullYear(),
    shifted.getUTCMonth(),
    1
  );
  return {
    startSeconds: Math.floor(monthStartUtc / 1000) - DAY_SECONDS,
    endSeconds: Math.floor(now.getTime() / 1000),
  };
}

interface SpendPoint {
  start: number;
  category: string;
  volume: number;
  /** Em micro-unidades inteiras; `null` = a Meta não informou. */
  costMicro: number | null;
}

function collectPoints(raw: unknown): SpendPoint[] {
  const body = isRecord(raw) ? raw : {};
  const analytics = isRecord(body.pricing_analytics)
    ? body.pricing_analytics
    : body;
  const data = Array.isArray(analytics.data) ? analytics.data : [];

  const points: SpendPoint[] = [];
  for (const entry of data) {
    if (!isRecord(entry) || !Array.isArray(entry.data_points)) continue;
    for (const p of entry.data_points) {
      if (!isRecord(p)) continue;
      const start = toFiniteNumber(p.start);
      if (start === null) continue;
      const cost = toFiniteNumber(p.cost);
      points.push({
        start,
        category: (
          toStringOrNull(p.pricing_category) ?? 'UNCATEGORIZED'
        ).toUpperCase(),
        volume: toFiniteNumber(p.volume) ?? 0,
        // Somar em inteiros: 0.1 + 0.2 em mil pontos não acumula erro.
        costMicro: cost === null ? null : Math.round(cost * MICRO),
      });
    }
  }
  return points.sort((a, b) => a.start - b.start);
}

/**
 * Interpreta a resposta de `pricing_analytics` (granularidade DAILY,
 * dimensão PRICING_CATEGORY) e soma só o mês LOCAL corrente do WABA.
 *
 * O fuso é inferido de cada ponto (a virada de horário de verão muda o
 * deslocamento no meio do mês); o do ponto mais recente define o "agora"
 * local e, portanto, qual é o mês corrente. Sem nenhum ponto, o consumo é
 * zero CONHECIDO (WABA sem uso) e o mês é o UTC.
 */
export function parsePricingAnalytics(raw: unknown, now: Date): ParsedSpend {
  const points = collectPoints(raw);
  const nowSeconds = Math.floor(now.getTime() / 1000);

  const latest = points.length > 0 ? points[points.length - 1] : null;
  const tzOffsetSeconds = latest ? inferTzOffsetSeconds(latest.start) : null;
  const currentMonth = localYearMonth(nowSeconds, tzOffsetSeconds ?? 0);

  const acc = new Map<
    string,
    { volume: number; costMicro: number; costKnown: boolean }
  >();
  let allCostsKnown = true;

  for (const p of points) {
    // Dia local do ponto: data UTC de `start + offset` do próprio ponto.
    const offset = inferTzOffsetSeconds(p.start);
    if (localYearMonth(p.start, offset) !== currentMonth) continue;

    const slot = acc.get(p.category) ?? {
      volume: 0,
      costMicro: 0,
      costKnown: true,
    };
    slot.volume += p.volume;
    if (p.costMicro === null) {
      slot.costKnown = false;
      allCostsKnown = false;
    } else {
      slot.costMicro += p.costMicro;
    }
    acc.set(p.category, slot);
  }

  const byCategory: Record<string, BillingSpendCategory> = {};
  let totalMicro = 0;
  for (const [category, slot] of acc) {
    byCategory[category] = {
      volume: slot.volume,
      cost: slot.costKnown ? slot.costMicro / MICRO : null,
    };
    totalMicro += slot.costMicro;
  }

  return {
    periodStart: `${currentMonth}-01`,
    tzOffsetSeconds,
    available: allCostsKnown,
    total: allCostsKnown ? totalMicro / MICRO : null,
    byCategory,
  };
}

// ============================================================
// Cabeçalho X-Business-Use-Case-Usage (F-13, V-5)
// ============================================================

export interface BusinessUseCaseUsage {
  /** % do limite de chamadas consumido na janela. */
  callCount: number | null;
  /** Minutos até a Meta voltar a aceitar chamadas (0 = já aceita). */
  estimatedMinutesToRegainAccess: number | null;
}

/**
 * Lê o cabeçalho `X-Business-Use-Case-Usage`:
 * `{"<id>":[{"type":"…","call_count":28,"estimated_time_to_regain_access":0}]}`.
 *
 * O cabeçalho pode trazer vários ids e vários tipos de uso. Vale o PIOR
 * caso entre todas as entradas (maior `call_count`, maior tempo de
 * espera): pegar só a primeira entrada diria "0 min" para um WABA que
 * outra entrada já mostra limitado, e o recuo seria curto demais.
 *
 * Devolve `null` se ausente, ilegível ou sem nenhuma entrada — o
 * cabeçalho é ajuda de dimensionamento, nunca requisito.
 */
export function parseBusinessUseCaseUsage(
  header: string | null | undefined
): BusinessUseCaseUsage | null {
  if (!header) return null;
  try {
    const parsed: unknown = JSON.parse(header);
    if (!isRecord(parsed)) return null;

    const calls: number[] = [];
    const waits: number[] = [];
    let entriesSeen = 0;
    for (const entries of Object.values(parsed)) {
      if (!Array.isArray(entries)) continue;
      for (const entry of entries.filter(isRecord)) {
        entriesSeen += 1;
        const call = toFiniteNumber(entry.call_count);
        const wait = toFiniteNumber(entry.estimated_time_to_regain_access);
        if (call !== null) calls.push(call);
        if (wait !== null) waits.push(wait);
      }
    }
    if (entriesSeen === 0) return null;

    return {
      callCount: calls.length > 0 ? Math.max(...calls) : null,
      estimatedMinutesToRegainAccess:
        waits.length > 0 ? Math.max(...waits) : null,
    };
  } catch {
    return null;
  }
}

// ============================================================
// Erros da Graph (SPEC §13.2)
// ============================================================

export interface GraphErrorClass {
  kind: BillingErrorKind;
  code: number | null;
  httpStatus: number | null;
  /** 368/131031/130403: conta restrita por política — vale `blocked`. */
  policyBlocked: boolean;
  /** 131042 numa LEITURA: é o sinal de pagamento, não erro de leitura. */
  paymentSignal: boolean;
  /** Código 100: provável campo/versão errada — pede alerta de log. */
  suspectVersion: boolean;
}

const PERMISSION_CODES = new Set([10, 3, 131005]);
const RATE_LIMIT_CODES = new Set([4, 17, 32, 613, 80007, 80008, 130429]);
const TRANSIENT_CODES = new Set([1, 2, 131000]);
const POLICY_CODES = new Set([368, 131031, 130403]);

/**
 * Classifica o erro de uma leitura da Graph. O CÓDIGO da Meta vence o
 * status HTTP; sem código, vale o status. Qualquer coisa que não seja
 * `MetaApiError` (timeout, rede, JSON ilegível) é transitória.
 *
 * `instanceof` (e não o `name` da classe): um erro com o nome certo e a
 * classe errada, ou o contrário, não pode trocar um 401 por "transitório"
 * e deixar o canal sendo relido para sempre.
 */
export function classifyGraphError(err: unknown): GraphErrorClass {
  const isMeta = err instanceof MetaApiError;
  const status = isMeta ? err.status : null;
  const code = isMeta ? err.code : null;
  const base = {
    code,
    httpStatus: status,
    policyBlocked: false,
    paymentSignal: false,
    suspectVersion: false,
  };

  if (!isMeta) return { ...base, kind: 'transient' };

  if (code === PAYMENT_ERROR_CODE) {
    return { ...base, kind: 'unknown', paymentSignal: true };
  }
  if (code !== null && POLICY_CODES.has(code)) {
    return { ...base, kind: 'unknown', policyBlocked: true };
  }
  if (code === 190 || code === 0) return { ...base, kind: 'auth' };
  if (
    code !== null &&
    (PERMISSION_CODES.has(code) || (code >= 200 && code <= 299))
  ) {
    return { ...base, kind: 'permission' };
  }
  if (code !== null && RATE_LIMIT_CODES.has(code)) {
    return { ...base, kind: 'rate_limit' };
  }
  if (code !== null && TRANSIENT_CODES.has(code)) {
    return { ...base, kind: 'transient' };
  }
  if (code === 100) return { ...base, kind: 'unknown', suspectVersion: true };

  // Sem código conhecido: vale o status HTTP.
  if (status === 401) return { ...base, kind: 'auth' };
  if (status === 403) return { ...base, kind: 'permission' };
  if (status === 429) return { ...base, kind: 'rate_limit' };
  if (status !== null && status >= 500) return { ...base, kind: 'transient' };
  return { ...base, kind: 'unknown' };
}

/**
 * Remove segredos de uma mensagem de erro antes de gravar/logar (§12):
 * `access_token=…`, `Bearer …` e o formato de token da Meta (`EAA…`).
 * Limita ao teto da coluna.
 */
export function sanitizeErrorMessage(message: string): string {
  const cleaned = message
    .replace(/access_token=[^\s&"']+/gi, 'access_token=[redacted]')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(/EAA[A-Za-z0-9]{20,}/g, '[redacted]');
  if (cleaned.length <= MAX_ERROR_MESSAGE_LENGTH) return cleaned;

  // `slice` conta unidades UTF-16: cortar no meio de um par substituto
  // (emoji) deixa um surrogate solitário, que o Postgres/PostgREST recusa
  // (22P05) — e a gravação do erro inteiro falharia junto.
  const last = cleaned.charCodeAt(MAX_ERROR_MESSAGE_LENGTH - 1);
  const splitsPair = last >= 0xd800 && last <= 0xdbff;
  return cleaned.slice(0, MAX_ERROR_MESSAGE_LENGTH - (splitsPair ? 1 : 0));
}

/** Últimos 4 dígitos para log/resposta (§12): `****4821`. */
export function maskId(id: string | null | undefined): string {
  if (!id) return '-';
  return `****${id.slice(-4)}`;
}

// ============================================================
// Cache
// ============================================================

/**
 * O retrato ainda vale e a Meta pode ser poupada? Mesmo formato de
 * `isCacheFresh` (SPEC 044): `checkedAt` ausente, ilegível ou no FUTURO
 * (relógio torto entre app e banco) nunca vale como cache.
 */
export function isFresh(
  checkedAt: string | null | undefined,
  ttlMs: number,
  now: Date = new Date()
): boolean {
  if (!checkedAt) return false;
  const ts = Date.parse(checkedAt);
  if (Number.isNaN(ts)) return false;
  const age = now.getTime() - ts;
  if (age < 0) return false;
  return age < ttlMs;
}

// ============================================================
// Estado principal (SPEC §6)
// ============================================================

export type SendState =
  | 'ok'
  | 'limited'
  | 'blocked'
  | 'payment_blocked'
  | 'auth_error'
  | 'no_credentials'
  | 'unknown';

/** O que `deriveSendState` precisa saber — um recorte da linha do banco. */
export interface SendStateSnapshot {
  /** Canal tem `waba_id` e token? Sem isso, nem se chama a Meta (RF-12). */
  hasCredentials: boolean;
  healthOverall: WabaHealthValue | null;
  healthCheckedAt: string | null;
  /** `payment_blocked_since IS NOT NULL` (§6.3). */
  paymentPending: boolean;
  /**
   * Erro da leitura do STATUS DE ENVIO (`health_error_*`). O erro da
   * leitura do consumo (`spend_error_*`) não entra aqui de propósito: uma
   * falha só do consumo não diz nada sobre se o canal consegue enviar.
   */
  healthErrorKind: BillingErrorKind | null;
  healthErrorAt: string | null;
}

export interface SendStateResult {
  state: SendState;
  /**
   * Falha transitória DEPOIS da última leitura boa: o retrato mostrado é
   * o anterior e a UI diz "não foi possível atualizar agora" (§6.2).
   */
  stale: boolean;
  /** Pagamento pendente, em qualquer estado. */
  paymentPending: boolean;
  /**
   * Pagamento pendente que NÃO é o estado principal porque `auth_error`
   * veio antes na precedência: vira alerta secundário no painel.
   */
  secondaryPaymentAlert: boolean;
}

/**
 * "A leitura do status de envio que falhou ainda não foi superada por uma
 * boa?" Comparação estrita: erro e leitura boa no mesmo instante contam
 * como recuperado.
 */
function errorIsUnrecovered(snapshot: SendStateSnapshot): boolean {
  if (!snapshot.healthErrorAt) return false;
  const errorAt = Date.parse(snapshot.healthErrorAt);
  if (Number.isNaN(errorAt)) return false;
  if (!snapshot.healthCheckedAt) return true;
  const goodAt = Date.parse(snapshot.healthCheckedAt);
  if (Number.isNaN(goodAt)) return true;
  return errorAt > goodAt;
}

/**
 * Um único estado principal por canal, na ordem do §6.2.
 *
 * Falha transitória (5xx, timeout, rede, 429) não muda o estado: mantém
 * o retrato e liga `stale`. Só sem nenhum retrato anterior ela resulta em
 * `unknown` — o que cai naturalmente do passo "qualquer outra coisa".
 */
export function deriveSendState(snapshot: SendStateSnapshot): SendStateResult {
  const paymentPending = snapshot.paymentPending;
  const unrecovered = errorIsUnrecovered(snapshot);
  const result = (
    state: SendState,
    extra: Partial<SendStateResult> = {}
  ): SendStateResult => ({
    state,
    stale: false,
    paymentPending,
    secondaryPaymentAlert: false,
    ...extra,
  });

  // 1. Sem credencial.
  if (!snapshot.hasCredentials) return result('no_credentials');

  // 2. Credencial/permissão recusada e sem leitura boa depois.
  if (
    unrecovered &&
    (snapshot.healthErrorKind === 'auth' ||
      snapshot.healthErrorKind === 'permission')
  ) {
    return result('auth_error', { secondaryPaymentAlert: paymentPending });
  }

  // 3. Pagamento pendente (D-4: independe do health_status).
  if (paymentPending) {
    return result('payment_blocked', { stale: isStale(snapshot, unrecovered) });
  }

  // Erro "desconhecido" (ex.: código 100, campo/versão) sem leitura boa
  // depois: a tabela do §13.2 manda para `unknown`.
  if (unrecovered && snapshot.healthErrorKind === 'unknown') {
    return result('unknown');
  }

  const stale = isStale(snapshot, unrecovered);

  // 4-6. O que o health_status disse.
  switch (snapshot.healthOverall) {
    case 'BLOCKED':
      return result('blocked', { stale });
    case 'LIMITED':
      return result('limited', { stale });
    case 'AVAILABLE':
      return result('ok', { stale });
    default:
      // 7. Nunca houve leitura boa, ou valor fora do vocabulário.
      return result('unknown');
  }
}

/** Transitória/limite de taxa depois de uma leitura boa existente. */
function isStale(snapshot: SendStateSnapshot, unrecovered: boolean): boolean {
  return (
    unrecovered &&
    snapshot.healthCheckedAt !== null &&
    (snapshot.healthErrorKind === 'transient' ||
      snapshot.healthErrorKind === 'rate_limit')
  );
}

// ============================================================
// Webhook de status (SPEC §10.2)
// ============================================================

/** Recorte de `statuses[]` que `readStatus` consome. */
export interface WebhookStatusItem {
  status?: string;
  pricing?: {
    billable?: boolean;
    pricing_model?: string;
    category?: string;
    type?: string;
  };
  errors?: Array<{ code?: number | string }>;
}

export interface ReadStatusResult {
  /** `pricing.billable`, ou `null` quando a Meta não informou. */
  billable: boolean | null;
  /** `pricing.category` em MAIÚSCULAS, ou `null`. */
  category: string | null;
  /** `failed` com erro 131042 — liga o estado de pagamento (RF-07). */
  paymentBlocked: boolean;
}

export function readStatus(item: WebhookStatusItem): ReadStatusResult {
  const pricing = isRecord(item.pricing) ? item.pricing : null;
  const billable =
    pricing && typeof pricing.billable === 'boolean' ? pricing.billable : null;
  const rawCategory = pricing ? toStringOrNull(pricing.category) : null;

  const paymentBlocked =
    item.status === 'failed' &&
    Array.isArray(item.errors) &&
    item.errors.some((e) => toFiniteNumber(e?.code) === PAYMENT_ERROR_CODE);

  return {
    billable,
    category: rawCategory ? rawCategory.toUpperCase() : null,
    paymentBlocked,
  };
}
