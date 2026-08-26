/**
 * Validação do catálogo (plans.limits/plans.features) contra `types.ts`
 * — o teste de contrato que compensa o JSONB sem CHECK no banco
 * (migração 067 §2.2). Chave desconhecida em `limits` ou `features` é
 * erro: normalmente sinal de um typo no seed comercial
 * (`supabase/setup/plans-seed.sql`) que passaria silenciosamente batido
 * pelo Postgres.
 */

import {
  FEATURE_KEYS,
  QUOTA_KEYS,
  type FeatureKey,
  type QuotaKey,
} from './types';

export interface CatalogValidationError {
  planCode: string;
  field: 'limits' | 'features';
  key: string;
}

export interface CatalogPlanInput {
  code: string;
  limits: Record<string, unknown>;
  features: Record<string, unknown>;
}

const QUOTA_KEY_SET: ReadonlySet<string> = new Set(QUOTA_KEYS);
const FEATURE_KEY_SET: ReadonlySet<string> = new Set(FEATURE_KEYS);

export function isQuotaKey(key: string): key is QuotaKey {
  return QUOTA_KEY_SET.has(key);
}

export function isFeatureKey(key: string): key is FeatureKey {
  return FEATURE_KEY_SET.has(key);
}

export function validateCatalog(
  plans: CatalogPlanInput[]
): CatalogValidationError[] {
  const errors: CatalogValidationError[] = [];

  for (const plan of plans) {
    for (const key of Object.keys(plan.limits)) {
      if (!isQuotaKey(key)) {
        errors.push({ planCode: plan.code, field: 'limits', key });
      }
    }
    for (const key of Object.keys(plan.features)) {
      if (!isFeatureKey(key)) {
        errors.push({ planCode: plan.code, field: 'features', key });
      }
    }
  }

  return errors;
}

export interface OverridesValidationError {
  key: string;
  reason: 'unknown_key' | 'wrong_type';
}

/**
 * Valida `account_plans.limit_overrides` — um único objeto que mistura
 * quotas numéricas e recursos booleanos (ao contrário de `plans.limits`/
 * `plans.features`, que são dois objetos separados). Usado pela rota de
 * operador que grava overrides por conta: sem isto, um valor errado
 * (ex. `{"contacts": "unlimited"}`) só falha depois, com um erro de
 * cast cru do Postgres no próximo INSERT de contato dessa conta
 * (`plan_limit()` faz `... ->> key)::INTEGER`) — achado de code review.
 */
export function validateOverrides(
  overrides: Record<string, unknown>
): OverridesValidationError[] {
  const errors: OverridesValidationError[] = [];

  for (const [key, value] of Object.entries(overrides)) {
    if (isQuotaKey(key)) {
      if (typeof value !== 'number' || !Number.isInteger(value)) {
        errors.push({ key, reason: 'wrong_type' });
      }
    } else if (isFeatureKey(key)) {
      if (typeof value !== 'boolean') {
        errors.push({ key, reason: 'wrong_type' });
      }
    } else {
      errors.push({ key, reason: 'unknown_key' });
    }
  }

  return errors;
}
