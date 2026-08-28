/**
 * Ciclo de vida e preço de assinatura (SPEC 062 §5.1).
 *
 * Puro, sem I/O — server e cliente podem importar o mesmo módulo (o
 * modal de troca de ciclo calcula o preço anual ao vivo enquanto o
 * desconto é digitado, §7.4). `computePeriodEnd` usa `date-fns`
 * (`addMonths`/`addYears`), que já resolve a armadilha de fim de mês —
 * a tentação de "otimizar" para `setMonth(+1)` é o que os testes
 * abaixo existem para barrar.
 */

import { addMonths, addYears } from 'date-fns';

import type { BillingPeriod, Plan } from './types';

export type BillingCycle = 'monthly' | 'yearly';

/**
 * `null` quando o plano não vence: `billing_period` é `'none'`/`'custom'`
 * (o Empresarial "sob medida" e o `unlimited` de backfill) ou o preço é
 * zero (o Grátis não vence). Migração 069 §3.3: nenhuma conta existente
 * sai com vencimento inventado — esta função é a mesma regra do lado do
 * app, para quando F8 gravar `current_period_end` pela primeira vez.
 */
export function computePeriodEnd(
  startedAt: Date | string,
  cycle: BillingCycle,
  plan: Pick<Plan, 'billingPeriod' | 'priceCents'>
): Date | null {
  if (!vencePorCiclo(plan.billingPeriod) || plan.priceCents === 0) {
    return null;
  }
  const start = typeof startedAt === 'string' ? new Date(startedAt) : startedAt;
  return cycle === 'yearly' ? addYears(start, 1) : addMonths(start, 1);
}

function vencePorCiclo(billingPeriod: BillingPeriod): boolean {
  return billingPeriod === 'monthly' || billingPeriod === 'yearly';
}

/** `plan.yearlyDiscountPercent ?? padrão da plataforma` (D-5). */
function resolveDiscount(
  plan:
    | Pick<Plan, 'yearlyDiscountPercent'>
    | { yearlyDiscountPercent?: number | null },
  defaultDiscountPercent: number
): number {
  const value = (plan as { yearlyDiscountPercent?: number | null })
    .yearlyDiscountPercent;
  return value ?? defaultDiscountPercent;
}

/**
 * `round(priceCents * 12 * (100 - d) / 100)`. `Math.round` no fim — sem
 * ele, `29900 × 12 × 0,83` (ou qualquer desconto que não seja múltiplo
 * "redondo" do preço) gera centavo fracionário, e um preço em centavos
 * não pode ser `29891.999...`.
 */
export function yearlyPriceCents(
  plan: Pick<Plan, 'priceCents' | 'yearlyDiscountPercent'>,
  defaultDiscountPercent: number
): number {
  const d = resolveDiscount(plan, defaultDiscountPercent);
  return Math.round((plan.priceCents * 12 * (100 - d)) / 100);
}

/** O número que o modal mostra: "economize R$ X" (§7.6). */
export function yearlySavingsCents(
  plan: Pick<Plan, 'priceCents' | 'yearlyDiscountPercent'>,
  defaultDiscountPercent: number
): number {
  return plan.priceCents * 12 - yearlyPriceCents(plan, defaultDiscountPercent);
}

/** Preço anual ÷ 12 — o "equivale a R$ X/mês" ao lado do preço anual. */
export function effectiveMonthlyCents(
  plan: Pick<Plan, 'priceCents' | 'yearlyDiscountPercent'>,
  defaultDiscountPercent: number
): number {
  return Math.round(yearlyPriceCents(plan, defaultDiscountPercent) / 12);
}

/**
 * `periodEnd === null` nunca é "vencido" — é a mesma regra que
 * `computePeriodEnd` já aplica na origem, repetida aqui porque quem lê
 * `current_period_end` do banco não tem o `Plan` por perto para
 * recalcular. `now` é parâmetro, nunca `Date.now()` interno: sem isso o
 * teste não consegue fixar a borda exata (§5.1, "mesmo instante → 0").
 */
export function isExpired(periodEnd: Date | string | null, now: Date): boolean {
  if (periodEnd === null) return false;
  const end = typeof periodEnd === 'string' ? new Date(periodEnd) : periodEnd;
  return now.getTime() > end.getTime();
}

/**
 * Dias até o vencimento. Negativo quando já venceu; `0` exatamente no
 * instante do vencimento (nunca `-0`). `null` quando o plano não vence.
 */
export function daysUntil(
  periodEnd: Date | string | null,
  now: Date
): number | null {
  if (periodEnd === null) return null;
  const end = typeof periodEnd === 'string' ? new Date(periodEnd) : periodEnd;
  const diffMs = end.getTime() - now.getTime();
  if (diffMs === 0) return 0;
  return Math.ceil(diffMs / (24 * 60 * 60 * 1000));
}

/** Fim da carência (§8, passo 2): `periodEnd + graceDays`. */
export function graceEnd(periodEnd: Date | string, graceDays: number): Date {
  const end = typeof periodEnd === 'string' ? new Date(periodEnd) : periodEnd;
  return new Date(end.getTime() + graceDays * 24 * 60 * 60 * 1000);
}

/**
 * Avança `periods` ciclos **a partir de `base`** (§6.2, passo 2) — o
 * chamador passa o vencimento ATUAL, nunca "agora": renovar no dia 3
 * um plano que venceu no dia 1 não pode empurrar o vencimento para o
 * dia 3 do mês seguinte, senão o cliente perde os dois dias entre o
 * vencimento e o pagamento a cada renovação. `date-fns` de novo pela
 * mesma razão de `computePeriodEnd` — `addMonths`/`addYears` aceitam
 * `periods` diretamente, sem laço.
 */
export function advancePeriod(
  base: Date | string,
  cycle: BillingCycle,
  periods: number
): Date {
  const start = typeof base === 'string' ? new Date(base) : base;
  return cycle === 'yearly'
    ? addYears(start, periods)
    : addMonths(start, periods);
}

export interface CycleChangeDescription {
  /** Novo vencimento após a troca — o período recomeça hoje (§7.6: sem pró-rata). */
  newPeriodEnd: Date | null;
  /**
   * `true` quando o plano de destino tem uma quota numérica menor que
   * o uso atual em pelo menos uma dimensão — o modal usa isto para
   * mostrar o alerta de overage no downgrade (§7.6).
   */
  hasOverageWarning: boolean;
  /** Chaves de quota onde o uso atual excederia o limite do novo plano. */
  overageKeys: string[];
}

/**
 * O texto do modal de troca de plano (§5.1): novo vencimento a partir
 * de hoje, e o alerta de overage quando o plano destino tem quota
 * menor que o uso atual em alguma dimensão.
 */
export function describeCycleChange(
  nextPlan: Pick<Plan, 'billingPeriod' | 'priceCents' | 'limits'>,
  nextCycle: BillingCycle,
  now: Date,
  currentUsage: Partial<Record<string, number>> = {}
): CycleChangeDescription {
  const newPeriodEnd = computePeriodEnd(now, nextCycle, nextPlan);

  const overageKeys = Object.entries(currentUsage)
    .filter(([key, used]) => {
      if (used === undefined) return false;
      const limit = nextPlan.limits[key as keyof typeof nextPlan.limits];
      return typeof limit === 'number' && used > limit;
    })
    .map(([key]) => key);

  return {
    newPeriodEnd,
    hasOverageWarning: overageKeys.length > 0,
    overageKeys,
  };
}
