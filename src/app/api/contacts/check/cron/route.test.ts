import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: (v: string) => `decrypted:${v}`,
}));

const runCheckBatch = vi.fn();
vi.mock('@/lib/evolution/check-run', async () => {
  const actual = await vi.importActual<
    typeof import('@/lib/evolution/check-run')
  >('@/lib/evolution/check-run');
  return {
    ...actual,
    runCheckBatch: (...args: unknown[]) => runCheckBatch(...args),
  };
});

const readEvolutionConfig = vi.fn();
vi.mock('@/lib/evolution/config', () => ({
  readEvolutionConfig: () => readEvolutionConfig(),
}));

// ------------------------------------------------------------
// Cenário controlado por teste
// ------------------------------------------------------------
interface Scenario {
  pendingRows: Array<{
    id: string;
    account_id: string;
    check_channel_id: string | null;
    source: 'contacts_import' | 'broadcast';
    attempts: number;
    created_at: string;
  }>;
  /** account_id:channel_id -> tem instância conectada+check_enabled? */
  connectedInstances: Set<string>;
  /** account_id -> channel_id da instância `check_enabled`+conectada
   *  ATUAL da conta (resolveCheckInstance, sem filtro de channel_id). */
  currentCheckInstanceByAccount?: Record<string, string>;
  accountLimits?: Record<string, unknown>;
  queueRowsById?: Record<
    string,
    { contact_id: string; phone_normalized: string }
  >;
  contactsById?: Record<string, { avatar_fetched_at: string | null }>;
}

let scenario: Scenario;
const updates: Array<{ table: string; payload: unknown; filters: unknown[] }> =
  [];

function makeDb() {
  function chain(table: string) {
    const filters: unknown[] = [];
    let updatePayload: unknown;
    const c: Record<string, unknown> = {
      select: () => c,
      eq: (...args: unknown[]) => {
        filters.push(['eq', ...args]);
        return c;
      },
      not: (...args: unknown[]) => {
        filters.push(['not', ...args]);
        return c;
      },
      lt: (...args: unknown[]) => {
        filters.push(['lt', ...args]);
        return c;
      },
      in: (...args: unknown[]) => {
        filters.push(['in', ...args]);
        return c;
      },
      is: (...args: unknown[]) => {
        filters.push(['is', ...args]);
        return c;
      },
      gte: (...args: unknown[]) => {
        filters.push(['gte', ...args]);
        return c;
      },
      order: () => c,
      limit: () => c,
      update: (p: unknown) => {
        updatePayload = p;
        return c;
      },
      maybeSingle: () => Promise.resolve(resolveMaybeSingle(table, filters)),
      then: (resolve: (v: unknown) => unknown) => {
        if (updatePayload !== undefined) {
          updates.push({ table, payload: updatePayload, filters });
        }
        return Promise.resolve(resolveThen(table, filters, updatePayload)).then(
          resolve
        );
      },
    };
    return c;
  }
  return {
    from: (t: string) => chain(t),
    rpc: () => Promise.resolve({ data: {}, error: null }),
  };
}

function findFilterValue(filters: unknown[], key: string): unknown {
  for (const f of filters) {
    const arr = f as unknown[];
    if (arr[0] === 'eq' && arr[1] === key) return arr[2];
  }
  return undefined;
}

function resolveMaybeSingle(table: string, filters: unknown[]) {
  if (table === 'evolution_instances') {
    const accountId = findFilterValue(filters, 'account_id');
    const channelId = findFilterValue(filters, 'channel_id');
    if (channelId !== undefined) {
      // resolveConnectedCheckInstance: escopada ao canal congelado na
      // fila.
      const key = `${accountId}:${channelId}`;
      if (scenario.connectedInstances.has(key)) {
        return {
          data: { id: `inst-${key}`, channel_id: channelId },
          error: null,
        };
      }
      return { data: null, error: null };
    }
    // resolveCheckInstance: sem filtro de channel_id — "qual instância
    // valida números pela CONTA agora" (pode ser outra, se a congelada
    // caiu e a conta trocou de instância).
    const current =
      scenario.currentCheckInstanceByAccount?.[accountId as string];
    if (current) {
      return {
        data: { id: `inst-${accountId}:${current}`, channel_id: current },
        error: null,
      };
    }
    return { data: null, error: null };
  }
  if (table === 'evolution_instance_secrets') {
    return { data: { instance_token_encrypted: 'enc' }, error: null };
  }
  return { data: null, error: null };
}

function resolveThen(
  table: string,
  filters: unknown[],
  updatePayload: unknown
) {
  if (updatePayload !== undefined) return { data: null, error: null };

  if (table === 'contact_check_queue') {
    // A leitura principal (pending scan) não tem `.eq('id', ...)` de
    // um item específico — é o `select` inicial.
    const hasIn = filters.some((f) => (f as unknown[])[0] === 'in');
    if (hasIn) {
      // hydrateItems: select id, contact_id, phone_normalized IN (...)
      const idsArg = filters.find(
        (f) => (f as unknown[])[0] === 'in'
      ) as unknown[];
      const ids = idsArg[2] as string[];
      const rows = ids
        .map((id) => {
          const row = scenario.queueRowsById?.[id];
          return row ? { id, ...row } : null;
        })
        .filter(Boolean);
      return { data: rows, error: null };
    }
    return { data: scenario.pendingRows, error: null };
  }

  if (table === 'contacts') {
    const idsArg = filters.find((f) => (f as unknown[])[0] === 'in') as
      unknown[] | undefined;
    const ids = (idsArg?.[2] as string[]) ?? [];
    const rows = ids.map((id) => ({
      id,
      avatar_fetched_at: scenario.contactsById?.[id]?.avatar_fetched_at ?? null,
    }));
    return { data: rows, error: null };
  }

  return { data: null, error: null };
}

vi.mock('@/lib/supabase/admin', () => ({
  supabaseAdmin: () => makeDb(),
}));

import { GET } from './route';

function makeRequest(secret?: string): Request {
  return new Request('http://localhost/api/contacts/check/cron', {
    headers: secret ? { 'x-cron-secret': secret } : {},
  });
}

const CONFIG = {
  apiUrl: 'https://evo.example.com',
  globalApiKey: 'global',
  maxInstancesPerAccount: 3,
  maxInstancesTotal: 20,
  instancePrefix: 'zapcrm',
  webhookPublicUrl: null,
  requestTimeoutMs: 15_000,
  mediaRequestTimeoutMs: 60_000,
};

beforeEach(() => {
  updates.length = 0;
  runCheckBatch.mockReset();
  readEvolutionConfig.mockReset();
  readEvolutionConfig.mockReturnValue(CONFIG);
  process.env.AUTOMATION_CRON_SECRET = 'the-secret';
  scenario = {
    pendingRows: [],
    connectedInstances: new Set(),
  };
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('GET /api/contacts/check/cron — contrato de auth (SPEC 069 §11.3)', () => {
  it('503 sem AUTOMATION_CRON_SECRET', async () => {
    delete process.env.AUTOMATION_CRON_SECRET;
    const res = await GET(makeRequest('anything'));
    expect(res.status).toBe(503);
  });

  it('401 com segredo errado', async () => {
    const res = await GET(makeRequest('wrong'));
    expect(res.status).toBe(401);
  });

  it('401 sem header nenhum', async () => {
    const res = await GET(makeRequest());
    expect(res.status).toBe(401);
  });

  it('200 com segredo certo, fila vazia', async () => {
    const res = await GET(makeRequest('the-secret'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      accountsProcessed: 0,
      checked: 0,
      invalid: 0,
    });
  });
});

describe('GET /api/contacts/check/cron — sem Evolution configurada', () => {
  it('200 vazio, sem tocar a fila', async () => {
    readEvolutionConfig.mockReturnValue(null);
    scenario.pendingRows = [
      {
        id: 'q1',
        account_id: 'a1',
        check_channel_id: 'c1',
        source: 'contacts_import',
        attempts: 0,
        created_at: new Date().toISOString(),
      },
    ];

    const res = await GET(makeRequest('the-secret'));

    expect(res.status).toBe(200);
    expect(runCheckBatch).not.toHaveBeenCalled();
  });
});

describe('GET /api/contacts/check/cron — reclaim de itens presos', () => {
  it('faz UPDATE de in_progress velho para pending antes de processar', async () => {
    await GET(makeRequest('the-secret'));

    const reclaim = updates.find(
      (u) =>
        u.table === 'contact_check_queue' &&
        (u.payload as Record<string, unknown>).status === 'pending' &&
        u.filters.some((f) => (f as unknown[])[2] === 'in_progress')
    );
    expect(reclaim).toBeDefined();
  });
});

describe('GET /api/contacts/check/cron — instância indisponível', () => {
  it('marca os itens do grupo como skipped e reporta no agregado', async () => {
    scenario.pendingRows = [
      {
        id: 'q1',
        account_id: 'a1',
        check_channel_id: 'c1',
        source: 'contacts_import',
        attempts: 0,
        created_at: new Date().toISOString(),
      },
    ];
    // connectedInstances vazio: nenhuma instância conectada.

    const res = await GET(makeRequest('the-secret'));
    const body = await res.json();

    expect(body.skipped).toContainEqual(
      expect.objectContaining({ accountId: 'a1', channelId: 'c1' })
    );
    const skipUpdate = updates.find(
      (u) =>
        u.table === 'contact_check_queue' &&
        (u.payload as Record<string, unknown>).status === 'skipped'
    );
    expect(skipUpdate).toBeDefined();
    expect(runCheckBatch).not.toHaveBeenCalled();
  });

  it('a instância congelada caiu, mas a conta tem outra check_enabled agora: realoca em vez de skipped (achado de code review)', async () => {
    scenario.pendingRows = [
      {
        id: 'q1',
        account_id: 'a1',
        check_channel_id: 'c1',
        source: 'contacts_import',
        attempts: 0,
        created_at: new Date().toISOString(),
      },
    ];
    // c1 (a instância que enfileirou) caiu — mas a conta trocou para c2.
    scenario.currentCheckInstanceByAccount = { a1: 'c2' };

    const res = await GET(makeRequest('the-secret'));
    const body = await res.json();

    expect(body.rerouted).toContainEqual(
      expect.objectContaining({
        accountId: 'a1',
        fromChannelId: 'c1',
        toChannelId: 'c2',
        count: 1,
      })
    );
    expect(body.skipped).toEqual([]);
    const reroute = updates.find(
      (u) =>
        u.table === 'contact_check_queue' &&
        (u.payload as Record<string, unknown>).check_channel_id === 'c2'
    );
    expect(reroute).toBeDefined();
    const skipUpdate = updates.find(
      (u) =>
        u.table === 'contact_check_queue' &&
        (u.payload as Record<string, unknown>).status === 'skipped'
    );
    expect(skipUpdate).toBeUndefined();
    expect(runCheckBatch).not.toHaveBeenCalled();
  });

  it('sem NENHUMA instância disponível (nem a congelada, nem outra da conta): skipped como antes', async () => {
    scenario.pendingRows = [
      {
        id: 'q1',
        account_id: 'a1',
        check_channel_id: 'c1',
        source: 'contacts_import',
        attempts: 0,
        created_at: new Date().toISOString(),
      },
    ];
    // Nem connectedInstances, nem currentCheckInstanceByAccount: a
    // conta não tem instância validadora nenhuma agora.

    const res = await GET(makeRequest('the-secret'));
    const body = await res.json();

    expect(body.rerouted).toEqual([]);
    expect(body.skipped).toContainEqual(
      expect.objectContaining({ accountId: 'a1', channelId: 'c1' })
    );
  });
});

describe('GET /api/contacts/check/cron — grupo processável', () => {
  it('resolve a instância, hidrata os itens e chama runCheckBatch; agrega o resultado', async () => {
    scenario.pendingRows = [
      {
        id: 'q1',
        account_id: 'a1',
        check_channel_id: 'c1',
        source: 'contacts_import',
        attempts: 0,
        created_at: new Date().toISOString(),
      },
    ];
    scenario.connectedInstances.add('a1:c1');
    scenario.queueRowsById = {
      q1: { contact_id: 'contact-1', phone_normalized: '5511900000001' },
    };
    scenario.contactsById = { 'contact-1': { avatar_fetched_at: null } };
    runCheckBatch.mockResolvedValue({
      results: [],
      checked: 1,
      invalid: 0,
      avatarsFetched: 1,
      failed: 0,
      abortedChannelUnavailable: false,
    });

    const res = await GET(makeRequest('the-secret'));
    const body = await res.json();

    expect(runCheckBatch).toHaveBeenCalledTimes(1);
    const callArgs = runCheckBatch.mock.calls[0][2];
    expect(callArgs.items).toEqual([
      {
        queueItemId: 'q1',
        contactId: 'contact-1',
        phoneNormalized: '5511900000001',
        avatarFetchedAt: null,
      },
    ]);
    expect(callArgs.instanceToken).toBe('decrypted:enc');
    expect(body.accountsProcessed).toBe(1);
    expect(body.checked).toBe(1);
    expect(body.avatarsFetched).toBe(1);
  });

  it('dois grupos (contas diferentes) processam em chamadas separadas', async () => {
    scenario.pendingRows = [
      {
        id: 'q1',
        account_id: 'a1',
        check_channel_id: 'c1',
        source: 'contacts_import',
        attempts: 0,
        created_at: new Date().toISOString(),
      },
      {
        id: 'q2',
        account_id: 'a2',
        check_channel_id: 'c2',
        source: 'contacts_import',
        attempts: 0,
        created_at: new Date().toISOString(),
      },
    ];
    scenario.connectedInstances = new Set(['a1:c1', 'a2:c2']);
    scenario.queueRowsById = {
      q1: { contact_id: 'contact-1', phone_normalized: '5511900000001' },
      q2: { contact_id: 'contact-2', phone_normalized: '5511900000002' },
    };
    runCheckBatch.mockResolvedValue({
      results: [],
      checked: 1,
      invalid: 0,
      avatarsFetched: 0,
      failed: 0,
      abortedChannelUnavailable: false,
    });

    const res = await GET(makeRequest('the-secret'));
    const body = await res.json();

    expect(runCheckBatch).toHaveBeenCalledTimes(2);
    expect(body.accountsProcessed).toBe(2);
    expect(body.checked).toBe(2);
  });
});
