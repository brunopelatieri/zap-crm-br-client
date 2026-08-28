import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { loadOwnerSelfRefs } from './owner-profile';

function makeDb(result: { data?: unknown; error?: unknown }) {
  const client = {
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: () => Promise.resolve(result),
        }),
      }),
    }),
  };
  return client as unknown as SupabaseClient;
}

describe('loadOwnerSelfRefs', () => {
  it('devolve accountId/userId do perfil quando o proprietário tem conta aqui', async () => {
    const db = makeDb({
      data: { user_id: 'owner-1', account_id: 'acct-owner' },
      error: null,
    });
    const result = await loadOwnerSelfRefs(db, 'owner-1');
    expect(result).toEqual({
      ownerUserId: 'owner-1',
      ownerAccountId: 'acct-owner',
    });
  });

  it('sem perfil aqui: ownerAccountId null, ownerUserId ecoa o id da sessão', async () => {
    const db = makeDb({ data: null, error: null });
    const result = await loadOwnerSelfRefs(db, 'owner-1');
    expect(result).toEqual({ ownerUserId: 'owner-1', ownerAccountId: null });
  });

  // Achado de code review (ausência de teste, AGENTS.md "adicione o
  // teste ao lado"): esta é a falha fechada que o comentário do arquivo
  // descreve — sem ela, um erro de leitura poderia devolver
  // `ownerUserId: null` e `canBlockUser` perderia a comparação por id,
  // deixando só a comparação por e-mail como defesa contra autobloqueio.
  it('falha fechada: erro de consulta ainda devolve o ownerUserId da sessão, nunca null', async () => {
    const db = makeDb({ data: null, error: { message: 'boom' } });
    const result = await loadOwnerSelfRefs(db, 'owner-1');
    expect(result).toEqual({ ownerUserId: 'owner-1', ownerAccountId: null });
  });
});
