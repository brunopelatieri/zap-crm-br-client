/**
 * Histórico de pagamentos da conta — leitura para o card "Pagamentos" do
 * console (SPEC 078 §4.4).
 *
 * Server-only: `account_plan_payments` tem RLS ligada e ZERO policies
 * (071), só `service_role` lê. Os mais novos primeiro; o desempate por
 * `id` espelha o que `reverse_plan_payment` usa para decidir "último".
 */

import type { SupabaseClient } from '@supabase/supabase-js';

import type { PaymentMethod } from './manual-billing';
import type { AccountPlanStatus } from './types';

export const DEFAULT_PAYMENTS_LIMIT = 20;

export interface AccountPayment {
  id: string;
  accountId: string;
  paymentRef: string;
  periods: number;
  previousPeriodEnd: string | null;
  newPeriodEnd: string;
  paidAt: string;
  externalRef: string | null;
  note: string | null;
  method: PaymentMethod | null;
  amountCents: number | null;
  /** `console:<email>` ou `api:billing-renew`. */
  recordedBy: string | null;
  /** `null` = gravado antes da 089: não estornável (§4.5 item 5). */
  previousStatus: AccountPlanStatus | null;
  reversedAt: string | null;
  reversedBy: string | null;
  reversalReason: string | null;
  createdAt: string;
}

interface AccountPaymentRow {
  id: string;
  account_id: string;
  payment_ref: string;
  periods: number;
  previous_period_end: string | null;
  new_period_end: string;
  paid_at: string;
  external_ref: string | null;
  note: string | null;
  method: PaymentMethod | null;
  amount_cents: number | null;
  recorded_by: string | null;
  previous_status: AccountPlanStatus | null;
  reversed_at: string | null;
  reversed_by: string | null;
  reversal_reason: string | null;
  created_at: string;
}

const PAYMENTS_SELECT =
  'id, account_id, payment_ref, periods, previous_period_end, new_period_end, paid_at, external_ref, note, method, amount_cents, recorded_by, previous_status, reversed_at, reversed_by, reversal_reason, created_at';

export async function listAccountPayments(
  db: SupabaseClient,
  accountId: string,
  limit: number = DEFAULT_PAYMENTS_LIMIT
): Promise<AccountPayment[]> {
  const { data, error } = await db
    .from('account_plan_payments')
    .select(PAYMENTS_SELECT)
    .eq('account_id', accountId)
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(limit);

  if (error) throw error;

  return ((data ?? []) as unknown as AccountPaymentRow[]).map((row) => ({
    id: row.id,
    accountId: row.account_id,
    paymentRef: row.payment_ref,
    periods: row.periods,
    previousPeriodEnd: row.previous_period_end,
    newPeriodEnd: row.new_period_end,
    paidAt: row.paid_at,
    externalRef: row.external_ref,
    note: row.note,
    method: row.method,
    amountCents: row.amount_cents,
    recordedBy: row.recorded_by,
    previousStatus: row.previous_status,
    reversedAt: row.reversed_at,
    reversedBy: row.reversed_by,
    reversalReason: row.reversal_reason,
    createdAt: row.created_at,
  }));
}

export type PaymentReversibility =
  | 'reversible'
  | 'already_reversed'
  | 'not_reversible'
  | 'not_latest'
  | 'period_changed';

/**
 * Quais linhas da lista o botão "Desfazer" pode valer (§4.5) — a mesma
 * decisão de `reverse_plan_payment`, para a tela não oferecer um clique
 * que o banco vai recusar. O banco continua sendo a garantia (409).
 *
 * `payments` vem do mais novo para o mais antigo (`listAccountPayments`).
 * Só o PRIMEIRO não estornado pode ser desfeito; os demais ficam
 * `not_latest`. O limite de 20 da lista não muda isso: o mais novo
 * sempre está nela.
 */
export function resolvePaymentReversibility(
  payments: readonly AccountPayment[],
  currentPeriodEnd: string | null
): Map<string, PaymentReversibility> {
  const result = new Map<string, PaymentReversibility>();
  let latestFound = false;
  for (const payment of payments) {
    if (payment.reversedAt !== null) {
      result.set(payment.id, 'already_reversed');
      continue;
    }
    if (latestFound) {
      result.set(payment.id, 'not_latest');
      continue;
    }
    latestFound = true;
    if (payment.previousStatus === null) {
      result.set(payment.id, 'not_reversible');
    } else if (
      currentPeriodEnd === null ||
      new Date(currentPeriodEnd).getTime() !==
        new Date(payment.newPeriodEnd).getTime()
    ) {
      result.set(payment.id, 'period_changed');
    } else {
      result.set(payment.id, 'reversible');
    }
  }
  return result;
}

export type DuplicateRef =
  'same_payment' | 'other_account' | 'reversed' | 'unknown';

/**
 * `apply_plan_renewal` devolveu `applied = false` (unique_violation em
 * `payment_ref`). `payment_ref` é UNIQUE na tabela inteira — todas as
 * contas, inclusive linhas estornadas — então "o banco recusou como
 * repetido" só é idempotência quando a linha existente é um pagamento
 * VIGENTE desta mesma conta. De quem é a linha que ocupa o identificador?
 *
 *   - desta conta e vigente → retentativa legítima (`already_applied`);
 *   - de OUTRA conta → nada foi aplicado aqui: identificador errado, ou o
 *     mesmo dinheiro atribuído a duas contas;
 *   - desta conta, mas estornado → a linha estornada mantém o
 *     `payment_ref` ocupado de propósito (089 §5: o sistema externo não
 *     pode reaplicar), então um novo registro precisa de outro
 *     identificador;
 *   - `unknown` → a leitura falhou ou a linha sumiu entre o INSERT e a
 *     consulta: não dá para afirmar "já aplicado".
 *
 * Compartilhado pelo console (`/api/platform/**`) e pela rota de máquina
 * (`/api/admin/**`): as duas dizem a mesma coisa sobre o mesmo
 * identificador.
 */
export async function resolveDuplicateRef(
  db: SupabaseClient,
  accountId: string,
  paymentRef: string
): Promise<DuplicateRef> {
  const { data, error } = await db
    .from('account_plan_payments')
    .select('account_id, reversed_at')
    .eq('payment_ref', paymentRef)
    .maybeSingle();
  if (error || !data) {
    console.error(
      '[plans/payments] duplicate payment_ref lookup failed:',
      error?.message ?? 'row not found'
    );
    return 'unknown';
  }
  const row = data as { account_id: string; reversed_at: string | null };
  if (row.account_id !== accountId) return 'other_account';
  if (row.reversed_at !== null) return 'reversed';
  return 'same_payment';
}
