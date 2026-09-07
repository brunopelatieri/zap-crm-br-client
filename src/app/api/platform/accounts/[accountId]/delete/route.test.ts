import { beforeEach, describe, expect, it, vi } from 'vitest';

// ------------------------------------------------------------
// Mocks
// ------------------------------------------------------------

const requirePlatformOwner = vi.fn();
vi.mock('@/lib/platform/owner', () => ({
  requirePlatformOwner: () => requirePlatformOwner(),
}));

const writePlatformAudit = vi.fn().mockResolvedValue(undefined);
vi.mock('@/lib/platform/audit', async () => {
  const actual = await vi.importActual<typeof import('@/lib/platform/audit')>(
    '@/lib/platform/audit'
  );
  return {
    ...actual,
    writePlatformAudit: (...args: unknown[]) => writePlatformAudit(...args),
  };
});

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
// Fake admin db
// ------------------------------------------------------------

const calls: string[] = [];
let accountRow: { name: string; owner_user_id: string } | null = {
  name: 'Conta X',
  owner_user_id: 'user-1',
};
// Perfis da conta (dono incluso) — `loadAccountProfiles` não filtra mais
// no servidor, filtra em JS; o fake db devolve a lista crua.
let profileRows: { user_id: string; email: string; account_role: string }[] =
  [];
let deleteAccountError: { message: string } | null = null;
let deleteUserError: { message: string } | null = null;
let instanceRows: { id: string; remote_instance_id: string | null }[] = [];
let rpcResult: {
  data: unknown;
  error: { code?: string; message: string } | null;
} = { data: 'acct-new', error: null };
let rpcShouldThrow = false;

function makeAdminDb() {
  return {
    from: (table: string) => {
      const filters: Record<string, unknown> = {};
      const chain: Record<string, unknown> = {};
      chain.select = () => chain;
      chain.eq = (k: string, v: unknown) => {
        filters[k] = v;
        return chain;
      };
      chain.in = () => chain;
      chain.delete = () => {
        filters.__delete = true;
        return chain;
      };
      chain.maybeSingle = () => {
        if (table === 'accounts') return Promise.resolve({ data: accountRow });
        return Promise.resolve({ data: null });
      };
      chain.then = (resolve: (v: unknown) => unknown) => {
        let result: unknown = { data: null, error: null, count: 0 };
        if (table === 'accounts' && filters.__delete) {
          calls.push('delete:accounts');
          result = { error: deleteAccountError };
        } else if (table === 'profiles') {
          result = { data: profileRows, error: null };
        } else if (table === 'conversations') {
          result = { data: [], error: null };
        } else if (table === 'evolution_instances') {
          result = { data: instanceRows, error: null };
        } else {
          result = { count: 0, data: null, error: null };
        }
        return Promise.resolve(result).then(resolve);
      };
      return chain;
    },
    rpc: (fn: string) => {
      calls.push(`rpc:${fn}`);
      if (rpcShouldThrow) throw new Error('network blip');
      return Promise.resolve(rpcResult);
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
      from: () => ({
        list: () => Promise.resolve({ data: [], error: null }),
        remove: () => Promise.resolve({ error: null }),
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
const PARAMS = { params: Promise.resolve({ accountId: 'acct-1' }) };

beforeEach(() => {
  vi.clearAllMocks();
  calls.length = 0;
  accountRow = { name: 'Conta X', owner_user_id: 'user-1' };
  profileRows = [];
  deleteAccountError = null;
  deleteUserError = null;
  instanceRows = [];
  evolutionConfigured = true;
  writePlatformAudit.mockResolvedValue(undefined);
  emitSystemEvent.mockResolvedValue(undefined);
  deleteInstanceOnVpsByRemoteId.mockResolvedValue(null);
  requirePlatformOwner.mockResolvedValue({
    email: 'operador@zapcrmbr.com',
    userId: 'platform-owner-user',
  });
  rpcResult = { data: 'acct-new', error: null };
  rpcShouldThrow = false;
});

describe('POST /api/platform/accounts/[accountId]/delete', () => {
  it('quem não é o proprietário da plataforma → 404, nenhuma escrita', async () => {
    requirePlatformOwner.mockRejectedValue(new Error('not platform owner'));
    const res = await POST(makeRequest({ confirmName: 'Conta X' }), PARAMS);
    expect(res.status).toBe(404);
    expect(calls).toEqual([]);
  });

  it('conta inexistente → 404', async () => {
    accountRow = null;
    const res = await POST(makeRequest({ confirmName: 'Conta X' }), PARAMS);
    expect(res.status).toBe(404);
    expect(calls).toEqual([]);
  });

  it('nome errado → 400, nenhuma escrita', async () => {
    const res = await POST(makeRequest({ confirmName: 'Nome Errado' }), PARAMS);
    const json = await res.json();
    expect(res.status).toBe(400);
    expect(json.code).toBe('name_mismatch');
    expect(calls).toEqual([]);
  });

  it('caminho feliz → ordem exata, actor do console e e-mail do titular resolvido', async () => {
    profileRows = [
      { user_id: 'user-1', email: 'dono@example.com', account_role: 'owner' },
      { user_id: 'user-2', email: 'colega@example.com', account_role: 'agent' },
    ];
    const res = await POST(makeRequest({ confirmName: 'Conta X' }), PARAMS);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(calls).toEqual([
      'rpc:platform_remove_account_member',
      'delete:accounts',
      'deleteUser:user-1',
    ]);
    expect(writePlatformAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'account.delete',
        actor: 'console:operador@zapcrmbr.com',
      })
    );
    expect(emitSystemEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'account.deleted',
        actor: 'console:operador@zapcrmbr.com',
        account: expect.objectContaining({ ownerEmail: 'dono@example.com' }),
      }),
      expect.anything()
    );
  });

  it('titular sem linha em profiles → ownerEmail null, exclusão segue', async () => {
    profileRows = [];
    const res = await POST(makeRequest({ confirmName: 'Conta X' }), PARAMS);
    expect(res.status).toBe(200);
    expect(emitSystemEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        account: expect.objectContaining({ ownerEmail: null }),
      }),
      expect.anything()
    );
  });

  it('membro não desligado (erro genérico) → 500, DELETE FROM accounts nunca roda', async () => {
    profileRows = [
      { user_id: 'user-1', email: 'dono@example.com', account_role: 'owner' },
      { user_id: 'user-2', email: 'colega@example.com', account_role: 'agent' },
    ];
    rpcResult = { data: null, error: { message: 'boom' } };
    const res = await POST(makeRequest({ confirmName: 'Conta X' }), PARAMS);
    expect(res.status).toBe(500);
    expect(calls).toEqual(['rpc:platform_remove_account_member']);
  });

  it('RPC de desligar membro falha com 22023 → 400 com a mensagem do banco', async () => {
    profileRows = [
      { user_id: 'user-1', email: 'dono@example.com', account_role: 'owner' },
      { user_id: 'user-2', email: 'colega@example.com', account_role: 'agent' },
    ];
    rpcResult = {
      data: null,
      error: { code: '22023', message: 'Target user not found' },
    };
    const res = await POST(makeRequest({ confirmName: 'Conta X' }), PARAMS);
    const json = await res.json();
    expect(res.status).toBe(400);
    expect(json.error).toBe('Target user not found');
  });

  it('login do titular não removido → 200, sobra em leftovers', async () => {
    deleteUserError = { message: 'auth admin unreachable' };
    const res = await POST(makeRequest({ confirmName: 'Conta X' }), PARAMS);
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(
      json.deleted.leftovers.some((l: string) =>
        l.includes('auth admin unreachable')
      )
    ).toBe(true);
  });

  it('exceção inesperada depois das guardas → 500 limpo, não crash cru', async () => {
    profileRows = [
      { user_id: 'user-1', email: 'dono@example.com', account_role: 'owner' },
      { user_id: 'user-2', email: 'colega@example.com', account_role: 'agent' },
    ];
    rpcShouldThrow = true;
    const res = await POST(makeRequest({ confirmName: 'Conta X' }), PARAMS);
    const json = await res.json();
    expect(res.status).toBe(500);
    expect(typeof json.error).toBe('string');
  });

  it('VPS fora do ar → 200 com a instância listada em leftovers', async () => {
    instanceRows = [{ id: 'inst-1', remote_instance_id: 'remote-1' }];
    deleteInstanceOnVpsByRemoteId.mockResolvedValue('VPS unreachable');
    const res = await POST(makeRequest({ confirmName: 'Conta X' }), PARAMS);
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(
      json.deleted.leftovers.some((l: string) => l.includes('remote-1'))
    ).toBe(true);
  });
});
