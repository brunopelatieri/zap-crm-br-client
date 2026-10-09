/**
 * Desfazer um pagamento manual (SPEC 078 §4.5, D-9).
 *
 * Server-only. A regra inteira (só o último não estornado, vencimento
 * ainda igual ao gravado pelo pagamento, linha marcada e nunca apagada)
 * mora na função Postgres `reverse_plan_payment` (migração 089), sob o
 * lock da linha de `account_plans` — a mesma que renovação e troca de
 * vencimento travam, então as três serializam por conta.
 *
 * Este módulo é só o contrato com a RPC: os parâmetros certos saem e os
 * erros de negócio (sinalizados pelo TEXTO da exceção, como em
 * `billing-renew.ts`) viram códigos estáveis para a rota traduzir em
 * `409`.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

import type { AccountPlanStatus } from './types';

export interface ReversePaymentInput {
  paymentId: string;
  /** `'console:<email>'` — vai para `reversed_by` e `account_plans.updated_by`. */
  actor: string;
  reason?: string | null;
}

export interface ReversedPayment {
  restoredPeriodEnd: string | null;
  restoredStatus: AccountPlanStatus;
}

export type ReversePaymentError =
  | 'payment_not_found'
  | 'account_not_found'
  | 'payment_already_reversed'
  | 'payment_not_reversible'
  | 'payment_not_latest'
  | 'period_changed_since_payment'
  | 'update_failed';

export type ReversePaymentResult =
  | { ok: true; restored: ReversedPayment }
  | { ok: false; error: ReversePaymentError };

interface ReversePlanPaymentRow {
  restored_period_end: string | null;
  restored_status: AccountPlanStatus;
}

/** Texto da exceção da função → código estável (o PostgREST só expõe `.message`). */
const BUSINESS_ERRORS: readonly [string, ReversePaymentError][] = [
  ['PAYMENT_NOT_FOUND', 'payment_not_found'],
  ['ACCOUNT_NOT_FOUND', 'account_not_found'],
  ['PAYMENT_ALREADY_REVERSED', 'payment_already_reversed'],
  ['PAYMENT_NOT_REVERSIBLE', 'payment_not_reversible'],
  ['PAYMENT_NOT_LATEST', 'payment_not_latest'],
  ['PERIOD_CHANGED_SINCE_PAYMENT', 'period_changed_since_payment'],
];

export async function reversePlanPayment(
  db: SupabaseClient,
  input: ReversePaymentInput
): Promise<ReversePaymentResult> {
  const { data, error } = await db.rpc('reverse_plan_payment', {
    p_payment_id: input.paymentId,
    p_actor: input.actor,
    p_reason: input.reason ?? null,
  });

  if (error) {
    const message = error.message ?? '';
    for (const [needle, code] of BUSINESS_ERRORS) {
      if (message.includes(needle)) return { ok: false, error: code };
    }
    console.error(
      '[plans/payment-reversal] reverse_plan_payment RPC failed:',
      error
    );
    return { ok: false, error: 'update_failed' };
  }

  const row = (Array.isArray(data) ? data[0] : data) as
    ReversePlanPaymentRow | undefined;
  if (!row) {
    console.error(
      '[plans/payment-reversal] reverse_plan_payment returned no row'
    );
    return { ok: false, error: 'update_failed' };
  }

  return {
    ok: true,
    restored: {
      restoredPeriodEnd: row.restored_period_end,
      restoredStatus: row.restored_status,
    },
  };
}
