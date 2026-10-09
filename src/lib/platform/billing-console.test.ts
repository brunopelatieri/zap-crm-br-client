import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

const writePlatformAudit = vi.fn().mockResolvedValue(undefined);
vi.mock('./audit', async () => {
  const actual = await vi.importActual<typeof import('./audit')>('./audit');
  return {
    ...actual,
    writePlatformAudit: (...args: unknown[]) => writePlatformAudit(...args),
  };
});

const recordActivity = vi.fn().mockResolvedValue(undefined);
vi.mock('@/lib/activity/record', () => ({
  recordActivity: (...args: unknown[]) => recordActivity(...args),
}));

const dispatchWebhookEvent = vi.fn().mockResolvedValue(undefined);
vi.mock('@/lib/webhooks/deliver', () => ({
  dispatchWebhookEvent: (...args: unknown[]) => dispatchWebhookEvent(...args),
}));

const emitSystemEvent = vi.fn().mockResolvedValue(undefined);
vi.mock('@/lib/notifications/emit', () => ({
  emitSystemEvent: (...args: unknown[]) => emitSystemEvent(...args),
}));

import {
  changePlanPeriodEnd,
  listPayments,
  recordManualPayment,
  reverseManualPayment,
} from './billing-console';

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const PAYMENT = '22222222-2222-4222-8222-222222222222';
const OWNER = 'bruno@zapcrmbr.com';
const ACTOR = `console:${OWNER}`;
// 2026-10-09 em São Paulo.
const NOW = new Date('2026-10-09T15:00:00Z');

interface FakeOptions {
  rpc?: (fn: string, args: Record<string, unknown>) => unknown;
  payment?: {
    id?: string;
    account_id: string;
    payment_ref?: string;
    reversed_at?: string | null;
  } | null;
  blockedAt?: string | null;
  paymentsRows?: unknown[];
}

function makeDb(options: FakeOptions = {}) {
  const rpcCalls: { fn: string; args: Record<string, unknown> }[] = [];
  const db = {
    rpc: (fn: string, args: Record<string, unknown>) => {
      rpcCalls.push({ fn, args });
      return Promise.resolve(
        options.rpc?.(fn, args) ?? { data: [], error: null }
      );
    },
    from: (table: string) => {
      const chain: Record<string, unknown> = {
        select: () => chain,
        eq: () => chain,
        order: () => chain,
        limit: () =>
          Promise.resolve({ data: options.paymentsRows ?? [], error: null }),
        maybeSingle: () => {
          if (table === 'accounts') {
            return Promise.resolve({
              data: { blocked_at: options.blockedAt ?? null },
              error: null,
            });
          }
          if (table === 'account_plan_payments') {
            return Promise.resolve({
              data: options.payment === undefined ? null : options.payment,
              error: null,
            });
          }
          throw new Error(`tabela inesperada: ${table}`);
        },
      };
      return chain;
    },
  } as unknown as SupabaseClient;
  return { db, rpcCalls };
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

// ── Alterar vencimento ───────────────────────────────────────────────

describe('changePlanPeriodEnd', () => {
  const periodRow = {
    previous_period_end: '2026-10-10T02:59:59+00:00',
    new_period_end: '2026-12-21T02:59:59+00:00',
    previous_status: 'past_due',
    new_status: 'active',
    billing_cycle: 'monthly',
  };
  const run = (db: SupabaseClient, body: Record<string, unknown> | null) =>
    changePlanPeriodEnd(db, {
      accountId: ACCOUNT,
      ownerEmail: OWNER,
      body,
      now: NOW,
    });

  it('caminho feliz: chama a RPC com o ator do console e dispara os efeitos', async () => {
    const { db, rpcCalls } = makeDb({
      rpc: () => ({ data: [periodRow], error: null }),
    });
    const result = await run(db, {
      date: '2026-12-20',
      billingCycle: 'yearly',
      reason: '  cliente pediu  ',
    });

    expect(result).toEqual({
      ok: true,
      data: {
        previousPeriodEnd: '2026-10-10T02:59:59+00:00',
        currentPeriodEnd: '2026-12-21T02:59:59+00:00',
        previousStatus: 'past_due',
        status: 'active',
        billingCycle: 'monthly',
      },
    });
    expect(rpcCalls[0]).toEqual({
      fn: 'set_plan_period_end',
      args: {
        p_account_id: ACCOUNT,
        p_date: '2026-12-20',
        p_billing_cycle: 'yearly',
        p_actor: ACTOR,
      },
    });
    expect(writePlatformAudit).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        actor: ACTOR,
        action: 'billing.period_end.set',
        accountId: ACCOUNT,
        payload: expect.objectContaining({
          previousPeriodEnd: '2026-10-10T02:59:59+00:00',
          newPeriodEnd: '2026-12-21T02:59:59+00:00',
          reason: 'cliente pediu',
        }),
      })
    );
    expect(recordActivity).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        accountId: ACCOUNT,
        resourceType: 'plan',
        action: 'plan.period_changed',
        actor: { kind: 'system', name: 'platform' },
      })
    );
    expect(dispatchWebhookEvent).toHaveBeenCalledWith(
      db,
      ACCOUNT,
      'plan.period_changed',
      {
        previousPeriodEnd: '2026-10-10T02:59:59+00:00',
        currentPeriodEnd: '2026-12-21T02:59:59+00:00',
        billingCycle: 'monthly',
        status: 'active',
      }
    );
    // §8.1: alterar vencimento não gera evento do sistema (SPEC 063).
    expect(emitSystemEvent).not.toHaveBeenCalled();
  });

  it('corpo ausente → 400 invalid_body, sem tocar no banco', async () => {
    const { db, rpcCalls } = makeDb();
    expect(await run(db, null)).toMatchObject({
      ok: false,
      status: 400,
      code: 'invalid_body',
    });
    expect(rpcCalls).toEqual([]);
  });

  it('data de ontem (calendário de SP) → 400 period_end_out_of_range, sem RPC', async () => {
    const { db, rpcCalls } = makeDb();
    expect(await run(db, { date: '2026-10-08' })).toMatchObject({
      ok: false,
      status: 400,
      code: 'period_end_out_of_range',
    });
    expect(rpcCalls).toEqual([]);
    expect(writePlatformAudit).not.toHaveBeenCalled();
  });

  it('ciclo inválido → 400 invalid_billing_cycle', async () => {
    const { db } = makeDb();
    expect(
      await run(db, { date: '2026-12-20', billingCycle: 'weekly' })
    ).toMatchObject({
      ok: false,
      status: 400,
      code: 'invalid_billing_cycle',
    });
  });

  it.each([
    ['ACCOUNT_NOT_FOUND', 404, 'account_not_found'],
    ['NO_BILLING_CYCLE', 400, 'no_billing_cycle'],
    ['PERIOD_END_OUT_OF_RANGE', 400, 'period_end_out_of_range'],
    ['connection reset', 500, 'update_failed'],
  ])(
    'exceção do banco %s → %i %s, sem efeitos',
    async (message, status, code) => {
      const { db } = makeDb({
        rpc: () => ({ data: null, error: { message } }),
      });
      expect(await run(db, { date: '2026-12-20' })).toMatchObject({
        ok: false,
        status,
        code,
      });
      expect(writePlatformAudit).not.toHaveBeenCalled();
      expect(recordActivity).not.toHaveBeenCalled();
      expect(dispatchWebhookEvent).not.toHaveBeenCalled();
    }
  );
});

// ── Pagamento manual ─────────────────────────────────────────────────

describe('recordManualPayment', () => {
  const body = {
    paymentRef: 'console:abc',
    paidAt: '2026-10-09',
    periods: 1,
    method: 'pix',
    amountCents: 34900,
    note: 'Pix conciliado',
  };
  const applied = {
    data: [
      {
        applied: true,
        current_period_end: '2026-11-10T02:59:59+00:00',
        status: 'active',
      },
    ],
    error: null,
  };
  const run = (db: SupabaseClient, b: Record<string, unknown> | null = body) =>
    recordManualPayment(db, {
      accountId: ACCOUNT,
      ownerEmail: OWNER,
      body: b,
      now: NOW,
    });

  it('aplicado: RPC com actor/método/valor e todos os efeitos', async () => {
    const { db, rpcCalls } = makeDb({ rpc: () => applied });
    const result = await run(db);

    expect(result).toEqual({
      ok: true,
      data: {
        status: 'applied',
        accountPlan: {
          currentPeriodEnd: '2026-11-10T02:59:59+00:00',
          status: 'active',
        },
        accountBlocked: false,
      },
    });
    expect(rpcCalls[0].fn).toBe('apply_plan_renewal');
    expect(rpcCalls[0].args).toMatchObject({
      p_account_id: ACCOUNT,
      p_payment_ref: 'console:abc',
      p_paid_at: '2026-10-09T15:00:00.000Z',
      p_periods: 1,
      p_note: 'Pix conciliado',
      p_actor: ACTOR,
      p_method: 'pix',
      p_amount_cents: 34900,
    });
    expect(writePlatformAudit).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        actor: ACTOR,
        action: 'billing.payment.manual',
        accountId: ACCOUNT,
      })
    );
    expect(recordActivity).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        action: 'plan.renewed',
        actor: { kind: 'system', name: 'platform' },
        metadata: { payment_ref: 'console:abc', periods: 1, source: 'console' },
      })
    );
    expect(dispatchWebhookEvent).toHaveBeenCalledWith(
      db,
      ACCOUNT,
      'plan.renewed',
      {
        paymentRef: 'console:abc',
        periods: 1,
        currentPeriodEnd: '2026-11-10T02:59:59+00:00',
        source: 'console',
      }
    );
    expect(emitSystemEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'plan.renewed',
        accountId: ACCOUNT,
        actor: ACTOR,
      }),
      db
    );
  });

  const notApplied = () => ({
    data: [
      {
        applied: false,
        current_period_end: '2026-11-10T02:59:59+00:00',
        status: 'active',
      },
    ],
    error: null,
  });

  const expectNoEffects = () => {
    expect(writePlatformAudit).not.toHaveBeenCalled();
    expect(recordActivity).not.toHaveBeenCalled();
    expect(dispatchWebhookEvent).not.toHaveBeenCalled();
    expect(emitSystemEvent).not.toHaveBeenCalled();
  };

  it('já aplicado NESTA conta, vigente (idempotência): 200 already_applied, nenhum efeito', async () => {
    const { db } = makeDb({
      rpc: notApplied,
      payment: { account_id: ACCOUNT, reversed_at: null },
    });
    expect(await run(db)).toEqual({
      ok: true,
      data: { status: 'already_applied' },
    });
    expectNoEffects();
  });

  it('identificador de OUTRA conta: 409 payment_ref_in_use (nada foi aplicado aqui)', async () => {
    const { db } = makeDb({
      rpc: notApplied,
      payment: {
        account_id: '33333333-3333-4333-8333-333333333333',
        reversed_at: null,
      },
    });
    expect(await run(db)).toMatchObject({
      ok: false,
      status: 409,
      code: 'payment_ref_in_use',
    });
    expectNoEffects();
  });

  it('identificador de pagamento ESTORNADO desta conta: 409 payment_ref_reversed', async () => {
    const { db } = makeDb({
      rpc: notApplied,
      payment: { account_id: ACCOUNT, reversed_at: '2026-10-09T14:00:00Z' },
    });
    expect(await run(db)).toMatchObject({
      ok: false,
      status: 409,
      code: 'payment_ref_reversed',
    });
    expectNoEffects();
  });

  it('dono do identificador não encontrado: 500, nunca already_applied', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { db } = makeDb({ rpc: notApplied, payment: null });
    expect(await run(db)).toMatchObject({
      ok: false,
      status: 500,
      code: 'read_failed',
    });
    expectNoEffects();
    spy.mockRestore();
  });

  it('conta bloqueada: o pagamento aplica e a resposta avisa accountBlocked', async () => {
    const { db } = makeDb({
      rpc: () => applied,
      blockedAt: '2026-10-01T00:00:00Z',
    });
    const result = await run(db);
    expect(result).toMatchObject({
      ok: true,
      data: { status: 'applied', accountBlocked: true },
    });
  });

  it('sem paymentRef → 400 payment_ref_required (o diálogo gera, a rota não)', async () => {
    const { db, rpcCalls } = makeDb();
    expect(await run(db, { ...body, paymentRef: undefined })).toMatchObject({
      ok: false,
      status: 400,
      code: 'payment_ref_required',
    });
    expect(rpcCalls).toEqual([]);
  });

  it.each([
    [{ paidAt: '2026-10-10' }, 'paid_at_in_future'],
    [{ periods: 13 }, 'periods_invalid'],
    [{ method: 'bitcoin' }, 'method_invalid'],
    [{ amountCents: -1 }, 'amount_invalid'],
  ])('entrada inválida %j → 400 %s, sem RPC', async (override, code) => {
    const { db, rpcCalls } = makeDb();
    expect(await run(db, { ...body, ...override })).toMatchObject({
      ok: false,
      status: 400,
      code,
    });
    expect(rpcCalls).toEqual([]);
  });

  it.each([
    ['ACCOUNT_NOT_FOUND', 404, 'account_not_found'],
    ['NO_BILLING_CYCLE', 400, 'no_billing_cycle'],
    ['connection reset', 500, 'update_failed'],
  ])(
    'exceção do banco %s → %i %s, sem efeitos',
    async (message, status, code) => {
      const { db } = makeDb({
        rpc: () => ({ data: null, error: { message } }),
      });
      expect(await run(db)).toMatchObject({ ok: false, status, code });
      expect(writePlatformAudit).not.toHaveBeenCalled();
      expect(dispatchWebhookEvent).not.toHaveBeenCalled();
    }
  );
});

// ── Listagem e estorno ───────────────────────────────────────────────

describe('listPayments', () => {
  it('devolve os pagamentos mapeados', async () => {
    const { db } = makeDb({
      paymentsRows: [
        {
          id: PAYMENT,
          account_id: ACCOUNT,
          payment_ref: 'x',
          periods: 1,
          previous_period_end: null,
          new_period_end: '2026-11-10T02:59:59+00:00',
          paid_at: '2026-10-09T15:00:00+00:00',
          external_ref: null,
          note: null,
          method: 'pix',
          amount_cents: null,
          recorded_by: ACTOR,
          previous_status: 'active',
          reversed_at: null,
          reversed_by: null,
          reversal_reason: null,
          created_at: '2026-10-09T15:01:00+00:00',
        },
      ],
    });
    const result = await listPayments(db, ACCOUNT);
    expect(result.ok && result.data.payments).toHaveLength(1);
    expect(result.ok && result.data.payments[0].paymentRef).toBe('x');
  });
});

describe('reverseManualPayment', () => {
  const run = (db: SupabaseClient, body: { reason?: unknown } | null = {}) =>
    reverseManualPayment(db, {
      accountId: ACCOUNT,
      paymentId: PAYMENT,
      ownerEmail: OWNER,
      body,
    });
  const existing = { id: PAYMENT, account_id: ACCOUNT, payment_ref: 'E2E1' };

  it('sucesso: RPC com ator e motivo, auditoria e atividade, sem webhook', async () => {
    const { db, rpcCalls } = makeDb({
      payment: existing,
      rpc: () => ({
        data: [
          {
            restored_period_end: '2026-10-10T02:59:59+00:00',
            restored_status: 'past_due',
          },
        ],
        error: null,
      }),
    });
    const result = await run(db, { reason: ' Pix na conta errada ' });

    expect(result).toEqual({
      ok: true,
      data: {
        restoredPeriodEnd: '2026-10-10T02:59:59+00:00',
        restoredStatus: 'past_due',
      },
    });
    expect(rpcCalls[0]).toEqual({
      fn: 'reverse_plan_payment',
      args: {
        p_payment_id: PAYMENT,
        p_actor: ACTOR,
        p_reason: 'Pix na conta errada',
      },
    });
    expect(writePlatformAudit).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        action: 'billing.payment.reverse',
        accountId: ACCOUNT,
        payload: expect.objectContaining({
          paymentId: PAYMENT,
          paymentRef: 'E2E1',
          reason: 'Pix na conta errada',
        }),
      })
    );
    expect(recordActivity).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ action: 'plan.payment_reversed' })
    );
    expect(dispatchWebhookEvent).not.toHaveBeenCalled();
    expect(emitSystemEvent).not.toHaveBeenCalled();
  });

  it('pagamento inexistente → 404, sem RPC', async () => {
    const { db, rpcCalls } = makeDb({ payment: null });
    expect(await run(db)).toMatchObject({
      ok: false,
      status: 404,
      code: 'payment_not_found',
    });
    expect(rpcCalls).toEqual([]);
  });

  it('pagamento de OUTRA conta → 404 (não estorna por id adivinhado), sem RPC', async () => {
    const { db, rpcCalls } = makeDb({
      payment: {
        ...existing,
        account_id: '99999999-9999-4999-8999-999999999999',
      },
    });
    expect(await run(db)).toMatchObject({
      ok: false,
      status: 404,
      code: 'payment_not_found',
    });
    expect(rpcCalls).toEqual([]);
  });

  it.each([
    'payment_already_reversed',
    'payment_not_reversible',
    'payment_not_latest',
    'period_changed_since_payment',
  ])('%s → 409, sem efeitos', async (code) => {
    const { db } = makeDb({
      payment: existing,
      rpc: () => ({ data: null, error: { message: code.toUpperCase() } }),
    });
    expect(await run(db)).toMatchObject({ ok: false, status: 409, code });
    expect(writePlatformAudit).not.toHaveBeenCalled();
    expect(recordActivity).not.toHaveBeenCalled();
  });

  it('erro de infra → 500 update_failed', async () => {
    const { db } = makeDb({
      payment: existing,
      rpc: () => ({ data: null, error: { message: 'boom' } }),
    });
    expect(await run(db)).toMatchObject({
      ok: false,
      status: 500,
      code: 'update_failed',
    });
  });
});
