import { describe, it, expect, vi } from 'vitest';

import {
  createSupabaseMock,
  type MockResult,
  type QueryOp,
} from '@/lib/audience/supabase-mock';
import { loadScopedChannel, scopedChannelError } from './scoped-channel';

const ACCOUNT = 'acct-1';
const ROW = {
  id: 'ch-a',
  account_id: ACCOUNT,
  type: 'whatsapp_cloud',
  status: 'connected',
};

/** Só devolve a linha quando a cadeia casa AS DUAS chaves. */
function makeDb(opts: { error?: string } = {}) {
  const handler = (table: string, ops: QueryOp[]): MockResult | undefined => {
    if (table !== 'channels') return undefined;
    if (opts.error) return { data: null, error: { message: opts.error } };
    const eqs = ops
      .filter((o) => o.fn === 'eq')
      .map((o) => o.args as [string, unknown]);
    const wanted = Object.fromEntries(eqs);
    const match = wanted.id === ROW.id && wanted.account_id === ROW.account_id;
    return { data: match ? ROW : null };
  };
  return createSupabaseMock(handler);
}

describe('loadScopedChannel (SPEC 065 §5.4)', () => {
  it('sem canal pedido é SUCESSO com `channel: null` — "vale para todos"', async () => {
    const { db, calls } = makeDb();

    await expect(loadScopedChannel(db, ACCOUNT, null)).resolves.toEqual({
      ok: true,
      channel: null,
    });
    // Nem consulta: não há id a verificar.
    expect(calls).toHaveLength(0);
  });

  it('canal da conta volta com a linha', async () => {
    const { db } = makeDb();

    await expect(loadScopedChannel(db, ACCOUNT, 'ch-a')).resolves.toEqual({
      ok: true,
      channel: ROW,
    });
  });

  // O `account_id` na consulta é o que faz o id de outra conta não
  // devolver linha — e a resposta é a MESMA de um id inexistente, de
  // propósito: distinguir os dois confirmaria que o id existe.
  it('canal de outra conta é `not_found`, sem vazar a linha', async () => {
    const { db, callsFor } = makeDb();

    const out = await loadScopedChannel(db, 'acct-2', 'ch-a');

    expect(out).toEqual({ ok: false, reason: 'not_found' });
    const eqs = callsFor('channels')[0]
      .ops.filter((o) => o.fn === 'eq')
      .map((o) => o.args);
    expect(eqs).toContainEqual(['account_id', 'acct-2']);
  });

  it('id inexistente é `not_found`', async () => {
    const { db } = makeDb();

    await expect(loadScopedChannel(db, ACCOUNT, 'ch-zzz')).resolves.toEqual({
      ok: false,
      reason: 'not_found',
    });
  });

  // Achado de code review: antes esta falha virava o mesmo `null` de
  // "não é seu", e as rotas diziam ao operador que o número dele não
  // existe — sem lhe dar motivo para tentar de novo.
  it('erro de leitura é `read_failed`, e NÃO se confunde com "não existe"', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { db } = makeDb({ error: 'connection reset' });

    await expect(loadScopedChannel(db, ACCOUNT, 'ch-a')).resolves.toEqual({
      ok: false,
      reason: 'read_failed',
    });
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe('scopedChannelError (SPEC 065 §6)', () => {
  it('`not_found` é 400 com código estável', () => {
    expect(scopedChannelError('not_found')).toEqual({
      status: 400,
      body: {
        error: 'channel not found in this account',
        code: 'channel_not_in_account',
      },
    });
  });

  // 503, não 400: não é o pedido que está errado, é a leitura que não
  // aconteceu — e o operador deve tentar de novo.
  it('`read_failed` é 503, com código próprio', () => {
    const e = scopedChannelError('read_failed');

    expect(e.status).toBe(503);
    expect(e.body.code).toBe('channel_lookup_failed');
  });
});
