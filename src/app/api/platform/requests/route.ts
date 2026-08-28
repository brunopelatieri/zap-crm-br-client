// ============================================================
// GET/PATCH /api/platform/requests — SPEC 062 §6, F6
//
//   Solicitações de plano sob medida (D-8/D-9 do PRD 059) — o mesmo
//   fluxo de `/api/admin/plan-requests`, agora atrás de sessão do
//   proprietário. 'approved' aplica a troca via `changeAccountPlan`
//   (a mesma função que a porta admin e a rota de plano do console já
//   chamam — nenhuma cópia nova de "UPDATE account_plans + INSERT
//   account_plan_events" nasce aqui); 'rejected' só marca e explica.
// ============================================================

import { NextResponse } from 'next/server';

import { requirePlatformOwner } from '@/lib/platform/owner';
import { changeAccountPlan } from '@/lib/platform/plan-actions';
import { consoleActorTag, writePlatformAudit } from '@/lib/platform/audit';
import { supabaseAdmin } from '@/lib/supabase/admin';

const NOT_FOUND = NextResponse.json({ error: 'Not found' }, { status: 404 });

export async function GET(request: Request) {
  try {
    await requirePlatformOwner();
  } catch {
    return NOT_FOUND;
  }

  const url = new URL(request.url);
  const status = url.searchParams.get('status') ?? 'pending';

  let query = supabaseAdmin()
    .from('plan_change_requests')
    .select(
      'id, account_id, requested_plan_id, requested_by, status, message, resolved_at, resolved_note, created_at, plans:requested_plan_id (code, name), accounts:account_id (name)'
    )
    .order('created_at', { ascending: false });

  if (status !== 'all') query = query.eq('status', status);

  const { data, error } = await query;

  if (error) {
    console.error('[GET /api/platform/requests] fetch error:', error);
    return NextResponse.json(
      { error: 'Failed to load plan requests' },
      { status: 500 }
    );
  }

  return NextResponse.json({ requests: data ?? [] });
}

interface PatchBody {
  id?: unknown;
  decision?: unknown;
  note?: unknown;
}

export async function PATCH(request: Request) {
  let ownerEmail: string;
  try {
    const ctx = await requirePlatformOwner();
    ownerEmail = ctx.email;
  } catch {
    return NOT_FOUND;
  }

  const body = (await request.json().catch(() => null)) as PatchBody | null;
  if (
    !body ||
    typeof body.id !== 'string' ||
    (body.decision !== 'approved' && body.decision !== 'rejected')
  ) {
    return NextResponse.json(
      { error: "'id' and 'decision' ('approved'|'rejected') are required" },
      { status: 400 }
    );
  }

  const db = supabaseAdmin();
  const actor = consoleActorTag(ownerEmail);
  const note = typeof body.note === 'string' ? body.note : null;
  const nowIso = new Date().toISOString();

  const { data: reqRow, error: reqErr } = await db
    .from('plan_change_requests')
    .select('id, account_id, requested_plan_id, status')
    .eq('id', body.id)
    .maybeSingle();

  if (reqErr || !reqRow) {
    return NextResponse.json(
      { error: 'Plan request not found' },
      { status: 404 }
    );
  }
  if (reqRow.status !== 'pending') {
    return NextResponse.json(
      { error: `Request is already '${reqRow.status}'` },
      { status: 409 }
    );
  }

  if (body.decision === 'approved') {
    const { data: plan } = await db
      .from('plans')
      .select('id, code')
      .eq('id', reqRow.requested_plan_id)
      .maybeSingle();
    if (!plan) {
      return NextResponse.json(
        { error: 'Requested plan no longer exists' },
        { status: 404 }
      );
    }

    const result = await changeAccountPlan(db, {
      accountId: reqRow.account_id,
      planCode: plan.code,
      status: 'active',
      actor,
      reason: note ?? `Approved plan request ${reqRow.id}`,
    });

    if (!result.ok) {
      if (result.error === 'account_not_found') {
        return NextResponse.json(
          { error: 'Account has no plan assigned' },
          { status: 404 }
        );
      }
      console.error(
        '[PATCH /api/platform/requests] changeAccountPlan failed:',
        result.error,
        result.details
      );
      return NextResponse.json(
        { error: 'Failed to apply plan change' },
        { status: 500 }
      );
    }
  }

  const { data: resolved, error: resolveErr } = await db
    .from('plan_change_requests')
    .update({
      status: body.decision,
      resolved_at: nowIso,
      resolved_note: note,
    })
    .eq('id', body.id)
    .select('id, status, resolved_at, resolved_note')
    .single();

  if (resolveErr || !resolved) {
    console.error('[PATCH /api/platform/requests] resolve error:', resolveErr);
    return NextResponse.json(
      { error: 'Failed to resolve plan request' },
      { status: 500 }
    );
  }

  await writePlatformAudit(db, {
    actor,
    action:
      body.decision === 'approved'
        ? 'plan.request.approve'
        : 'plan.request.reject',
    accountId: reqRow.account_id,
    payload: { requestId: reqRow.id, note },
  });

  return NextResponse.json({ request: resolved });
}
