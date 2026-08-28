// ============================================================
// /api/admin/accounts/[accountId]/plan — SPEC 059 §6, D-9
//
//   GET — plano/status/overrides atuais da conta + histórico recente.
//   PUT — troca o plano, status e/ou overrides. É AQUI que a
//         "solicitação" de D-8 vira realidade: o operador confirma o
//         pagamento fora do sistema e chama esta rota. Toda troca
//         grava uma linha em account_plan_events (histórico
//         append-only, sem policy de escrita pelo cliente).
//
// Protegida por PLATFORM_ADMIN_SECRET — ver src/lib/auth/platform-admin.ts.
// ============================================================

import { NextResponse } from 'next/server';

import { requirePlatformAdminSecret } from '@/lib/auth/platform-admin';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { changeAccountPlan } from '@/lib/platform/plan-actions';
import type { AccountPlanStatus } from '@/lib/plans/types';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ accountId: string }> }
) {
  const denied = requirePlatformAdminSecret(request);
  if (denied) return denied;
  const { accountId } = await params;

  const db = supabaseAdmin();

  const [{ data: accountPlan, error }, { data: events }] = await Promise.all([
    db
      .from('account_plans')
      .select(
        'account_id, plan_id, status, trial_ends_at, current_period_end, limit_overrides, note, updated_by, updated_at, plans:plan_id (code, name)'
      )
      .eq('account_id', accountId)
      .maybeSingle(),
    db
      .from('account_plan_events')
      .select(
        'id, from_plan_code, to_plan_code, from_status, to_status, overrides_after, actor, reason, created_at'
      )
      .eq('account_id', accountId)
      .order('created_at', { ascending: false })
      .limit(20),
  ]);

  if (error) {
    console.error(
      '[GET /api/admin/accounts/[accountId]/plan] fetch error:',
      error
    );
    return NextResponse.json(
      { error: 'Failed to load account plan' },
      { status: 500 }
    );
  }
  if (!accountPlan) {
    return NextResponse.json(
      { error: 'Account has no plan assigned' },
      { status: 404 }
    );
  }

  return NextResponse.json({ accountPlan, events: events ?? [] });
}

interface PlanPutBody {
  planCode?: unknown;
  status?: unknown;
  limitOverrides?: unknown;
  note?: unknown;
  actor?: unknown;
  reason?: unknown;
}

// SPEC 062 F6: a lógica de troca em si mora em
// `@/lib/platform/plan-actions` (`changeAccountPlan`) — a mesma função
// que `PUT /api/platform/accounts/[accountId]/plan` chama. Esta rota
// só faz a validação de forma do corpo (que já existia aqui) e traduz
// o resultado de volta para o formato snake_case que os integradores
// desta rota já recebem — trocar isso quebraria contrato sem aviso.
export async function PUT(
  request: Request,
  { params }: { params: Promise<{ accountId: string }> }
) {
  const denied = requirePlatformAdminSecret(request);
  if (denied) return denied;
  const { accountId } = await params;

  const body = (await request.json().catch(() => null)) as PlanPutBody | null;
  if (!body || typeof body.actor !== 'string' || body.actor.trim() === '') {
    return NextResponse.json(
      { error: "'actor' is required (who is making this change)" },
      { status: 400 }
    );
  }

  const overrides =
    body.limitOverrides && typeof body.limitOverrides === 'object'
      ? (body.limitOverrides as Record<string, unknown>)
      : undefined;

  const result = await changeAccountPlan(supabaseAdmin(), {
    accountId,
    planCode: typeof body.planCode === 'string' ? body.planCode : undefined,
    status:
      typeof body.status === 'string'
        ? (body.status as AccountPlanStatus)
        : undefined,
    limitOverrides: overrides,
    note: typeof body.note === 'string' ? body.note : undefined,
    actor: body.actor,
    reason: typeof body.reason === 'string' ? body.reason : null,
  });

  if (!result.ok) {
    if (result.error === 'invalid_status') {
      return NextResponse.json({ error: 'Invalid status' }, { status: 400 });
    }
    if (result.error === 'invalid_overrides') {
      return NextResponse.json(
        { error: 'Invalid limitOverrides', details: result.details },
        { status: 400 }
      );
    }
    if (result.error === 'account_not_found') {
      return NextResponse.json(
        { error: 'Account has no plan assigned' },
        { status: 404 }
      );
    }
    if (result.error === 'plan_not_found') {
      return NextResponse.json({ error: 'Plan not found' }, { status: 404 });
    }
    // result.error === 'update_failed'
    return NextResponse.json(
      { error: 'Failed to update account plan' },
      { status: 500 }
    );
  }

  const ap = result.accountPlan;
  return NextResponse.json({
    accountPlan: {
      account_id: ap.accountId,
      plan_id: ap.planId,
      status: ap.status,
      limit_overrides: ap.limitOverrides,
      note: ap.note,
    },
  });
}
