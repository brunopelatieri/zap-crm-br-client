import { describe, it, expect } from 'vitest';

import { formatLimit, formatPlanPrice, planChangeErrorKey } from './format';

describe('formatLimit', () => {
  it('null vira "Ilimitado" em pt-BR', () => {
    expect(formatLimit(null, 'pt-BR')).toBe('Ilimitado');
  });

  it('null vira "Unlimited" em en', () => {
    expect(formatLimit(null, 'en')).toBe('Unlimited');
  });

  it('0 vira "Não incluído" em pt-BR', () => {
    expect(formatLimit(0, 'pt-BR')).toBe('Não incluído');
  });

  it('0 vira "Not included" em en', () => {
    expect(formatLimit(0, 'en')).toBe('Not included');
  });

  it('número positivo é formatado por locale', () => {
    expect(formatLimit(2000, 'pt-BR')).toContain('2');
    expect(formatLimit(2000, 'en')).toContain('2');
  });
});

describe('formatPlanPrice', () => {
  it('formata centavos como moeda no locale pt-BR', () => {
    const result = formatPlanPrice(14900, 'BRL', 'pt-BR');
    expect(result).toContain('149');
  });

  it('formata centavos como moeda no locale en', () => {
    const result = formatPlanPrice(14900, 'BRL', 'en');
    expect(result).toContain('149');
  });

  it('zero é formatado sem lançar', () => {
    expect(() => formatPlanPrice(0, 'BRL', 'pt-BR')).not.toThrow();
  });
});

// Achado de code review: `plan-catalog.tsx` (atalho do plano Grátis) e
// `plan-cycle-dialog.tsx` chamam a mesma rota mas só um tinha o
// mapeamento de `code` — este teste trava o contrato compartilhado dos
// dois, para não divergirem de novo.
describe('planChangeErrorKey', () => {
  it('mapeia os três códigos conhecidos', () => {
    expect(planChangeErrorKey('self_service_disabled')).toBe(
      'errorSelfServiceDisabled'
    );
    expect(planChangeErrorKey('plan_not_available')).toBe(
      'errorPlanNotAvailable'
    );
    expect(planChangeErrorKey('account_past_due')).toBe('errorAccountPastDue');
  });

  it('código desconhecido ou ausente devolve null (chamador cai para payload.error)', () => {
    expect(planChangeErrorKey('account_not_found')).toBeNull();
    expect(planChangeErrorKey(undefined)).toBeNull();
  });
});
