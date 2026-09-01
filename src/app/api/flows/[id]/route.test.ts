import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// SPEC 065 §6/§5.5 — PUT /api/flows/[id], escopo de canal.
//
// Achado de code review: ao contrário de `PATCH /api/automations/[id]`, esta
// rota nunca chamava `validateFlowChannel` — um fluxo ATIVO podia ser
// re-escopado para um canal `disabled` sem erro nenhum, e simplesmente parava
// de casar qualquer mensagem em `dispatchInboundToFlows` (filtro exato por
// `channel_id`), sem log, sem diagnóstico. Não havia teste algum desta rota.
//
// Um segundo achado, compartilhado com o de automações: as duas UPDATEs do
// desvio D-8 (desativação do gatilho + reativação manual) não são uma
// transação — a reativação agora precisa de uma trava otimista
// (`.eq('status', 'draft')`) para não sobrescrever cegamente uma mudança
// concorrente.
// ---------------------------------------------------------------------------

const h = vi.hoisted(() => ({
  state: {
    /** Linha atual de `flows`, lida por `requireOwnership` (RLS) e pelo
     *  `admin` (service-role) — mesma linha, dois clientes. */
    existing: {} as Record<string, unknown>,
    /** Linha de `channels` que a conta tem. */
    channel: null as Record<string, unknown> | null,
    /** Todo UPDATE em `flows`, na ordem. */
    updates: [] as Record<string, unknown>[],
    /** Filtros `.eq()` de cada UPDATE, na mesma ordem de `updates`. */
    updateFilters: [] as [string, unknown][][],
    /** Simula a trava otimista da reativação — ver o mesmo campo no
     *  teste de automações. */
    reactivationMatches: true,
  },
}));

vi.mock('@/lib/auth/account', () => ({
  requireRole: vi.fn(async () => ({ accountId: 'acct-1' })),
  toErrorResponse: vi.fn(),
}));

// requireOwnership usa este cliente (RLS) só para confirmar posse — a
// leitura em si não importa para os testes de canal, que rodam depois.
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: 'user-1' } } }) },
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({ data: { id: 'flow-1' }, error: null }),
        }),
      }),
    }),
  }),
}));

vi.mock('@/lib/flows/admin-client', () => {
  const { state } = h;

  function builder(table: string) {
    let verb = 'select';
    let payload: Record<string, unknown> | null = null;
    let recorded = false;
    const filters: [string, unknown][] = [];

    const settle = () => {
      if (table === 'flows') {
        if (verb === 'update') {
          if (!recorded) {
            state.updates.push(payload ?? {});
            state.updateFilters.push(filters.slice());
            recorded = true;
          }
          const isReactivation =
            Object.keys(payload ?? {}).length === 1 &&
            (payload as Record<string, unknown>)?.status === 'active';
          const data = isReactivation
            ? state.reactivationMatches
              ? [{ id: 'flow-1' }]
              : []
            : null;
          return { data, error: null };
        }
        return { data: state.existing, error: null };
      }
      if (table === 'channels') return { data: state.channel, error: null };
      if (table === 'flow_nodes') return { data: [], error: null };
      return { data: null, error: null };
    };

    const b: Record<string, unknown> = {
      select: () => b,
      update: (p: Record<string, unknown>) => (
        (verb = 'update'),
        (payload = p),
        b
      ),
      delete: () => ((verb = 'delete'), b),
      insert: () => ((verb = 'insert'), b),
      eq: (k: string, v: unknown) => (filters.push([k, v]), b),
      order: () => b,
      maybeSingle: () => Promise.resolve(settle()),
      single: () => Promise.resolve(settle()),
      then: (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) =>
        Promise.resolve(settle()).then(onF, onR),
    };
    return b;
  }

  return { supabaseAdmin: () => ({ from: (t: string) => builder(t) }) };
});

import { PUT } from './route';

const CHANNEL = {
  id: 'ch-a',
  account_id: 'acct-1',
  type: 'whatsapp_cloud',
  status: 'connected',
};

const DISABLED_CHANNEL = { ...CHANNEL, id: 'ch-disabled', status: 'disabled' };

function put(body: unknown) {
  return PUT(
    new Request('http://x/api/flows/flow-1', {
      method: 'PUT',
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: 'flow-1' }) }
  );
}

beforeEach(() => {
  h.state.channel = CHANNEL;
  h.state.updates = [];
  h.state.updateFilters = [];
  h.state.reactivationMatches = true;
  h.state.existing = {
    id: 'flow-1',
    account_id: 'acct-1',
    status: 'active',
    channel_id: 'ch-a',
  };
});

describe('PUT — canal desativado não pode manter um fluxo ATIVO (achado de code review)', () => {
  it('recusa com 400 quando o fluxo está ativo e o canal escolhido é disabled', async () => {
    h.state.channel = DISABLED_CHANNEL;

    const res = await put({ channel_id: 'ch-disabled' });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      error: 'Cannot keep flow active with invalid channel',
    });
    // Nada foi gravado — a recusa acontece ANTES do UPDATE.
    expect(h.state.updates).toHaveLength(0);
  });

  it('aceita quando o fluxo está ativo e o canal escolhido está saudável', async () => {
    const res = await put({ channel_id: 'ch-a' });

    expect(res.status).toBe(200);
    expect(h.state.updates).toHaveLength(1);
    expect(h.state.updates[0]).toMatchObject({ channel_id: 'ch-a' });
  });

  it('um fluxo em RASCUNHO pode salvar um canal disabled (drafts ficam incompletos)', async () => {
    h.state.existing.status = 'draft';
    h.state.channel = DISABLED_CHANNEL;

    const res = await put({ channel_id: 'ch-disabled' });

    expect(res.status).toBe(200);
    expect(h.state.updates).toHaveLength(1);
  });

  it('canal de outra conta (ou inexistente) recusa com 400 e código estável, mesmo em rascunho', async () => {
    h.state.existing.status = 'draft';
    h.state.channel = null;

    const res = await put({ channel_id: 'ch-de-outra-conta' });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      code: 'channel_not_in_account',
    });
    expect(h.state.updates).toHaveLength(0);
  });
});

describe('PUT — voltar para "Todos os números" (SPEC 065 D-8)', () => {
  it('reativa o fluxo na mesma requisição, com UPDATE separado', async () => {
    const res = await put({ channel_id: null });

    expect(res.status).toBe(200);
    expect(h.state.updates).toHaveLength(2);
    expect(h.state.updates[0]).toMatchObject({ channel_id: null });
    expect(h.state.updates[1]).toEqual({ status: 'active' });
  });

  it('a reativação só escreve se a linha ainda estiver em rascunho (trava otimista)', async () => {
    await put({ channel_id: null });

    const reactivationFilters = h.state.updateFilters[1];
    expect(reactivationFilters).toContainEqual(['status', 'draft']);
    expect(reactivationFilters).toContainEqual(['id', 'flow-1']);
  });

  it('reativação sem linha casada (requisição concorrente) não vira 500', async () => {
    h.state.reactivationMatches = false;

    const res = await put({ channel_id: null });

    expect(res.status).toBe(200);
    expect(h.state.updates).toHaveLength(2);
  });

  it('fluxo já em rascunho não é reativado por acidente', async () => {
    h.state.existing.status = 'draft';

    await put({ channel_id: null });

    expect(h.state.updates).toHaveLength(1);
  });
});
