import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { updateUserIdentity } from './user-identity-actions';

interface AuthError {
  message?: string;
  status?: number;
  code?: string;
}

interface Options {
  /** Resposta de cada chamada a `updateUserById`, na ordem. */
  authResults?: { error: AuthError | null }[];
  profileResult?: { data: unknown; error: { message: string } | null };
}

/**
 * Cliente de mentira: `auth.admin.updateUserById` e a cadeia
 * `from('profiles').update().eq().select()`. `calls` guarda a ordem das
 * escritas — o que o módulo existe para garantir (§5.3).
 */
function makeDb({ authResults = [], profileResult }: Options = {}) {
  const calls: string[] = [];
  const authCalls: { id: string; attributes: Record<string, unknown> }[] = [];
  const profileUpdates: Record<string, unknown>[] = [];
  let authIndex = 0;

  const admin = {
    updateUserById: (id: string, attributes: Record<string, unknown>) => {
      calls.push('auth');
      authCalls.push({ id, attributes });
      const result = authResults[authIndex++] ?? { error: null };
      return Promise.resolve(result);
    },
  };

  const db = {
    auth: { admin },
    from(table: string) {
      if (table !== 'profiles') throw new Error(`tabela inesperada: ${table}`);
      return {
        update(payload: Record<string, unknown>) {
          calls.push('profiles');
          profileUpdates.push(payload);
          const c = {
            eq: () => c,
            select: () =>
              Promise.resolve(
                profileResult ?? { data: [{ user_id: 'u1' }], error: null }
              ),
          };
          return c;
        },
      };
    },
  } as unknown as SupabaseClient;

  return { db, calls, authCalls, profileUpdates };
}

describe('updateUserIdentity', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => errorSpy.mockRestore());

  it('sem nome nem e-mail: no_changes, nada é escrito', async () => {
    const { db, calls } = makeDb();
    expect(await updateUserIdentity(db, { userId: 'u1' })).toEqual({
      ok: false,
      error: 'no_changes',
      emailUpdated: false,
    });
    expect(calls).toEqual([]);
  });

  it('só e-mail: confirma na hora (email_confirm: true) e não toca em profiles', async () => {
    const { db, calls, authCalls } = makeDb();
    const result = await updateUserIdentity(db, {
      userId: 'u1',
      email: 'novo@empresa.com',
    });
    expect(result).toEqual({
      ok: true,
      emailUpdated: true,
      nameUpdated: false,
    });
    expect(calls).toEqual(['auth']);
    expect(authCalls[0]).toEqual({
      id: 'u1',
      attributes: { email: 'novo@empresa.com', email_confirm: true },
    });
  });

  it('só nome: grava profiles.full_name e depois a cópia em user_metadata', async () => {
    const { db, calls, authCalls, profileUpdates } = makeDb();
    const result = await updateUserIdentity(db, {
      userId: 'u1',
      fullName: 'Ana Souza',
    });
    expect(result).toEqual({
      ok: true,
      emailUpdated: false,
      nameUpdated: true,
    });
    expect(calls).toEqual(['profiles', 'auth']);
    expect(profileUpdates[0]).toEqual({ full_name: 'Ana Souza' });
    expect(authCalls[0].attributes).toEqual({
      user_metadata: { full_name: 'Ana Souza' },
    });
  });

  it('nome + e-mail: e-mail primeiro, depois o nome', async () => {
    const { db, calls } = makeDb();
    const result = await updateUserIdentity(db, {
      userId: 'u1',
      fullName: 'Ana Souza',
      email: 'novo@empresa.com',
    });
    expect(result).toEqual({ ok: true, emailUpdated: true, nameUpdated: true });
    expect(calls).toEqual(['auth', 'profiles', 'auth']);
  });

  it('falha do e-mail NÃO chama a escrita do nome (nada fica gravado)', async () => {
    const { db, calls } = makeDb({
      authResults: [{ error: { message: 'boom', status: 500 } }],
    });
    const result = await updateUserIdentity(db, {
      userId: 'u1',
      fullName: 'Ana Souza',
      email: 'novo@empresa.com',
    });
    expect(result).toEqual({
      ok: false,
      error: 'update_failed',
      emailUpdated: false,
    });
    expect(calls).toEqual(['auth']);
  });

  it('e-mail repetido (code email_exists) vira email_taken, sem tocar no nome', async () => {
    const { db, calls } = makeDb({
      authResults: [
        {
          error: {
            message: 'Email address already registered',
            status: 422,
            code: 'email_exists',
          },
        },
      ],
    });
    const result = await updateUserIdentity(db, {
      userId: 'u1',
      fullName: 'Ana Souza',
      email: 'outro@empresa.com',
    });
    expect(result).toEqual({
      ok: false,
      error: 'email_taken',
      emailUpdated: false,
    });
    expect(calls).toEqual(['auth']);
  });

  it('e-mail repetido na forma antiga (só o texto) também vira email_taken', async () => {
    const { db } = makeDb({
      authResults: [
        {
          error: {
            message:
              'A user with this email address has already been registered',
            status: 422,
          },
        },
      ],
    });
    const result = await updateUserIdentity(db, {
      userId: 'u1',
      email: 'outro@empresa.com',
    });
    expect(result).toMatchObject({ ok: false, error: 'email_taken' });
  });

  it('usuário inexistente no Auth vira user_not_found', async () => {
    const { db } = makeDb({
      authResults: [
        {
          error: {
            message: 'User not found',
            status: 404,
            code: 'user_not_found',
          },
        },
      ],
    });
    const result = await updateUserIdentity(db, {
      userId: 'sumiu',
      email: 'novo@empresa.com',
    });
    expect(result).toMatchObject({ ok: false, error: 'user_not_found' });
  });

  it('nome falha DEPOIS do e-mail: partial_update com emailUpdated: true', async () => {
    const { db } = makeDb({
      profileResult: { data: null, error: { message: 'db down' } },
    });
    const result = await updateUserIdentity(db, {
      userId: 'u1',
      fullName: 'Ana Souza',
      email: 'novo@empresa.com',
    });
    expect(result).toEqual({
      ok: false,
      error: 'partial_update',
      emailUpdated: true,
    });
  });

  it('cópia em user_metadata falha (e-mail + nome): é melhor esforço, o perfil já mudou — sucesso', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { db } = makeDb({
      authResults: [
        { error: null },
        { error: { message: 'meta failed', status: 500 } },
      ],
    });
    const result = await updateUserIdentity(db, {
      userId: 'u1',
      fullName: 'Ana Souza',
      email: 'novo@empresa.com',
    });
    expect(result).toEqual({ ok: true, emailUpdated: true, nameUpdated: true });
    spy.mockRestore();
  });

  it('cópia em user_metadata falha (só nome): sucesso, não update_failed', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { db } = makeDb({
      authResults: [{ error: { message: 'meta failed', status: 500 } }],
    });
    const result = await updateUserIdentity(db, {
      userId: 'u1',
      fullName: 'Ana Souza',
    });
    expect(result).toEqual({
      ok: true,
      emailUpdated: false,
      nameUpdated: true,
    });
    spy.mockRestore();
  });

  it('nome falha sem e-mail: update_failed (nada de partial)', async () => {
    const { db, calls } = makeDb({
      profileResult: { data: null, error: { message: 'db down' } },
    });
    const result = await updateUserIdentity(db, {
      userId: 'u1',
      fullName: 'Ana Souza',
    });
    expect(result).toEqual({
      ok: false,
      error: 'update_failed',
      emailUpdated: false,
    });
    expect(calls).toEqual(['profiles']);
  });

  it('perfil inexistente (zero linhas) vira user_not_found e não grava a cópia do Auth', async () => {
    const { db, calls } = makeDb({ profileResult: { data: [], error: null } });
    const result = await updateUserIdentity(db, {
      userId: 'sem-perfil',
      fullName: 'Ana Souza',
    });
    expect(result).toEqual({
      ok: false,
      error: 'user_not_found',
      emailUpdated: false,
    });
    expect(calls).toEqual(['profiles']);
  });
});
