/**
 * Resolução de limite efetivo: override da conta > plano > ausente.
 * Espelha `account_effective_limits`/`plan_limit` da migração 067 —
 * mesma precedência, do lado do TypeScript, para a UI antecipar sem
 * round-trip.
 */

import type { PlanLimits, PlanOverrides, QuotaKey } from './types';

/**
 * `null` = ilimitado (chave ausente nos dois níveis — D-3). `0` é um
 * valor explícito ("bloqueado"), nunca tratado como ausente.
 */
export function resolveLimit(
  limits: PlanLimits,
  overrides: PlanOverrides,
  key: QuotaKey
): number | null {
  const overrideValue = overrides[key];
  if (overrideValue !== undefined) return overrideValue;

  const planValue = limits[key];
  return planValue === undefined ? null : planValue;
}

export function isUnlimited(value: number | null): boolean {
  return value === null;
}

export function isBlocked(value: number | null): boolean {
  return value === 0;
}

/** Override vence — mesma semântica do `||` de JSONB no banco. */
export function mergeLimits(
  limits: PlanLimits,
  overrides: PlanOverrides
): PlanLimits {
  return { ...limits, ...(overrides as PlanLimits) };
}
