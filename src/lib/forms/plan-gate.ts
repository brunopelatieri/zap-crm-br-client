// ============================================================
// Guarda de plano dos formulários — lado da conta (PRD 084 D-10/D-11,
// SPEC 085 §5.3). Cópia adaptada de `contact-portal/plan-gate.ts`.
//
// `forms_enabled` é lida por `plan_feature_strict()` (migração 096):
// chave ausente é FALSE, `quotas_enforced` não é consultado e conta sem
// `account_plans` é FALSE. A MESMA função que `form_public_availability`
// (098) usa do lado do visitante — rota, barra lateral e página pública
// enxergam uma decisão só. `limit_overrides.forms_enabled = true` é o
// caminho da conta piloto.
//
// Fail-closed também na falha: RPC ausente (096 não aplicada) ou erro →
// "não está no plano", com `console.error` sem a conta no log.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import { ForbiddenError } from '@/lib/auth/account';
import type { FeatureKey } from '@/lib/plans/types';

import { supabaseAdmin } from './admin-client';

/** Código do 403 das rotas `/api/forms/*` (SPEC 085 §7.1). */
export const FEATURE_NOT_IN_PLAN = 'FEATURE_NOT_IN_PLAN';

export const FORMS_FEATURE_KEY = 'forms_enabled' as const satisfies FeatureKey;

type Db = Pick<SupabaseClient, 'rpc'>;

export async function hasFormsFeature(
  accountId: string,
  db: Db = supabaseAdmin()
): Promise<boolean> {
  const { data, error } = await db.rpc('plan_feature_strict', {
    p_account_id: accountId,
    p_key: FORMS_FEATURE_KEY,
  });
  if (error) {
    console.error(
      '[forms] plan_feature_strict failed:',
      (error as { code?: string }).code ?? 'unknown'
    );
    return false;
  }
  return data === true;
}

/**
 * Para as rotas da conta, logo depois de `requireRole(min)`: lança
 * `ForbiddenError('FEATURE_NOT_IN_PLAN')` → `403 { error: 'FEATURE_NOT_IN_PLAN' }`.
 * Exceção: `GET /api/forms` responde `200 { featureInPlan: false, forms: [] }`
 * e usa `hasFormsFeature` direto (SPEC §5.3).
 */
export async function requireFormsFeature(
  accountId: string,
  db?: Db
): Promise<void> {
  if (!(await hasFormsFeature(accountId, db))) {
    throw new ForbiddenError(FEATURE_NOT_IN_PLAN);
  }
}
