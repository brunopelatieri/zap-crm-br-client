import { beforeEach, describe, expect, it, vi } from 'vitest';

const requireRole = vi.fn();
vi.mock('@/lib/auth/account', async () => {
  const actual =
    await vi.importActual<typeof import('@/lib/auth/account')>(
      '@/lib/auth/account'
    );
  return {
    ...actual,
    requireRole: (...args: unknown[]) => requireRole(...args),
  };
});

let rows: Array<Record<string, unknown>> = [];
const seenOps: Array<{ fn: string; args: unknown[] }> = [];

function makeSessionDb() {
  const chain: Record<string, unknown> = {};
  chain.select = (...args: unknown[]) => {
    seenOps.push({ fn: 'select', args });
    return chain;
  };
  chain.eq = (...args: unknown[]) => {
    seenOps.push({ fn: 'eq', args });
    return chain;
  };
  chain.or = (...args: unknown[]) => {
    seenOps.push({ fn: 'or', args });
    return chain;
  };
  chain.order = (...args: unknown[]) => {
    seenOps.push({ fn: 'order', args });
    return chain;
  };
  chain.limit = (...args: unknown[]) => {
    seenOps.push({ fn: 'limit', args });
    return Promise.resolve({ data: rows, error: null });
  };
  return { from: () => chain };
}

import { GET } from './route';

function makeRequest(qs = ''): Request {
  return new Request(`http://localhost/api/evolution/harvested${qs}`);
}

beforeEach(() => {
  seenOps.length = 0;
  rows = [];
  requireRole.mockResolvedValue({
    supabase: makeSessionDb(),
    accountId: 'acct-1',
    userId: 'user-1',
    role: 'viewer',
    account: { id: 'acct-1', name: 'Conta' },
  });
});

describe('GET /api/evolution/harvested', () => {
  it('exige papel viewer (o mínimo — é leitura)', async () => {
    await GET(makeRequest());
    expect(requireRole).toHaveBeenCalledWith('viewer');
  });

  it('status padrão é "new" quando não informado', async () => {
    await GET(makeRequest());
    const statusEq = seenOps.find(
      (o) => o.fn === 'eq' && o.args[0] === 'status'
    );
    expect(statusEq?.args).toEqual(['status', 'new']);
  });

  it('status inválido cai no padrão "new", não quebra', async () => {
    await GET(makeRequest('?status=lixo'));
    const statusEq = seenOps.find(
      (o) => o.fn === 'eq' && o.args[0] === 'status'
    );
    expect(statusEq?.args).toEqual(['status', 'new']);
  });

  it('status válido diferente é respeitado', async () => {
    await GET(makeRequest('?status=promoted'));
    const statusEq = seenOps.find(
      (o) => o.fn === 'eq' && o.args[0] === 'status'
    );
    expect(statusEq?.args).toEqual(['status', 'promoted']);
  });

  it('channelId opcional filtra quando presente', async () => {
    await GET(makeRequest('?channelId=chan-1'));
    expect(
      seenOps.some((o) => o.fn === 'eq' && o.args[0] === 'channel_id')
    ).toBe(true);
  });

  it('sem channelId, não filtra por canal', async () => {
    await GET(makeRequest());
    expect(
      seenOps.some((o) => o.fn === 'eq' && o.args[0] === 'channel_id')
    ).toBe(false);
  });

  it('devolve items e next_cursor', async () => {
    rows = [
      { id: 'h1', created_at: '2026-09-01T00:00:00Z', jid: 'a@s.whatsapp.net' },
    ];
    const res = await GET(makeRequest());
    const body = await res.json();
    expect(body.items).toHaveLength(1);
    expect(body.next_cursor).toBeNull();
  });
});
