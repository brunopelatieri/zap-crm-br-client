import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import {
  AccountBlockedError,
  assertAccountNotBlocked,
  isAccountBlocked,
  loadBlockedAccountIds,
} from './blocked';

/** Cliente de mentira para o ponto-lookup de `isAccountBlocked`. */
function pointLookup(result: { data?: unknown; error?: unknown }) {
  return {
    from: () => {
      const chain = {
        select: () => chain,
        eq: () => chain,
        maybeSingle: () =>
          Promise.resolve({
            data: result.data ?? null,
            error: result.error ?? null,
          }),
      };
      return chain;
    },
  } as unknown as SupabaseClient;
}

/** Cliente de mentira para a listagem de `loadBlockedAccountIds`. */
function listLookup(result: { data?: unknown; error?: unknown }) {
  const filters: [string, string, unknown][] = [];
  const client = {
    from: () => {
      const chain = {
        select: () => chain,
        not: (col: string, op: string, val: unknown) => {
          filters.push([col, op, val]);
          return chain;
        },
        then: (
          resolve: (v: unknown) => unknown,
          reject?: (e: unknown) => unknown
        ) =>
          Promise.resolve({
            data: result.data ?? null,
            error: result.error ?? null,
          }).then(resolve, reject),
      };
      return chain;
    },
  } as unknown as SupabaseClient;
  return { client, filters };
}

describe('isAccountBlocked', () => {
  it('conta com blocked_at nulo não está bloqueada', async () => {
    const db = pointLookup({ data: { blocked_at: null } });
    expect(await isAccountBlocked(db, 'acct-1')).toBe(false);
  });

  it('conta com blocked_at preenchido está bloqueada', async () => {
    const db = pointLookup({ data: { blocked_at: '2026-08-27T00:00:00Z' } });
    expect(await isAccountBlocked(db, 'acct-1')).toBe(true);
  });

  // Falha FECHADA. Um banco fora do ar não pode virar "libera o
  // disparo" — é a diferença entre um incidente de disponibilidade e um
  // incidente de conta bloqueada que continuou mandando campanha.
  it('erro de consulta falha fechada (trata como bloqueada) e avisa', async () => {
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
    const db = pointLookup({ error: { message: 'connection reset' } });
    expect(await isAccountBlocked(db, 'acct-1')).toBe(true);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  // Conta que não existe também não recebe envio — não é o mesmo que
  // "não bloqueada".
  it('conta inexistente é tratada como bloqueada', async () => {
    const db = pointLookup({ data: null });
    expect(await isAccountBlocked(db, 'sumiu')).toBe(true);
  });
});

describe('assertAccountNotBlocked', () => {
  it('passa em silêncio quando a conta está ativa', async () => {
    const db = pointLookup({ data: { blocked_at: null } });
    await expect(
      assertAccountNotBlocked(db, 'acct-1')
    ).resolves.toBeUndefined();
  });

  it('lança AccountBlockedError com code account_blocked e status 403', async () => {
    const db = pointLookup({ data: { blocked_at: '2026-08-27T00:00:00Z' } });
    const err = await assertAccountNotBlocked(db, 'acct-1').catch((e) => e);
    expect(err).toBeInstanceOf(AccountBlockedError);
    expect(err.code).toBe('account_blocked');
    expect(err.status).toBe(403);
  });
});

describe('loadBlockedAccountIds', () => {
  it('devolve o conjunto de ids bloqueados', async () => {
    const { client } = listLookup({
      data: [{ id: 'acct-1' }, { id: 'acct-2' }],
    });
    const set = await loadBlockedAccountIds(client);
    expect(set).toEqual(new Set(['acct-1', 'acct-2']));
  });

  it('nenhuma conta bloqueada devolve conjunto vazio', async () => {
    const { client } = listLookup({ data: [] });
    expect(await loadBlockedAccountIds(client)).toEqual(new Set());
  });

  // O predicado tem que casar com o índice parcial `idx_accounts_blocked`
  // da 069 — é ele que faz o custo desta consulta ser o do conjunto de
  // bloqueados, não o da tabela inteira.
  it('filtra por blocked_at IS NOT NULL (casa com o índice parcial)', async () => {
    const { client, filters } = listLookup({ data: [] });
    await loadBlockedAccountIds(client);
    expect(filters).toEqual([['blocked_at', 'is', null]]);
  });

  // Ao contrário do ponto-lookup, aqui não existe "falhar fechado"
  // possível — não há como devolver "todas as contas". Degrada para
  // vazio e avisa alto; o backstop de envio (§4.3 ponto 4) ainda decide
  // conta a conta.
  it('erro de consulta degrada para vazio, com aviso', async () => {
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { client } = listLookup({ error: { message: 'timeout' } });
    expect(await loadBlockedAccountIds(client)).toEqual(new Set());
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
