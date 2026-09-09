/**
 * Autosserviço de plano (SPEC 062 §6.1, §7.6, D-3): o cliente troca de
 * plano/ciclo sozinho, sem passar pela fila de aprovação da SPEC 059
 * (`plan_change_requests`). Duas ações, um arquivo — `applyPlanChange`
 * (troca imediata) e `setCancelAtPeriodEnd` (agendar/reverter
 * cancelamento) — porque as duas mexem nas mesmas colunas de
 * `account_plans` e compartilham a mesma guarda de pré-condição
 * (`self_service_enabled`).
 *
 * `changeAccountPlan` (`@/lib/platform/plan-actions.ts`) continua sendo
 * a rota do OPERADOR (`/api/admin/**` e `/api/platform/**`) — não é
 * reaproveitada aqui porque ela não conhece ciclo/vencimento, e
 * misturar as duas responsabilidades numa função só criaria um branch
 * "se for autosserviço, também mexe em started_at" dentro de um código
 * que hoje não precisa saber disso.
 *
 * Sempre `service_role`: não existe policy de escrita em `account_plans`
 * para o cliente (migração 067) — a guarda de quem pode chamar isto é
 * `requireRole('admin')` na rota, não RLS.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

import { dispatchWebhookEvent } from '@/lib/webhooks/deliver';
import { emitSystemEvent } from '@/lib/notifications/emit';
import { recordActivity } from '@/lib/activity/record';
import { computePeriodEnd, type BillingCycle } from './billing';
import type { AccountPlanStatus, BillingPeriod } from './types';

export interface ApplyPlanChangeInput {
  accountId: string;
  planId: string;
  billingCycle: BillingCycle;
  /** `self-service:<email>` — montado pelo chamador (rota), não aqui. */
  actor: string;
  now?: Date;
}

export interface ChangedSelfServicePlan {
  planId: string;
  planCode: string;
  billingCycle: BillingCycle;
  startedAt: string;
  currentPeriodEnd: string | null;
  status: AccountPlanStatus;
  cancelAtPeriodEnd: boolean;
}

export type ApplyPlanChangeResult =
  | { ok: true; accountPlan: ChangedSelfServicePlan }
  | {
      ok: false;
      error:
        | 'self_service_disabled'
        | 'plan_not_available'
        | 'account_not_found'
        | 'account_past_due'
        | 'update_failed';
    };

interface PlanRow {
  id: string;
  code: string;
  name: string;
  billing_period: BillingPeriod;
  price_cents: number;
  yearly_discount_percent: number | null;
}

/**
 * Troca imediata de plano + ciclo (§6.1: "aplica na hora para plano
 * público e ativo, com self_service_enabled ligado"). O período
 * **recomeça hoje, sem pró-rata** (§7.6) — é por isso que `started_at`
 * é sempre `now`, nunca o `started_at` anterior.
 */
export async function applyPlanChange(
  db: SupabaseClient,
  input: ApplyPlanChangeInput
): Promise<ApplyPlanChangeResult> {
  const now = input.now ?? new Date();

  const { data: settings } = await db
    .from('platform_settings')
    .select('self_service_enabled')
    .maybeSingle();
  if (settings?.self_service_enabled !== true) {
    return { ok: false, error: 'self_service_disabled' };
  }

  // `is_public && is_active`, checado de novo aqui — nunca confiar só
  // no catálogo que o cliente já viu na tela (§6.1: "plano público e
  // ativo"; um id de plano sob medida ou desativado não pode entrar
  // por esta porta mesmo que o corpo da requisição force o id certo).
  const { data: plan } = await db
    .from('plans')
    .select(
      'id, code, name, billing_period, price_cents, yearly_discount_percent'
    )
    .eq('id', input.planId)
    .eq('is_public', true)
    .eq('is_active', true)
    .maybeSingle();
  if (!plan) {
    return { ok: false, error: 'plan_not_available' };
  }
  const planRow = plan as PlanRow;

  const { data: current, error: currentErr } = await db
    .from('account_plans')
    .select('status, plans:plan_id (code), accounts:account_id (name)')
    .eq('account_id', input.accountId)
    .maybeSingle();
  if (currentErr || !current) {
    return { ok: false, error: 'account_not_found' };
  }
  const fromPlanCode =
    (current.plans as unknown as { code: string } | null)?.code ?? null;
  const fromStatus = current.status as AccountPlanStatus;
  const accountName =
    (current.accounts as unknown as { name: string } | null)?.name ?? 'Conta';

  // Achado de code review: sem esta guarda, uma conta `past_due` ou
  // `suspended` reinstala a si mesma — status volta a `active`,
  // `grace_until` é limpo e um `current_period_end` novo é gravado —
  // sem que nenhum pagamento tenha acontecido (D-14: cobrança é
  // EXTERNA; o autosserviço não é o mecanismo que confirma pagamento).
  // Essas duas transições só saem por `billing/renew` (pagamento
  // confirmado) ou pelo console (`changeAccountPlan`, decisão do
  // proprietário) — nunca pelo próprio cliente clicando em "trocar
  // plano".
  if (fromStatus === 'past_due' || fromStatus === 'suspended') {
    return { ok: false, error: 'account_past_due' };
  }

  const periodEnd = computePeriodEnd(now, input.billingCycle, {
    billingPeriod: planRow.billing_period,
    priceCents: planRow.price_cents,
  });

  const { data: updated, error: updateErr } = await db
    .from('account_plans')
    .update({
      plan_id: planRow.id,
      billing_cycle: input.billingCycle,
      started_at: now.toISOString(),
      current_period_end: periodEnd ? periodEnd.toISOString() : null,
      status: 'active',
      cancel_at_period_end: false,
      canceled_at: null,
      grace_until: null,
      updated_by: input.actor,
      updated_at: now.toISOString(),
    })
    .eq('account_id', input.accountId)
    .select(
      'plan_id, status, billing_cycle, started_at, current_period_end, cancel_at_period_end, limit_overrides'
    )
    .single();

  if (updateErr || !updated) {
    console.error('[self-service] applyPlanChange update error:', updateErr);
    return { ok: false, error: 'update_failed' };
  }

  const { error: eventErr } = await db.from('account_plan_events').insert({
    account_id: input.accountId,
    from_plan_code: fromPlanCode,
    to_plan_code: planRow.code,
    from_status: fromStatus,
    to_status: 'active',
    // Ecoa o valor persistido — a troca de ciclo não mexe em overrides,
    // e o histórico (append-only) não pode sugerir que zerou algo que
    // continua lá (mesmo cuidado de plan-actions.ts).
    overrides_after: updated.limit_overrides ?? {},
    actor: input.actor,
    reason: null,
  });
  if (eventErr) {
    console.error(
      '[self-service] applyPlanChange event insert error:',
      eventErr
    );
  }

  // SPEC 075 F4 — `input.actor` já vem como uma tag ("self-service:
  // <email>"), não um `userId`; `system` com o nome é o que dá para
  // registrar sem reabrir a assinatura só para isto.
  await recordActivity(db, {
    accountId: input.accountId,
    resourceType: 'plan',
    action: 'plan.changed',
    resourceLabel: planRow.code,
    actor: { kind: 'system', name: input.actor },
    source: { table: 'account_plan_events', id: input.accountId },
    metadata: { from_plan_code: fromPlanCode, to_plan_code: planRow.code },
  });

  await dispatchWebhookEvent(db, input.accountId, 'plan.changed', {
    fromPlanCode,
    toPlanCode: planRow.code,
    billingCycle: updated.billing_cycle,
    currentPeriodEnd: updated.current_period_end,
  });
  await emitSystemEvent(
    {
      type: 'plan.changed',
      accountId: input.accountId,
      account: { id: input.accountId, name: accountName, ownerEmail: null },
      actor: input.actor,
      data: {
        plan: {
          fromPlanCode,
          toPlanCode: planRow.code,
          toPlanName: planRow.name,
          billingCycle: updated.billing_cycle,
          priceCents: planRow.price_cents,
          currency: 'BRL',
          currentPeriodEnd: updated.current_period_end,
        },
      },
    },
    db,
    now
  );

  return {
    ok: true,
    accountPlan: {
      planId: updated.plan_id,
      planCode: planRow.code,
      billingCycle: updated.billing_cycle,
      startedAt: updated.started_at,
      currentPeriodEnd: updated.current_period_end,
      status: updated.status,
      cancelAtPeriodEnd: updated.cancel_at_period_end,
    },
  };
}

export type SetCancelResult =
  | { ok: true; cancelAtPeriodEnd: boolean }
  | {
      ok: false;
      error:
        | 'self_service_disabled'
        | 'account_not_found'
        | 'no_period_end'
        | 'update_failed';
    };

/**
 * Agenda (`scheduled = true`) ou reverte (`scheduled = false`) o
 * cancelamento no fim do período atual (§6.1, §7.6). Nunca derruba o
 * acesso agora — só marca a intenção; quem efetiva é `lifecycle.ts`
 * quando o vencimento chegar (§8, passo 2).
 */
export async function setCancelAtPeriodEnd(
  db: SupabaseClient,
  accountId: string,
  scheduled: boolean,
  now: Date = new Date(),
  actor: string | null = null
): Promise<SetCancelResult> {
  const { data: settings } = await db
    .from('platform_settings')
    .select('self_service_enabled')
    .maybeSingle();
  if (settings?.self_service_enabled !== true) {
    return { ok: false, error: 'self_service_disabled' };
  }

  const { data: current, error: currentErr } = await db
    .from('account_plans')
    .select(
      'status, current_period_end, limit_overrides, plans:plan_id (code), accounts:account_id (name)'
    )
    .eq('account_id', accountId)
    .maybeSingle();
  if (currentErr || !current) {
    return { ok: false, error: 'account_not_found' };
  }
  // Um plano sem vencimento (`billing_period` 'none'/'custom') nunca
  // teria `lifecycle.ts` para efetivar o cancelamento — agendar aqui
  // seria uma promessa que o cron nunca cumpre.
  if (scheduled && current.current_period_end === null) {
    return { ok: false, error: 'no_period_end' };
  }

  const { error: updateErr } = await db
    .from('account_plans')
    .update({
      cancel_at_period_end: scheduled,
      canceled_at: scheduled ? now.toISOString() : null,
      // Achado de code review: faltava aqui — sem `updated_by`, o
      // histórico da conta (`/admin/accounts/[id]`) atribui esta
      // mudança a quem quer que tenha tocado a linha por último (o
      // cron de vencimento, uma troca de plano anterior…), nunca a
      // quem realmente clicou em cancelar.
      updated_by: actor,
      updated_at: now.toISOString(),
    })
    .eq('account_id', accountId);

  if (updateErr) {
    console.error(
      '[self-service] setCancelAtPeriodEnd update error:',
      updateErr
    );
    return { ok: false, error: 'update_failed' };
  }

  const planCode =
    (current.plans as unknown as { code: string } | null)?.code ?? null;
  const accountName =
    (current.accounts as unknown as { name: string } | null)?.name ?? 'Conta';

  // Achado de code review: `applyPlanChange` grava `account_plan_events`
  // e dispara o webhook POR CONTA para toda outra transição de plano —
  // cancelar/reverter fazia só metade disso (só a outbox do
  // proprietário, `emitSystemEvent`, abaixo). `from`/`to` são iguais
  // dos dois lados porque esta transição não muda plano nem status, só
  // `cancel_at_period_end` — mesmo padrão do ramo "vencido sem
  // cancelamento agendado" de `lifecycle.ts` (a coluna é `NOT NULL`,
  // então precisa de um valor mesmo quando "nada mudou aqui").
  const { error: eventErr } = await db.from('account_plan_events').insert({
    account_id: accountId,
    from_plan_code: planCode,
    to_plan_code: planCode,
    from_status: current.status,
    to_status: current.status,
    overrides_after: current.limit_overrides ?? {},
    // `account_plan_events.actor` é `NOT NULL` (067); `updated_by` na
    // linha de `account_plans` acima, essa sim, pode ficar `null` — são
    // colunas com contratos diferentes, então não usam o mesmo fallback.
    actor: actor ?? 'self-service:unknown',
    reason: scheduled
      ? 'self-service: cancel scheduled at period end'
      : 'self-service: scheduled cancellation reverted',
  });
  if (eventErr) {
    console.error(
      '[self-service] setCancelAtPeriodEnd event insert error:',
      eventErr
    );
  }

  const webhookData = {
    planCode,
    currentPeriodEnd: current.current_period_end,
  };
  await dispatchWebhookEvent(
    db,
    accountId,
    scheduled ? 'plan.canceled' : 'plan.cancel_reverted',
    webhookData
  );
  await emitSystemEvent(
    {
      type: scheduled ? 'plan.canceled' : 'plan.cancel_reverted',
      accountId,
      account: { id: accountId, name: accountName, ownerEmail: null },
      actor,
      data: { plan: webhookData },
    },
    db,
    now
  );

  return { ok: true, cancelAtPeriodEnd: scheduled };
}
