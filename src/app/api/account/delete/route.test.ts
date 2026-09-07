import { beforeEach, describe, expect, it, vi } from 'vitest';

// ------------------------------------------------------------
// Mocks
// ------------------------------------------------------------

const getCurrentAccount = vi.fn();
const requireRole = vi.fn();
vi.mock('@/lib/auth/account', async () => {
  const actual =
    await vi.importActual<typeof import('@/lib/auth/account')>(
      '@/lib/auth/account'
    );
  return {
    ...actual,
    getCurrentAccount: (...args: unknown[]) => getCurrentAccount(...args),
    requireRole: (...args: unknown[]) => requireRole(...args),
  };
});

const signInWithPassword = vi.fn();
vi.mock('@supabase/supabase-js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@supabase/supabase-js')>();
  return {
    ...actual,
    createClient: () => ({
      auth: {
        signInWithPassword: (...a: unknown[]) => signInWithPassword(...a),
      },
    }),
  };
});

const writePlatformAudit = vi.fn().mockResolvedValue(undefined);
vi.mock('@/lib/platform/audit', () => ({
  writePlatformAudit: (...args: unknown[]) => writePlatformAudit(...args),
}));

const emitSystemEvent = vi.fn().mockResolvedValue(undefined);
vi.mock('@/lib/notifications/emit', () => ({
  emitSystemEvent: (...args: unknown[]) => emitSystemEvent(...args),
}));

const deleteInstanceOnVpsByRemoteId = vi.fn().mockResolvedValue(null);
vi.mock('@/lib/evolution/instances', () => ({
  deleteInstanceOnVpsByRemoteId: (...args: unknown[]) =>
    deleteInstanceOnVpsByRemoteId(...args),
}));

let evolutionConfigured = true;
vi.mock('@/lib/evolution/config', () => ({
  readEvolutionConfig: () =>
    evolutionConfigured
      ? {
          apiUrl: 'https://evo.example.com',
          globalApiKey: 'global-key',
          maxInstancesPerAccount: 5,
          maxInstancesTotal: 100,
          instancePrefix: 'zapcrm',
          webhookPublicUrl: 'https://app.example.com',
          requestTimeoutMs: 15000,
          mediaRequestTimeoutMs: 60000,
        }
      : null,
}));

// ------------------------------------------------------------
// Fake admin db — só a superfície que a rota usa.
// ------------------------------------------------------------

const calls: string[] = [];
let deleteAccountError: { message: string } | null = null;
let deleteUserError: { message: string } | null = null;
let memberRows: { user_id: string }[] = [];
let instanceRows: { id: string; remote_instance_id: string | null }[] = [];
const removedPaths: Record<string, string[]> = {};

function makeAdminDb() {
  return {
    from: (table: string) => {
      const filters: Record<string, unknown> = {};
      let opts: { count?: string; head?: boolean } | undefined;
      const chain: Record<string, unknown> = {};
      chain.select = (_cols: unknown, o?: typeof opts) => {
        opts = o;
        return chain;
      };
      chain.eq = (k: string, v: unknown) => {
        filters[k] = v;
        return chain;
      };
      chain.neq = (k: string, v: unknown) => {
        filters[`neq_${k}`] = v;
        return chain;
      };
      chain.in = (k: string, v: unknown) => {
        filters[`in_${k}`] = v;
        return chain;
      };
      chain.delete = () => {
        filters.__delete = true;
        return chain;
      };
      chain.then = (resolve: (v: unknown) => unknown) => {
        let result: unknown = { data: null, error: null, count: 0 };
        if (table === 'accounts' && filters.__delete) {
          calls.push('delete:accounts');
          result = { error: deleteAccountError };
        } else if (table === 'profiles' && filters.neq_account_role) {
          result = { data: memberRows, error: null };
        } else if (table === 'profiles') {
          result = { count: 0, data: null, error: null };
        } else if (table === 'conversations' && opts?.count) {
          result = { count: 0, data: null, error: null };
        } else if (table === 'conversations') {
          result = { data: [], error: null };
        } else if (table === 'evolution_instances') {
          result = { data: instanceRows, error: null };
        } else if (
          table === 'contacts' ||
          table === 'broadcasts' ||
          table === 'channels' ||
          table === 'messages'
        ) {
          result = { count: 0, data: null, error: null };
        }
        return Promise.resolve(result).then(resolve);
      };
      return chain;
    },
    auth: {
      admin: {
        deleteUser: (id: string) => {
          calls.push(`deleteUser:${id}`);
          return Promise.resolve({ error: deleteUserError });
        },
      },
    },
    storage: {
      from: (bucket: string) => ({
        list: () => Promise.resolve({ data: [], error: null }),
        remove: (paths: string[]) => {
          removedPaths[bucket] = paths;
          return Promise.resolve({ error: null });
        },
      }),
    },
  };
}

vi.mock('@/lib/supabase/admin', () => ({
  supabaseAdmin: () => makeAdminDb(),
}));

import { POST } from './route';

function makeRequest(body: unknown): Request {
  return new Request('http://localhost/x', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

const sessionRpc = vi.fn();

function baseCtx(role: string) {
  return {
    supabase: {
      auth: {
        getUser: () =>
          Promise.resolve({ data: { user: { email: 'dono@example.com' } } }),
      },
      rpc: (fn: string, args: unknown) => {
        calls.push(`rpc:${fn}`);
        return sessionRpc(fn, args);
      },
    },
    accountId: 'acct-1',
    userId: 'user-1',
    role,
    account: { id: 'acct-1', name: 'Conta X' },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  calls.length = 0;
  deleteAccountError = null;
  deleteUserError = null;
  memberRows = [];
  instanceRows = [];
  evolutionConfigured = true;
  writePlatformAudit.mockResolvedValue(undefined);
  emitSystemEvent.mockResolvedValue(undefined);
  deleteInstanceOnVpsByRemoteId.mockResolvedValue(null);
  getCurrentAccount.mockResolvedValue(baseCtx('owner'));
  signInWithPassword.mockResolvedValue({ error: null });
  sessionRpc.mockResolvedValue({ data: 'acct-new', error: null });
});

describe('POST /api/account/delete', () => {
  it('admin autenticado → 403 e nenhuma escrita', async () => {
    getCurrentAccount.mockResolvedValue(baseCtx('admin'));
    const res = await POST(
      makeRequest({ confirmName: 'Conta X', password: 'x' })
    );
    const json = await res.json();
    expect(res.status).toBe(403);
    expect(json.code).toBe('not_owner');
    expect(calls).toEqual([]);
    expect(signInWithPassword).not.toHaveBeenCalled();
  });

  it('nome errado → 400 antes de reautenticar', async () => {
    const res = await POST(
      makeRequest({ confirmName: 'Nome Errado', password: 'x' })
    );
    const json = await res.json();
    expect(res.status).toBe(400);
    expect(json.code).toBe('name_mismatch');
    expect(signInWithPassword).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  it('senha errada → 401 e nenhuma escrita', async () => {
    signInWithPassword.mockResolvedValue({ error: { message: 'bad' } });
    const res = await POST(
      makeRequest({ confirmName: 'Conta X', password: 'errada' })
    );
    const json = await res.json();
    expect(res.status).toBe(401);
    expect(json.code).toBe('bad_password');
    expect(calls).toEqual([]);
  });

  it('caminho feliz → ordem exata: membros → DELETE accounts → deleteUser', async () => {
    memberRows = [{ user_id: 'user-2' }];
    const res = await POST(
      makeRequest({ confirmName: 'Conta X', password: 'certa' })
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(calls).toEqual([
      'rpc:remove_account_member',
      'delete:accounts',
      'deleteUser:user-1',
    ]);
    expect(writePlatformAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'account.delete', accountId: null })
    );
    expect(emitSystemEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'account.deleted', accountId: null }),
      expect.anything()
    );
  });

  it('VPS fora do ar → 200 com a instância listada em leftovers', async () => {
    instanceRows = [{ id: 'inst-1', remote_instance_id: 'remote-1' }];
    deleteInstanceOnVpsByRemoteId.mockResolvedValue('VPS unreachable');
    const res = await POST(
      makeRequest({ confirmName: 'Conta X', password: 'certa' })
    );
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(
      json.deleted.leftovers.some((l: string) => l.includes('remote-1'))
    ).toBe(true);
  });

  it('emitSystemEvent que rejeita → a resposta continua 200', async () => {
    emitSystemEvent.mockImplementation(() =>
      Promise.reject(new Error('boom')).catch(() => undefined)
    );
    const res = await POST(
      makeRequest({ confirmName: 'Conta X', password: 'certa' })
    );
    expect(res.status).toBe(200);
  });
});
