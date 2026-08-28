// ============================================================
// POST /api/account/plan/change — autosserviço de ciclo/plano
// (SPEC 062 §6.1, D-3, F8)
//
//   admin+ troca de plano/ciclo NA HORA — só para plano público e
//   ativo, e só com `platform_settings.self_service_enabled` ligado
//   (§7.1). Sem passar pela fila de `plan_change_requests` da SPEC 059
//   §6: aquela fila continua existindo em
//   `/api/account/plan/request`, mas só entra em jogo quando o plano
//   NÃO é público (D-3) ou quando o autosserviço está desligado.
//
// A lógica em si (validar, recalcular started_at/current_period_end,
// gravar account_plan_events) mora em `@/lib/plans/self-service.ts` —
// esta rota só resolve QUEM está chamando e traduz o resultado.
// ============================================================

import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { applyPlanChange } from '@/lib/plans/self-service';
import type { BillingCycle } from '@/lib/plans/billing';

function isBillingCycle(value: unknown): value is BillingCycle {
  return value === 'monthly' || value === 'yearly';
}

export async function POST(request: Request) {
  try {
    const ctx = await requireRole('admin');

    const body = (await request.json().catch(() => null)) as {
      planId?: unknown;
      billingCycle?: unknown;
    } | null;

    if (!body || typeof body.planId !== 'string' || body.planId === '') {
      return NextResponse.json(
        { error: "'planId' is required" },
        { status: 400 }
      );
    }
    if (!isBillingCycle(body.billingCycle)) {
      return NextResponse.json(
        { error: "'billingCycle' must be 'monthly' or 'yearly'" },
        { status: 400 }
      );
    }

    const {
      data: { user },
    } = await ctx.supabase.auth.getUser();
    const actor = `self-service:${user?.email ?? ctx.userId}`;

    const result = await applyPlanChange(supabaseAdmin(), {
      accountId: ctx.accountId,
      planId: body.planId,
      billingCycle: body.billingCycle,
      actor,
    });

    if (!result.ok) {
      if (result.error === 'self_service_disabled') {
        return NextResponse.json(
          {
            error: 'Self-service plan changes are disabled',
            code: result.error,
          },
          { status: 403 }
        );
      }
      if (result.error === 'plan_not_available') {
        return NextResponse.json(
          { error: 'Plan not found or not available', code: result.error },
          { status: 404 }
        );
      }
      if (result.error === 'account_not_found') {
        return NextResponse.json(
          { error: 'Account has no plan assigned', code: result.error },
          { status: 404 }
        );
      }
      if (result.error === 'account_past_due') {
        return NextResponse.json(
          {
            error:
              'This account is past due; contact support to settle billing before changing plans',
            code: result.error,
          },
          { status: 409 }
        );
      }
      return NextResponse.json(
        { error: 'Failed to change plan', code: result.error },
        { status: 500 }
      );
    }

    return NextResponse.json({ accountPlan: result.accountPlan });
  } catch (err) {
    return toErrorResponse(err);
  }
}
