import { describe, expect, it } from 'vitest';

import { describeAuditEvent, mergeAccountHistory } from './audit-feed';

const fmt = {
  date: (iso: string) => `D(${iso.slice(0, 10)})`,
  method: (code: string) => `M(${code})`,
  field: (code: string) => `F(${code})`,
};

describe('describeAuditEvent', () => {
  it('vencimento alterado: de → para, formatados', () => {
    expect(
      describeAuditEvent(
        {
          action: 'billing.period_end.set',
          payload: {
            previousPeriodEnd: '2026-11-10T02:59:59+00:00',
            newPeriodEnd: '2026-12-21T02:59:59+00:00',
          },
        },
        fmt
      )
    ).toEqual({
      key: 'billing_period_end_set',
      values: { from: 'D(2026-11-10)', to: 'D(2026-12-21)' },
    });
  });

  it('vencimento anterior nulo vira travessão', () => {
    const { values } = describeAuditEvent(
      {
        action: 'billing.period_end.set',
        payload: {
          previousPeriodEnd: null,
          newPeriodEnd: '2026-12-21T00:00:00Z',
        },
      },
      fmt
    );
    expect(values.from).toBe('—');
  });

  it('pagamento manual: forma traduzida, períodos e identificador', () => {
    expect(
      describeAuditEvent(
        {
          action: 'billing.payment.manual',
          payload: { method: 'pix', periods: 3, paymentRef: 'E2E1' },
        },
        fmt
      )
    ).toEqual({
      key: 'billing_payment_manual',
      values: { method: 'M(pix)', periods: 3, ref: 'E2E1' },
    });
  });

  it('estorno e renovação pela API mostram só o identificador', () => {
    for (const action of ['billing.payment.reverse', 'billing.renew']) {
      expect(
        describeAuditEvent({ action, payload: { paymentRef: 'X9' } }, fmt)
      ).toEqual({ key: action.replace(/\./g, '_'), values: { ref: 'X9' } });
    }
  });

  it('edição de usuário lista os campos traduzidos, sem endereços', () => {
    const result = describeAuditEvent(
      {
        action: 'user.profile_update',
        payload: {
          fields: ['email', 'fullName'],
          previousEmail: 'a@b.co',
          newEmail: 'c@d.co',
        },
      },
      fmt
    );
    expect(result).toEqual({
      key: 'user_profile_update',
      values: { fields: 'F(email), F(fullName)' },
    });
    expect(JSON.stringify(result)).not.toContain('@');
  });

  it('payload malformado não lança', () => {
    expect(
      describeAuditEvent(
        {
          action: 'billing.payment.manual',
          payload: { periods: 'x', method: 5 },
        },
        fmt
      ).values
    ).toEqual({ method: '—', periods: 1, ref: '—' });
    expect(
      describeAuditEvent({ action: 'user.profile_update', payload: {} }, fmt)
        .values.fields
    ).toBe('—');
  });

  it('ação desconhecida cai em unknown', () => {
    expect(
      describeAuditEvent({ action: 'algo.novo', payload: {} }, fmt)
    ).toEqual({ key: 'unknown', values: { action: 'algo.novo' } });
  });
});

describe('mergeAccountHistory', () => {
  const ev = (id: string, created_at: string) => ({ id, created_at });
  const limits = { plan: 3, audit: 3 };

  it('intercala os dois tipos, do mais novo para o mais antigo', () => {
    const merged = mergeAccountHistory(
      [ev('p1', '2026-10-05T12:00:00Z')],
      [ev('a1', '2026-10-07T12:00:00Z'), ev('a2', '2026-10-01T12:00:00Z')],
      limits
    );
    expect(merged.map((i) => `${i.kind}:${i.event.id}`)).toEqual([
      'audit:a1',
      'plan:p1',
      'audit:a2',
    ]);
  });

  it('nenhuma fonte encheu: nada é cortado', () => {
    const merged = mergeAccountHistory(
      [ev('p1', '2026-01-01T00:00:00Z')],
      [ev('a1', '2026-10-01T00:00:00Z')],
      limits
    );
    expect(merged).toHaveLength(2);
  });

  it('uma fonte encheu (pode ter cortado o passado): o histórico só vai até o evento mais antigo dela', () => {
    const merged = mergeAccountHistory(
      [
        ev('p1', '2026-10-09T00:00:00Z'),
        ev('p2', '2026-10-08T00:00:00Z'),
        ev('p3', '2026-10-07T00:00:00Z'),
      ],
      [ev('a1', '2026-10-08T12:00:00Z'), ev('a-old', '2026-09-01T00:00:00Z')],
      limits
    );
    expect(merged.map((i) => i.event.id)).toEqual(['p1', 'a1', 'p2', 'p3']);
  });

  it('as duas encheram: vale o corte mais recente', () => {
    const merged = mergeAccountHistory(
      [
        ev('p1', '2026-10-09T00:00:00Z'),
        ev('p2', '2026-10-05T00:00:00Z'),
        ev('p3', '2026-10-01T00:00:00Z'),
      ],
      [
        ev('a1', '2026-10-08T00:00:00Z'),
        ev('a2', '2026-10-07T00:00:00Z'),
        ev('a3', '2026-10-06T00:00:00Z'),
      ],
      limits
    );
    expect(merged.map((i) => i.event.id)).toEqual(['p1', 'a1', 'a2', 'a3']);
  });

  it('compara instantes, não texto (offsets diferentes)', () => {
    const merged = mergeAccountHistory(
      [ev('p1', '2026-10-09T00:00:00+00:00')],
      [ev('a1', '2026-10-08T22:00:00-03:00')],
      limits
    );
    expect(merged.map((i) => i.event.id)).toEqual(['a1', 'p1']);
  });
});
