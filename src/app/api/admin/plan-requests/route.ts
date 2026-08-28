// ============================================================
// /api/admin/plan-requests — SPEC 059 §6, D-8/D-9
//
//   GET   — lista solicitações (por padrão só as pendentes).
//   PATCH — resolve uma solicitação: 'approved' efetiva a troca de
//           plano (grava account_plans + account_plan_events, no
//           mesmo formato de PUT /api/admin/accounts/[accountId]/plan);
//           'rejected' só marca e explica em resolved_note.
//
// Protegida por PLATFORM_ADMIN_SECRET — ver src/lib/auth/platform-admin.ts.
// ============================================================

import { NextResponse } from 'next/server';

import { requirePlatformAdminSecret } from '@/lib/auth/platform-admin';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { changeAccountPlan } from '@/lib/platform/plan-actions';

export async function GET(request: Request) {
  const denied = requirePlatformAdminSecret(request);
  if (denied) return denied;

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
    console.error('[GET /api/admin/plan-requests] fetch error:', error);
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
  actor?: unknown;
  note?: unknown;
}

export async function PATCH(request: Request) {
  const denied = requirePlatformAdminSecret(request);
  if (denied) return denied;

  const body = (await request.json().catch(() => null)) as PatchBody | null;
  if (
    !body ||
    typeof body.id !== 'string' ||
    (body.decision !== 'approved' && body.decision !== 'rejected') ||
    typeof body.actor !== 'string' ||
    body.actor.trim() === ''
  ) {
    return NextResponse.json(
      {
        error:
          "'id', 'decision' ('approved'|'rejected') and 'actor' are required",
      },
      { status: 400 }
    );
  }

  const db = supabaseAdmin();
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
    // SPEC 062 F6: a aplicação em si (UPDATE account_plans + INSERT
    // account_plan_events, ecoando limit_overrides já persistido) mora
    // em `changeAccountPlan` — a mesma função que as duas portas de
    // `PUT …/plan` chamam. `status: 'active'` é forçado, sem tocar
    // `limitOverrides` (omitido = mantém o valor atual), exatamente o
    // comportamento que esta rota já tinha antes da extração.
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
      actor: body.actor,
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
        '[PATCH /api/admin/plan-requests] changeAccountPlan failed:',
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
    console.error(
      '[PATCH /api/admin/plan-requests] resolve error:',
      resolveErr
    );
    return NextResponse.json(
      { error: 'Failed to resolve plan request' },
      { status: 500 }
    );
  }

  return NextResponse.json({ request: resolved });
}
