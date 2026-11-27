// ============================================================
// Portão de plano da IA (SPEC 089 D-20): `ai_enabled` em modo ESTRITO.
//
// `plan_feature_strict()` (migração 096): chave ausente = FALSE, conta sem
// `account_plans` = FALSE. Só `service_role` executa (anon e authenticated
// sem EXECUTE), então a leitura usa `supabaseAdmin()` — mesmo padrão de
// `src/lib/forms/plan-gate.ts`. Fail-closed na falha: RPC ausente ou erro
// = "não está no plano".
//
// ⚠️ ORDEM OBRIGATÓRIA (D-20): primeiro o DADO (todo plano e as contas
// com IA ganham `ai_enabled`, SQL do §3.1 de `spec-089-f0-medicoes.md`),
// só então o CÓDIGO que lê a chave. Em 2026-11-26 o dado ainda não estava
// no `vn` (vn_personal e unlimited sem a chave), então este módulo existe
// e é testado, mas NÃO está ligado ao auto-reply nem às rotas. Ligar =
// chamar `hasAiFeature` / `requireAiFeature` nos pontos da F1 do §5.1,
// depois da checagem de conta bloqueada.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import { ForbiddenError } from '@/lib/auth/account';
import type { FeatureKey } from '@/lib/plans/types';

import { supabaseAdmin } from './admin-client';

/** Código do 403 das rotas `/api/ai/*` (mesmo das `/api/forms/*`). */
export const AI_FEATURE_NOT_IN_PLAN = 'FEATURE_NOT_IN_PLAN';

export const AI_FEATURE_KEY = 'ai_enabled' as const satisfies FeatureKey;

type Db = Pick<SupabaseClient, 'rpc'>;

export async function hasAiFeature(
  accountId: string,
  db: Db = supabaseAdmin()
): Promise<boolean> {
  const { data, error } = await db.rpc('plan_feature_strict', {
    p_account_id: accountId,
    p_key: AI_FEATURE_KEY,
  });
  if (error) {
    console.error(
      '[ai] plan_feature_strict failed:',
      (error as { code?: string }).code ?? 'unknown'
    );
    return false;
  }
  return data === true;
}

/** Para as rotas, logo depois de `requireRole`/`getCurrentAccount`:
 *  lança `ForbiddenError('FEATURE_NOT_IN_PLAN')` → 403. */
export async function requireAiFeature(
  accountId: string,
  db?: Db
): Promise<void> {
  if (!(await hasAiFeature(accountId, db))) {
    throw new ForbiddenError(AI_FEATURE_NOT_IN_PLAN);
  }
}
