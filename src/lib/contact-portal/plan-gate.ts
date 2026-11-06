// ============================================================
// Guarda de plano da área do contato — lado da conta (SPEC 083 §8.4,
// PRD 082 D-2 e D-4).
//
// `contact_portal_enabled` é a primeira chave de recurso que BLOQUEIA de
// verdade uma rota. A decisão vem do banco, por `plan_feature_strict()`
// (migração 096): chave ausente é FALSE, `quotas_enforced` não é
// consultado e conta sem `account_plans` é FALSE. É a mesma função que
// `contact_portal.account_is_eligible` usa do lado do contato, então a
// aba, a ficha, as rotas e a área enxergam uma decisão só.
//
// Por que não `useAccountPlan().plan.features` no cliente: o cliente não
// vê `limit_overrides` (a exceção por conta do console), e a UI nunca é
// a guarda — a rota é. Por que não `plan_feature()` da 067: ela devolve
// TRUE para chave ausente e com quotas desligadas (PRD 082 D-2).
//
// Fail-closed também na falha: se a RPC não existir (096 ainda não
// aplicada) ou errar, a resposta é "não está no plano", com `console.error`
// para o diagnóstico. Uma porta de login que abre por erro de leitura é
// pior do que uma que fecha.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import { ForbiddenError } from '@/lib/auth/account';
import type { FeatureKey } from '@/lib/plans/types';

import { portalDb } from './service';

/** Código do 403 das rotas `/api/contact-portal/*` (SPEC 083 E-10). */
export const FEATURE_NOT_IN_PLAN = 'FEATURE_NOT_IN_PLAN';

/** A chave de `FEATURE_KEYS` que libera a porta — e só ela (PRD 082 D-5). */
export const CONTACT_PORTAL_FEATURE_KEY =
  'contact_portal_enabled' as const satisfies FeatureKey;

type Db = Pick<SupabaseClient, 'rpc'>;

/**
 * A conta tem `contact_portal_enabled` no plano (ou na exceção por conta)?
 * Lê `plan_feature_strict` com `service_role` — a função só concede
 * EXECUTE a esse papel. Qualquer coisa que não seja `true` é `false`.
 */
export async function hasContactPortalFeature(
  accountId: string,
  db: Db = portalDb()
): Promise<boolean> {
  const { data, error } = await db.rpc('plan_feature_strict', {
    p_account_id: accountId,
    p_key: CONTACT_PORTAL_FEATURE_KEY,
  });
  if (error) {
    console.error(
      '[contact-portal] plan_feature_strict failed:',
      (error as { code?: string }).code ?? 'unknown'
    );
    return false;
  }
  return data === true;
}

/**
 * Para as rotas da conta, logo depois de `requireRole(min)`: lança
 * `ForbiddenError('FEATURE_NOT_IN_PLAN')`, que `toErrorResponse` vira
 * `403 { error: 'FEATURE_NOT_IN_PLAN' }` (mensagem em inglês, como toda
 * `/api/**`; a UI traduz).
 */
export async function requireContactPortalFeature(
  accountId: string,
  db?: Db
): Promise<void> {
  if (!(await hasContactPortalFeature(accountId, db))) {
    throw new ForbiddenError(FEATURE_NOT_IN_PLAN);
  }
}
