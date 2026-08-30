import { describe, expect, it } from 'vitest';

import {
  advancePeriod,
  computePeriodEnd,
  daysUntil,
  describeCycleChange,
  effectiveMonthlyCents,
  graceEnd,
  isExpired,
  resolveExpiryOnPlanChange,
  yearlyPriceCents,
  yearlySavingsCents,
} from './billing';
import type { Plan } from './types';

function makePlan(overrides: Partial<Plan> = {}): Plan {
  return {
    id: 'plan-1',
    code: 'pro',
    name: 'Profissional',
    description: null,
    priceCents: 34900,
    currency: 'BRL',
    billingPeriod: 'monthly',
    limits: {},
    features: {},
    isPublic: true,
    isActive: true,
    sortOrder: 1,
    yearlyDiscountPercent: null,
    ...overrides,
  };
}

describe('computePeriodEnd', () => {
  it('adesão em 31/01 com ciclo mensal cai em 28/02 (não 03/03)', () => {
    const start = new Date('2026-01-31T12:00:00Z');
    const result = computePeriodEnd(start, 'monthly', makePlan());
    expect(result).not.toBeNull();
    expect(result!.getUTCMonth()).toBe(1); // fevereiro
    expect(result!.getUTCDate()).toBe(28);
  });

  it('adesão em 31/01 com ciclo mensal cai em 29/02 em ano bissexto', () => {
    const start = new Date('2028-01-31T12:00:00Z'); // 2028 é bissexto
    const result = computePeriodEnd(start, 'monthly', makePlan());
    expect(result!.getUTCMonth()).toBe(1);
    expect(result!.getUTCDate()).toBe(29);
  });

  it('ciclo anual sobre 29/02 cai em 28/02 do ano seguinte', () => {
    const start = new Date('2028-02-29T12:00:00Z');
    const result = computePeriodEnd(start, 'yearly', makePlan());
    expect(result!.getUTCFullYear()).toBe(2029);
    expect(result!.getUTCMonth()).toBe(1);
    expect(result!.getUTCDate()).toBe(28);
  });

  it('billing_period=none nunca vence', () => {
    const plan = makePlan({ billingPeriod: 'none' });
    expect(computePeriodEnd(new Date(), 'monthly', plan)).toBeNull();
  });

  it('billing_period=custom nunca vence', () => {
    const plan = makePlan({ billingPeriod: 'custom' });
    expect(computePeriodEnd(new Date(), 'yearly', plan)).toBeNull();
  });

  it('plano de preço zero (Grátis) nunca vence', () => {
    const plan = makePlan({ priceCents: 0 });
    expect(computePeriodEnd(new Date(), 'monthly', plan)).toBeNull();
  });
});

describe('yearlyPriceCents / yearlySavingsCents / effectiveMonthlyCents', () => {
  it('desconto 0 é exatamente 12x o preço mensal', () => {
    const plan = makePlan({ priceCents: 10000 });
    expect(yearlyPriceCents(plan, 0)).toBe(120000);
    expect(yearlySavingsCents(plan, 0)).toBe(0);
  });

  it('desconto 100 zera o preço anual', () => {
    const plan = makePlan({ priceCents: 10000 });
    expect(yearlyPriceCents(plan, 100)).toBe(0);
    expect(yearlySavingsCents(plan, 100)).toBe(120000);
  });

  it('yearlyDiscountPercent do plano vence o padrão da plataforma', () => {
    const plan = makePlan({ priceCents: 10000, yearlyDiscountPercent: 50 });
    expect(yearlyPriceCents(plan, 17)).toBe(60000);
  });

  it('desconto padrão (17%) não gera centavo fracionário', () => {
    const plan = makePlan({ priceCents: 29900 });
    const price = yearlyPriceCents(plan, 17);
    expect(Number.isInteger(price)).toBe(true);
    // 29900 * 12 * 0.83 = 297756 exato, mas o arredondamento tem que
    // valer mesmo quando a conta não é redonda.
    expect(price).toBe(Math.round((29900 * 12 * 83) / 100));
  });

  it('arredondamento cobre desconto que produz fração', () => {
    const plan = makePlan({ priceCents: 33300, yearlyDiscountPercent: 13 });
    const price = yearlyPriceCents(plan, 17);
    expect(Number.isInteger(price)).toBe(true);
  });

  it('effectiveMonthlyCents é o preço anual dividido por 12', () => {
    const plan = makePlan({ priceCents: 10000, yearlyDiscountPercent: 0 });
    expect(effectiveMonthlyCents(plan, 17)).toBe(10000);
  });
});

describe('isExpired / daysUntil', () => {
  it('periodEnd null nunca é vencido', () => {
    expect(isExpired(null, new Date())).toBe(false);
    expect(daysUntil(null, new Date())).toBeNull();
  });

  it('mesmo instante do vencimento não é "vencido" e daysUntil é 0 (não -0 nem 1)', () => {
    const end = new Date('2026-06-01T00:00:00Z');
    expect(isExpired(end, end)).toBe(false);
    const days = daysUntil(end, end);
    expect(days).toBe(0);
    expect(Object.is(days, -0)).toBe(false);
  });

  it('um segundo após o vencimento já é vencido', () => {
    const end = new Date('2026-06-01T00:00:00Z');
    const now = new Date(end.getTime() + 1000);
    expect(isExpired(end, now)).toBe(true);
  });

  it('daysUntil negativo quando já venceu', () => {
    const end = new Date('2026-06-01T00:00:00Z');
    const now = new Date('2026-06-03T00:00:00Z');
    expect(daysUntil(end, now)).toBeLessThan(0);
  });
});

describe('graceEnd', () => {
  it('soma graceDays em dias corridos', () => {
    const periodEnd = new Date('2026-06-01T00:00:00Z');
    const result = graceEnd(periodEnd, 7);
    expect(result.getTime() - periodEnd.getTime()).toBe(
      7 * 24 * 60 * 60 * 1000
    );
  });
});

describe('advancePeriod', () => {
  it('avança a partir do vencimento ATUAL, não de "agora" (§6.2 passo 2)', () => {
    // Venceu no dia 1; o pagamento chega no dia 3 — o novo vencimento
    // precisa ser 1 mês a partir do dia 1, nunca do dia 3.
    const previousPeriodEnd = new Date('2026-06-01T00:00:00Z');
    const result = advancePeriod(previousPeriodEnd, 'monthly', 1);
    expect(result.toISOString()).toBe('2026-07-01T00:00:00.000Z');
  });

  it('respeita múltiplos períodos de uma vez', () => {
    const previousPeriodEnd = new Date('2026-06-01T00:00:00Z');
    const result = advancePeriod(previousPeriodEnd, 'monthly', 3);
    expect(result.toISOString()).toBe('2026-09-01T00:00:00.000Z');
  });

  it('anual multiplica o número de anos', () => {
    const previousPeriodEnd = new Date('2026-06-01T00:00:00Z');
    const result = advancePeriod(previousPeriodEnd, 'yearly', 2);
    expect(result.toISOString()).toBe('2028-06-01T00:00:00.000Z');
  });
});

describe('describeCycleChange', () => {
  it('sem overage quando o uso está dentro do novo plano', () => {
    const plan = makePlan({ limits: { contacts: 5000 } });
    const result = describeCycleChange(plan, 'monthly', new Date(), {
      contacts: 100,
    });
    expect(result.hasOverageWarning).toBe(false);
    expect(result.overageKeys).toEqual([]);
  });

  it('sinaliza overage quando o uso atual excede a quota do plano destino', () => {
    const plan = makePlan({ limits: { contacts: 100 } });
    const result = describeCycleChange(plan, 'monthly', new Date(), {
      contacts: 500,
    });
    expect(result.hasOverageWarning).toBe(true);
    expect(result.overageKeys).toEqual(['contacts']);
  });
});

// SPEC 062 §3.3.1 (decisão B, 2026-08-30) — troca de plano pelo console.
describe('resolveExpiryOnPlanChange', () => {
  const now = new Date('2026-08-30T12:00:00Z');

  it('HERDA quando a conta já vencia e o plano novo também vence', () => {
    const result = resolveExpiryOnPlanChange(
      new Date('2026-09-01T00:00:00Z'),
      makePlan({ billingPeriod: 'monthly', priceCents: 29900 }),
      now
    );
    expect(result).toEqual({ kind: 'inherit' });
  });

  it('aceita `current_period_end` como string ISO (o formato que vem do banco)', () => {
    const result = resolveExpiryOnPlanChange(
      '2026-09-01T00:00:00.000Z',
      makePlan({ billingPeriod: 'monthly', priceCents: 29900 }),
      now
    );
    expect(result).toEqual({ kind: 'inherit' });
  });

  it('CALCULA um vencimento novo a partir de `now` quando a conta nunca venceu', () => {
    const plan = makePlan({ billingPeriod: 'monthly', priceCents: 9900 });
    const result = resolveExpiryOnPlanChange(null, plan, now);
    expect(result.kind).toBe('started');
    if (result.kind === 'started') {
      expect(result.startedAt).toEqual(now);
      expect(result.billingCycle).toBe('monthly');
      // +1 mês a partir de `now` — mesma regra de computePeriodEnd.
      expect(result.currentPeriodEnd).toEqual(
        computePeriodEnd(now, 'monthly', plan)
      );
    }
  });

  it('sempre usa ciclo mensal ao calcular do zero — nunca lê um billing_cycle órfão do chamador', () => {
    // O console nunca oferece escolha de ciclo (isso é autosserviço) —
    // a assinatura da função nem aceita um `billingCycle` de entrada,
    // então não há como um valor 'yearly' residual de uma assinatura
    // anterior vazar para o cálculo. Este teste documenta essa garantia
    // por construção: a data resultante é sempre ~1 mês, nunca ~1 ano.
    const plan = makePlan({ billingPeriod: 'monthly', priceCents: 9900 });
    const result = resolveExpiryOnPlanChange(null, plan, now);
    expect(result.kind).toBe('started');
    if (result.kind === 'started') {
      const deltaDays =
        (result.currentPeriodEnd.getTime() - now.getTime()) /
        (24 * 60 * 60 * 1000);
      expect(deltaDays).toBeGreaterThan(25);
      expect(deltaDays).toBeLessThan(35);
    }
  });

  it('LIMPA quando o plano novo não vence, mesmo que a conta já vencesse', () => {
    const result = resolveExpiryOnPlanChange(
      new Date('2026-09-01T00:00:00Z'),
      makePlan({ billingPeriod: 'none', priceCents: 0 }),
      now
    );
    expect(result).toEqual({ kind: 'cleared' });
  });

  it('LIMPA quando o plano novo é Grátis (billing_period vence, mas preço é zero)', () => {
    const result = resolveExpiryOnPlanChange(
      new Date('2026-09-01T00:00:00Z'),
      makePlan({ billingPeriod: 'monthly', priceCents: 0 }),
      now
    );
    expect(result).toEqual({ kind: 'cleared' });
  });
});
