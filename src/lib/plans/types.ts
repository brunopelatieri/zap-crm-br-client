/**
 * Fonte de verdade das chaves de quota e recurso (SPEC 059 §5).
 *
 * `plans.limits`/`plans.features` são JSONB no banco (sem CHECK sobre o
 * formato — ver migração 067 §2.2). É este arquivo, e o teste de
 * contrato em catalog.test.ts, que compensam a ausência do CHECK.
 */

export const QUOTA_KEYS = [
  'contacts',
  'members_total',
  'members_admin',
  'members_agent',
  'members_viewer',
  'channels_whatsapp_qr',
  'channels_whatsapp_cloud',
] as const;

export type QuotaKey = (typeof QUOTA_KEYS)[number];

export const FEATURE_KEYS = [
  'ai_enabled',
  'api_v1_enabled',
  'flows_enabled',
  'broadcasts_enabled',
  'webhooks_out_enabled',
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
}

export type AccountPlanStatus =
  'trialing' | 'active' | 'past_due' | 'suspended' | 'canceled';

export interface AccountPlan {
  accountId: string;
  planId: string;
  status: AccountPlanStatus;
  trialEndsAt: string | null;
  currentPeriodEnd: string | null;
  limitOverrides: PlanOverrides;
  note: string | null;
}

export type UsageBucketStatus = 'ok' | 'warn' | 'full' | 'over';

export interface PlanUsageBucket {
  key: QuotaKey;
  used: number;
  /** `null` = ilimitado. */
  limit: number | null;
  status: UsageBucketStatus;
}

export interface PlanUsage {
  buckets: PlanUsageBucket[];
}
