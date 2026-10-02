import { afterEach, describe, expect, it, vi } from 'vitest';
import { enUS, ptBR } from 'date-fns/locale';

import {
  formatClock,
  formatDateTime,
  formatMoney,
  formatPeriodMonth,
  formatVolume,
  isBillingProblem,
  isKnownPricingCategory,
} from './billing-format';

// `Intl` usa espaço não separável entre símbolo e valor: normaliza.
const flat = (s: string) => s.replace(/ | /g, ' ');

afterEach(() => vi.restoreAllMocks());

describe('formatMoney', () => {
  it('USD em pt-BR sai "US$ 7,06" (7,0625 arredondado)', () => {
    expect(flat(formatMoney('pt-BR', 'USD', 7.0625))).toBe('US$ 7,06');
  });

  it('BRL em pt-BR sai "R$ 7,06"', () => {
    expect(flat(formatMoney('pt-BR', 'BRL', 7.06))).toBe('R$ 7,06');
  });

  it('USD em en sai "$7.06"', () => {
    expect(formatMoney('en', 'USD', 7.0625)).toBe('$7.06');
  });

  it('zero é "US$ 0,00", não vazio', () => {
    expect(flat(formatMoney('pt-BR', 'USD', 0))).toBe('US$ 0,00');
  });

  it('moeda inválida cai em "7,06 CÓDIGO" e loga, sem lançar', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(flat(formatMoney('pt-BR', 'XX', 7.06))).toBe('7,06 XX');
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('sem moeda: só o número com duas casas', () => {
    expect(formatMoney('pt-BR', null, 7)).toBe('7,00');
    expect(formatMoney('en', undefined, 7)).toBe('7.00');
  });
});

describe('formatVolume', () => {
  it('usa o separador de milhar do idioma', () => {
    expect(flat(formatVolume('pt-BR', 12345))).toBe('12.345');
    expect(formatVolume('en', 12345)).toBe('12,345');
  });
});

describe('formatPeriodMonth', () => {
  it('2026-10-01 → "outubro/2026" / "October/2026"', () => {
    expect(formatPeriodMonth('2026-10-01', ptBR)).toBe('outubro/2026');
    expect(formatPeriodMonth('2026-10-01', enUS)).toBe('October/2026');
  });

  it('não recua um dia: dia 1 de janeiro continua janeiro', () => {
    expect(formatPeriodMonth('2027-01-01', ptBR)).toBe('janeiro/2027');
  });

  it('entrada ausente ou ilegível → string vazia', () => {
    expect(formatPeriodMonth(null, ptBR)).toBe('');
    expect(formatPeriodMonth('lixo', ptBR)).toBe('');
  });
});

describe('formatDateTime / formatClock', () => {
  it('data e hora curtas no idioma', () => {
    const out = formatDateTime('2026-10-01T13:58:42Z', ptBR);
    expect(out).toMatch(/^\d{2}\/\d{2}\/\d{4}/);
  });

  it('ilegível ou ausente → string vazia', () => {
    expect(formatDateTime(null, ptBR)).toBe('');
    expect(formatDateTime('x', ptBR)).toBe('');
    expect(formatClock(undefined, ptBR)).toBe('');
    expect(formatClock('x', ptBR)).toBe('');
  });

  it('hora curta tem dígitos', () => {
    expect(formatClock('2026-10-01T13:58:42Z', ptBR)).toMatch(/\d/);
  });
});

describe('isBillingProblem', () => {
  it.each(['payment_blocked', 'blocked', 'auth_error', 'limited'] as const)(
    '%s é problema',
    (s) => expect(isBillingProblem(s)).toBe(true)
  );

  it.each(['ok', 'unknown', 'no_credentials'] as const)(
    '%s não é problema',
    (s) => expect(isBillingProblem(s)).toBe(false)
  );

  it('null/undefined não é problema', () => {
    expect(isBillingProblem(null)).toBe(false);
    expect(isBillingProblem(undefined)).toBe(false);
  });
});

describe('isKnownPricingCategory', () => {
  it('reconhece as cinco e rejeita o resto', () => {
    expect(isKnownPricingCategory('MARKETING')).toBe(true);
    expect(isKnownPricingCategory('AUTHENTICATION_INTERNATIONAL')).toBe(true);
    expect(isKnownPricingCategory('MARKETING_LITE')).toBe(false);
    expect(isKnownPricingCategory('marketing')).toBe(false);
  });
});
