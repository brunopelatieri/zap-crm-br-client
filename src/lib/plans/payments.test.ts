import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import {
  listAccountPayments,
  resolveDuplicateRef,
  resolvePaymentReversibility,
  type AccountPayment,
} from './payments';

function makeDb(result: { data: unknown; error: { message: string } | null }) {
  const filters: [string, unknown][] = [];
  const orders: [string, unknown][] = [];
  let limitValue: number | undefined;
  const chain: Record<string, unknown> = {
    select: () => chain,
    eq: (column: string, value: unknown) => {
      filters.push([column, value]);
      return chain;
    },
    order: (column: string, opts: unknown) => {
      orders.push([column, opts]);
      return chain;
    },
    limit: (n: number) => {
      limitValue = n;
      return Promise.resolve(result);
    },
  };
  const client = {
    from: (table: string) => {
      if (table !== 'account_plan_payments') {
        throw new Error(`tabela inesperada: ${table}`);
      }
      return chain;
    },
  } as unknown as SupabaseClient;
  return { client, filters, orders, getLimit: () => limitValue };
}

const ROW = {
  id: 'pay-1',
  account_id: 'acct-1',
  payment_ref: 'E2E123',
  periods: 1,
  previous_period_end: '2026-10-10T02:59:59+00:00',
  new_period_end: '2026-11-10T02:59:59+00:00',
  paid_at: '2026-10-09T15:00:00+00:00',
  external_ref: null,
  note: 'Pix conciliado',
  method: 'pix',
  amount_cents: 34900,
  recorded_by: 'console:bruno@zapcrmbr.com',
  previous_status: 'past_due',
  reversed_at: null,
  reversed_by: null,
  reversal_reason: null,
  created_at: '2026-10-09T15:01:00+00:00',
};

describe('listAccountPayments', () => {
  it('filtra pela conta, ordena do mais novo (created_at, id) e limita a 20 por padrão', async () => {
    const { client, filters, orders, getLimit } = makeDb({
      data: [],
      error: null,
    });
    await listAccountPayments(client, 'acct-1');
    expect(filters).toEqual([['account_id', 'acct-1']]);
    expect(orders).toEqual([
      ['created_at', { ascending: false }],
      ['id', { ascending: false }],
    ]);
    expect(getLimit()).toBe(20);
  });

  it('o limite é configurável', async () => {
    const { client, getLimit } = makeDb({ data: [], error: null });
    await listAccountPayments(client, 'acct-1', 5);
    expect(getLimit()).toBe(5);
  });

  it('mapeia snake_case para camelCase', async () => {
    const { client } = makeDb({ data: [ROW], error: null });
    expect(await listAccountPayments(client, 'acct-1')).toEqual([
      {
        id: 'pay-1',
        accountId: 'acct-1',
        paymentRef: 'E2E123',
        periods: 1,
        previousPeriodEnd: '2026-10-10T02:59:59+00:00',
        newPeriodEnd: '2026-11-10T02:59:59+00:00',
        paidAt: '2026-10-09T15:00:00+00:00',
        externalRef: null,
        note: 'Pix conciliado',
        method: 'pix',
        amountCents: 34900,
        recordedBy: 'console:bruno@zapcrmbr.com',
        previousStatus: 'past_due',
        reversedAt: null,
        reversedBy: null,
        reversalReason: null,
        createdAt: '2026-10-09T15:01:00+00:00',
      },
    ]);
  });

  it('linha antiga (anterior à 089) mantém os campos novos nulos', async () => {
    const { client } = makeDb({
      data: [
        { ...ROW, method: null, amount_cents: null, previous_status: null },
      ],
      error: null,
    });
    const [payment] = await listAccountPayments(client, 'acct-1');
    expect(payment.method).toBeNull();
    expect(payment.amountCents).toBeNull();
    expect(payment.previousStatus).toBeNull();
  });

  it('data nulo vira lista vazia', async () => {
    const { client } = makeDb({ data: null, error: null });
    expect(await listAccountPayments(client, 'acct-1')).toEqual([]);
  });

  it('erro do banco é lançado (a rota decide o 500)', async () => {
    const { client } = makeDb({ data: null, error: { message: 'boom' } });
    await expect(listAccountPayments(client, 'acct-1')).rejects.toEqual({
      message: 'boom',
    });
  });
});

describe('resolvePaymentReversibility', () => {
  const pay = (
    id: string,
    overrides: Partial<AccountPayment> = {}
  ): AccountPayment => ({
    id,
    accountId: 'acct-1',
    paymentRef: id,
    periods: 1,
    previousPeriodEnd: '2026-10-10T02:59:59+00:00',
    newPeriodEnd: '2026-11-10T02:59:59+00:00',
    paidAt: '2026-10-09T15:00:00+00:00',
    externalRef: null,
    note: null,
    method: 'pix',
    amountCents: null,
    recordedBy: 'console:x@y.com',
    previousStatus: 'active',
    reversedAt: null,
    reversedBy: null,
    reversalReason: null,
    createdAt: '2026-10-09T15:01:00+00:00',
    ...overrides,
  });
  const CURRENT = '2026-11-10T02:59:59+00:00';

  it('só o mais novo não estornado é reversível; os demais são not_latest', () => {
    const result = resolvePaymentReversibility(
      [pay('c'), pay('b'), pay('a')],
      CURRENT
    );
    expect(result.get('c')).toBe('reversible');
    expect(result.get('b')).toBe('not_latest');
    expect(result.get('a')).toBe('not_latest');
  });

  it('estornados ficam already_reversed e o próximo não estornado vira o elegível', () => {
    const result = resolvePaymentReversibility(
      [pay('c', { reversedAt: '2026-10-10T00:00:00Z' }), pay('b')],
      CURRENT
    );
    expect(result.get('c')).toBe('already_reversed');
    expect(result.get('b')).toBe('reversible');
  });

  it('anterior à 089 (sem previousStatus) não é reversível', () => {
    const result = resolvePaymentReversibility(
      [pay('a', { previousStatus: null })],
      CURRENT
    );
    expect(result.get('a')).toBe('not_reversible');
  });

  it('vencimento alterado depois do pagamento → period_changed', () => {
    const result = resolvePaymentReversibility(
      [pay('a')],
      '2026-12-20T02:59:59+00:00'
    );
    expect(result.get('a')).toBe('period_changed');
  });

  it('compara instantes, não texto (+00:00 vs Z)', () => {
    const result = resolvePaymentReversibility(
      [pay('a')],
      '2026-11-10T02:59:59.000Z'
    );
    expect(result.get('a')).toBe('reversible');
  });

  it('conta sem vencimento → period_changed; lista vazia → mapa vazio', () => {
    expect(resolvePaymentReversibility([pay('a')], null).get('a')).toBe(
      'period_changed'
    );
    expect(resolvePaymentReversibility([], CURRENT).size).toBe(0);
  });
});

describe('resolveDuplicateRef', () => {
  function makeLookupDb(result: {
    data: unknown;
    error: { message: string } | null;
  }) {
    const filters: [string, unknown][] = [];
    const chain: Record<string, unknown> = {
      select: () => chain,
      eq: (column: string, value: unknown) => {
        filters.push([column, value]);
        return chain;
      },
      maybeSingle: () => Promise.resolve(result),
    };
    const client = { from: () => chain } as unknown as SupabaseClient;
    return { client, filters };
  }

  it('consulta pelo payment_ref, sem filtrar por conta (a UNIQUE é global)', async () => {
    const { client, filters } = makeLookupDb({
      data: { account_id: 'acct-1', reversed_at: null },
      error: null,
    });
    await resolveDuplicateRef(client, 'acct-1', 'E2E123');
    expect(filters).toEqual([['payment_ref', 'E2E123']]);
  });

  it('desta conta e vigente → same_payment', async () => {
    const { client } = makeLookupDb({
      data: { account_id: 'acct-1', reversed_at: null },
      error: null,
    });
    expect(await resolveDuplicateRef(client, 'acct-1', 'x')).toBe(
      'same_payment'
    );
  });

  it('de outra conta → other_account', async () => {
    const { client } = makeLookupDb({
      data: { account_id: 'acct-2', reversed_at: null },
      error: null,
    });
    expect(await resolveDuplicateRef(client, 'acct-1', 'x')).toBe(
      'other_account'
    );
  });

  it('de outra conta E estornado → continua other_account (a conta vem primeiro)', async () => {
    const { client } = makeLookupDb({
      data: { account_id: 'acct-2', reversed_at: '2026-10-09T00:00:00Z' },
      error: null,
    });
    expect(await resolveDuplicateRef(client, 'acct-1', 'x')).toBe(
      'other_account'
    );
  });

  it('desta conta, estornado → reversed', async () => {
    const { client } = makeLookupDb({
      data: { account_id: 'acct-1', reversed_at: '2026-10-09T00:00:00Z' },
      error: null,
    });
    expect(await resolveDuplicateRef(client, 'acct-1', 'x')).toBe('reversed');
  });

  it.each([
    ['erro de leitura', { data: null, error: { message: 'boom' } }],
    ['linha inexistente', { data: null, error: null }],
  ])('%s → unknown (nunca afirma "já aplicado")', async (_name, result) => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { client } = makeLookupDb(result);
    expect(await resolveDuplicateRef(client, 'acct-1', 'x')).toBe('unknown');
    spy.mockRestore();
  });
});
