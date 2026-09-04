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

interface Scenario {
  instance: Record<string, unknown> | null;
}
let scenario: Scenario;
const updates: Array<Record<string, unknown>> = [];

function makeAdminDb() {
  return {
    from: () => {
      const chain: Record<string, unknown> = {};
      let updatePayload: unknown;
      chain.select = () => chain;
      chain.eq = () => chain;
      chain.update = (p: unknown) => {
        updatePayload = p;
        return chain;
      };
      chain.maybeSingle = () =>
        Promise.resolve({ data: scenario.instance, error: null });
      chain.then = (resolve: (v: unknown) => unknown) => {
        if (updatePayload !== undefined) {
          updates.push(updatePayload as Record<string, unknown>);
        }
        return Promise.resolve({ error: null }).then(resolve);
      };
      return chain;
    },
    rpc: () => Promise.resolve({ data: {}, error: null }),
  };
}

vi.mock('@/lib/supabase/admin', () => ({
  supabaseAdmin: () => makeAdminDb(),
}));

import { PATCH } from './route';

function makeRequest(body: unknown): Request {
  return new Request('http://localhost/x', {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
}
const PARAMS = { params: Promise.resolve({ id: 'inst-1' }) };

beforeEach(() => {
  updates.length = 0;
  requireRole.mockResolvedValue({
    supabase: {},
    accountId: 'acct-1',
    userId: 'user-1',
    role: 'admin',
    account: { id: 'acct-1', name: 'Conta' },
  });
  scenario = {
    instance: {
      id: 'inst-1',
      channel_id: 'chan-1',
      connected_phone: '5511900000000',
      check_enabled: false,
      harvest_enabled: false,
      harvest_max_contacts: null,
      harvested_count: 0,
    },
  };
});

describe('PATCH /api/channels/evolution/instances/[id]/enrichment', () => {
  it('exige admin+', async () => {
    await PATCH(makeRequest({ checkEnabled: true }), PARAMS);
    expect(requireRole).toHaveBeenCalledWith('admin');
  });

  it('JSON inválido → 400', async () => {
    const req = new Request('http://x', { method: 'PATCH', body: '{not json' });
    const res = await PATCH(req, PARAMS);
    expect(res.status).toBe(400);
  });

  it('checkEnabled não-booleano → 400', async () => {
    const res = await PATCH(makeRequest({ checkEnabled: 'yes' }), PARAMS);
    expect(res.status).toBe(400);
  });

  it('instância não encontrada (outra conta ou id inexistente) → 404', async () => {
    scenario.instance = null;
    const res = await PATCH(makeRequest({ checkEnabled: true }), PARAMS);
    expect(res.status).toBe(404);
  });

  it('ligar checkEnabled numa instância que nunca conectou → 409', async () => {
    scenario.instance!.connected_phone = null;
    const res = await PATCH(makeRequest({ checkEnabled: true }), PARAMS);
    const body = await res.json();
    expect(res.status).toBe(409);
    expect(body.error).toMatch(/not connected/);
  });

  it('desligar checkEnabled numa instância nunca conectada é permitido (só ligar exige conexão)', async () => {
    scenario.instance!.connected_phone = null;
    const res = await PATCH(makeRequest({ checkEnabled: false }), PARAMS);
    expect(res.status).toBe(200);
  });

  it('caminho feliz: liga check e harvest, devolve o estado', async () => {
    const res = await PATCH(
      makeRequest({ checkEnabled: true, harvestEnabled: true }),
      PARAMS
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toMatchObject({ checkEnabled: true, harvestEnabled: true });
    expect(updates[0]).toMatchObject({
      check_enabled: true,
      harvest_enabled: true,
    });
  });

  it('harvestMaxContacts acima do teto duro → 400, sem gravar nada', async () => {
    process.env.EVOLUTION_HARVEST_MAX_PER_INSTANCE_MAX = '2000';
    const res = await PATCH(makeRequest({ harvestMaxContacts: 5000 }), PARAMS);
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toMatch(/exceeds the ceiling/);
    expect(updates).toHaveLength(0);

    delete process.env.EVOLUTION_HARVEST_MAX_PER_INSTANCE_MAX;
  });

  it('harvestMaxContacts null volta a herdar', async () => {
    const res = await PATCH(makeRequest({ harvestMaxContacts: null }), PARAMS);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(updates[0]).toMatchObject({ harvest_max_contacts: null });
    expect(body.harvestMaxContacts).toBeNull();
  });

  it('harvestMaxContacts negativo → 400', async () => {
    const res = await PATCH(makeRequest({ harvestMaxContacts: -1 }), PARAMS);
    expect(res.status).toBe(400);
  });

  it('resposta sempre inclui harvestMaxContactsCeiling, mesmo sem tocar o campo', async () => {
    const res = await PATCH(makeRequest({ checkEnabled: true }), PARAMS);
    const body = await res.json();
    expect(body.harvestMaxContactsCeiling).toBeDefined();
  });
});
