/**
 * Alterar o vencimento do plano de uma conta (SPEC 078 §3, §7).
 *
 * Server-only (recebe um cliente `service_role`). A escrita em si é a
 * função Postgres `set_plan_period_end` (migração 089) — não um
 * `select` + `update` pelo supabase-js: uma renovação chegando entre os
 * dois passos teria o avanço sobrescrito, e a auditoria gravaria um
 * "valor anterior" que já não era o anterior (§3.2).
 *
 * Validação de entrada (formato, faixa de datas) é de
 * `validatePeriodEndInput`, em `manual-billing.ts` — a rota valida antes
 * de chamar esta função; o banco repete a faixa sob o lock da linha.
 *
 * Mesmo desenho de `billing-renew.ts`: erros de negócio da função chegam
 * pelo TEXTO da exceção (o PostgREST só expõe `.message`).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

import type { BillingCycle } from './billing';
import type { AccountPlanStatus } from './types';

export interface SetPeriodEndInput {
  accountId: string;
  /** `YYYY-MM-DD` no calendário de São Paulo (D-2). */
  date: string;
  /** Omitido/`null` mantém o ciclo atual da conta (D-4). */
  billingCycle?: BillingCycle | null;
  /** `'console:<email>'` — vai para `account_plans.updated_by`. */
  actor: string;
}

export interface PeriodEndChange {
  previousPeriodEnd: string | null;
  newPeriodEnd: string;
  previousStatus: AccountPlanStatus;
  newStatus: AccountPlanStatus;
  billingCycle: BillingCycle;
}

export type SetPeriodEndResult =
  | { ok: true; change: PeriodEndChange }
  | {
      ok: false;
      error:
        | 'account_not_found'
        | 'no_billing_cycle'
        | 'period_end_out_of_range'
        | 'invalid_billing_cycle'
        | 'update_failed';
    };

interface SetPlanPeriodEndRow {
  previous_period_end: string | null;
  new_period_end: string;
  previous_status: AccountPlanStatus;
  new_status: AccountPlanStatus;
  billing_cycle: BillingCycle;
}

export async function setPlanPeriodEnd(
  db: SupabaseClient,
  input: SetPeriodEndInput
): Promise<SetPeriodEndResult> {
  const { data, error } = await db.rpc('set_plan_period_end', {
    p_account_id: input.accountId,
    p_date: input.date,
    p_billing_cycle: input.billingCycle ?? null,
    p_actor: input.actor,
  });

  if (error) {
    const message = error.message ?? '';
    if (message.includes('ACCOUNT_NOT_FOUND')) {
      return { ok: false, error: 'account_not_found' };
    }
    if (message.includes('NO_BILLING_CYCLE')) {
      return { ok: false, error: 'no_billing_cycle' };
    }
    if (message.includes('PERIOD_END_OUT_OF_RANGE')) {
      return { ok: false, error: 'period_end_out_of_range' };
    }
    if (message.includes('INVALID_BILLING_CYCLE')) {
      return { ok: false, error: 'invalid_billing_cycle' };
    }
    console.error('[plans/period-end] set_plan_period_end RPC failed:', error);
    return { ok: false, error: 'update_failed' };
  }

  const row = (Array.isArray(data) ? data[0] : data) as
    SetPlanPeriodEndRow | undefined;
  if (!row) {
    console.error('[plans/period-end] set_plan_period_end returned no row');
    return { ok: false, error: 'update_failed' };
  }

  return {
    ok: true,
    change: {
      previousPeriodEnd: row.previous_period_end,
      newPeriodEnd: row.new_period_end,
      previousStatus: row.previous_status,
      newStatus: row.new_status,
      billingCycle: row.billing_cycle,
    },
  };
}
