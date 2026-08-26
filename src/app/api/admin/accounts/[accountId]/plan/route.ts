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
import { validateOverrides } from '@/lib/plans/catalog';

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

const VALID_STATUSES = new Set([
  'trialing',
  'active',
  'past_due',
  'suspended',
  'canceled',
]);

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
  if (
    body.status !== undefined &&
    (typeof body.status !== 'string' || !VALID_STATUSES.has(body.status))
  ) {
    return NextResponse.json({ error: 'Invalid status' }, { status: 400 });
  }

  const db = supabaseAdmin();

  const { data: current } = await db
    .from('account_plans')
    .select('plan_id, status, plans:plan_id (code)')
    .eq('account_id', accountId)
    .maybeSingle();
  if (!current) {
    return NextResponse.json(
      { error: 'Account has no plan assigned' },
      { status: 404 }
    );
  }
  const currentPlanCode = (current.plans as unknown as { code: string } | null)
    ?.code;

  let nextPlanId = current.plan_id;
  let nextPlanCode = currentPlanCode ?? null;
  if (typeof body.planCode === 'string' && body.planCode !== currentPlanCode) {
    const { data: plan } = await db
      .from('plans')
      .select('id, code')
      .eq('code', body.planCode)
      .maybeSingle();
    if (!plan) {
      return NextResponse.json({ error: 'Plan not found' }, { status: 404 });
    }
    nextPlanId = plan.id;
    nextPlanCode = plan.code;
  }

  const nextStatus =
    typeof body.status === 'string' ? body.status : current.status;
  const overrides =
    body.limitOverrides && typeof body.limitOverrides === 'object'
      ? (body.limitOverrides as Record<string, unknown>)
      : undefined;

  // Achado de code review: sem isto, um override com chave desconhecida
  // ou tipo errado (ex. {"contacts": "unlimited"}) só falhava depois,
  // com um erro de cast cru do Postgres no próximo INSERT de contato
  // dessa conta — plan_limit() faz (... ->> key)::INTEGER.
  if (overrides !== undefined) {
    const validationErrors = validateOverrides(overrides);
    if (validationErrors.length > 0) {
      return NextResponse.json(
        { error: 'Invalid limitOverrides', details: validationErrors },
        { status: 400 }
      );
    }
  }

  const note = typeof body.note === 'string' ? body.note : undefined;

  const update: Record<string, unknown> = {
    plan_id: nextPlanId,
    status: nextStatus,
    updated_by: body.actor,
    updated_at: new Date().toISOString(),
  };
  if (overrides !== undefined) update.limit_overrides = overrides;
  if (note !== undefined) update.note = note;

  const { data: updated, error: updateErr } = await db
    .from('account_plans')
    .update(update)
    .eq('account_id', accountId)
    .select('account_id, plan_id, status, limit_overrides, note')
    .single();

  if (updateErr || !updated) {
    console.error(
      '[PUT /api/admin/accounts/[accountId]/plan] update error:',
      updateErr
    );
    return NextResponse.json(
      { error: 'Failed to update account plan' },
      { status: 500 }
    );
  }

  // Histórico append-only — nunca falha a resposta por causa dele, mas
  // registra o erro (uma troca sem rastro é o pior desfecho aqui).
  const { error: eventErr } = await db.from('account_plan_events').insert({
    account_id: accountId,
    from_plan_code: currentPlanCode ?? null,
    to_plan_code: nextPlanCode,
    from_status: current.status,
    to_status: nextStatus,
    overrides_after: updated.limit_overrides ?? {},
    actor: body.actor,
    reason: typeof body.reason === 'string' ? body.reason : null,
  });
  if (eventErr) {
    console.error(
      '[PUT /api/admin/accounts/[accountId]/plan] event insert error:',
      eventErr
    );
  }

  return NextResponse.json({ accountPlan: updated });
}
