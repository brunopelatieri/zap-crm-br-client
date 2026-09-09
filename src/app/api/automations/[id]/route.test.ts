import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// SPEC 065 §6 — PATCH /api/automations/[id], escopo de canal.
//
// Dois achados de code review vivem aqui e em lugar nenhum mais:
//
//   1. o gatilho D-8 da migração 075 desativa toda automação cujo
//      `channel_id` vá de preenchido para NULL — inclusive quando quem
//      fez isso foi o operador escolhendo "Todos os números";
//   2. `channel_id` era copiado CRU do corpo para o UPDATE, então uma
//      string vazia (o `<select value="">` de "Todos os números") ia
//      para o Postgres como uuid inválido.
//
// Os dois só aparecem na rota: o banco é quem desativa, e o valor cru só
// existe aqui. Daí um teste de rota, e não de lib.
// ---------------------------------------------------------------------------

const h = vi.hoisted(() => ({
  state: {
    /** Linha atual de `automations`. */
    existing: {} as Record<string, unknown>,
    /** Linha de `channels` que a conta tem. */
    channel: null as Record<string, unknown> | null,
    /** Todo UPDATE em `automations`, na ordem. */
    updates: [] as Record<string, unknown>[],
    /** Filtros `.eq()` de cada UPDATE, na mesma ordem de `updates`. */
    updateFilters: [] as [string, unknown][][],
    /**
     * Simula a trava otimista da reativação (achado de code review):
     * `false` = a segunda UPDATE (`is_active: true`) não acha a linha
     * (uma requisição concorrente já mudou o estado) — o teste confere
     * que a rota não trata isso como erro.
     */
    reactivationMatches: true,
  },
}));

vi.mock('@/lib/auth/account', () => ({
  requireRole: vi.fn(async () => ({ accountId: 'acct-1', userId: 'user-1' })),
  toErrorResponse: vi.fn(),
}));

const recordActivityMock = vi.fn(async () => undefined);
vi.mock('@/lib/activity/record', () => ({
  recordActivity: (...args: unknown[]) => recordActivityMock(...(args as [])),
}));

vi.mock('@/lib/automations/steps-tree', () => ({
  replaceSteps: vi.fn(async () => null),
  loadStepsTree: vi.fn(async () => [
    { step_type: 'send_message', step_config: { text: 'oi' } },
  ]),
}));

vi.mock('@/lib/channels/account-channel-types', () => ({
  loadAccountChannelTypes: vi.fn(async () => ['whatsapp_cloud']),
}));

vi.mock('@/lib/automations/admin-client', () => {
  const { state } = h;

  function builder(table: string) {
    let verb = 'select';
    let payload: Record<string, unknown> | null = null;
    let recorded = false;
    const filters: [string, unknown][] = [];

    const settle = () => {
      if (table === 'automations') {
        if (verb === 'update') {
          // Só registra uma vez por UPDATE (a cadeia pode chamar
          // `settle()` mais de uma vez via `.select()` + `then`).
          if (!recorded) {
            state.updates.push(payload ?? {});
            state.updateFilters.push(filters.slice());
            recorded = true;
          }
          // A trava otimista (`.eq('is_active', false)`) da reativação:
          // simula "achou a linha" vs "requisição concorrente já mudou
          // o estado" via `reactivationMatches`.
          const isReactivation =
            Object.keys(payload ?? {}).length === 1 &&
            (payload as Record<string, unknown>)?.is_active === true;
          const data = isReactivation
            ? state.reactivationMatches
              ? [{ id: 'auto-1' }]
              : []
            : null;
          return { data, error: null };
        }
        return { data: state.existing, error: null };
      }
      if (table === 'channels') return { data: state.channel, error: null };
      return { data: null, error: null };
    };

    const b: Record<string, unknown> = {
      select: () => b,
      update: (p: Record<string, unknown>) => (
        (verb = 'update'),
        (payload = p),
        b
      ),
      eq: (k: string, v: unknown) => (filters.push([k, v]), b),
      maybeSingle: () => Promise.resolve(settle()),
      single: () => Promise.resolve(settle()),
      then: (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) =>
        Promise.resolve(settle()).then(onF, onR),
    };
    return b;
  }

  return { supabaseAdmin: () => ({ from: (t: string) => builder(t) }) };
});

import { PATCH } from './route';

const CHANNEL = {
  id: 'ch-a',
  account_id: 'acct-1',
  type: 'whatsapp_cloud',
  status: 'connected',
};

function patch(body: unknown) {
  return PATCH(
    new Request('http://x/api/automations/auto-1', {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: 'auto-1' }) }
  );
}

beforeEach(() => {
  h.state.channel = CHANNEL;
  h.state.updates = [];
  h.state.updateFilters = [];
  h.state.reactivationMatches = true;
  h.state.existing = {
    id: 'auto-1',
    user_id: 'user-1',
    account_id: 'acct-1',
    name: 'Boas-vindas',
    is_active: true,
    trigger_type: 'new_message_received',
    trigger_config: {},
    channel_id: 'ch-a',
  };
  recordActivityMock.mockClear();
});

describe('PATCH — SPEC 075 F4: feed de atividade', () => {
  it('is_active: false → automation.disabled, sem automation.updated', async () => {
    await patch({ is_active: false });

    expect(recordActivityMock).toHaveBeenCalledTimes(1);
    expect(recordActivityMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        resourceType: 'automation',
        action: 'automation.disabled',
        resourceId: 'auto-1',
      })
    );
  });

  it('mudar só o nome → automation.updated, sem enabled/disabled', async () => {
    await patch({ name: 'Novo nome' });

    expect(recordActivityMock).toHaveBeenCalledTimes(1);
    expect(recordActivityMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'automation.updated' })
    );
  });

  it('reativação por channel_id: null NÃO conta como automation.enabled', async () => {
    await patch({ channel_id: null });

    // Só `automation.updated` (mudança de canal) — a reativação do
    // gatilho não passou por `update.is_active`.
    expect(recordActivityMock).toHaveBeenCalledTimes(1);
    expect(recordActivityMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'automation.updated' })
    );
  });
});

describe('PATCH — voltar para "Todos os números" (SPEC 065 D-8)', () => {
  // O gatilho da 075 é BEFORE e escreve `NEW.is_active := FALSE`. A rota
  // validou a automação como ATIVA e respondia `{ ok: true }` — ela
  // parava de disparar sem nada dizer por quê.
  it('reativa a automação na mesma requisição, com UPDATE separado', async () => {
    const res = await patch({ channel_id: null });

    expect(res.status).toBe(200);
    // Primeiro UPDATE grava o escopo; o segundo desfaz a desativação do
    // gatilho e NÃO toca em `channel_id` (senão o gatilho dispararia de
    // novo e anularia a reativação).
    expect(h.state.updates).toHaveLength(2);
    expect(h.state.updates[0]).toMatchObject({ channel_id: null });
    expect(h.state.updates[1]).toEqual({ is_active: true });
    expect(h.state.updates[1]).not.toHaveProperty('channel_id');
  });

  // Achado de code review: as duas UPDATEs não são uma transação — a
  // reativação precisa de uma trava otimista (`.eq('is_active', false)`)
  // para não sobrescrever cegamente uma mudança concorrente na mesma
  // automação, entre o UPDATE que o gatilho desativou e este que a
  // reativaria.
  it('a reativação só escreve se a linha ainda estiver desativada (trava otimista)', async () => {
    await patch({ channel_id: null });

    const reactivationFilters = h.state.updateFilters[1];
    expect(reactivationFilters).toContainEqual(['is_active', false]);
    expect(reactivationFilters).toContainEqual(['id', 'auto-1']);
  });

  it('reativação sem linha casada (requisição concorrente) não vira 500', async () => {
    h.state.reactivationMatches = false;

    const res = await patch({ channel_id: null });

    // A UPDATE aconteceu (a rota não sabe fazer diferente sem outra
    // leitura), mas não achar a linha é um caso ESPERADO — outra
    // requisição já decidiu o estado final — e não um erro do servidor.
    expect(res.status).toBe(200);
    expect(h.state.updates).toHaveLength(2);
  });

  it('automação já inativa não é reativada por acidente', async () => {
    h.state.existing.is_active = false;

    await patch({ channel_id: null });

    expect(h.state.updates).toHaveLength(1);
    expect(h.state.updates[0]).toMatchObject({ channel_id: null });
  });

  it('quem já estava sem canal não dispara reativação nenhuma', async () => {
    h.state.existing.channel_id = null;

    await patch({ channel_id: null });

    expect(h.state.updates).toHaveLength(1);
  });

  it('desativar de propósito no mesmo PATCH continua desativando', async () => {
    await patch({ channel_id: null, is_active: false });

    expect(h.state.updates).toHaveLength(1);
    expect(h.state.updates[0]).toMatchObject({ is_active: false });
  });
});

describe('PATCH — normalização de channel_id (SPEC 065 §6)', () => {
  // O `<select value="">` de "Todos os números". Antes o valor cru ia
  // para o Postgres e voltava 22P02 (500), enquanto a validação já o
  // tinha lido como `null` e deixado passar.
  it('string vazia é gravada como NULL, nunca como ""', async () => {
    const res = await patch({ channel_id: '' });

    expect(res.status).toBe(200);
    expect(h.state.updates[0].channel_id).toBeNull();
    expect(h.state.updates[0].channel_id).not.toBe('');
  });

  it('canal de outra conta (ou inexistente) recusa com 400 e código estável', async () => {
    h.state.channel = null;

    const res = await patch({ channel_id: 'ch-de-outra-conta' });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      code: 'channel_not_in_account',
    });
    expect(h.state.updates).toHaveLength(0);
  });
});
