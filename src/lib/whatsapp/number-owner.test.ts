import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import {
  __resetNumberOwnerCacheForTests,
  resolveNumberOwner,
} from './number-owner';

const ROW = {
  account_id: 'acct-1',
  waba_id: '100000000004821',
  channels: { status: 'connected' } as unknown,
};

/** `whatsapp_config` de mentira; `answers` é consumido leitura a leitura. */
function makeDb(answers: Array<{ data?: unknown; error?: unknown } | Error>) {
  const filters: unknown[][] = [];
  const db = {
    from: () => ({
      select: () => ({
        eq: async (...a: unknown[]) => {
          filters.push(a);
          const answer = answers.shift() ?? { data: [] };
          if (answer instanceof Error) throw answer;
          return { data: answer.data ?? null, error: answer.error ?? null };
        },
      }),
    }),
  };
  return { db: db as unknown as SupabaseClient, filters };
}

const OWNER = { accountId: 'acct-1', wabaId: '100000000004821' };

beforeEach(() => {
  __resetNumberOwnerCacheForTests();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('resolveNumberOwner', () => {
  it('lê pelo número e guarda o resultado por 15 s', async () => {
    vi.useFakeTimers();
    const { db, filters } = makeDb([{ data: [ROW] }, { data: [ROW] }]);

    for (let i = 0; i < 3; i++) {
      expect(await resolveNumberOwner(db, 'pnid-1')).toEqual({
        owner: OWNER,
        reason: null,
      });
    }
    expect(filters).toEqual([['phone_number_id', 'pnid-1']]);

    vi.advanceTimersByTime(15_001);
    await resolveNumberOwner(db, 'pnid-1');
    expect(filters).toHaveLength(2);
  });

  it('config sem waba_id ainda resolve a conta (o espelho não depende do WABA)', async () => {
    const { db } = makeDb([{ data: [{ ...ROW, waba_id: null }] }]);
    expect((await resolveNumberOwner(db, 'pnid-1')).owner).toEqual({
      accountId: 'acct-1',
      wabaId: null,
    });
  });

  it('sem canal no embed (config antiga): não é tratado como desativado', async () => {
    const { db } = makeDb([{ data: [{ ...ROW, channels: null }] }]);
    expect((await resolveNumberOwner(db, 'pnid-1')).owner).toEqual(OWNER);
  });

  it.each([
    ['no_config', { data: [] }],
    ['multiple_configs', { data: [ROW, ROW] }],
    ['disabled', { data: [{ ...ROW, channels: { status: 'disabled' } }] }],
    ['disabled', { data: [{ ...ROW, channels: [{ status: 'disabled' }] }] }],
  ])('%s: sem dono, sem lançar e sem guardar', async (reason, answer) => {
    const { db, filters } = makeDb([answer, { data: [ROW] }]);

    expect(await resolveNumberOwner(db, 'pnid-1')).toEqual({
      owner: null,
      reason,
    });
    // A próxima chamada relê: o número pode ter acabado de ser cadastrado.
    expect((await resolveNumberOwner(db, 'pnid-1')).owner).toEqual(OWNER);
    expect(filters).toHaveLength(2);
  });

  // L-2: uma falha transitória descartaria todos os statuses do `change`.
  it.each([
    ['erro do PostgREST', { error: { message: 'db down' } }],
    ['exceção', new Error('fetch failed')],
  ])('%s passageiro: UMA nova tentativa resolve', async (_label, answer) => {
    const { db, filters } = makeDb([answer, { data: [ROW] }]);

    expect((await resolveNumberOwner(db, 'pnid-1')).owner).toEqual(OWNER);
    expect(filters).toHaveLength(2);
    expect(console.error).not.toHaveBeenCalled();
  });

  it.each([
    ['erro do PostgREST', { error: { message: 'db down' } }],
    ['exceção', new Error('fetch failed')],
  ])(
    '%s persistente: sem dono, sem lançar e sem guardar',
    async (_l, answer) => {
      const { db, filters } = makeDb([answer, answer, { data: [ROW] }]);

      expect(await resolveNumberOwner(db, 'pnid-1')).toEqual({
        owner: null,
        reason: 'error',
      });
      // Duas leituras, nunca mais que isso, e um log só.
      expect(filters).toHaveLength(2);
      expect(console.error).toHaveBeenCalledTimes(1);
      expect((await resolveNumberOwner(db, 'pnid-1')).owner).toEqual(OWNER);
    }
  );

  it.each([[undefined], [null], [''], [123], [{ a: 1 }]])(
    'número inválido %j: sem dono e sem tocar o banco',
    async (value) => {
      const { db, filters } = makeDb([{ data: [ROW] }]);
      expect(await resolveNumberOwner(db, value)).toEqual({
        owner: null,
        reason: 'no_config',
      });
      expect(filters).toEqual([]);
    }
  );
});
