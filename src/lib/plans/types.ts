/**
 * Fonte de verdade das chaves de quota e recurso (SPEC 059 §5).
 *
 * `plans.limits`/`plans.features` são JSONB no banco (sem CHECK sobre o
 * formato — ver migração 067 §2.2). É este arquivo, e o teste de
 * contrato em catalog.test.ts, que compensam a ausência do CHECK.
 */

/**
 * Quotas de **uso** — "quanto você pode ter". São as que têm um
 * contador do outro lado (contatos cadastrados, membros por papel,
 * canais conectados), e por isso são as únicas que viram barra de uso
 * na tela do cliente e linha no catálogo de planos.
 */
export const USAGE_QUOTA_KEYS = [
  'contacts',
  'members_total',
  'members_admin',
  'members_agent',
  'members_viewer',
  'channels_whatsapp_qr',
  'channels_whatsapp_cloud',
  // Formulários de captação (PRD 084 D-10, SPEC 085 §5.2/§5.3). Os três
  // têm contador em `account_usage_counters`: `forms` (não arquivados),
  // `form_responses:YYYY-MM` (concluídas no mês, America/Sao_Paulo) e
  // `form_upload_bytes` (a chave do plano é em MB; a conversão fica em
  // `account-plan.ts`).
  'forms',
  'form_responses_month',
  'form_upload_mb',
  // Base de conhecimento da IA (SPEC 089 D-20, migração 103): documentos
  // por conta, contador `knowledge_documents` em `account_usage_counters`.
  // Ausente = ilimitado.
  'knowledge_documents',
] as const;

export type UsageQuotaKey = (typeof USAGE_QUOTA_KEYS)[number];

/**
 * Limites de **segurança** por conta (SPEC 069 D-5, nível 1a): "com
 * que taxa você pode agir". Compartilham o mecanismo das quotas —
 * `plan_limit()`, `plans.limits`, `account_plans.limit_overrides` e a
 * validação da rota de plano — porque um mecanismo só é melhor que
 * dois, mas **não** são a mesma coisa na tela.
 *
 * Por que não entram na barra de uso do cliente (SPEC 069 §15.3)
 *
 *   "Envios frios por dia" ao lado de "contatos" faz o cliente ler o
 *   teto de segurança como algo que ele comprou e pode gastar. Não é:
 *   é o freio que protege o número dele. Quem edita esses valores é o
 *   proprietário, em `/admin`, e é lá que eles aparecem.
 *
 * Enumeradas à mão, e não derivadas de `ACCOUNT_CONFIGURABLE_LIMIT_KEYS`
 * em tempo de execução, porque `QuotaKey` precisa continuar sendo uma
 * união FECHADA: derivar a lista de um `.filter()` a colapsaria em
 * `string`, e todo `Record<QuotaKey, …>` do módulo deixaria de pegar
 * chave errada no `typecheck` — trocaríamos um limite escondido por
 * um tipo cego. A divergência entre as duas listas é fechada por teste
 * de contrato em `registry.test.ts`, que falha alto no minuto em que
 * alguém marcar `accountConfigurable: true` numa entrada nova sem
 * passar por aqui.
 */
export const SAFETY_QUOTA_KEYS = [
  'evolution_cold_send_silence_hours',
  'evolution_cold_send_per_hour',
  'evolution_cold_send_per_day',
  'evolution_cold_send_min_interval_seconds',
  'evolution_cold_send_warmup_days',
  'evolution_check_per_hour',
  'evolution_check_per_day',
  'evolution_check_min_interval_seconds',
  'evolution_check_batch_size',
  'evolution_harvest_per_run',
  'evolution_harvest_max_per_instance',
] as const;

export type SafetyQuotaKey = (typeof SAFETY_QUOTA_KEYS)[number];

/**
 * O contrato completo aceito em `plans.limits` e
 * `account_plans.limit_overrides` — uso + segurança. É esta lista que
 * `validateCatalog`/`validateOverrides` e a rota
 * `PUT /api/admin/accounts/[accountId]/plan` conferem.
 */
export const QUOTA_KEYS = [...USAGE_QUOTA_KEYS, ...SAFETY_QUOTA_KEYS] as const;

export type QuotaKey = UsageQuotaKey | SafetyQuotaKey;

export const FEATURE_KEYS = [
  'ai_enabled',
  'api_v1_enabled',
  'flows_enabled',
  'broadcasts_enabled',
  'webhooks_out_enabled',
  // Área do contato (PRD 082 D-1/D-2, SPEC 083 §5.4). Primeira chave que
  // bloqueia de verdade uma rota: lida por `plan_feature_strict()` (096),
  // fail-closed — chave ausente é FALSE. Mesmo assim o seed grava `false`
  // explícito nos quatro planos (D-1), e `catalog.test.ts` cobra isso.
  'contact_portal_enabled',
  // Formulários de captação (PRD 084 D-10/D-11). Mesma semântica estrita
  // da área: `plan_feature_strict()`, chave ausente é FALSE; o seed grava
  // o valor explícito em todo plano e `catalog.test.ts` cobra isso.
  'forms_enabled',
] as const;

export type FeatureKey = (typeof FEATURE_KEYS)[number];

export type PlanLimits = Partial<Record<QuotaKey, number>>;
export type PlanFeatures = Partial<Record<FeatureKey, boolean>>;

/**
 * `account_plans.limit_overrides` guarda os dois tipos de exceção por
 * conta (quota numérica e recurso booleano) num único JSONB.
 */
export type PlanOverrides = Partial<Record<QuotaKey, number>> &
  Partial<Record<FeatureKey, boolean>>;

export type BillingPeriod = 'monthly' | 'yearly' | 'custom' | 'none';

export interface Plan {
  id: string;
  code: string;
  name: string;
  description: string | null;
  priceCents: number;
  currency: string;
  billingPeriod: BillingPeriod;
  limits: PlanLimits;
  features: PlanFeatures;
  isPublic: boolean;
  isActive: boolean;
  sortOrder: number;
  /** SPEC 062 §3.4 — `null` usa o padrão da plataforma (D-5). */
  yearlyDiscountPercent: number | null;
}

export type AccountPlanStatus =
  'trialing' | 'active' | 'past_due' | 'suspended' | 'canceled';

export type BillingCycle = 'monthly' | 'yearly';
export type BillingSource = 'manual' | 'external' | 'gateway';

export interface AccountPlan {
  accountId: string;
  planId: string;
  status: AccountPlanStatus;
  trialEndsAt: string | null;
  currentPeriodEnd: string | null;
  limitOverrides: PlanOverrides;
  note: string | null;
  /** SPEC 062 §3.3 — ciclo de vida da assinatura. */
  billingCycle: BillingCycle;
  startedAt: string;
  cancelAtPeriodEnd: boolean;
  canceledAt: string | null;
  graceUntil: string | null;
  /** SPEC 062 §3.7 — cobrança externa. */
  billingSource: BillingSource;
  externalBillingRef: string | null;
  lastPaymentRef: string | null;
  lastPaymentAt: string | null;
}

export type UsageBucketStatus = 'ok' | 'warn' | 'full' | 'over';

export interface PlanUsageBucket {
  // Só chave de USO: o painel de uso do cliente não mostra limite de
  // segurança (SPEC 069 §15.3) — misturá-los faz "envios frios" passar
  // por algo que ele comprou.
  key: UsageQuotaKey;
  used: number;
  /** `null` = ilimitado. */
  limit: number | null;
  status: UsageBucketStatus;
}

export interface PlanUsage {
  buckets: PlanUsageBucket[];
}
