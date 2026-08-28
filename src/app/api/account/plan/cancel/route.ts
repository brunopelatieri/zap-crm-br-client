// ============================================================
// /api/account/plan/cancel — agendar/reverter cancelamento
// (SPEC 062 §6.1, §7.6, F8)
//
//   POST   — agenda `cancel_at_period_end = true`. O acesso continua
//            até o fim do período atual (D-7: vencimento não bloqueia
//            sozinho) — quem efetiva a troca para o plano padrão é
//            `lifecycle.ts` (§8), na F9.
//   DELETE — reverte antes de o período acabar.
// ============================================================

import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { setCancelAtPeriodEnd } from '@/lib/plans/self-service';

function toResponse(
  result: Awaited<ReturnType<typeof setCancelAtPeriodEnd>>
): NextResponse {
  if (result.ok) {
    return NextResponse.json({ cancelAtPeriodEnd: result.cancelAtPeriodEnd });
  }
  if (result.error === 'self_service_disabled') {
    return NextResponse.json(
      { error: 'Self-service plan changes are disabled', code: result.error },
      { status: 403 }
    );
  }
  if (result.error === 'account_not_found') {
    return NextResponse.json(
      { error: 'Account has no plan assigned', code: result.error },
      { status: 404 }
    );
  }
  if (result.error === 'no_period_end') {
    return NextResponse.json(
      {
        error: 'This plan has no billing period to cancel',
        code: result.error,
      },
      { status: 400 }
    );
  }
  return NextResponse.json(
    { error: 'Failed to update cancellation', code: result.error },
    { status: 500 }
  );
}

async function actorFor(ctx: Awaited<ReturnType<typeof requireRole>>) {
  const {
    data: { user },
  } = await ctx.supabase.auth.getUser();
  return `self-service:${user?.email ?? ctx.userId}`;
}

export async function POST() {
  try {
    const ctx = await requireRole('admin');
    const result = await setCancelAtPeriodEnd(
      supabaseAdmin(),
      ctx.accountId,
      true,
      new Date(),
      await actorFor(ctx)
    );
    return toResponse(result);
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function DELETE() {
  try {
    const ctx = await requireRole('admin');
    const result = await setCancelAtPeriodEnd(
      supabaseAdmin(),
      ctx.accountId,
      false,
      new Date(),
      await actorFor(ctx)
    );
    return toResponse(result);
  } catch (err) {
    return toErrorResponse(err);
  }
}
