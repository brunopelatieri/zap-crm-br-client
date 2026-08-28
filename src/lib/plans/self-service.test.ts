import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { applyPlanChange, setCancelAtPeriodEnd } from './self-service';

interface RecordedOp {
  table: string;
  verb: 'select' | 'update' | 'insert';
  payload?: unknown;
}

/** Mesmo espírito de `plan-actions.test.ts` — mock keyed por `${table}.${verb}`. */
function makeDb(
  results: Record<string, { data?: unknown; error?: unknown }> = {}
) {
  const ops: RecordedOp[] = [];
  const insertedEvents: Record<string, unknown>[] = [];
  const updates: Record<string, unknown>[] = [];

  function builder(table: string) {
    const op: RecordedOp = { table, verb: 'select' };
    let recorded = false;
    const settle = () => {
      if (!recorded) {
        ops.push(op);
        recorded = true;
      }
      return results[`${table}.${op.verb}`] ?? { data: null, error: null };
    };

    const chain: Record<string, unknown> = {
      insert: (payload?: unknown) => {
        op.verb = 'insert';
        op.payload = payload;
        if (table === 'account_plan_events') {
          insertedEvents.push(payload as Record<string, unknown>);
        }
        return chain;
      },
      update: (payload?: unknown) => {
        op.verb = 'update';
        op.payload = payload;
        updates.push({ table, payload });
        return chain;
      },
      select: () => chain,
      eq: () => chain,
      single: () => Promise.resolve(settle()),
      maybeSingle: () => Promise.resolve(settle()),
      then: (resolve: (v: unknown) => unknown) =>
        Promise.resolve(settle()).then(resolve),
    };
    return chain;
  }

  return {
    client: { from: (t: string) => builder(t) } as unknown as SupabaseClient,
    ops,
    insertedEvents,
    updates,
  };
}

const PUBLIC_PLAN_ROW = {
  id: 'plan-pro',
  code: 'profissional',
  billing_period: 'monthly',
  price_cents: 34900,
  yearly_discount_percent: null,
};

const CURRENT_ACCOUNT_ROW = {
  status: 'active',
  plans: { code: 'essencial' },
};

const UPDATED_ACCOUNT_ROW = {
  plan_id: 'plan-pro',
  status: 'active',
  billing_cycle: 'monthly',
  started_at: '2026-08-27T12:00:00.000Z',
  current_period_end: '2026-09-27T12:00:00.000Z',
  cancel_at_period_end: false,
  limit_overrides: { contacts: 500 },
};

describe('applyPlanChange', () => {
  it('self_service_enabled=false recusa antes de tocar plans/account_plans', async () => {
    const { client, ops } = makeDb({
      'platform_settings.select': {
        data: { self_service_enabled: false },
        error: null,
      },
    });
    const result = await applyPlanChange(client, {
      accountId: 'acct-1',
      planId: 'plan-pro',
      billingCycle: 'monthly',
      actor: 'self-service:x@y.com',
    });
    expect(result).toEqual({ ok: false, error: 'self_service_disabled' });
    expect(ops.map((o) => o.table)).toEqual(['platform_settings']);
  });

  it('plano fora do catálogo público+ativo devolve plan_not_available', async () => {
    const { client } = makeDb({
      'platform_settings.select': {
        data: { self_service_enabled: true },
        error: null,
      },
      'plans.select': { data: null, error: null },
    });
    const result = await applyPlanChange(client, {
      accountId: 'acct-1',
      planId: 'plan-custom',
      billingCycle: 'monthly',
      actor: 'self-service:x@y.com',
    });
    expect(result).toEqual({ ok: false, error: 'plan_not_available' });
  });

  it('conta sem account_plans devolve account_not_found', async () => {
    const { client } = makeDb({
      'platform_settings.select': {
        data: { self_service_enabled: true },
        error: null,
      },
      'plans.select': { data: PUBLIC_PLAN_ROW, error: null },
      'account_plans.select': { data: null, error: null },
    });
    const result = await applyPlanChange(client, {
      accountId: 'sumiu',
      planId: 'plan-pro',
      billingCycle: 'monthly',
      actor: 'self-service:x@y.com',
    });
    expect(result).toEqual({ ok: false, error: 'account_not_found' });
  });

  it('troca bem-sucedida recalcula started_at/current_period_end a partir de agora, não do started_at anterior', async () => {
    const { client, insertedEvents, updates } = makeDb({
      'platform_settings.select': {
        data: { self_service_enabled: true },
        error: null,
      },
      'plans.select': { data: PUBLIC_PLAN_ROW, error: null },
      'account_plans.select': { data: CURRENT_ACCOUNT_ROW, error: null },
      'account_plans.update': { data: UPDATED_ACCOUNT_ROW, error: null },
    });
    const now = new Date('2026-08-27T12:00:00.000Z');
    const result = await applyPlanChange(client, {
      accountId: 'acct-1',
      planId: 'plan-pro',
      billingCycle: 'monthly',
      actor: 'self-service:owner@x.com',
      now,
    });

    expect(result.ok).toBe(true);
    const update = updates.find((u) => u.table === 'account_plans')
      ?.payload as Record<string, unknown>;
    expect(update.started_at).toBe(now.toISOString());
    expect(update.current_period_end).toBe('2026-09-27T12:00:00.000Z');
    expect(update.cancel_at_period_end).toBe(false);
    expect(update.canceled_at).toBe(null);
    expect(update.status).toBe('active');

    expect(insertedEvents).toEqual([
      {
        account_id: 'acct-1',
        from_plan_code: 'essencial',
        to_plan_code: 'profissional',
        from_status: 'active',
        to_status: 'active',
        overrides_after: { contacts: 500 },
        actor: 'self-service:owner@x.com',
        reason: null,
      },
    ]);
  });

  it('plano sem vencimento (billing_period none) grava current_period_end null', async () => {
    const { client, updates } = makeDb({
      'platform_settings.select': {
        data: { self_service_enabled: true },
        error: null,
      },
      'plans.select': {
        data: { ...PUBLIC_PLAN_ROW, billing_period: 'none', price_cents: 0 },
        error: null,
      },
      'account_plans.select': { data: CURRENT_ACCOUNT_ROW, error: null },
      'account_plans.update': {
        data: { ...UPDATED_ACCOUNT_ROW, current_period_end: null },
        error: null,
      },
    });
    await applyPlanChange(client, {
      accountId: 'acct-1',
      planId: 'plan-free',
      billingCycle: 'monthly',
      actor: 'self-service:x@y.com',
    });
    const update = updates.find((u) => u.table === 'account_plans')
      ?.payload as Record<string, unknown>;
    expect(update.current_period_end).toBe(null);
  });

  it('falha na escrita devolve update_failed', async () => {
    const { client } = makeDb({
      'platform_settings.select': {
        data: { self_service_enabled: true },
        error: null,
      },
      'plans.select': { data: PUBLIC_PLAN_ROW, error: null },
      'account_plans.select': { data: CURRENT_ACCOUNT_ROW, error: null },
      'account_plans.update': { data: null, error: { message: 'conflict' } },
    });
    const result = await applyPlanChange(client, {
      accountId: 'acct-1',
      planId: 'plan-pro',
      billingCycle: 'monthly',
      actor: 'self-service:x@y.com',
    });
    expect(result).toEqual({ ok: false, error: 'update_failed' });
  });
});

describe('setCancelAtPeriodEnd', () => {
  it('self_service_enabled=false recusa', async () => {
    const { client } = makeDb({
      'platform_settings.select': {
        data: { self_service_enabled: false },
        error: null,
      },
    });
    const result = await setCancelAtPeriodEnd(client, 'acct-1', true);
    expect(result).toEqual({ ok: false, error: 'self_service_disabled' });
  });

  it('agendar num plano sem vencimento devolve no_period_end', async () => {
    const { client } = makeDb({
      'platform_settings.select': {
        data: { self_service_enabled: true },
        error: null,
      },
      'account_plans.select': {
        data: { current_period_end: null },
        error: null,
      },
    });
    const result = await setCancelAtPeriodEnd(client, 'acct-1', true);
    expect(result).toEqual({ ok: false, error: 'no_period_end' });
  });

  it('agenda o cancelamento quando há vencimento', async () => {
    const { client, updates } = makeDb({
      'platform_settings.select': {
        data: { self_service_enabled: true },
        error: null,
      },
      'account_plans.select': {
        data: { current_period_end: '2026-09-27T12:00:00.000Z' },
        error: null,
      },
      'account_plans.update': { data: {}, error: null },
    });
    const now = new Date('2026-08-27T12:00:00.000Z');
    const result = await setCancelAtPeriodEnd(
      client,
      'acct-1',
      true,
      now,
      'self-service:owner@x.com'
    );
    expect(result).toEqual({ ok: true, cancelAtPeriodEnd: true });
    const update = updates.find((u) => u.table === 'account_plans')
      ?.payload as Record<string, unknown>;
    expect(update.cancel_at_period_end).toBe(true);
    expect(update.canceled_at).toBe(now.toISOString());
  });

  // Achado de code review: diferente de `applyPlanChange`, esta função
  // não gravava `updated_by` nem `account_plan_events` — o histórico da
  // conta ficava mudo sobre quem (e quando) agendou/reverteu um
  // cancelamento. Os dois testes abaixo travam a correção.
  it('grava updated_by e um evento no histórico (achado de code review)', async () => {
    const { client, updates, insertedEvents } = makeDb({
      'platform_settings.select': {
        data: { self_service_enabled: true },
        error: null,
      },
      'account_plans.select': {
        data: {
          status: 'active',
          current_period_end: '2026-09-27T12:00:00.000Z',
          limit_overrides: { contacts: 500 },
          plans: { code: 'essencial' },
          accounts: { name: 'Conta X' },
        },
        error: null,
      },
      'account_plans.update': { data: {}, error: null },
    });
    const result = await setCancelAtPeriodEnd(
      client,
      'acct-1',
      true,
      new Date('2026-08-27T12:00:00.000Z'),
      'self-service:owner@x.com'
    );
    expect(result.ok).toBe(true);

    const update = updates.find((u) => u.table === 'account_plans')
      ?.payload as Record<string, unknown>;
    expect(update.updated_by).toBe('self-service:owner@x.com');

    expect(insertedEvents).toEqual([
      expect.objectContaining({
        account_id: 'acct-1',
        from_plan_code: 'essencial',
        to_plan_code: 'essencial',
        from_status: 'active',
        to_status: 'active',
        overrides_after: { contacts: 500 },
        actor: 'self-service:owner@x.com',
      }),
    ]);
  });

  it('actor ausente: updated_by fica null, mas o evento nunca viola o NOT NULL de actor', async () => {
    const { client, updates, insertedEvents } = makeDb({
      'platform_settings.select': {
        data: { self_service_enabled: true },
        error: null,
      },
      'account_plans.select': {
        data: {
          status: 'active',
          current_period_end: '2026-09-27T12:00:00.000Z',
          limit_overrides: {},
          plans: { code: 'essencial' },
          accounts: { name: 'Conta X' },
        },
        error: null,
      },
      'account_plans.update': { data: {}, error: null },
    });
    await setCancelAtPeriodEnd(client, 'acct-1', true);

    const update = updates.find((u) => u.table === 'account_plans')
      ?.payload as Record<string, unknown>;
    expect(update.updated_by).toBeNull();
    expect(insertedEvents[0]?.actor).toBe('self-service:unknown');
  });

  it('reverter limpa canceled_at mesmo sem vencimento', async () => {
    const { client, updates } = makeDb({
      'platform_settings.select': {
        data: { self_service_enabled: true },
        error: null,
      },
      'account_plans.select': {
        data: { current_period_end: null },
        error: null,
      },
      'account_plans.update': { data: {}, error: null },
    });
    const result = await setCancelAtPeriodEnd(client, 'acct-1', false);
    expect(result).toEqual({ ok: true, cancelAtPeriodEnd: false });
    const update = updates.find((u) => u.table === 'account_plans')
      ?.payload as Record<string, unknown>;
    expect(update.cancel_at_period_end).toBe(false);
    expect(update.canceled_at).toBe(null);
  });

  it('falha na escrita devolve update_failed', async () => {
    const { client } = makeDb({
      'platform_settings.select': {
        data: { self_service_enabled: true },
        error: null,
      },
      'account_plans.select': {
        data: { current_period_end: '2026-09-27T12:00:00.000Z' },
        error: null,
      },
      'account_plans.update': { data: null, error: { message: 'conflict' } },
    });
    const result = await setCancelAtPeriodEnd(client, 'acct-1', true);
    expect(result).toEqual({ ok: false, error: 'update_failed' });
  });
});
