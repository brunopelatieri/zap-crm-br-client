// ============================================================
// /api/account/plan/request
//
//   POST   — admin+ grava uma solicitação de troca de plano
//            (SPEC 059 D-8: é uma SOLICITAÇÃO, não uma troca
//            automática — quem efetiva é o operador em /api/admin/**).
//   DELETE — admin+ cancela a PRÓPRIA solicitação pendente.
//
// O índice parcial idx_plan_requests_one_pending (migração 067) já
// impede duas solicitações pendentes na mesma conta — um segundo POST
// com uma ainda em aberto recebe 409 do próprio Postgres.
// ============================================================

import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { deliverPlanRequestWebhook } from '@/lib/plans/request-webhook';

export async function POST(request: Request) {
  try {
    const ctx = await requireRole('admin');

    const body = (await request.json().catch(() => null)) as {
      planId?: unknown;
      message?: unknown;
    } | null;

    const requestedPlanId = body?.planId;
    if (typeof requestedPlanId !== 'string' || requestedPlanId.length === 0) {
      return NextResponse.json(
        { error: "'planId' is required" },
        { status: 400 }
      );
    }

    const message =
      typeof body?.message === 'string'
        ? body.message.trim().slice(0, 2000)
        : null;

    // O plano precisa existir e estar no catálogo público (RLS de
    // `plans` já restringe a leitura a is_active && is_public, ou ao
    // plano atual da conta — um id fora disso simplesmente não é
    // encontrado, sem vazar por que).
    const { data: plan } = await ctx.supabase
      .from('plans')
      .select('id, code, name')
      .eq('id', requestedPlanId)
      .maybeSingle();

    if (!plan) {
      return NextResponse.json(
        { error: 'Plan not found or not available' },
        { status: 404 }
      );
    }

    const { data: created, error } = await ctx.supabase
      .from('plan_change_requests')
      .insert({
        account_id: ctx.accountId,
        requested_plan_id: plan.id,
        requested_by: ctx.userId,
        message,
      })
      .select('id, requested_plan_id, status, message, created_at')
      .single();

    if (error || !created) {
      if (error?.code === '23505') {
        return NextResponse.json(
          { error: 'You already have a pending plan request' },
          { status: 409 }
        );
      }
      console.error('[POST /api/account/plan/request] insert error:', error);
      return NextResponse.json(
        { error: 'Failed to create plan request' },
        { status: 500 }
      );
    }

    // Melhor esforço — nunca falha a solicitação por causa do aviso.
    deliverPlanRequestWebhook({
      accountId: ctx.accountId,
      accountName: ctx.account.name,
      planCode: plan.code,
      planName: plan.name,
      message,
    }).catch((err) => {
      console.error('[POST /api/account/plan/request] webhook error:', err);
    });

    return NextResponse.json({ request: created }, { status: 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function DELETE() {
  try {
    const ctx = await requireRole('admin');

    const { data, error } = await ctx.supabase
      .from('plan_change_requests')
      .update({ status: 'canceled', resolved_at: new Date().toISOString() })
      .eq('account_id', ctx.accountId)
      .eq('status', 'pending')
      .select('id')
      .maybeSingle();

    if (error) {
      console.error('[DELETE /api/account/plan/request] update error:', error);
      return NextResponse.json(
        { error: 'Failed to cancel plan request' },
        { status: 500 }
      );
    }
    if (!data) {
      return NextResponse.json(
        { error: 'No pending plan request to cancel' },
        { status: 404 }
      );
    }

    return NextResponse.json({ canceled: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
