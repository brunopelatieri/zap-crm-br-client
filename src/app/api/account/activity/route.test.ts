import { describe, expect, it, vi, beforeEach } from 'vitest';

import { ForbiddenError } from '@/lib/auth/account';

let requireRoleMock = vi.fn();
vi.mock('@/lib/auth/account', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/account')>();
  return {
    ...actual,
    requireRole: (...args: unknown[]) => requireRoleMock(...args),
  };
});

let queryActivityResult: unknown;
const queryActivityMock = vi.fn(async () => queryActivityResult);
vi.mock('@/lib/activity/query', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/activity/query')>();
  return {
    ...actual,
    queryActivity: (...args: unknown[]) => queryActivityMock(...(args as [])),
  };
});

import { GET } from './route';

function get(qs = '') {
  return GET(new Request(`http://localhost/api/account/activity${qs}`));
}

beforeEach(() => {
  queryActivityMock.mockClear();
  queryActivityResult = {
    items: [],
    nextCursor: null,
    hiddenByChannelFilter: null,
  };
  requireRoleMock = vi.fn(async (min: string) => {
    if (min !== 'admin') throw new Error('unexpected min role in test');
    return {
      supabase: {},
      accountId: 'acct-1',
      userId: 'user-1',
      role: 'admin',
    };
  });
});

describe('GET /api/account/activity — papéis (D-5)', () => {
  it('admin: 200', async () => {
    const res = await get();
    expect(res.status).toBe(200);
  });

  it('owner: 200 (requireRole aceita owner+admin como admin+)', async () => {
    requireRoleMock = vi.fn(async () => ({
      supabase: {},
      accountId: 'acct-1',
      userId: 'user-1',
      role: 'owner',
    }));
    const res = await get();
    expect(res.status).toBe(200);
  });

  it('agent: 403 — a página é admin+, mesmo a RLS deixando ver a própria linha', async () => {
    requireRoleMock = vi.fn(async () => {
      throw new ForbiddenError(
        "This action requires the 'admin' role or higher"
      );
    });
    const res = await get();
    expect(res.status).toBe(403);
    expect(queryActivityMock).not.toHaveBeenCalled();
  });

  it('viewer: 403', async () => {
    requireRoleMock = vi.fn(async () => {
      throw new ForbiddenError(
        "This action requires the 'admin' role or higher"
      );
    });
    const res = await get();
    expect(res.status).toBe(403);
  });
});

describe('GET /api/account/activity — parsing de query params', () => {
  it('sem params, chama queryActivity com filtros vazios', async () => {
    await get();
    expect(queryActivityMock).toHaveBeenCalledWith(
      {},
      'acct-1',
      expect.objectContaining({
        from: null,
        to: null,
        actorUserId: null,
        resourceTypes: undefined,
        channelIds: undefined,
        search: undefined,
        cursor: null,
        limit: undefined,
      })
    );
  });

  it('resource_type em CSV vira array', async () => {
    await get('?resource_type=contact,deal');
    expect(queryActivityMock).toHaveBeenCalledWith(
      {},
      'acct-1',
      expect.objectContaining({ resourceTypes: ['contact', 'deal'] })
    );
  });

  it('resource_type desconhecido devolve 400 sem chamar queryActivity', async () => {
    const res = await get('?resource_type=nao_existe');
    expect(res.status).toBe(400);
    expect(queryActivityMock).not.toHaveBeenCalled();
  });

  it('channel_id em CSV vira array', async () => {
    await get('?channel_id=chan-1,chan-2');
    expect(queryActivityMock).toHaveBeenCalledWith(
      {},
      'acct-1',
      expect.objectContaining({ channelIds: ['chan-1', 'chan-2'] })
    );
  });

  it('repassa from/to/time_zone/search/cursor/limit', async () => {
    await get(
      '?from=2026-09-01&to=2026-09-02&time_zone=America/Sao_Paulo&search=Ana&cursor=abc&limit=10'
    );
    expect(queryActivityMock).toHaveBeenCalledWith(
      {},
      'acct-1',
      expect.objectContaining({
        from: '2026-09-01',
        to: '2026-09-02',
        timeZone: 'America/Sao_Paulo',
        search: 'Ana',
        cursor: 'abc',
        limit: 10,
      })
    );
  });
});

describe('GET /api/account/activity — resposta', () => {
  it('sucesso: items/next_cursor/hidden_by_channel_filter em snake_case', async () => {
    queryActivityResult = {
      items: [{ id: 'evt-1' }],
      nextCursor: 'cursor-xyz',
      hiddenByChannelFilter: 3,
    };

    const res = await get();
    const json = await res.json();

    expect(json).toEqual({
      items: [{ id: 'evt-1' }],
      next_cursor: 'cursor-xyz',
      hidden_by_channel_filter: 3,
    });
  });

  it('erro de validação (fuso/data) vira 400 em inglês, com o código', async () => {
    queryActivityResult = { error: 'invalid_time_zone' };

    const res = await get();
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      error: "'time_zone' is not a valid IANA time zone",
      code: 'invalid_time_zone',
    });
  });

  it('data inválida nomeia o campo no erro', async () => {
    queryActivityResult = { error: 'invalid_date', field: 'from' };

    const res = await get();
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      error: "'from' is not a valid date",
      code: 'invalid_date',
    });
  });
});
