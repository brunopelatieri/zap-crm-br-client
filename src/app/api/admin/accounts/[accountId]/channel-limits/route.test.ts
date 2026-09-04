import { beforeEach, describe, expect, it, vi } from 'vitest';

process.env.PLATFORM_ADMIN_SECRET = 'the-admin-secret';

let accountPlanOverrides: Record<string, unknown> = {};
let accountHasNoPlan = false;
let instanceRows: Array<{
  id: string;
  channel_id: string;
  limit_overrides: Record<string, unknown>;
  channels: { name: string };
}> = [];
const updates: Array<{ table: string; payload: unknown; channelId?: string }> =
  [];

function makeDb() {
  return {
    from: (table: string) => {
      const chain: Record<string, unknown> = {};
      const filters: Record<string, unknown> = {};
      chain.select = () => chain;
      chain.eq = (key: string, value: unknown) => {
        filters[key] = value;
        return chain;
      };
      chain.update = (payload: Record<string, unknown>) => {
        updates.push({
          table,
          payload,
          channelId: filters.channel_id as string | undefined,
        });
        return {
          eq: () => Promise.resolve({ error: null }),
        };
      };
      chain.maybeSingle = () => {
        if (table === 'account_plans') {
          return Promise.resolve({
            data: accountHasNoPlan
              ? null
              : { limit_overrides: accountPlanOverrides },
            error: null,
          });
        }
        if (table === 'evolution_instances') {
          const row = instanceRows.find(
            (r) => r.channel_id === filters.channel_id
          );
          return Promise.resolve({
            data: row
              ? { id: row.id, limit_overrides: row.limit_overrides }
              : null,
            error: null,
          });
        }
        return Promise.resolve({ data: null, error: null });
      };
      chain.then = (resolve: (v: unknown) => unknown) => {
        if (table === 'evolution_instances') {
          return Promise.resolve({ data: instanceRows, error: null }).then(
            resolve
          );
        }
        return Promise.resolve({ data: null, error: null }).then(resolve);
      };
      return chain;
    },
    rpc: (fn: string) => {
      if (fn === 'account_effective_limits') {
        return Promise.resolve({ data: accountPlanOverrides, error: null });
      }
      return Promise.resolve({ data: {}, error: null });
    },
  };
}

vi.mock('@/lib/supabase/admin', () => ({
  supabaseAdmin: () => makeDb(),
}));

import { GET, PUT } from './route';

function makeRequest(
  method: 'GET' | 'PUT',
  body?: unknown,
  secret = 'the-admin-secret'
): Request {
  return new Request('http://localhost/x', {
    method,
    headers: {
      ...(secret ? { 'x-admin-secret': secret } : {}),
      'Content-Type': 'application/json',
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

const ctx = { params: Promise.resolve({ accountId: 'acct-1' }) };

beforeEach(() => {
  updates.length = 0;
  accountPlanOverrides = {};
  accountHasNoPlan = false;
  instanceRows = [
    {
      id: 'inst-1',
      channel_id: 'chan-1',
      limit_overrides: {},
      channels: { name: 'Comercial' },
    },
  ];
});

describe('GET /api/admin/accounts/[accountId]/channel-limits', () => {
  it('503 sem PLATFORM_ADMIN_SECRET configurado', async () => {
    const original = process.env.PLATFORM_ADMIN_SECRET;
    delete process.env.PLATFORM_ADMIN_SECRET;
    const res = await GET(makeRequest('GET'), ctx);
    expect(res.status).toBe(503);
    process.env.PLATFORM_ADMIN_SECRET = original;
  });

  it('401 com segredo errado', async () => {
    const res = await GET(makeRequest('GET', undefined, 'wrong'), ctx);
    expect(res.status).toBe(401);
  });

  it('devolve os limites de conta resolvidos e os overrides por instância', async () => {
    accountPlanOverrides = { evolution_cold_send_per_day: 150 };
    instanceRows[0].limit_overrides = { evolution_cold_send_per_hour: 8 };

    const res = await GET(makeRequest('GET'), ctx);
    const body = await res.json();

    expect(body.account.evolution_cold_send_per_day).toMatchObject({
      value: 150,
      level: 'account',
      override: 150,
    });
    expect(body.account.evolution_cold_send_per_hour).toMatchObject({
      value: 12,
      level: 'code',
      override: null,
    });
    expect(body.instances).toEqual([
      {
        channelId: 'chan-1',
        label: 'Comercial',
        overrides: { evolution_cold_send_per_hour: 8 },
      },
    ]);
  });
});

describe('PUT /api/admin/accounts/[accountId]/channel-limits — validação', () => {
  it('chave desconhecida → 400', async () => {
    const res = await PUT(
      makeRequest('PUT', { account: { nao_existe: 10 } }),
      ctx
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/unknown limit key/);
  });

  it('valor acima do teto duro → 400, nunca clamp silencioso', async () => {
    const res = await PUT(
      makeRequest('PUT', { account: { evolution_cold_send_per_day: 5000 } }),
      ctx
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/above the ceiling of 250/);
    expect(updates).toHaveLength(0);
  });

  it('piso: valor abaixo do mínimo → 400', async () => {
    const res = await PUT(
      makeRequest('PUT', {
        account: { evolution_cold_send_min_interval_seconds: 1 },
      }),
      ctx
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/below the floor of 10/);
  });

  it('chave de instância desconhecida → 400, nada gravado', async () => {
    const res = await PUT(
      makeRequest('PUT', { instances: { 'chan-1': { xyz: 1 } } }),
      ctx
    );
    expect(res.status).toBe(400);
    expect(updates).toHaveLength(0);
  });

  it('valor não inteiro → 400', async () => {
    const res = await PUT(
      makeRequest('PUT', { account: { evolution_cold_send_per_day: 1.5 } }),
      ctx
    );
    expect(res.status).toBe(400);
  });
});

describe('PUT /api/admin/accounts/[accountId]/channel-limits — grava e remove', () => {
  it('salva um override de conta SEM apagar os outros já existentes', async () => {
    accountPlanOverrides = { contacts: 5000 }; // override de QUOTA, não de segurança

    await PUT(
      makeRequest('PUT', {
        account: { evolution_cold_send_per_day: 150 },
      }),
      ctx
    );

    const update = updates.find((u) => u.table === 'account_plans');
    expect(update?.payload).toMatchObject({
      limit_overrides: { contacts: 5000, evolution_cold_send_per_day: 150 },
    });
  });

  it('null REMOVE o override (volta a herdar)', async () => {
    accountPlanOverrides = {
      evolution_cold_send_per_day: 150,
      contacts: 5000,
    };

    await PUT(
      makeRequest('PUT', {
        account: { evolution_cold_send_per_day: null },
      }),
      ctx
    );

    const update = updates.find((u) => u.table === 'account_plans');
    expect(update?.payload).toEqual({ limit_overrides: { contacts: 5000 } });
  });

  it('0 é um valor válido (bloqueia o eixo), não é tratado como remoção', async () => {
    await PUT(
      makeRequest('PUT', { account: { evolution_cold_send_per_day: 0 } }),
      ctx
    );

    const update = updates.find((u) => u.table === 'account_plans');
    expect(update?.payload).toEqual({
      limit_overrides: { evolution_cold_send_per_day: 0 },
    });
  });

  it('salva override por instância, escopado ao channel_id certo', async () => {
    await PUT(
      makeRequest('PUT', {
        instances: { 'chan-1': { evolution_cold_send_per_hour: 8 } },
      }),
      ctx
    );

    const update = updates.find((u) => u.table === 'evolution_instances');
    expect(update?.payload).toEqual({
      limit_overrides: { evolution_cold_send_per_hour: 8 },
    });
  });

  it('instância de outra conta (não encontrada) → 404, nada gravado', async () => {
    instanceRows = [];
    const res = await PUT(
      makeRequest('PUT', {
        instances: { 'chan-outro': { evolution_cold_send_per_hour: 8 } },
      }),
      ctx
    );
    expect(res.status).toBe(404);
  });

  it('conta sem plano atribuído → 404, nada gravado', async () => {
    accountHasNoPlan = true;
    const res = await PUT(
      makeRequest('PUT', { account: { evolution_cold_send_per_day: 100 } }),
      ctx
    );
    expect(res.status).toBe(404);
    expect(updates).toHaveLength(0);
  });
});
