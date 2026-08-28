// ============================================================
// POST /api/admin/accounts/{accountId}/billing/renew — SPEC 062 §6.2,
// PRD §5.2, D-14
//
//   A porta do sistema externo de cobrança. Fica em `/api/admin/**` e
//   não em `/api/platform/**` de propósito: quem chama é MÁQUINA, não
//   navegador — a autenticação por segredo de servidor é a mesma que
//   D-2 já preservou para toda essa família de rotas. É literalmente
//   a forma que um webhook de gateway de pagamento assumiria no
//   futuro (`billing_source` já prevê `'gateway'`, §3.7) — sem
//   migração nova quando esse dia chegar.
//
// A lógica (idempotência, avançar a partir do vencimento ATUAL, voltar
// de `past_due`) mora em `@/lib/plans/billing-renew.ts`; esta rota só
// valida o corpo, chama a função e grava a auditoria.
// ============================================================

import { NextResponse } from 'next/server';

import { requirePlatformAdminSecret } from '@/lib/auth/platform-admin';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { writePlatformAudit } from '@/lib/platform/audit';
import { dispatchWebhookEvent } from '@/lib/webhooks/deliver';
import { emitSystemEvent } from '@/lib/notifications/emit';
import { renewAccountPlan } from '@/lib/plans/billing-renew';

interface RenewBody {
  paymentRef?: unknown;
  paidAt?: unknown;
  periods?: unknown;
  externalRef?: unknown;
  note?: unknown;
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ accountId: string }> }
) {
  const denied = requirePlatformAdminSecret(request);
  if (denied) return denied;
  const { accountId } = await params;

  const body = (await request.json().catch(() => null)) as RenewBody | null;
  if (
    !body ||
    typeof body.paymentRef !== 'string' ||
    body.paymentRef.trim() === ''
  ) {
    return NextResponse.json(
      { error: "'paymentRef' is required" },
      { status: 400 }
    );
  }

  const periods =
    body.periods === undefined
      ? 1
      : typeof body.periods === 'number' && Number.isInteger(body.periods)
        ? body.periods
        : NaN;
  if (!Number.isInteger(periods) || periods < 1) {
    return NextResponse.json(
      { error: "'periods' must be a positive integer" },
      { status: 400 }
    );
  }

  const paidAt =
    typeof body.paidAt === 'string' && body.paidAt.trim() !== ''
      ? body.paidAt
      : null;

  const externalRef =
    typeof body.externalRef === 'string' ? body.externalRef : null;
  const note = typeof body.note === 'string' ? body.note : null;

  const db = supabaseAdmin();
  const result = await renewAccountPlan(db, {
    accountId,
    paymentRef: body.paymentRef,
    paidAt,
    periods,
    externalRef,
    note,
  });

  if (!result.ok) {
    if (result.error === 'account_not_found') {
      return NextResponse.json(
        { error: 'Account has no plan assigned' },
        { status: 404 }
      );
    }
    if (result.error === 'no_billing_cycle') {
      return NextResponse.json(
        { error: 'This plan has no billing cycle to renew' },
        { status: 400 }
      );
    }
    return NextResponse.json(
      { error: 'Failed to renew account plan' },
      { status: 500 }
    );
  }

  // A retentativa do sistema externo é comportamento esperado — 200,
  // nunca 409 (§6.2 passo 1).
  if (result.status === 'already_applied') {
    return NextResponse.json({ status: 'already_applied' });
  }

  await writePlatformAudit(db, {
    actor: 'api:billing-renew',
    action: 'billing.renew',
    accountId,
    payload: { paymentRef: body.paymentRef, periods, externalRef, note },
  });
  await dispatchWebhookEvent(db, accountId, 'plan.renewed', {
    paymentRef: body.paymentRef,
    periods,
    currentPeriodEnd: result.accountPlan.currentPeriodEnd,
  });
  await emitSystemEvent(
    {
      type: 'plan.renewed',
      accountId,
      actor: 'api:billing-renew',
      data: {
        plan: {
          paymentRef: body.paymentRef,
          periods,
          currentPeriodEnd: result.accountPlan.currentPeriodEnd,
        },
      },
    },
    db
  );

  return NextResponse.json({
    status: 'applied',
    accountPlan: result.accountPlan,
  });
}
