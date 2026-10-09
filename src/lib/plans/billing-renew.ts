/**
 * Renovação externa (SPEC 062 §6.2, PRD §5.2, D-14) — a porta que
 * representa o sistema de cobrança inteiro do produto. Não existe
 * gateway de pagamento integrado (`billing_source` prevê `'gateway'`
 * SEM nada implementado, §3.7) — todo vencimento avança por aqui, à
 * mão ou por uma automação simples do lado de fora, e é o proprietário
 * quem tem o controle completo do ciclo/vencimento de cada conta,
 * mensal ou anual, sem um gateway real por trás.
 *
 * A aplicação em si é a função Postgres `apply_plan_renewal`
 * (migração 071) — não código TypeScript com duas idas ao banco. Achado
 * de code review sobre a versão anterior: a idempotência comparava o
 * `paymentRef` recebido contra o ÚNICO valor guardado em
 * `account_plans.last_payment_ref`, o que reconhece a retentativa mais
 * RECENTE mas não uma retentativa de um pagamento mais ANTIGO depois
 * que outro já sobrescreveu a coluna — o período avançava pela segunda
 * vez para o mesmo pagamento. A correção precisa de um LOG de
 * pagamentos aplicados (tabela `account_plan_payments`, com
 * `UNIQUE(payment_ref)`), não um campo só — e a checagem+escrita
 * precisa ser ATÔMICA (mesma transação), senão a janela de corrida só
 * muda de lugar. As duas coisas exigem estar dentro do banco, não numa
 * sequência de chamadas `supabase-js` — daí a função.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

import type { PaymentMethod } from './manual-billing';

export interface RenewInput {
  accountId: string;
  paymentRef: string;
  paidAt: string | null;
  periods: number;
  /** Referência do sistema externo (nota fiscal, id de conciliação). */
  externalRef?: string | null;
  /** Nota livre do operador. */
  note?: string | null;
  /**
   * SPEC 078 §4.3 — quem registrou (`'console:<email>'`). Omitido, a
   * função grava `'api:billing-renew'`, que é o que separa "o sistema
   * externo renovou" de "registrei à mão" no histórico de pagamentos.
   */
  actor?: string | null;
  /** Forma do pagamento (`PaymentMethod`) — registro informativo (D-7). */
  method?: PaymentMethod | null;
  /** Valor em centavos — registro informativo, não concilia (D-7). */
  amountCents?: number | null;
}

export interface RenewedPlan {
  currentPeriodEnd: string | null;
  status: string;
}

export type RenewResult =
  | { ok: true; status: 'applied'; accountPlan: RenewedPlan }
  | { ok: true; status: 'already_applied' }
  | {
      ok: false;
      error: 'account_not_found' | 'no_billing_cycle' | 'update_failed';
    };

interface ApplyPlanRenewalRow {
  applied: boolean;
  current_period_end: string | null;
  status: string;
}

export async function renewAccountPlan(
  db: SupabaseClient,
  input: RenewInput
): Promise<RenewResult> {
  // Os três parâmetros da 089 só saem quando informados: a rota de
  // máquina (`/api/admin/.../billing/renew`) não os conhece, e o mesmo
  // payload de 6 nomes continua válido para a função de 9 parâmetros
  // (todos `DEFAULT NULL`) — e também para um banco que ainda não
  // recebeu a migração.
  const { data, error } = await db.rpc('apply_plan_renewal', {
    p_account_id: input.accountId,
    p_payment_ref: input.paymentRef,
    p_paid_at: input.paidAt,
    p_periods: input.periods,
    p_external_ref: input.externalRef ?? null,
    p_note: input.note ?? null,
    ...(input.actor != null && { p_actor: input.actor }),
    ...(input.method != null && { p_method: input.method }),
    ...(input.amountCents != null && { p_amount_cents: input.amountCents }),
  });

  if (error) {
    // A função sinaliza os dois erros de negócio pelo TEXTO da
    // exceção (mesmo padrão de `QUOTA_EXCEEDED:` em
    // `src/lib/plans/errors.ts` — o PostgREST não expõe um ERRCODE
    // customizado utilizável aqui, só `.message`).
    const message = error.message ?? '';
    if (message.includes('ACCOUNT_NOT_FOUND')) {
      return { ok: false, error: 'account_not_found' };
    }
    if (message.includes('NO_BILLING_CYCLE')) {
      return { ok: false, error: 'no_billing_cycle' };
    }
    console.error(
      '[plans/billing-renew] apply_plan_renewal RPC failed:',
      error
    );
    return { ok: false, error: 'update_failed' };
  }

  // Função `RETURNS TABLE` — supabase-js devolve um array; a função
  // sempre grava exatamente uma linha em cada caminho de sucesso (o
  // early-return de duplicata ou o final), nunca zero.
  const row = (Array.isArray(data) ? data[0] : data) as
    ApplyPlanRenewalRow | undefined;
  if (!row) {
    console.error('[plans/billing-renew] apply_plan_renewal returned no row');
    return { ok: false, error: 'update_failed' };
  }

  if (!row.applied) {
    return { ok: true, status: 'already_applied' };
  }

  return {
    ok: true,
    status: 'applied',
    accountPlan: {
      currentPeriodEnd: row.current_period_end,
      status: row.status,
    },
  };
}
