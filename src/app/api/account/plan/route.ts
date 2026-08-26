// ============================================================
// GET /api/account/plan
//
//   Qualquer membro pode ver o próprio plano (SPEC 059 §6). Devolve:
//   quotasEnforced, plan (efetivo, com limites já mesclados), usage
//   (barras por quota), catálogo público (para a página de planos) e
//   a solicitação de troca pendente, se houver e o chamador for admin+
//   (RLS de plan_change_requests já restringe a leitura a admin+ —
//   um viewer recebe pendingRequest: null sem round-trip extra).
//
// Dashboard-facing: cookie session auth via `getCurrentAccount`,
// cliente RLS-scoped — não é o envelope de /api/v1/**.
// ============================================================

import { NextResponse } from 'next/server';

import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account';
import { getAccountPlan } from '@/lib/plans/account-plan';

export async function GET() {
  try {
    const ctx = await getCurrentAccount();
    const snapshot = await getAccountPlan(ctx.accountId);

    const [{ data: catalog }, { data: pendingRequest }] = await Promise.all([
      ctx.supabase
        .from('plans')
        .select(
          'id, code, name, description, price_cents, currency, billing_period, limits, features, sort_order'
        )
        .eq('is_active', true)
        .eq('is_public', true)
        .order('sort_order', { ascending: true }),
      ctx.supabase
        .from('plan_change_requests')
        .select('id, requested_plan_id, status, message, created_at')
        .eq('account_id', ctx.accountId)
        .eq('status', 'pending')
        .maybeSingle(),
    ]);

    return NextResponse.json({
      quotasEnforced: snapshot.quotasEnforced,
      plan: snapshot.plan,
      accountPlan: snapshot.accountPlan,
      usage: snapshot.usage,
      catalog: (catalog ?? []).map((row) => ({
        id: row.id,
        code: row.code,
        name: row.name,
        description: row.description,
        priceCents: row.price_cents,
        currency: row.currency,
        billingPeriod: row.billing_period,
        limits: row.limits,
        features: row.features,
        sortOrder: row.sort_order,
      })),
      pendingRequest: pendingRequest
        ? {
            id: pendingRequest.id,
            requestedPlanId: pendingRequest.requested_plan_id,
            status: pendingRequest.status,
            message: pendingRequest.message,
            createdAt: pendingRequest.created_at,
          }
        : null,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
