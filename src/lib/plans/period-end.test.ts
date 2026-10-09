import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { setPlanPeriodEnd } from './period-end';

/**
 * A regra de verdade (faixa de datas, fuso, `past_due` → `active`, lock
 * da linha) mora em `set_plan_period_end` (migração 089). Aqui só o
 * CONTRATO com a RPC: os parâmetros certos saem, a linha devolvida vira
 * o resultado, e cada exceção de negócio mapeia para o código certo.
 */
function makeRpcClient(
  handler: (fn: string, args: Record<string, unknown>) => unknown
) {
  const calls: { fn: string; args: Record<string, unknown> }[] = [];
  const client = {
    rpc: (fn: string, args: Record<string, unknown>) => {
      calls.push({ fn, args });
      return Promise.resolve(handler(fn, args));
    },
  } as unknown as SupabaseClient;
  return { client, calls };
}

const ROW = {
  previous_period_end: '2026-11-10T02:59:59+00:00',
  new_period_end: '2026-12-21T02:59:59+00:00',
  previous_status: 'past_due',
  new_status: 'active',
  billing_cycle: 'monthly',
};

describe('setPlanPeriodEnd', () => {
  it('passa os parâmetros certos para set_plan_period_end', async () => {
    const { client, calls } = makeRpcClient(() => ({
      data: [ROW],
      error: null,
    }));
    await setPlanPeriodEnd(client, {
      accountId: 'acct-1',
      date: '2026-12-20',
      billingCycle: 'yearly',
      actor: 'console:bruno@zapcrmbr.com',
    });
    expect(calls).toEqual([
      {
        fn: 'set_plan_period_end',
        args: {
          p_account_id: 'acct-1',
          p_date: '2026-12-20',
          p_billing_cycle: 'yearly',
          p_actor: 'console:bruno@zapcrmbr.com',
        },
      },
    ]);
  });

  it('billingCycle omitido vira null (manter o ciclo atual)', async () => {
    const { client, calls } = makeRpcClient(() => ({
      data: [ROW],
      error: null,
    }));
    await setPlanPeriodEnd(client, {
      accountId: 'acct-1',
      date: '2026-12-20',
      actor: 'console:x@y.com',
    });
    expect(calls[0].args.p_billing_cycle).toBeNull();
  });

  it('a linha devolvida vira a mudança (anterior → novo, status, ciclo)', async () => {
    const { client } = makeRpcClient(() => ({ data: [ROW], error: null }));
    const result = await setPlanPeriodEnd(client, {
      accountId: 'acct-1',
      date: '2026-12-20',
      actor: 'console:x@y.com',
    });
    expect(result).toEqual({
      ok: true,
      change: {
        previousPeriodEnd: '2026-11-10T02:59:59+00:00',
        newPeriodEnd: '2026-12-21T02:59:59+00:00',
        previousStatus: 'past_due',
        newStatus: 'active',
        billingCycle: 'monthly',
      },
    });
  });

  it('data como objeto único (não array) também é aceito', async () => {
    const { client } = makeRpcClient(() => ({ data: ROW, error: null }));
    const result = await setPlanPeriodEnd(client, {
      accountId: 'acct-1',
      date: '2026-12-20',
      actor: 'console:x@y.com',
    });
    expect(result.ok).toBe(true);
  });

  it.each([
    ['ACCOUNT_NOT_FOUND', 'account_not_found'],
    ['NO_BILLING_CYCLE', 'no_billing_cycle'],
    ['PERIOD_END_OUT_OF_RANGE', 'period_end_out_of_range'],
    ['INVALID_BILLING_CYCLE', 'invalid_billing_cycle'],
  ])('exceção %s vira %s', async (message, code) => {
    const { client } = makeRpcClient(() => ({
      data: null,
      error: { message },
    }));
    const result = await setPlanPeriodEnd(client, {
      accountId: 'acct-1',
      date: '2026-12-20',
      actor: 'console:x@y.com',
    });
    expect(result).toEqual({ ok: false, error: code });
  });

  it('erro desconhecido/infra devolve update_failed, e loga', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { client } = makeRpcClient(() => ({
      data: null,
      error: { message: 'connection reset' },
    }));
    const result = await setPlanPeriodEnd(client, {
      accountId: 'acct-1',
      date: '2026-12-20',
      actor: 'console:x@y.com',
    });
    expect(result).toEqual({ ok: false, error: 'update_failed' });
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('RPC sem erro mas sem linha devolve update_failed', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { client } = makeRpcClient(() => ({ data: [], error: null }));
    const result = await setPlanPeriodEnd(client, {
      accountId: 'acct-1',
      date: '2026-12-20',
      actor: 'console:x@y.com',
    });
    expect(result).toEqual({ ok: false, error: 'update_failed' });
    errorSpy.mockRestore();
  });
});
