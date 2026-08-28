import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { changeAccountPlan } from './plan-actions';

interface RecordedOp {
  table: string;
  verb: 'select' | 'update' | 'insert';
  payload?: unknown;
  filters: [string, string, unknown][];
}

/**
 * Supabase de mentira, keyed por `${table}.${verb}` — mesmo espírito
 * de `send.test.ts`. `insertedEvents` captura tudo que
 * `account_plan_events` recebeu, para conferir o histórico gravado.
 */
function makeDb(
  results: Record<string, { data?: unknown; error?: unknown }> = {}
) {
  const ops: RecordedOp[] = [];
  const insertedEvents: Record<string, unknown>[] = [];

  function builder(table: string) {
    const op: RecordedOp = { table, verb: 'select', filters: [] };
    let recorded = false;
    const settle = () => {
      if (!recorded) {
        ops.push(op);
        recorded = true;
      }
      return results[`${table}.${op.verb}`] ?? { data: null, error: null };
    };

    const chain: Record<string, unknown> = {
      then(resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) {
        return Promise.resolve(settle()).then(resolve, reject);
      },
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
        return chain;
      },
      select: (...args: unknown[]) => {
        op.filters.push(['select', ...args] as [string, string, unknown]);
        return chain;
      },
      eq: (...args: unknown[]) => {
        op.filters.push(['eq', ...(args as [string, unknown])]);
        return chain;
      },
      single: () => Promise.resolve(settle()),
      maybeSingle: () => Promise.resolve(settle()),
    };
    return chain;
  }

  return {
    client: { from: (t: string) => builder(t) } as unknown as SupabaseClient,
    ops,
    insertedEvents,
  };
}

const CURRENT_ROW = {
  plan_id: 'plan-old',
  status: 'active',
  limit_overrides: { contacts: 500 },
  plans: { code: 'essencial' },
};

const UPDATED_ROW = {
  account_id: 'acct-1',
  plan_id: 'plan-new',
  status: 'active',
  limit_overrides: { contacts: 500 },
  note: null,
};

describe('changeAccountPlan', () => {
  it('rejeita status inválido antes de qualquer consulta', async () => {
    const { client, ops } = makeDb();
    const result = await changeAccountPlan(client, {
      accountId: 'acct-1',
      status: 'not_a_status' as never,
      actor: 'console:x@y.com',
    });
    expect(result).toEqual({ ok: false, error: 'invalid_status' });
    expect(ops).toEqual([]);
  });

  it('rejeita overrides com chave desconhecida antes de qualquer consulta', async () => {
    const { client, ops } = makeDb();
    const result = await changeAccountPlan(client, {
      accountId: 'acct-1',
      limitOverrides: { nao_existe: 1 },
      actor: 'console:x@y.com',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('invalid_overrides');
    expect(ops).toEqual([]);
  });

  it('conta sem account_plans devolve account_not_found', async () => {
    const { client } = makeDb({
      'account_plans.select': { data: null, error: null },
    });
    const result = await changeAccountPlan(client, {
      accountId: 'sumiu',
      actor: 'console:x@y.com',
    });
    expect(result).toEqual({ ok: false, error: 'account_not_found' });
  });

  it('planCode inexistente devolve plan_not_found sem escrever nada', async () => {
    const { client, ops } = makeDb({
      'account_plans.select': { data: CURRENT_ROW, error: null },
      'plans.select': { data: null, error: null },
    });
    const result = await changeAccountPlan(client, {
      accountId: 'acct-1',
      planCode: 'inexistente',
      actor: 'console:x@y.com',
    });
    expect(result).toEqual({ ok: false, error: 'plan_not_found' });
    expect(ops.some((o) => o.table === 'account_plan_events')).toBe(false);
  });

  it('planCode igual ao atual não faz lookup em plans', async () => {
    const { client, ops } = makeDb({
      'account_plans.select': { data: CURRENT_ROW, error: null },
      'account_plans.update': { data: UPDATED_ROW, error: null },
    });
    const result = await changeAccountPlan(client, {
      accountId: 'acct-1',
      planCode: 'essencial', // igual ao current
      actor: 'console:x@y.com',
    });
    expect(result.ok).toBe(true);
    expect(ops.map((o) => o.table)).toEqual([
      'account_plans',
      'account_plans',
      'account_plan_events',
    ]);
  });

  it('troca de plano bem-sucedida grava o evento com from/to corretos', async () => {
    const { client, insertedEvents } = makeDb({
      'account_plans.select': { data: CURRENT_ROW, error: null },
      'plans.select': {
        data: { id: 'plan-new', code: 'profissional' },
        error: null,
      },
      'account_plans.update': { data: UPDATED_ROW, error: null },
    });
    const result = await changeAccountPlan(client, {
      accountId: 'acct-1',
      planCode: 'profissional',
      actor: 'console:owner@x.com',
      reason: 'upgrade solicitado',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.accountPlan.planId).toBe('plan-new');
    }
    expect(insertedEvents).toEqual([
      {
        account_id: 'acct-1',
        from_plan_code: 'essencial',
        to_plan_code: 'profissional',
        from_status: 'active',
        to_status: 'active',
        overrides_after: { contacts: 500 },
        actor: 'console:owner@x.com',
        reason: 'upgrade solicitado',
      },
    ]);
  });

  // Achado de code review original (SPEC 059), preservado na extração:
  // quando limitOverrides não é tocado, o evento ecoa o valor JÁ
  // PERSISTIDO (o que updated.limit_overrides devolve), nunca o
  // default '{}' — senão o histórico append-only mentiria que os
  // overrides foram zerados.
  it('overrides omitidos: o evento ecoa o valor atual persistido, não {}', async () => {
    const { client, insertedEvents } = makeDb({
      'account_plans.select': { data: CURRENT_ROW, error: null },
      'account_plans.update': {
        data: { ...UPDATED_ROW, limit_overrides: { contacts: 500 } },
        error: null,
      },
    });
    await changeAccountPlan(client, {
      accountId: 'acct-1',
      status: 'suspended',
      actor: 'console:owner@x.com',
    });
    expect(insertedEvents[0]).toMatchObject({
      overrides_after: { contacts: 500 },
      to_status: 'suspended',
    });
  });

  it('falha na escrita devolve update_failed, não account_not_found', async () => {
    const { client } = makeDb({
      'account_plans.select': { data: CURRENT_ROW, error: null },
      'account_plans.update': { data: null, error: { message: 'conflict' } },
    });
    const result = await changeAccountPlan(client, {
      accountId: 'acct-1',
      status: 'active',
      actor: 'console:x@y.com',
    });
    expect(result).toEqual({ ok: false, error: 'update_failed' });
  });
});
