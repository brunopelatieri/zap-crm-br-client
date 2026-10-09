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
import { resolveDuplicateRef } from '@/lib/plans/payments';
import { recordActivity } from '@/lib/activity/record';

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

  // A retentativa do sistema externo É comportamento esperado — 200,
  // nunca 409 (§6.2 passo 1) — mas só quando o `paymentRef` já é um
  // pagamento vigente DESTA conta. `payment_ref` é UNIQUE na tabela
  // inteira: se a linha é de outra conta, ou foi estornada, nada foi
  // aplicado e responder `already_applied` faria o sistema externo dar o
  // pagamento por lançado.
  if (result.status === 'already_applied') {
    switch (await resolveDuplicateRef(db, accountId, body.paymentRef)) {
      case 'same_payment':
        return NextResponse.json({ status: 'already_applied' });
      case 'other_account':
        return NextResponse.json(
          {
            error:
              "'paymentRef' is already registered for another account; nothing was applied",
            code: 'payment_ref_in_use',
          },
          { status: 409 }
        );
      case 'reversed':
        return NextResponse.json(
          {
            error:
              "'paymentRef' belongs to a payment that was reversed by the platform operator; nothing was applied",
            code: 'payment_ref_reversed',
          },
          { status: 409 }
        );
      default:
        return NextResponse.json(
          {
            error:
              "'paymentRef' is already in use and its owner could not be checked",
          },
          { status: 500 }
        );
    }
  }

  await writePlatformAudit(db, {
    actor: 'api:billing-renew',
    action: 'billing.renew',
    accountId,
    payload: { paymentRef: body.paymentRef, periods, externalRef, note },
  });

  // SPEC 075 F4 — distinto de `writePlatformAudit` acima: aquele é "o
  // que o proprietário da plataforma fez" (fora de escopo desta SPEC,
  // §14); este é "o que aconteceu com a MINHA conta", visível ao
  // próprio cliente em `/activity`.
  void recordActivity(db, {
    accountId,
    resourceType: 'plan',
    action: 'plan.renewed',
    actor: { kind: 'system', name: 'billing' },
    metadata: { payment_ref: body.paymentRef, periods, source: 'api' },
  });

  await dispatchWebhookEvent(db, accountId, 'plan.renewed', {
    paymentRef: body.paymentRef,
    periods,
    currentPeriodEnd: result.accountPlan.currentPeriodEnd,
    // SPEC 078 §10 — o mesmo evento também nasce no console.
    source: 'api',
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
