// ============================================================
// PUT /api/platform/accounts/[accountId]/plan — SPEC 062 §6, F6
//
//   Troca plano/status/overrides/ciclo. Chama a MESMA
//   `changeAccountPlan` que `PUT /api/admin/accounts/[id]/plan` chama
//   — é isso que faz "as duas portas produzem eventos idênticos"
//   verdade por construção, não por disciplina de manter duas cópias
//   sincronizadas.
//
//   Diferença das duas portas: aqui o `actor` é sempre
//   `console:<email do proprietário>` (nunca lido do corpo — o
//   navegador não pode alegar ser outra pessoa), e toda troca também
//   grava `platform_audit_log` (§2.5), além de `account_plan_events`.
// ============================================================

import { NextResponse } from 'next/server';

import { requirePlatformOwner } from '@/lib/platform/owner';
import { changeAccountPlan } from '@/lib/platform/plan-actions';
import { consoleActorTag, writePlatformAudit } from '@/lib/platform/audit';
import type { AccountPlanStatus } from '@/lib/plans/types';
import { supabaseAdmin } from '@/lib/supabase/admin';

const NOT_FOUND = NextResponse.json({ error: 'Not found' }, { status: 404 });

interface PlanPutBody {
  planCode?: unknown;
  status?: unknown;
  limitOverrides?: unknown;
  note?: unknown;
  reason?: unknown;
}

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ accountId: string }> }
) {
  let ownerEmail: string;
  try {
    const ctx = await requirePlatformOwner();
    ownerEmail = ctx.email;
  } catch {
    return NOT_FOUND;
  }

  const { accountId } = await params;
  const body = (await request.json().catch(() => null)) as PlanPutBody | null;
  if (!body) {
    return NextResponse.json(
      { error: 'Invalid request body' },
      { status: 400 }
    );
  }

  const overrides =
    body.limitOverrides && typeof body.limitOverrides === 'object'
      ? (body.limitOverrides as Record<string, unknown>)
      : undefined;
  const actor = consoleActorTag(ownerEmail);
  const reason = typeof body.reason === 'string' ? body.reason : null;

  const db = supabaseAdmin();
  const result = await changeAccountPlan(db, {
    accountId,
    planCode: typeof body.planCode === 'string' ? body.planCode : undefined,
    status:
      typeof body.status === 'string'
        ? (body.status as AccountPlanStatus)
        : undefined,
    limitOverrides: overrides,
    note: typeof body.note === 'string' ? body.note : undefined,
    actor,
    reason,
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
    return NextResponse.json(
      { error: 'Failed to update account plan' },
      { status: 500 }
    );
  }

  await writePlatformAudit(db, {
    actor,
    action: 'plan.change',
    accountId,
    payload: {
      planCode: body.planCode ?? null,
      status: body.status ?? null,
      limitOverridesChanged: overrides !== undefined,
      reason,
    },
  });

  return NextResponse.json({ accountPlan: result.accountPlan });
}
