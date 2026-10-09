import { describe, expect, it } from 'vitest';

import {
  PAYMENT_METHODS,
  newConsolePaymentRef,
  paidAtRange,
  parseMoneyToCents,
  periodEndRange,
  previewManualPayment,
  todayInSaoPaulo,
  validateManualPaymentInput,
  validatePeriodEndInput,
} from './manual-billing';

const TODAY = '2026-10-09';

describe('todayInSaoPaulo', () => {
  it('02:00 UTC ainda é o dia anterior em São Paulo (UTC-3)', () => {
    expect(todayInSaoPaulo(new Date('2026-10-09T02:00:00Z'))).toBe(
      '2026-10-08'
    );
  });

  it('03:00 UTC já é o dia novo em São Paulo', () => {
    expect(todayInSaoPaulo(new Date('2026-10-09T03:00:00Z'))).toBe(
      '2026-10-09'
    );
  });
});

describe('validatePeriodEndInput', () => {
  const validate = (date: unknown, billingCycle?: unknown, todaySp = TODAY) =>
    validatePeriodEndInput({ date, billingCycle, todaySp });

  it('hoje é aceito (D-3)', () => {
    expect(validate(TODAY)).toEqual({
      ok: true,
      value: { date: TODAY, billingCycle: null },
    });
  });

  it('ontem é recusado', () => {
    expect(validate('2026-10-08')).toEqual({
      ok: false,
      code: 'period_end_out_of_range',
    });
  });

  it('hoje + 3 anos é aceito; + 3 anos + 1 dia é recusado', () => {
    expect(validate('2029-10-09').ok).toBe(true);
    expect(validate('2029-10-10')).toEqual({
      ok: false,
      code: 'period_end_out_of_range',
    });
  });

  it('hoje em 29/02: o teto é 28/02 três anos depois (mesma regra do Postgres)', () => {
    expect(validate('2031-02-28', undefined, '2028-02-29').ok).toBe(true);
    expect(validate('2031-03-01', undefined, '2028-02-29')).toEqual({
      ok: false,
      code: 'period_end_out_of_range',
    });
  });

  it('formato errado ou dia inexistente é period_end_invalid', () => {
    for (const bad of [
      '09/10/2026',
      '2026-1-9',
      '2026-02-30',
      '2026-13-01',
      '',
      null,
      20261009,
    ]) {
      expect(validate(bad)).toEqual({ ok: false, code: 'period_end_invalid' });
    }
  });

  it('29/02 de ano não bissexto é inexistente', () => {
    expect(validate('2027-02-29', undefined, '2027-01-01')).toEqual({
      ok: false,
      code: 'period_end_invalid',
    });
  });

  it('billingCycle: monthly e yearly passam; omitido/null vira null (manter o atual, D-4)', () => {
    expect(validate(TODAY, 'yearly')).toMatchObject({
      ok: true,
      value: { billingCycle: 'yearly' },
    });
    expect(validate(TODAY, 'monthly')).toMatchObject({
      ok: true,
      value: { billingCycle: 'monthly' },
    });
    expect(validate(TODAY, null)).toMatchObject({
      ok: true,
      value: { billingCycle: null },
    });
  });

  it('billingCycle fora da lista é invalid_billing_cycle', () => {
    expect(validate(TODAY, 'weekly')).toEqual({
      ok: false,
      code: 'invalid_billing_cycle',
    });
  });
});

describe('validateManualPaymentInput', () => {
  const base = {
    paidAt: TODAY,
    periods: 1,
    method: 'pix',
    paymentRef: 'E2E123',
    todaySp: TODAY,
  };
  const validate = (overrides: Record<string, unknown> = {}) =>
    validateManualPaymentInput({ ...base, ...overrides });

  it('caminho feliz: normaliza e ancora paid_at ao meio-dia de São Paulo', () => {
    expect(
      validate({ amountCents: 34900, note: '  Pix conciliado  ' })
    ).toEqual({
      ok: true,
      value: {
        paidAt: '2026-10-09T15:00:00.000Z',
        periods: 1,
        method: 'pix',
        amountCents: 34900,
        paymentRef: 'E2E123',
        note: 'Pix conciliado',
      },
    });
  });

  it('valor e observação são opcionais: viram null', () => {
    expect(validate()).toMatchObject({
      ok: true,
      value: { amountCents: null, note: null },
    });
    expect(validate({ amountCents: null, note: '   ' })).toMatchObject({
      ok: true,
      value: { amountCents: null, note: null },
    });
  });

  it('valor zero é aceito (só negativo é recusado)', () => {
    expect(validate({ amountCents: 0 })).toMatchObject({
      ok: true,
      value: { amountCents: 0 },
    });
  });

  it('paidAt de hoje e de hoje − 365 dias passam', () => {
    expect(validate({ paidAt: TODAY }).ok).toBe(true);
    expect(validate({ paidAt: '2025-10-09' }).ok).toBe(true);
  });

  it('paidAt futuro é recusado', () => {
    expect(validate({ paidAt: '2026-10-10' })).toEqual({
      ok: false,
      code: 'paid_at_in_future',
    });
  });

  it('paidAt com mais de 365 dias é recusado', () => {
    expect(validate({ paidAt: '2025-10-08' })).toEqual({
      ok: false,
      code: 'paid_at_too_old',
    });
  });

  it('paidAt malformado é paid_at_invalid', () => {
    expect(validate({ paidAt: '09/10/2026' })).toEqual({
      ok: false,
      code: 'paid_at_invalid',
    });
    expect(validate({ paidAt: undefined })).toEqual({
      ok: false,
      code: 'paid_at_invalid',
    });
  });

  it('periods: 1 e 12 passam; 0, 13, 1,5 e string são recusados', () => {
    expect(validate({ periods: 1 }).ok).toBe(true);
    expect(validate({ periods: 12 }).ok).toBe(true);
    for (const bad of [0, 13, 1.5, -1, '3', null, NaN]) {
      expect(validate({ periods: bad })).toEqual({
        ok: false,
        code: 'periods_invalid',
      });
    }
  });

  it('todos os métodos da lista passam; fora da lista é recusado', () => {
    for (const method of PAYMENT_METHODS) {
      expect(validate({ method }).ok).toBe(true);
    }
    expect(validate({ method: 'PIX' })).toEqual({
      ok: false,
      code: 'method_invalid',
    });
    expect(validate({ method: undefined })).toEqual({
      ok: false,
      code: 'method_invalid',
    });
  });

  it('valor negativo, fracionário, texto ou acima de int4 é recusado', () => {
    for (const bad of [-1, 10.5, '100', 2_147_483_648]) {
      expect(validate({ amountCents: bad })).toEqual({
        ok: false,
        code: 'amount_invalid',
      });
    }
  });

  it('identificador: obrigatório, aparado e usado literal (sem prefixo, §4.2)', () => {
    expect(validate({ paymentRef: '  E2E123  ' })).toMatchObject({
      ok: true,
      value: { paymentRef: 'E2E123' },
    });
    for (const bad of [undefined, null, '', '   ', 42]) {
      expect(validate({ paymentRef: bad })).toEqual({
        ok: false,
        code: 'payment_ref_required',
      });
    }
    expect(validate({ paymentRef: 'x'.repeat(201) })).toEqual({
      ok: false,
      code: 'payment_ref_too_long',
    });
  });

  it('observação: 500 caracteres passam, 501 não', () => {
    expect(validate({ note: 'n'.repeat(500) }).ok).toBe(true);
    expect(validate({ note: 'n'.repeat(501) })).toEqual({
      ok: false,
      code: 'note_too_long',
    });
  });
});

describe('previewManualPayment', () => {
  const NOW = new Date('2026-12-01T12:00:00Z');

  it('mensal sobre 31/01 cai em 28/02 (não 03/03)', () => {
    const { newPeriodEnd } = previewManualPayment(
      new Date('2027-01-31T12:00:00Z'),
      'monthly',
      1,
      NOW
    );
    expect(newPeriodEnd.getUTCMonth()).toBe(1);
    expect(newPeriodEnd.getUTCDate()).toBe(28);
  });

  it('anual sobre 29/02 cai em 28/02 do ano seguinte', () => {
    const { newPeriodEnd } = previewManualPayment(
      new Date('2028-02-29T12:00:00Z'),
      'yearly',
      1,
      NOW
    );
    expect(newPeriodEnd.getUTCFullYear()).toBe(2029);
    expect(newPeriodEnd.getUTCMonth()).toBe(1);
    expect(newPeriodEnd.getUTCDate()).toBe(28);
  });

  it('parte do vencimento ATUAL, não de hoje (renovar atrasado não encurta)', () => {
    // Venceu em 10/11; hoje é 01/12. Um período mensal vai para 10/12 —
    // a partir de hoje seria 01/01.
    const { previousPeriodEnd, newPeriodEnd } = previewManualPayment(
      '2026-11-10T12:00:00Z',
      'monthly',
      1,
      NOW
    );
    expect(previousPeriodEnd?.toISOString()).toBe('2026-11-10T12:00:00.000Z');
    expect(newPeriodEnd.getUTCMonth()).toBe(11); // dezembro
    expect(newPeriodEnd.getUTCDate()).toBe(10);
  });

  it('vários períodos avançam de uma vez', () => {
    const { newPeriodEnd } = previewManualPayment(
      new Date('2026-11-10T12:00:00Z'),
      'monthly',
      3,
      NOW
    );
    expect(newPeriodEnd.getUTCFullYear()).toBe(2027);
    expect(newPeriodEnd.getUTCMonth()).toBe(1); // fevereiro
    expect(newPeriodEnd.getUTCDate()).toBe(10);
  });

  it('sem vencimento gravado a base é agora', () => {
    const { previousPeriodEnd, newPeriodEnd } = previewManualPayment(
      null,
      'monthly',
      1,
      NOW
    );
    expect(previousPeriodEnd).toBeNull();
    expect(newPeriodEnd.getUTCFullYear()).toBe(2027);
    expect(newPeriodEnd.getUTCMonth()).toBe(0);
    expect(newPeriodEnd.getUTCDate()).toBe(1);
  });
});

describe('newConsolePaymentRef', () => {
  it('prefixa o uuid com console:', () => {
    expect(newConsolePaymentRef('abc-123')).toBe('console:abc-123');
  });
});

describe('periodEndRange / paidAtRange', () => {
  it('vencimento: de hoje a hoje + 3 anos (os mesmos limites do validador)', () => {
    expect(periodEndRange(TODAY)).toEqual({
      min: '2026-10-09',
      max: '2029-10-09',
    });
  });

  it('vencimento a partir de 29/02 termina em 28/02 três anos depois', () => {
    expect(periodEndRange('2028-02-29')?.max).toBe('2031-02-28');
  });

  it('pagamento: de hoje − 365 dias até hoje', () => {
    expect(paidAtRange(TODAY)).toEqual({
      min: '2025-10-09',
      max: '2026-10-09',
    });
  });

  it('as bordas das faixas são aceitas pelo validador', () => {
    const end = periodEndRange(TODAY)!;
    expect(validatePeriodEndInput({ date: end.min, todaySp: TODAY }).ok).toBe(
      true
    );
    expect(validatePeriodEndInput({ date: end.max, todaySp: TODAY }).ok).toBe(
      true
    );
    const paid = paidAtRange(TODAY)!;
    for (const paidAt of [paid.min, paid.max]) {
      expect(
        validateManualPaymentInput({
          paidAt,
          periods: 1,
          method: 'pix',
          paymentRef: 'x',
          todaySp: TODAY,
        }).ok
      ).toBe(true);
    }
  });

  it('hoje malformado devolve null', () => {
    expect(periodEndRange('hoje')).toBeNull();
    expect(paidAtRange('')).toBeNull();
  });
});

describe('parseMoneyToCents', () => {
  it.each([
    ['349', 34900],
    ['349,9', 34990],
    ['349,90', 34990],
    ['1.349,90', 134990],
    ['R$ 349,90', 34990],
    ['349.90', 34990],
    ['0', 0],
    ['0,05', 5],
  ])('%s → %i centavos', (input, cents) => {
    expect(parseMoneyToCents(input)).toBe(cents);
  });

  it.each([
    '',
    'abc',
    '-5',
    '349,999',
    '1.34,90',
    '1,2,3',
    '10.123',
    '99999999999',
  ])('%j é recusado', (input) => {
    expect(parseMoneyToCents(input)).toBeNull();
  });
});
