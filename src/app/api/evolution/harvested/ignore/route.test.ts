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

const updates: Array<{ payload: unknown; filters: unknown[][] }> = [];
let updateResult: { data: unknown; error: unknown } = {
  data: [{ id: 'h1' }],
  error: null,
};

function makeAdminDb() {
  return {
    from: () => {
      const filters: unknown[][] = [];
      let payload: unknown;
      const chain: Record<string, unknown> = {
        update: (p: unknown) => {
          payload = p;
          return chain;
        },
        eq: (...args: unknown[]) => {
          filters.push(args);
          return chain;
        },
        in: (...args: unknown[]) => {
          filters.push(args);
          return chain;
        },
        select: () => {
          updates.push({ payload, filters: filters.slice() });
          return Promise.resolve(updateResult);
        },
      };
      return chain;
    },
  };
}

vi.mock('@/lib/supabase/admin', () => ({
  supabaseAdmin: () => makeAdminDb(),
}));

import { POST } from './route';

function makeRequest(body: unknown): Request {
  return new Request('http://localhost/api/evolution/harvested/ignore', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  updates.length = 0;
  updateResult = { data: [{ id: 'h1' }], error: null };
  requireRole.mockResolvedValue({
    supabase: {},
    accountId: 'acct-1',
    userId: 'user-1',
    role: 'admin',
    account: { id: 'acct-1', name: 'Conta' },
  });
});

describe('POST /api/evolution/harvested/ignore', () => {
  it('exige admin+', async () => {
    await POST(makeRequest({ ids: ['h1'] }));
    expect(requireRole).toHaveBeenCalledWith('admin');
  });

  it('ids vazio → 400', async () => {
    const res = await POST(makeRequest({ ids: [] }));
    expect(res.status).toBe(400);
  });

  it('JSON inválido → 400', async () => {
    const req = new Request('http://x', { method: 'POST', body: '{not json' });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it('marca status=ignored, filtrado por account_id e status=new', async () => {
    await POST(makeRequest({ ids: ['h1', 'h2'] }));

    expect(updates[0].payload).toEqual({ status: 'ignored' });
    expect(updates[0].filters).toContainEqual(['account_id', 'acct-1']);
    expect(updates[0].filters).toContainEqual(['status', 'new']);
    expect(updates[0].filters).toContainEqual(['id', ['h1', 'h2']]);
  });

  it('devolve a contagem de fato ignorada', async () => {
    updateResult = { data: [{ id: 'h1' }, { id: 'h2' }], error: null };
    const res = await POST(makeRequest({ ids: ['h1', 'h2', 'h3'] }));
    const body = await res.json();
    expect(body.ignored).toBe(2);
  });

  it('erro do banco → 500', async () => {
    updateResult = { data: null, error: { message: 'boom' } };
    const res = await POST(makeRequest({ ids: ['h1'] }));
    expect(res.status).toBe(500);
  });
});
