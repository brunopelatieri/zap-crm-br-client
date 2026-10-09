/**
 * Vencimento e pagamento manual pelo console do proprietário
 * (SPEC 078 §3, §4, §8, §8.1).
 *
 * Server-only. As rotas de `/api/platform/accounts/[accountId]/billing/**`
 * só autenticam (`requirePlatformOwner`) e chamam estas funções — a
 * validação, a escrita (RPC no banco) e TODOS os efeitos colaterais
 * moram aqui, para ficarem testáveis sem HTTP:
 *
 *   - `platform_audit_log` — o que o proprietário fez (§2.5);
 *   - `account_activity_log` — o que aconteceu com a conta, visível ao
 *     cliente em `/activity`, com ator `system`/`platform`;
 *   - webhook de saída por conta e, no pagamento, a outbox do
 *     proprietário (SPEC 063).
 *
 * Os efeitos só rodam quando a escrita de fato mudou algo: um pagamento
 * `already_applied` (retentativa, clique duplo, o mesmo Pix pelo sistema
 * externo) não audita, não notifica e não dispara webhook.
 *
 * `payment_ref` é UNIQUE na tabela inteira (todas as contas, inclusive
 * linhas estornadas), então "o banco recusou como repetido" só é
 * idempotência quando a linha existente é um pagamento VIGENTE desta
 * mesma conta. Nos outros dois casos nada foi aplicado e o operador
 * precisa saber — ver `resolveDuplicateRef` (`@/lib/plans/payments`).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

import { recordActivity } from '@/lib/activity/record';
import { emitSystemEvent } from '@/lib/notifications/emit';
import { renewAccountPlan } from '@/lib/plans/billing-renew';
import {
  todayInSaoPaulo,
  validateManualPaymentInput,
  validatePeriodEndInput,
} from '@/lib/plans/manual-billing';
import { reversePlanPayment } from '@/lib/plans/payment-reversal';
import { listAccountPayments, resolveDuplicateRef } from '@/lib/plans/payments';
import type { AccountPayment } from '@/lib/plans/payments';
import { setPlanPeriodEnd } from '@/lib/plans/period-end';
import { dispatchWebhookEvent } from '@/lib/webhooks/deliver';

import { consoleActorTag, writePlatformAudit } from './audit';
import { fail, parseReason, type ConsoleResult } from './console-result';

/** Ator das linhas de atividade: o cliente lê "Suporte da plataforma". */
const PLATFORM_ACTIVITY_ACTOR = { kind: 'system', name: 'platform' } as const;

const NO_PLAN = 'Account has no plan assigned';

// ── Alterar vencimento (§3) ──────────────────────────────────────────

export interface ChangePeriodEndInput {
  accountId: string;
  ownerEmail: string;
  body: { date?: unknown; billingCycle?: unknown; reason?: unknown } | null;
  now?: Date;
}

export interface PeriodEndChanged {
  previousPeriodEnd: string | null;
  currentPeriodEnd: string;
  previousStatus: string;
  status: string;
  billingCycle: string;
}

const PERIOD_END_MESSAGES: Record<string, string> = {
  period_end_invalid: "'date' must be a valid YYYY-MM-DD date",
  period_end_out_of_range:
    "'date' must be between today and three years from today (America/Sao_Paulo)",
  invalid_billing_cycle: "'billingCycle' must be 'monthly' or 'yearly'",
};

export async function changePlanPeriodEnd(
  db: SupabaseClient,
  input: ChangePeriodEndInput
): Promise<ConsoleResult<PeriodEndChanged>> {
  const { accountId, ownerEmail, body } = input;
  if (!body) return fail(400, 'invalid_body', 'Invalid request body');

  const validated = validatePeriodEndInput({
    date: body.date,
    billingCycle: body.billingCycle,
    todaySp: todayInSaoPaulo(input.now ?? new Date()),
  });
  if (!validated.ok) {
    return fail(400, validated.code, PERIOD_END_MESSAGES[validated.code]);
  }

  const actor = consoleActorTag(ownerEmail);
  const reason = parseReason(body.reason);
  const result = await setPlanPeriodEnd(db, {
    accountId,
    date: validated.value.date,
    billingCycle: validated.value.billingCycle,
    actor,
  });

  if (!result.ok) {
    switch (result.error) {
      case 'account_not_found':
        return fail(404, 'account_not_found', NO_PLAN);
      case 'no_billing_cycle':
        return fail(
          400,
          'no_billing_cycle',
          'This plan has no billing cycle, so it has no due date'
        );
      case 'period_end_out_of_range':
      case 'invalid_billing_cycle':
        return fail(400, result.error, PERIOD_END_MESSAGES[result.error]);
      default:
        return fail(500, 'update_failed', 'Failed to update the due date');
    }
  }

  const { change } = result;

  await writePlatformAudit(db, {
    actor,
    action: 'billing.period_end.set',
    accountId,
    payload: {
      date: validated.value.date,
      previousPeriodEnd: change.previousPeriodEnd,
      newPeriodEnd: change.newPeriodEnd,
      previousStatus: change.previousStatus,
      newStatus: change.newStatus,
      billingCycle: change.billingCycle,
      reason,
    },
  });

  void recordActivity(db, {
    accountId,
    resourceType: 'plan',
    action: 'plan.period_changed',
    actor: PLATFORM_ACTIVITY_ACTOR,
    metadata: {
      previous_period_end: change.previousPeriodEnd,
      new_period_end: change.newPeriodEnd,
      billing_cycle: change.billingCycle,
    },
  });

  await dispatchWebhookEvent(db, accountId, 'plan.period_changed', {
    previousPeriodEnd: change.previousPeriodEnd,
    currentPeriodEnd: change.newPeriodEnd,
    billingCycle: change.billingCycle,
    status: change.newStatus,
  });

  return {
    ok: true,
    data: {
      previousPeriodEnd: change.previousPeriodEnd,
      currentPeriodEnd: change.newPeriodEnd,
      previousStatus: change.previousStatus,
      status: change.newStatus,
      billingCycle: change.billingCycle,
    },
  };
}

// ── Registrar pagamento manual (§4) ──────────────────────────────────

export interface RecordPaymentInput {
  accountId: string;
  ownerEmail: string;
  body: {
    paymentRef?: unknown;
    paidAt?: unknown;
    periods?: unknown;
    method?: unknown;
    amountCents?: unknown;
    note?: unknown;
  } | null;
  now?: Date;
}

export type RecordPaymentOutcome =
  | { status: 'already_applied' }
  | {
      status: 'applied';
      accountPlan: { currentPeriodEnd: string | null; status: string };
      /** §4.3: pagamento não desbloqueia — a UI avisa. */
      accountBlocked: boolean;
    };

const PAYMENT_MESSAGES: Record<string, string> = {
  paid_at_invalid: "'paidAt' must be a valid YYYY-MM-DD date",
  paid_at_in_future: "'paidAt' cannot be in the future",
  paid_at_too_old: "'paidAt' cannot be more than 365 days ago",
  periods_invalid: "'periods' must be an integer from 1 to 12",
  method_invalid:
    "'method' must be one of pix, boleto, card, transfer, cash, other",
  amount_invalid: "'amountCents' must be a non-negative integer",
  payment_ref_required: "'paymentRef' is required",
  payment_ref_too_long: "'paymentRef' must be at most 200 characters",
  note_too_long: "'note' must be at most 500 characters",
};

/**
 * `paymentRef` é obrigatório AQUI de propósito (§8): quem gera o
 * `console:<uuid>` é o diálogo, ao ABRIR. Gerar na rota faria cada
 * clique duplo um pagamento novo.
 */
export async function recordManualPayment(
  db: SupabaseClient,
  input: RecordPaymentInput
): Promise<ConsoleResult<RecordPaymentOutcome>> {
  const { accountId, ownerEmail, body } = input;
  if (!body) return fail(400, 'invalid_body', 'Invalid request body');

  const validated = validateManualPaymentInput({
    paidAt: body.paidAt,
    periods: body.periods,
    method: body.method,
    amountCents: body.amountCents,
    paymentRef: body.paymentRef,
    note: body.note,
    todaySp: todayInSaoPaulo(input.now ?? new Date()),
  });
  if (!validated.ok) {
    return fail(400, validated.code, PAYMENT_MESSAGES[validated.code]);
  }
  const payment = validated.value;
  const actor = consoleActorTag(ownerEmail);

  const result = await renewAccountPlan(db, {
    accountId,
    paymentRef: payment.paymentRef,
    paidAt: payment.paidAt,
    periods: payment.periods,
    note: payment.note,
    actor,
    method: payment.method,
    amountCents: payment.amountCents,
  });

  if (!result.ok) {
    switch (result.error) {
      case 'account_not_found':
        return fail(404, 'account_not_found', NO_PLAN);
      case 'no_billing_cycle':
        return fail(
          400,
          'no_billing_cycle',
          'This plan has no billing cycle to renew'
        );
      default:
        return fail(500, 'update_failed', 'Failed to register the payment');
    }
  }

  if (result.status === 'already_applied') {
    switch (await resolveDuplicateRef(db, accountId, payment.paymentRef)) {
      // Retentativa reconhecida pelo banco: 200, sem efeito nenhum.
      case 'same_payment':
        return { ok: true, data: { status: 'already_applied' } };
      case 'other_account':
        return fail(
          409,
          'payment_ref_in_use',
          'This payment identifier is already registered for another account; nothing was applied'
        );
      case 'reversed':
        return fail(
          409,
          'payment_ref_reversed',
          'This payment identifier belongs to a reversed payment; use a different identifier to register it again'
        );
      default:
        // Não dá para afirmar "já aplicado" sem saber de quem é a linha.
        return fail(
          500,
          'read_failed',
          'The payment identifier is already in use and its owner could not be checked'
        );
    }
  }

  const { currentPeriodEnd, status } = result.accountPlan;

  await writePlatformAudit(db, {
    actor,
    action: 'billing.payment.manual',
    accountId,
    payload: {
      paymentRef: payment.paymentRef,
      periods: payment.periods,
      method: payment.method,
      amountCents: payment.amountCents,
      paidAt: payment.paidAt,
      note: payment.note,
      newPeriodEnd: currentPeriodEnd,
      status,
    },
  });

  void recordActivity(db, {
    accountId,
    resourceType: 'plan',
    action: 'plan.renewed',
    actor: PLATFORM_ACTIVITY_ACTOR,
    metadata: {
      payment_ref: payment.paymentRef,
      periods: payment.periods,
      source: 'console',
    },
  });

  await dispatchWebhookEvent(db, accountId, 'plan.renewed', {
    paymentRef: payment.paymentRef,
    periods: payment.periods,
    currentPeriodEnd,
    source: 'console',
  });
  await emitSystemEvent(
    {
      type: 'plan.renewed',
      accountId,
      actor,
      data: {
        plan: {
          paymentRef: payment.paymentRef,
          periods: payment.periods,
          currentPeriodEnd,
        },
      },
    },
    db
  );

  return {
    ok: true,
    data: {
      status: 'applied',
      accountPlan: { currentPeriodEnd, status },
      accountBlocked: await isAccountBlocked(db, accountId),
    },
  };
}

/** Best-effort: falha de leitura vira "não bloqueada" (só afeta um aviso). */
async function isAccountBlocked(
  db: SupabaseClient,
  accountId: string
): Promise<boolean> {
  const { data, error } = await db
    .from('accounts')
    .select('blocked_at')
    .eq('id', accountId)
    .maybeSingle();
  if (error) {
    console.error(
      '[platform/billing-console] blocked_at read failed:',
      error.message
    );
    return false;
  }
  return (data as { blocked_at: string | null } | null)?.blocked_at != null;
}

// ── Listar / estornar pagamentos (§4.4, §4.5) ────────────────────────

export async function listPayments(
  db: SupabaseClient,
  accountId: string
): Promise<ConsoleResult<{ payments: AccountPayment[] }>> {
  try {
    return {
      ok: true,
      data: { payments: await listAccountPayments(db, accountId) },
    };
  } catch (err) {
    console.error('[platform/billing-console] list payments failed:', err);
    return fail(500, 'read_failed', 'Failed to load payments');
  }
}

export interface ReversePaymentInput {
  accountId: string;
  paymentId: string;
  ownerEmail: string;
  body: { reason?: unknown } | null;
}

export interface PaymentReversed {
  restoredPeriodEnd: string | null;
  restoredStatus: string;
}

const REVERSAL_FAILURES: Record<string, string> = {
  payment_already_reversed: 'This payment was already reversed',
  payment_not_reversible:
    'This payment predates reversal support and cannot be reversed',
  payment_not_latest:
    'Only the latest non-reversed payment of the account can be reversed',
  period_changed_since_payment:
    'The due date changed after this payment, so reversing it would undo that change too',
};

export async function reverseManualPayment(
  db: SupabaseClient,
  input: ReversePaymentInput
): Promise<ConsoleResult<PaymentReversed>> {
  const { accountId, paymentId, ownerEmail } = input;

  // O pagamento precisa existir E pertencer à conta da URL — senão a
  // rota estornaria o pagamento de qualquer conta por um id adivinhado.
  const { data: row, error: readErr } = await db
    .from('account_plan_payments')
    .select('id, account_id, payment_ref')
    .eq('id', paymentId)
    .maybeSingle();
  if (readErr) {
    console.error(
      '[platform/billing-console] payment read failed:',
      readErr.message
    );
    return fail(500, 'read_failed', 'Failed to load the payment');
  }
  const payment = row as {
    id: string;
    account_id: string;
    payment_ref: string;
  } | null;
  if (!payment || payment.account_id !== accountId) {
    return fail(404, 'payment_not_found', 'Payment not found');
  }

  const actor = consoleActorTag(ownerEmail);
  const reason = parseReason(input.body?.reason);
  const result = await reversePlanPayment(db, { paymentId, actor, reason });

  if (!result.ok) {
    if (result.error === 'payment_not_found') {
      return fail(404, 'payment_not_found', 'Payment not found');
    }
    if (result.error === 'account_not_found') {
      return fail(404, 'account_not_found', NO_PLAN);
    }
    const message = REVERSAL_FAILURES[result.error];
    if (message) return fail(409, result.error, message);
    return fail(500, 'update_failed', 'Failed to reverse the payment');
  }

  const { restoredPeriodEnd, restoredStatus } = result.restored;

  await writePlatformAudit(db, {
    actor,
    action: 'billing.payment.reverse',
    accountId,
    payload: {
      paymentId,
      paymentRef: payment.payment_ref,
      restoredPeriodEnd,
      restoredStatus,
      reason,
    },
  });

  void recordActivity(db, {
    accountId,
    resourceType: 'plan',
    action: 'plan.payment_reversed',
    actor: PLATFORM_ACTIVITY_ACTOR,
    metadata: { payment_ref: payment.payment_ref },
  });

  // Sem webhook de saída (§4.5): o sistema do cliente nunca foi
  // "desrenovado" por nós.
  return { ok: true, data: { restoredPeriodEnd, restoredStatus } };
}
