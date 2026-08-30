/**
 * Troca de plano/status/overrides de uma conta (SPEC 062 §5.2).
 *
 * Extraída de `PUT /api/admin/accounts/[accountId]/plan` — a lógica que
 * antes vivia só ali, servindo só ao `x-admin-secret`. Agora as DUAS
 * portas (`/api/admin/**` e `/api/platform/**`) chamam esta mesma
 * função, e é isso que faz o critério de F6 ser verificável POR
 * CONSTRUÇÃO: "a mesma ação produz a mesma linha em
 * `account_plan_events`", porque as duas portas literalmente executam
 * o mesmo código, mudando só o `actor` que cada uma monta.
 *
 * `/api/admin/plan-requests` (aprovar solicitação) e a futura
 * `/api/platform/requests` também chamam esta função para aplicar a
 * troca — a alternativa (cada rota reescrevendo "UPDATE account_plans +
 * INSERT account_plan_events") é exatamente a duplicação que este
 * módulo existe para eliminar. Ver `send.ts` (SPEC 048 F2) para o
 * mesmo raciocínio aplicado a "mandar uma mensagem".
 *
 * Vencimento (SPEC 062 §3.3.1, decisão B, 2026-08-30): trocar de plano por
 * aqui **herda** o `current_period_end` já existente — nunca reseta um
 * ciclo que já estava correndo. A regra completa (herda / calcula do
 * zero / limpa) é uma função pura em `@/lib/plans/billing.ts`
 * (`resolveExpiryOnPlanChange`) — este módulo só traduz o resultado
 * dela em colunas do `update`, nunca reimplementa a lógica.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

import { resolveExpiryOnPlanChange } from '@/lib/plans/billing';
import { validateOverrides } from '@/lib/plans/catalog';
import type { AccountPlanStatus, BillingPeriod } from '@/lib/plans/types';

export interface ChangeAccountPlanInput {
  accountId: string;
  /** Troca de plano por `code` — omitido ou igual ao atual não mexe em `plan_id`. */
  planCode?: string;
  status?: AccountPlanStatus;
  /** Omitido não mexe em `limit_overrides` — distinto de `{}`, que zera tudo. */
  limitOverrides?: Record<string, unknown>;
  note?: string;
  /** `'console:<email>'` ou o `actor` livre que `/api/admin/**` já aceitava. */
  actor: string;
  reason?: string | null;
}

export interface ChangedAccountPlan {
  accountId: string;
  planId: string;
  status: AccountPlanStatus;
  limitOverrides: Record<string, unknown>;
  note: string | null;
}

export type ChangeAccountPlanResult =
  | { ok: true; accountPlan: ChangedAccountPlan }
  | {
      ok: false;
      error:
        | 'account_not_found'
        | 'plan_not_found'
        | 'invalid_status'
        | 'invalid_overrides'
        | 'update_failed';
      details?: unknown;
    };

const VALID_STATUSES = new Set<AccountPlanStatus>([
  'trialing',
  'active',
  'past_due',
  'suspended',
  'canceled',
]);

/**
 * Aplica a troca e grava o evento, numa chamada. `db` é sempre
 * `service_role` — não existe policy de escrita em `account_plans` para
 * o cliente (migração 067).
 */
export async function changeAccountPlan(
  db: SupabaseClient,
  input: ChangeAccountPlanInput
): Promise<ChangeAccountPlanResult> {
  if (input.status !== undefined && !VALID_STATUSES.has(input.status)) {
    return { ok: false, error: 'invalid_status' };
  }
  if (input.limitOverrides !== undefined) {
    const validationErrors = validateOverrides(input.limitOverrides);
    if (validationErrors.length > 0) {
      return {
        ok: false,
        error: 'invalid_overrides',
        details: validationErrors,
      };
    }
  }

  const now = new Date();

  const { data: current, error: currentErr } = await db
    .from('account_plans')
    .select(
      'plan_id, status, limit_overrides, current_period_end, plans:plan_id (code)'
    )
    .eq('account_id', input.accountId)
    .maybeSingle();
  if (currentErr || !current) {
    return { ok: false, error: 'account_not_found' };
  }
  const currentPlanCode = (current.plans as unknown as { code: string } | null)
    ?.code;

  let nextPlanId = current.plan_id;
  let nextPlanCode = currentPlanCode ?? null;
  let nextPlanBillingPeriod: BillingPeriod | null = null;
  let nextPlanPriceCents: number | null = null;
  if (input.planCode !== undefined && input.planCode !== currentPlanCode) {
    const { data: plan } = await db
      .from('plans')
      .select('id, code, billing_period, price_cents')
      .eq('code', input.planCode)
      .maybeSingle();
    if (!plan) {
      return { ok: false, error: 'plan_not_found' };
    }
    nextPlanId = plan.id;
    nextPlanCode = plan.code;
    nextPlanBillingPeriod = plan.billing_period;
    nextPlanPriceCents = plan.price_cents;
  }

  const nextStatus = input.status ?? (current.status as AccountPlanStatus);
  const planChanged = nextPlanId !== current.plan_id;

  const update: Record<string, unknown> = {
    plan_id: nextPlanId,
    status: nextStatus,
    updated_by: input.actor,
    updated_at: now.toISOString(),
  };
  if (input.limitOverrides !== undefined)
    update.limit_overrides = input.limitOverrides;
  if (input.note !== undefined) update.note = input.note;

  // SPEC 062 §3.3.1 (decisão B): ver o docstring do módulo e de
  // `resolveExpiryOnPlanChange` para o raciocínio completo.
  if (planChanged) {
    const expiry = resolveExpiryOnPlanChange(
      current.current_period_end,
      {
        billingPeriod: nextPlanBillingPeriod as BillingPeriod,
        priceCents: nextPlanPriceCents ?? 0,
      },
      now
    );
    if (expiry.kind === 'cleared') {
      update.current_period_end = null;
      update.cancel_at_period_end = false;
      update.canceled_at = null;
      update.grace_until = null;
    } else if (expiry.kind === 'started') {
      update.current_period_end = expiry.currentPeriodEnd.toISOString();
      update.started_at = expiry.startedAt.toISOString();
      update.billing_cycle = expiry.billingCycle;
    }
    // expiry.kind === 'inherit': nada a gravar.

    // Achado de code review: um `status` que vira 'canceled' na MESMA
    // chamada que troca o plano não pode conviver com um vencimento
    // (herdado ou recém-calculado) sem `canceled_at` — senão a conta
    // aparenta uma renovação futura "ativa" que já foi cancelada aqui.
    // Cobre os dois sub-casos de `expiry.kind` que deixam a conta com
    // vencimento (`'inherit'` e `'started'`) — só `'cleared'` já não
    // tem vencimento nenhum para este problema existir.
    if (nextStatus === 'canceled' && expiry.kind !== 'cleared') {
      update.canceled_at = now.toISOString();
      update.cancel_at_period_end = false;
    }
  }

  const { data: updated, error: updateErr } = await db
    .from('account_plans')
    .update(update)
    .eq('account_id', input.accountId)
    .select('account_id, plan_id, status, limit_overrides, note')
    .single();

  if (updateErr || !updated) {
    console.error('[plan-actions] changeAccountPlan update error:', updateErr);
    return { ok: false, error: 'update_failed' };
  }

  // Histórico append-only — nunca derruba a resposta por causa dele
  // (mesma postura de platform_audit_log em block.ts), mas registra o
  // erro: uma troca sem rastro é o pior desfecho aqui.
  const { error: eventErr } = await db.from('account_plan_events').insert({
    account_id: input.accountId,
    from_plan_code: currentPlanCode ?? null,
    to_plan_code: nextPlanCode,
    from_status: current.status,
    to_status: nextStatus,
    // Ecoa o valor JÁ PERSISTIDO, não o que veio no input: quando
    // `limitOverrides` não foi tocado nesta chamada, isto grava o valor
    // ATUAL (achado de code review original, SPEC 059) — nunca deixa
    // cair no default `{}` da coluna, senão o histórico (append-only)
    // passaria a mentir que os overrides foram zerados.
    overrides_after: updated.limit_overrides ?? {},
    actor: input.actor,
    reason: input.reason ?? null,
  });
  if (eventErr) {
    console.error(
      '[plan-actions] changeAccountPlan event insert error:',
      eventErr
    );
  }

  return {
    ok: true,
    accountPlan: {
      accountId: updated.account_id,
      planId: updated.plan_id,
      status: updated.status,
      limitOverrides: updated.limit_overrides ?? {},
      note: updated.note ?? null,
    },
  };
}
