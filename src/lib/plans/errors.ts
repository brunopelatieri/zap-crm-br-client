/**
 * Ponte entre o erro que o Postgres devolve e algo que o app consegue
 * traduzir. `enforce_contact_quota()` (migração 067 §9) e as checagens
 * dentro de `redeem_invitation`/`set_member_role` (§12) levantam
 * exceções no formato:
 *
 *   QUOTA_EXCEEDED:<metric>:<used>:<limit>
 *
 * O PostgREST expõe essa string em `error.message` (`.code` vira
 * `P0001` ou `22023`, sem o detalhe). `parseQuotaError` reconhece o
 * formato em qualquer coisa que carregue um `.message` (PostgrestError,
 * Error comum, string crua) — mudou o formato de um lado, muda dos
 * dois.
 */

import type { QuotaKey } from './types';

export interface QuotaError {
  /** `QuotaKey`, ou `members_<role>` — métricas de papel não estão na união fechada. */
  metric: string;
  used: number;
  limit: number;
}

const QUOTA_ERROR_PATTERN = /QUOTA_EXCEEDED:([a-zA-Z0-9_]+):(-?\d+):(-?\d+)/;

export function parseQuotaError(err: unknown): QuotaError | null {
  const message = extractMessage(err);
  if (!message) return null;

  const match = QUOTA_ERROR_PATTERN.exec(message);
  if (!match) return null;

  return {
    metric: match[1],
    used: Number(match[2]),
    limit: Number(match[3]),
  };
}

export function formatQuotaError(error: QuotaError): string {
  return `QUOTA_EXCEEDED:${error.metric}:${error.used}:${error.limit}`;
}

export function isContactQuotaError(err: unknown): boolean {
  const parsed = parseQuotaError(err);
  return parsed !== null && (parsed.metric as QuotaKey) === 'contacts';
}

function extractMessage(err: unknown): string | null {
  if (typeof err === 'string') return err;
  if (
    err &&
    typeof err === 'object' &&
    'message' in err &&
    typeof (err as { message?: unknown }).message === 'string'
  ) {
    return (err as { message: string }).message;
  }
  return null;
}
