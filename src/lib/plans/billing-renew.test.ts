import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { renewAccountPlan } from './billing-renew';

/**
 * A idempotência de verdade (log de pagamentos + `UNIQUE(payment_ref)`
 * + `SELECT ... FOR UPDATE`, migração 071) mora no Postgres agora, não
 * em TypeScript — e já foi verificada ao vivo contra o banco real
 * (fim de mês, retentativa da MESMA fatura, e o cenário exato do bug
 * original: retentativa TARDIA de uma fatura antiga depois que uma
 * mais recente já tinha avançado o período). O que este arquivo trava
 * é o CONTRATO entre `renewAccountPlan` e a RPC `apply_plan_renewal`:
 * os parâmetros certos saem, o resultado da função vira o `RenewResult`
 * certo, os três tipos de erro (`ACCOUNT_NOT_FOUND`/`NO_BILLING_CYCLE`/
 * falha genérica) mapeiam para o código certo.
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

describe('renewAccountPlan', () => {
  it('passa os parâmetros certos para apply_plan_renewal, inclusive externalRef/note', async () => {
    const { client, calls } = makeRpcClient(() => ({
      data: [
        {
          applied: true,
          current_period_end: '2026-09-27T12:00:00.000Z',
          status: 'active',
        },
      ],
      error: null,
    }));
    await renewAccountPlan(client, {
      accountId: 'acct-1',
      paymentRef: 'fatura-2026-09',
      paidAt: '2026-08-27T12:00:00.000Z',
      periods: 1,
      externalRef: 'nf-4471',
      note: 'Pix conciliado',
    });
    expect(calls).toEqual([
      {
        fn: 'apply_plan_renewal',
        args: {
          p_account_id: 'acct-1',
          p_payment_ref: 'fatura-2026-09',
          p_paid_at: '2026-08-27T12:00:00.000Z',
          p_periods: 1,
          p_external_ref: 'nf-4471',
          p_note: 'Pix conciliado',
        },
      },
    ]);
  });

  it('externalRef/note omitidos viram null, não undefined (a RPC exige o parâmetro)', async () => {
    const { client, calls } = makeRpcClient(() => ({
      data: [{ applied: true, current_period_end: null, status: 'active' }],
      error: null,
    }));
    await renewAccountPlan(client, {
      accountId: 'acct-1',
      paymentRef: 'fatura-1',
      paidAt: null,
      periods: 1,
    });
    expect(calls[0].args.p_external_ref).toBeNull();
    expect(calls[0].args.p_note).toBeNull();
  });

  // SPEC 078 §4.3 — os três parâmetros da 089.
  it('actor/method/amountCents chegam à RPC com os nomes p_actor/p_method/p_amount_cents', async () => {
    const { client, calls } = makeRpcClient(() => ({
      data: [{ applied: true, current_period_end: null, status: 'active' }],
      error: null,
    }));
    await renewAccountPlan(client, {
      accountId: 'acct-1',
      paymentRef: 'E2E123',
      paidAt: '2026-10-09T15:00:00.000Z',
      periods: 1,
      actor: 'console:bruno@zapcrmbr.com',
      method: 'pix',
      amountCents: 34900,
    });
    expect(calls[0].args).toMatchObject({
      p_actor: 'console:bruno@zapcrmbr.com',
      p_method: 'pix',
      p_amount_cents: 34900,
    });
  });

  it('valor 0 é repassado (0 não é "ausente")', async () => {
    const { client, calls } = makeRpcClient(() => ({
      data: [{ applied: true, current_period_end: null, status: 'active' }],
      error: null,
    }));
    await renewAccountPlan(client, {
      accountId: 'acct-1',
      paymentRef: 'cortesia-1',
      paidAt: null,
      periods: 1,
      amountCents: 0,
    });
    expect(calls[0].args.p_amount_cents).toBe(0);
  });

  it('a rota de máquina (sem os campos novos) continua mandando só os 6 nomes antigos', async () => {
    const { client, calls } = makeRpcClient(() => ({
      data: [{ applied: true, current_period_end: null, status: 'active' }],
      error: null,
    }));
    await renewAccountPlan(client, {
      accountId: 'acct-1',
      paymentRef: 'fatura-1',
      paidAt: null,
      periods: 1,
    });
    expect(Object.keys(calls[0].args).sort()).toEqual([
      'p_account_id',
      'p_external_ref',
      'p_note',
      'p_paid_at',
      'p_payment_ref',
      'p_periods',
    ]);
  });

  it('applied=true na linha devolvida vira status "applied" com o plano atualizado', async () => {
    const { client } = makeRpcClient(() => ({
      data: [
        {
          applied: true,
          current_period_end: '2026-09-27T12:00:00.000Z',
          status: 'active',
        },
      ],
      error: null,
    }));
    const result = await renewAccountPlan(client, {
      accountId: 'acct-1',
      paymentRef: 'fatura-1',
      paidAt: null,
      periods: 1,
    });
    expect(result).toEqual({
      ok: true,
      status: 'applied',
      accountPlan: {
        currentPeriodEnd: '2026-09-27T12:00:00.000Z',
        status: 'active',
      },
    });
  });

  it('applied=false na linha devolvida vira already_applied (retentativa reconhecida pelo Postgres)', async () => {
    const { client } = makeRpcClient(() => ({
      data: [
        {
          applied: false,
          current_period_end: '2026-08-27T12:00:00.000Z',
          status: 'active',
        },
      ],
      error: null,
    }));
    const result = await renewAccountPlan(client, {
      accountId: 'acct-1',
      paymentRef: 'fatura-repetida',
      paidAt: null,
      periods: 1,
    });
    expect(result).toEqual({ ok: true, status: 'already_applied' });
  });

  it('erro ACCOUNT_NOT_FOUND da função vira account_not_found', async () => {
    const { client } = makeRpcClient(() => ({
      data: null,
      error: { message: 'ACCOUNT_NOT_FOUND' },
    }));
    const result = await renewAccountPlan(client, {
      accountId: 'sumiu',
      paymentRef: 'ref-1',
      paidAt: null,
      periods: 1,
    });
    expect(result).toEqual({ ok: false, error: 'account_not_found' });
  });

  it('erro NO_BILLING_CYCLE da função vira no_billing_cycle', async () => {
    const { client } = makeRpcClient(() => ({
      data: null,
      error: { message: 'NO_BILLING_CYCLE' },
    }));
    const result = await renewAccountPlan(client, {
      accountId: 'acct-1',
      paymentRef: 'ref-1',
      paidAt: null,
      periods: 1,
    });
    expect(result).toEqual({ ok: false, error: 'no_billing_cycle' });
  });

  it('erro desconhecido/infra devolve update_failed, e loga', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { client } = makeRpcClient(() => ({
      data: null,
      error: { message: 'connection reset' },
    }));
    const result = await renewAccountPlan(client, {
      accountId: 'acct-1',
      paymentRef: 'ref-1',
      paidAt: null,
      periods: 1,
    });
    expect(result).toEqual({ ok: false, error: 'update_failed' });
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  // Achado de code review preservado: uma função `RETURNS TABLE` sem
  // linha nenhuma (não deveria acontecer — a função sempre grava uma —
  // mas o cliente não pode presumir isso) não pode ser tratada como
  // sucesso silencioso.
  it('RPC sem erro mas sem linha nenhuma devolve update_failed', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { client } = makeRpcClient(() => ({ data: [], error: null }));
    const result = await renewAccountPlan(client, {
      accountId: 'acct-1',
      paymentRef: 'ref-1',
      paidAt: null,
      periods: 1,
    });
    expect(result).toEqual({ ok: false, error: 'update_failed' });
    errorSpy.mockRestore();
  });

  it('data como objeto único (não array) também é aceito', async () => {
    const { client } = makeRpcClient(() => ({
      data: {
        applied: true,
        current_period_end: '2026-09-27T12:00:00.000Z',
        status: 'active',
      },
      error: null,
    }));
    const result = await renewAccountPlan(client, {
      accountId: 'acct-1',
      paymentRef: 'ref-1',
      paidAt: null,
      periods: 1,
    });
    expect(result.ok).toBe(true);
  });

  it('periods > 1 é repassado intacto para a RPC', async () => {
    const { client, calls } = makeRpcClient(() => ({
      data: [
        {
          applied: true,
          current_period_end: '2026-11-27T12:00:00.000Z',
          status: 'active',
        },
      ],
      error: null,
    }));
    await renewAccountPlan(client, {
      accountId: 'acct-1',
      paymentRef: 'fatura-trimestre',
      paidAt: null,
      periods: 3,
    });
    expect(calls[0].args.p_periods).toBe(3);
  });
});
