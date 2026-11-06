// ============================================================
// Quotas dos formulários — lado TypeScript (PRD 084 D-10, SPEC 085 §5.2).
//
// O banco decide (triggers e funções da 098); aqui ficam as chaves de
// métrica, a virada de mês e a tradução do erro. Os literais abaixo são
// CONTRATO com a 098 (`form_month_metric`, `enforce_form_quota`,
// `form_upload_quota_state`): mudou de um lado, muda dos dois.
// ============================================================

import { parseQuotaError, type QuotaError } from '@/lib/plans/errors';
import type { PlanUsage, PlanUsageBucket } from '@/lib/plans/types';

export const FORMS_METRIC = 'forms';
export const FORM_UPLOAD_BYTES_METRIC = 'form_upload_bytes';
export const FORM_RESPONSES_METRIC_PREFIX = 'form_responses:';

/** Fuso do contador mensal — o mesmo da `form_month_metric()` (098). */
export const FORMS_QUOTA_TIMEZONE = 'America/Sao_Paulo';

export const BYTES_PER_MB = 1024 * 1024;

/**
 * `form_responses:YYYY-MM` do instante `now` no fuso dado. Uma resposta
 * às 23:59:59 de 30/11 em São Paulo conta em `2026-11`; às 00:00:00 de
 * 01/12, em `2026-12` — ainda que em UTC já seja (ou ainda não seja) o
 * dia seguinte (SPEC 085 §12.1 item 9).
 */
export function monthMetricKey(
  now: Date,
  timeZone: string = FORMS_QUOTA_TIMEZONE
): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
  }).formatToParts(now);
  const year = parts.find((p) => p.type === 'year')?.value ?? '0000';
  const month = parts.find((p) => p.type === 'month')?.value ?? '00';
  return `${FORM_RESPONSES_METRIC_PREFIX}${year}-${month}`;
}

export function bytesToMbCeil(bytes: number): number {
  if (!Number.isFinite(bytes) || bytes <= 0) return 0;
  return Math.ceil(bytes / BYTES_PER_MB);
}

export function mbToBytes(mb: number | null): number | null {
  if (mb === null || !Number.isFinite(mb)) return null;
  return Math.max(0, Math.floor(mb)) * BYTES_PER_MB;
}

/** `QUOTA_EXCEEDED:forms:…` vindo da trigger `enforce_form_quota` (098). */
export function parseFormsQuotaError(err: unknown): QuotaError | null {
  const parsed = parseQuotaError(err);
  return parsed && parsed.metric === FORMS_METRIC ? parsed : null;
}

export function isFormsQuotaError(err: unknown): boolean {
  return parseFormsQuotaError(err) !== null;
}

export interface QuotaRoom {
  used: number;
  /** `null` = ilimitado. */
  limit: number | null;
  /** Há vaga para mais UM? (`0` = bloqueado, PRD 058 D-3.) */
  available: boolean;
}

/**
 * Vaga para criar/desarquivar um formulário a partir do snapshot de uso
 * (`getAccountPlan().usage`). É a PRÉ-checagem da UI/rota; a decisão
 * final é da trigger (SPEC 059 §1). Bucket ausente = ilimitado.
 */
export function checkFormsAvailableQuota(usage: PlanUsage): QuotaRoom {
  const bucket = usage.buckets.find((b) => b.key === FORMS_METRIC);
  return roomFromBucket(bucket);
}

export function roomFromBucket(bucket: PlanUsageBucket | undefined): QuotaRoom {
  if (!bucket) return { used: 0, limit: null, available: true };
  return {
    used: bucket.used,
    limit: bucket.limit,
    available: bucket.limit === null || bucket.used < bucket.limit,
  };
}

/** Linha de `form_month_quota_state(account)` (098). */
export interface MonthQuotaState {
  used: number;
  limit: number | null;
}

export function monthQuotaHasRoom(state: MonthQuotaState): boolean {
  return state.limit === null || state.used < state.limit;
}

/** Linha de `form_upload_quota_state(account)` (098). */
export interface UploadQuotaState {
  usedBytes: number;
  limitBytes: number | null;
}

/** Cabe mais `declaredBytes`? (Com folga para o tamanho declarado, §7.2.) */
export function uploadQuotaHasRoom(
  state: UploadQuotaState,
  declaredBytes: number
): boolean {
  if (state.limitBytes === null) return true;
  return state.usedBytes + Math.max(0, declaredBytes) <= state.limitBytes;
}

/** Converte a linha crua da RPC (snake_case, `string | number`) no tipo acima. */
export function parseUploadQuotaRow(
  row: { used_bytes?: unknown; limit_bytes?: unknown } | null | undefined
): UploadQuotaState {
  const used = Number(row?.used_bytes ?? 0);
  const limitRaw = row?.limit_bytes;
  const limit =
    limitRaw === null || limitRaw === undefined ? null : Number(limitRaw);
  return {
    usedBytes: Number.isFinite(used) ? used : 0,
    limitBytes: limit !== null && Number.isFinite(limit) ? limit : null,
  };
}

export function parseMonthQuotaRow(
  row: { used?: unknown; limit?: unknown } | null | undefined
): MonthQuotaState {
  const used = Number(row?.used ?? 0);
  const limitRaw = row?.limit;
  const limit =
    limitRaw === null || limitRaw === undefined ? null : Number(limitRaw);
  return {
    used: Number.isFinite(used) ? used : 0,
    limit: limit !== null && Number.isFinite(limit) ? limit : null,
  };
}
