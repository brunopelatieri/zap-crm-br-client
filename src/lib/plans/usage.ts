/**
 * Leitura de uso contra limite — para barras de progresso e avisos.
 * Módulo puro: recebe uso e limite já lidos, decide o estado.
 */

import type { UsageBucketStatus } from './types';

/** Limiar de aviso (80%) — abaixo disso o bucket é 'ok'. */
const WARN_THRESHOLD = 0.8;

/** `null` (limite ilimitado) devolve `null` — não há "restante" a mostrar. */
export function remaining(used: number, limit: number | null): number | null {
  if (limit === null) return null;
  return Math.max(0, limit - used);
}

/** `null` quando o limite é ilimitado ou zero — divisão por zero nunca estoura aqui. */
export function ratio(used: number, limit: number | null): number | null {
  if (limit === null || limit === 0) return null;
  return used / limit;
}

export function bucketStatus(
  used: number,
  limit: number | null
): UsageBucketStatus {
  if (limit === null) return 'ok';
  if (used > limit) return 'over';
  if (used === limit) return 'full';

  const r = ratio(used, limit);
  if (r !== null && r >= WARN_THRESHOLD) return 'warn';
  return 'ok';
}

export function overageAmount(used: number, limit: number | null): number {
  if (limit === null) return 0;
  return Math.max(0, used - limit);
}
