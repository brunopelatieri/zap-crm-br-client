/**
 * Decisão de pré-checagem: "essa criação pode acontecer?" Espelha a
 * forma de `checkInstanceLimit` (src/lib/evolution/limits.ts) e
 * `evaluateColdSend` (src/lib/channels/cold-send-limit.ts) — mesmo
 * tipo de decisão, mesmo padrão de módulo puro.
 *
 * Este é o ANTECIPADOR (TypeScript). A palavra final é sempre a
 * trigger/RPC no banco — este gate só evita o round-trip de "colar
 * 500 linhas e descobrir o erro depois".
 */

export interface QuotaGateInput {
  /** `null` = ilimitado. */
  limit: number | null;
  used: number;
  /** Quantas unidades esta operação pretende consumir (>1 para lote). */
  requested: number;
}

export interface QuotaGateDecision {
  allowed: boolean;
  reason?: 'quota_exceeded';
  limit: number | null;
  used: number;
  /** Vagas livres antes desta operação; `null` quando ilimitado. */
  remaining: number | null;
}

export function checkQuota({
  limit,
  used,
  requested,
}: QuotaGateInput): QuotaGateDecision {
  if (limit === null) {
    return { allowed: true, limit, used, remaining: null };
  }

  const remainingSlots = Math.max(0, limit - used);

  if (used + requested > limit) {
    return {
      allowed: false,
      reason: 'quota_exceeded',
      limit,
      used,
      remaining: remainingSlots,
    };
  }

  return { allowed: true, limit, used, remaining: remainingSlots };
}
