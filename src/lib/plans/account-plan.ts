/**
 * getAccountPlan() — plano efetivo + uso da conta, numa chamada.
 *
 * Server-only: usa o cliente SSR (`@/lib/supabase/server`), sujeito a
 * RLS. Todas as tabelas lidas aqui (platform_settings, account_plans,
 * plans, account_usage_counters, profiles, channels) já têm policy de
 * SELECT para membro da conta (migração 067) — não precisa de
 * service_role.
 *
 * Dois lookups por id em vez de embed FK (`plans(*)`) — mesma cautela
 * de `getCurrentAccount` (src/lib/auth/account.ts): um embed logo após
 * a migração que criou a FK pode bater em cache de schema do PostgREST
 * ainda não invalidado (PGRST200).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

import { createClient } from '@/lib/supabase/server';
import {
  FORMS_METRIC,
  FORM_UPLOAD_BYTES_METRIC,
  bytesToMbCeil,
  monthMetricKey,
} from '@/lib/forms/quota';
import { aiToolCallsMetricKey } from '@/lib/ai/tools/quota';
import { bucketStatus } from './usage';
import {
  USAGE_QUOTA_KEYS,
  type AccountPlan,
  type Plan,
  type PlanUsage,
  type PlanUsageBucket,
  type UsageQuotaKey,
} from './types';

export interface AccountPlanSnapshot {
  quotasEnforced: boolean;
  plan: Plan;
  accountPlan: AccountPlan;
  usage: PlanUsage;
}

interface PlanRow {
  id: string;
  code: string;
  name: string;
  description: string | null;
  price_cents: number;
  currency: string;
  billing_period: Plan['billingPeriod'];
  limits: Plan['limits'];
  features: Plan['features'];
  is_public: boolean;
  is_active: boolean;
  sort_order: number;
  yearly_discount_percent: number | null;
}

function mapPlanRow(row: PlanRow): Plan {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    description: row.description,
    priceCents: row.price_cents,
    currency: row.currency,
    billingPeriod: row.billing_period,
    limits: row.limits ?? {},
    features: row.features ?? {},
    isPublic: row.is_public,
    isActive: row.is_active,
    sortOrder: row.sort_order,
    yearlyDiscountPercent: row.yearly_discount_percent,
  };
}

/**
 * `client` opcional: por padrão cria o cliente SSR (sessão do
 * dashboard, sujeito a RLS). `/api/v1/me` (chave de API, sem sessão)
 * passa o cliente service-role já resolvido por `requireApiKey` — RLS
 * de `platform_settings`/`account_plans` exige `auth.uid()`, que uma
 * chave de API não tem.
 */
export async function getAccountPlan(
  accountId: string,
  client?: SupabaseClient
): Promise<AccountPlanSnapshot> {
  const supabase = client ?? (await createClient());

  const { data: settings } = await supabase
    .from('platform_settings')
    .select('quotas_enforced')
    .maybeSingle();
  const quotasEnforced = settings?.quotas_enforced ?? false;

  const { data: apRow, error: apErr } = await supabase
    .from('account_plans')
    .select(
      'account_id, plan_id, status, trial_ends_at, current_period_end, limit_overrides, note, billing_cycle, started_at, cancel_at_period_end, canceled_at, grace_until, billing_source, external_billing_ref, last_payment_ref, last_payment_at'
    )
    .eq('account_id', accountId)
    .maybeSingle();

  if (apErr) {
    throw new Error(
      `[getAccountPlan] account_plans fetch error: ${apErr.message}`
    );
  }
  if (!apRow) {
    // Não deveria acontecer pós-067 (backfill + handle_new_user
    // atribuem plano a toda conta) — mas plan_limit()/plan_feature()
    // já falham aberto (ilimitado) nesse caso, então espelhamos aqui.
    throw new Error(
      `[getAccountPlan] account ${accountId} has no account_plans row`
    );
  }

  const { data: planRow, error: planErr } = await supabase
    .from('plans')
    .select(
      'id, code, name, description, price_cents, currency, billing_period, limits, features, is_public, is_active, sort_order'
    )
    .eq('id', apRow.plan_id)
    .maybeSingle();

  if (planErr || !planRow) {
    throw new Error(
      `[getAccountPlan] plan ${apRow.plan_id} not found: ${planErr?.message ?? 'no row'}`
    );
  }

  const plan = mapPlanRow(planRow as PlanRow);
  const accountPlan: AccountPlan = {
    accountId: apRow.account_id,
    planId: apRow.plan_id,
    status: apRow.status,
    trialEndsAt: apRow.trial_ends_at,
    currentPeriodEnd: apRow.current_period_end,
    limitOverrides: apRow.limit_overrides ?? {},
    note: apRow.note,
    billingCycle: apRow.billing_cycle,
    startedAt: apRow.started_at,
    cancelAtPeriodEnd: apRow.cancel_at_period_end,
    canceledAt: apRow.canceled_at,
    graceUntil: apRow.grace_until,
    billingSource: apRow.billing_source,
    externalBillingRef: apRow.external_billing_ref,
    lastPaymentRef: apRow.last_payment_ref,
    lastPaymentAt: apRow.last_payment_at,
  };

  const usage = await computeUsage(
    supabase,
    accountId,
    plan,
    accountPlan,
    quotasEnforced
  );

  return { quotasEnforced, plan, accountPlan, usage };
}

async function computeUsage(
  supabase: SupabaseClient,
  accountId: string,
  plan: Plan,
  accountPlan: AccountPlan,
  quotasEnforced: boolean
): Promise<PlanUsage> {
  // Formulários (SPEC 085 §5.3): os três contadores saem da mesma
  // tabela, numa consulta só. O do mês é a chave do mês CORRENTE em
  // America/Sao_Paulo — o mesmo literal de `form_month_metric()` (098).
  const formMetrics = [
    FORMS_METRIC,
    monthMetricKey(new Date()),
    FORM_UPLOAD_BYTES_METRIC,
    // SPEC 089 D-20: documentos da base de conhecimento (trigger da 103).
    'knowledge_documents',
    // SPEC 089 F5: chamadas de ferramenta do agente no mês (migração 106).
    aiToolCallsMetricKey(new Date()),
  ];

  const [
    { data: contactsCounter },
    { data: profileRows },
    { count: qrCount },
    { count: cloudCount },
    { data: formCounters },
  ] = await Promise.all([
    supabase
      .from('account_usage_counters')
      .select('value')
      .eq('account_id', accountId)
      .eq('metric', 'contacts')
      .maybeSingle(),
    supabase
      .from('profiles')
      .select('account_role')
      .eq('account_id', accountId),
    // `disabled` NÃO ocupa vaga (SPEC 064 D-5/D-12): é exatamente o
    // filtro de `enforce_channel_quota()` na migração 072. Sem ele o
    // medidor diverge do enforcement — a barra diria "1 de 1" e a
    // trigger deixaria conectar, ou pior, a pré-checagem da UI
    // bloquearia um número que o banco aceitaria.
    supabase
      .from('channels')
      .select('id', { count: 'exact', head: true })
      .eq('account_id', accountId)
      .eq('type', 'whatsapp_qr')
      .neq('status', 'disabled'),
    supabase
      .from('channels')
      .select('id', { count: 'exact', head: true })
      .eq('account_id', accountId)
      .eq('type', 'whatsapp_cloud')
      .neq('status', 'disabled'),
    supabase
      .from('account_usage_counters')
      .select('metric, value')
      .eq('account_id', accountId)
      .in('metric', formMetrics),
  ]);

  const formCounterByMetric = new Map<string, number>();
  for (const row of formCounters ?? []) {
    formCounterByMetric.set(row.metric as string, Number(row.value) || 0);
  }

  const roleCounts = { owner: 0, admin: 0, agent: 0, viewer: 0 };
  for (const row of profileRows ?? []) {
    const role = row.account_role as keyof typeof roleCounts;
    if (role in roleCounts) roleCounts[role]++;
  }
  // D-6: owner conta em members_total e também em members_admin.
  const membersTotal =
    roleCounts.owner + roleCounts.admin + roleCounts.agent + roleCounts.viewer;
  const membersAdmin = roleCounts.owner + roleCounts.admin;

  const usedByKey: Record<UsageQuotaKey, number> = {
    contacts: contactsCounter?.value ?? 0,
    members_total: membersTotal,
    members_admin: membersAdmin,
    members_agent: roleCounts.agent,
    members_viewer: roleCounts.viewer,
    channels_whatsapp_qr: qrCount ?? 0,
    channels_whatsapp_cloud: cloudCount ?? 0,
    forms: formCounterByMetric.get(FORMS_METRIC) ?? 0,
    form_responses_month: formCounterByMetric.get(formMetrics[1]) ?? 0,
    // Contador em bytes, chave do plano em MB: arredonda para CIMA, para
    // a barra nunca mostrar "0 de 100 MB" com 300 KB já ocupados.
    form_upload_mb: bytesToMbCeil(
      formCounterByMetric.get(FORM_UPLOAD_BYTES_METRIC) ?? 0
    ),
    knowledge_documents: formCounterByMetric.get('knowledge_documents') ?? 0,
    ai_tool_calls_month: formCounterByMetric.get(formMetrics[4]) ?? 0,
  };

  // USAGE_QUOTA_KEYS, não QUOTA_KEYS: as chaves de segurança da SPEC
  // 069 compartilham o mecanismo de plano, mas não são uso — não têm
  // contador e não viram barra na tela do cliente (§15.3).
  const buckets: PlanUsageBucket[] = USAGE_QUOTA_KEYS.map((key) => {
    // Espelha account_effective_limits() (migração 067 §8): com o
    // interruptor desligado, TODA quota é ilimitada — não só quando a
    // trigger é chamada, também quando a UI mostra a barra de uso.
    // Achado de code review: antes disto, a tela "Plano e uso" e a
    // pré-checagem de importação podiam bloquear algo que o banco
    // nunca teria bloqueado.
    const overrideValue = accountPlan.limitOverrides[key];
    const limit = !quotasEnforced
      ? null
      : overrideValue !== undefined
        ? overrideValue
        : (plan.limits[key] ?? null);
    const used = usedByKey[key];
    return { key, used, limit, status: bucketStatus(used, limit) };
  });

  return { buckets };
}
