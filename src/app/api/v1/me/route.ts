// ============================================================
// GET /api/v1/me — public API identity probe.
//
// The reference endpoint for the public API: it requires nothing
// but a valid key (no scope), and returns the account the key is
// bound to plus the scopes it carries. Integrators use it to verify
// their key works and to discover what it's allowed to do before
// wiring up real calls.
//
// It also exercises the entire public-API stack end to end — bearer
// parse → hash lookup → liveness → rate limit → envelope — so a
// green response here means the plumbing every future endpoint
// depends on is sound.
// ============================================================

import { requireApiKey } from '@/lib/auth/api-context';
import { getAccountName } from '@/lib/api-keys/store';
import { ok, toApiErrorResponse } from '@/lib/api/v1/respond';
import { getAccountPlan } from '@/lib/plans/account-plan';

export async function GET(request: Request) {
  try {
    const ctx = await requireApiKey(request);
    const name = await getAccountName(ctx.accountId);

    // SPEC 059 §8.2: bloco de plano/uso — integrações checam antes de
    // despejar 10.000 contatos em vez de descobrir pelo 403. Best-effort:
    // /api/v1/me é o endpoint de referência ("minha chave funciona?") e
    // não pode virar 500 por causa de um problema no motor de quotas.
    let plan: {
      code: string;
      name: string;
      status: string;
      billingCycle: string;
      startedAt: string;
      currentPeriodEnd: string | null;
      cancelAtPeriodEnd: boolean;
    } | null = null;
    let usage: { key: string; used: number; limit: number | null }[] = [];
    try {
      const snapshot = await getAccountPlan(ctx.accountId, ctx.supabase);
      plan = {
        code: snapshot.plan.code,
        name: snapshot.plan.name,
        status: snapshot.accountPlan.status,
        // SPEC 062 §9 — uma integração que provisiona recursos precisa
        // saber QUANDO o acesso vence, não só o código do plano.
        billingCycle: snapshot.accountPlan.billingCycle,
        startedAt: snapshot.accountPlan.startedAt,
        currentPeriodEnd: snapshot.accountPlan.currentPeriodEnd,
        cancelAtPeriodEnd: snapshot.accountPlan.cancelAtPeriodEnd,
      };
      usage = snapshot.quotasEnforced
        ? snapshot.usage.buckets.map((b) => ({
            key: b.key,
            used: b.used,
            limit: b.limit,
          }))
        : [];
    } catch (err) {
      console.error('[api/v1/me] failed to load account plan:', err);
    }

    return ok({
      account: { id: ctx.accountId, name },
      key: { id: ctx.keyId, scopes: ctx.scopes },
      plan,
      usage,
    });
  } catch (err) {
    return toApiErrorResponse(err);
  }
}
