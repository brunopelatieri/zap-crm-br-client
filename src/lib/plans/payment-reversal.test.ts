import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { reversePlanPayment } from './payment-reversal';

/**
 * As regras do estorno (último não estornado, vencimento ainda igual,
 * linha marcada e nunca apagada) moram em `reverse_plan_payment`
 * (migração 089). Aqui só o contrato com a RPC e o mapeamento das cinco
 * exceções de negócio (mais `ACCOUNT_NOT_FOUND`) para códigos estáveis.
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

describe('reversePlanPayment', () => {
  it('passa os parâmetros certos para reverse_plan_payment', async () => {
    const { client, calls } = makeRpcClient(() => ({
      data: [
        {
          restored_period_end: '2026-11-10T12:00:00Z',
          restored_status: 'past_due',
        },
      ],
      error: null,
    }));
    await reversePlanPayment(client, {
      paymentId: 'pay-1',
      actor: 'console:bruno@zapcrmbr.com',
      reason: 'Pix lançado na conta errada',
    });
    expect(calls).toEqual([
      {
        fn: 'reverse_plan_payment',
        args: {
          p_payment_id: 'pay-1',
          p_actor: 'console:bruno@zapcrmbr.com',
          p_reason: 'Pix lançado na conta errada',
        },
      },
    ]);
  });

  it('reason omitido vira null', async () => {
    const { client, calls } = makeRpcClient(() => ({
      data: [{ restored_period_end: null, restored_status: 'active' }],
      error: null,
    }));
    await reversePlanPayment(client, {
      paymentId: 'pay-1',
      actor: 'console:x@y.com',
    });
    expect(calls[0].args.p_reason).toBeNull();
  });

  it('a linha devolvida vira o estado restaurado', async () => {
    const { client } = makeRpcClient(() => ({
      data: [
        {
          restored_period_end: '2026-11-10T12:00:00Z',
          restored_status: 'past_due',
        },
      ],
      error: null,
    }));
    const result = await reversePlanPayment(client, {
      paymentId: 'pay-1',
      actor: 'console:x@y.com',
    });
    expect(result).toEqual({
      ok: true,
      restored: {
        restoredPeriodEnd: '2026-11-10T12:00:00Z',
        restoredStatus: 'past_due',
      },
    });
  });

  it.each([
    ['PAYMENT_NOT_FOUND', 'payment_not_found'],
    ['ACCOUNT_NOT_FOUND', 'account_not_found'],
    ['PAYMENT_ALREADY_REVERSED', 'payment_already_reversed'],
    ['PAYMENT_NOT_REVERSIBLE', 'payment_not_reversible'],
    ['PAYMENT_NOT_LATEST', 'payment_not_latest'],
    ['PERIOD_CHANGED_SINCE_PAYMENT', 'period_changed_since_payment'],
  ])('exceção %s vira %s', async (message, code) => {
    const { client } = makeRpcClient(() => ({
      data: null,
      error: { message },
    }));
    const result = await reversePlanPayment(client, {
      paymentId: 'pay-1',
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
    const result = await reversePlanPayment(client, {
      paymentId: 'pay-1',
      actor: 'console:x@y.com',
    });
    expect(result).toEqual({ ok: false, error: 'update_failed' });
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('RPC sem erro mas sem linha devolve update_failed', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { client } = makeRpcClient(() => ({ data: [], error: null }));
    const result = await reversePlanPayment(client, {
      paymentId: 'pay-1',
      actor: 'console:x@y.com',
    });
    expect(result).toEqual({ ok: false, error: 'update_failed' });
    errorSpy.mockRestore();
  });
});
