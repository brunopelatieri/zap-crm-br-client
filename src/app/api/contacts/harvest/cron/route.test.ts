import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: (v: string) => `decrypted:${v}`,
}));

const readEvolutionConfig = vi.fn();
vi.mock('@/lib/evolution/config', () => ({
  readEvolutionConfig: () => readEvolutionConfig(),
}));

const listWhatsappContacts = vi.fn();
vi.mock('@/lib/evolution/user', () => ({
  listWhatsappContacts: (...args: unknown[]) => listWhatsappContacts(...args),
}));

interface Scenario {
  instances: Array<{
    id: string;
    account_id: string;
    channel_id: string;
    harvested_count: number;
  }>;
  triagedJids?: string[];
  linkedExternalIds?: string[];
  existingContactPhones?: string[];
  insertError?: string;
}

let scenario: Scenario;
const updates: Array<{ table: string; payload: unknown }> = [];
const inserts: Array<{ table: string; rows: unknown[] }> = [];

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
      in: (...args: unknown[]) => {
        filters.push(['in', ...args]);
        return c;
      },
      order: () => c,
      limit: () => c,
      update: (p: unknown) => {
        updatePayload = p;
        return c;
      },
      insert: (rows: unknown[]) => {
        inserts.push({ table, rows });
        if (table === 'evolution_harvested_contacts' && scenario.insertError) {
          return Promise.resolve({
            error: { message: scenario.insertError },
          });
        }
        return Promise.resolve({ error: null });
      },
      maybeSingle: () => {
        if (table === 'evolution_instance_secrets') {
          return Promise.resolve({
            data: { instance_token_encrypted: 'enc' },
            error: null,
          });
        }
        return Promise.resolve({ data: null, error: null });
      },
      then: (resolve: (v: unknown) => unknown) => {
        if (updatePayload !== undefined) {
          updates.push({ table, payload: updatePayload });
          return Promise.resolve({ data: null, error: null }).then(resolve);
        }
        if (table === 'evolution_instances') {
          return Promise.resolve({
            data: scenario.instances,
            error: null,
          }).then(resolve);
        }
        if (table === 'evolution_harvested_contacts') {
          const rows = (scenario.triagedJids ?? []).map((jid) => ({ jid }));
          return Promise.resolve({ data: rows, error: null }).then(resolve);
        }
        if (table === 'contact_identities') {
          const rows = (scenario.linkedExternalIds ?? []).map(
            (external_id) => ({
              external_id,
            })
          );
          return Promise.resolve({ data: rows, error: null }).then(resolve);
        }
        if (table === 'contacts') {
          const rows = (scenario.existingContactPhones ?? []).map(
            (phone_normalized) => ({ phone_normalized })
          );
          return Promise.resolve({ data: rows, error: null }).then(resolve);
        }
        return Promise.resolve({ data: null, error: null }).then(resolve);
      },
    };
    return c;
  }
  return { from: (t: string) => chain(t) };
}

vi.mock('@/lib/supabase/admin', () => ({
  supabaseAdmin: () => makeDb(),
}));

import { GET } from './route';

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

function makeRequest(secret?: string): Request {
  return new Request('http://localhost/api/contacts/harvest/cron', {
    headers: secret ? { 'x-cron-secret': secret } : {},
  });
}

beforeEach(() => {
  updates.length = 0;
  inserts.length = 0;
  listWhatsappContacts.mockReset();
  readEvolutionConfig.mockReset();
  readEvolutionConfig.mockReturnValue(CONFIG);
  process.env.AUTOMATION_CRON_SECRET = 'the-secret';
  process.env.EVOLUTION_HARVEST_WINDOW_START_HOUR = '0';
  process.env.EVOLUTION_HARVEST_WINDOW_END_HOUR = '6';
  process.env.EVOLUTION_HARVEST_TIMEZONE = 'America/Sao_Paulo';
  scenario = { instances: [] };
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('GET /api/contacts/harvest/cron — contrato de auth', () => {
  it('503 sem AUTOMATION_CRON_SECRET', async () => {
    delete process.env.AUTOMATION_CRON_SECRET;
    const res = await GET(makeRequest('anything'));
    expect(res.status).toBe(503);
  });

  it('401 com segredo errado', async () => {
    const res = await GET(makeRequest('wrong'));
    expect(res.status).toBe(401);
  });
});

describe('GET /api/contacts/harvest/cron — janela (§7.2)', () => {
  it('fora da janela: skipped=outside_window, ZERO chamada à Evolution', async () => {
    // 12:00 em SP é bem fora de [0,6).
    const midday = new Date('2026-09-03T15:00:00Z'); // 12:00 em SP
    vi.useFakeTimers();
    vi.setSystemTime(midday);

    scenario.instances = [
      { id: 'inst-1', account_id: 'a1', channel_id: 'c1', harvested_count: 0 },
    ];

    const res = await GET(makeRequest('the-secret'));
    const body = await res.json();

    expect(body.skipped).toBe('outside_window');
    expect(listWhatsappContacts).not.toHaveBeenCalled();

    vi.useRealTimers();
  });

  it('dentro da janela: processa normalmente', async () => {
    const midnight = new Date('2026-09-03T04:00:00Z'); // 01:00 em SP
    vi.useFakeTimers();
    vi.setSystemTime(midnight);

    scenario.instances = [];

    const res = await GET(makeRequest('the-secret'));
    const body = await res.json();

    expect(body.skipped).toBeUndefined();

    vi.useRealTimers();
  });
});

describe('GET /api/contacts/harvest/cron — sem Evolution configurada', () => {
  it('devolve not_configured, sem tocar nada', async () => {
    readEvolutionConfig.mockReturnValue(null);
    const res = await GET(makeRequest('the-secret'));
    const body = await res.json();
    expect(body.skipped).toBe('not_configured');
  });
});

describe('GET /api/contacts/harvest/cron — teto já atingido', () => {
  it('harvested_count >= max: harvest_complete, sem chamar /user/contacts', async () => {
    process.env.EVOLUTION_HARVEST_MAX_PER_INSTANCE = '10';
    scenario.instances = [
      { id: 'inst-1', account_id: 'a1', channel_id: 'c1', harvested_count: 10 },
    ];
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-03T04:00:00Z'));

    const res = await GET(makeRequest('the-secret'));
    const body = await res.json();

    expect(listWhatsappContacts).not.toHaveBeenCalled();
    expect(body.results).toContainEqual(
      expect.objectContaining({ accountId: 'a1', reason: 'harvest_complete' })
    );

    vi.useRealTimers();
    delete process.env.EVOLUTION_HARVEST_MAX_PER_INSTANCE;
  });
});

describe('GET /api/contacts/harvest/cron — caminho feliz', () => {
  it('capta contatos novos, ignora duplicatas dos três dedupes, atualiza contadores', async () => {
    scenario.instances = [
      { id: 'inst-1', account_id: 'a1', channel_id: 'c1', harvested_count: 5 },
    ];
    scenario.triagedJids = ['already-triaged@s.whatsapp.net'];
    scenario.linkedExternalIds = ['already-linked@lid'];
    scenario.existingContactPhones = ['5511900000099'];

    listWhatsappContacts.mockResolvedValue([
      {
        jid: 'already-triaged@s.whatsapp.net',
        found: true,
        firstName: null,
        fullName: null,
        pushName: 'X',
        businessName: null,
      },
      {
        jid: 'already-linked@lid',
        found: true,
        firstName: null,
        fullName: null,
        pushName: 'Y',
        businessName: null,
      },
      {
        jid: '5511900000099@s.whatsapp.net',
        found: true,
        firstName: null,
        fullName: null,
        pushName: 'Z',
        businessName: null,
      },
      {
        jid: '5511900000001@s.whatsapp.net',
        found: true,
        firstName: null,
        fullName: 'Fulano',
        pushName: 'Fulaninho',
        businessName: null,
      },
    ]);

    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-03T04:00:00Z'));

    const res = await GET(makeRequest('the-secret'));
    const body = await res.json();

    expect(body.harvested).toBe(1);
    const insertOp = inserts.find(
      (i) => i.table === 'evolution_harvested_contacts'
    );
    expect(insertOp?.rows).toEqual([
      expect.objectContaining({
        jid: '5511900000001@s.whatsapp.net',
        phone_normalized: '5511900000001',
        push_name: 'Fulaninho',
        full_name: 'Fulano',
        status: 'new',
      }),
    ]);

    const instanceUpdate = updates.find(
      (u) => u.table === 'evolution_instances'
    );
    expect(instanceUpdate?.payload).toMatchObject({ harvested_count: 6 });

    vi.useRealTimers();
  });

  it('Jid @lid não tem phone_normalized (não há telefone a extrair)', async () => {
    scenario.instances = [
      { id: 'inst-1', account_id: 'a1', channel_id: 'c1', harvested_count: 0 },
    ];
    listWhatsappContacts.mockResolvedValue([
      {
        jid: '999999999999@lid',
        found: true,
        firstName: null,
        fullName: null,
        pushName: 'Só LID',
        businessName: null,
      },
    ]);
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-03T04:00:00Z'));

    await GET(makeRequest('the-secret'));

    const insertOp = inserts.find(
      (i) => i.table === 'evolution_harvested_contacts'
    );
    expect(insertOp?.rows[0]).toMatchObject({ phone_normalized: null });

    vi.useRealTimers();
  });

  it('INSERT falho não incrementa harvested_count (achado de code review — desvio silencioso do contador)', async () => {
    scenario.instances = [
      { id: 'inst-1', account_id: 'a1', channel_id: 'c1', harvested_count: 5 },
    ];
    scenario.insertError = 'constraint violation';
    listWhatsappContacts.mockResolvedValue([
      {
        jid: '5511900000001@s.whatsapp.net',
        found: true,
        firstName: null,
        fullName: 'Fulano',
        pushName: 'Fulaninho',
        businessName: null,
      },
    ]);
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-03T04:00:00Z'));

    const res = await GET(makeRequest('the-secret'));
    const body = await res.json();

    // `insert(rows)` roda como um único INSERT: falhou, ZERO linhas
    // entraram — o contador não pode subir como se tivessem entrado,
    // senão `harvest_complete` dispara com a triagem vazia.
    expect(body.harvested).toBe(0);
    const instanceUpdate = updates.find(
      (u) => u.table === 'evolution_instances'
    );
    expect(instanceUpdate?.payload).toMatchObject({ harvested_count: 5 });
    expect(body.results).toContainEqual(
      expect.objectContaining({ accountId: 'a1', harvested: 0 })
    );

    vi.useRealTimers();
  });

  it('falha de /user/contacts (canal indisponível): não lança, reporta no resultado', async () => {
    scenario.instances = [
      { id: 'inst-1', account_id: 'a1', channel_id: 'c1', harvested_count: 0 },
    ];
    listWhatsappContacts.mockRejectedValue(new Error('network down'));
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-03T04:00:00Z'));

    const res = await GET(makeRequest('the-secret'));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.results).toContainEqual(
      expect.objectContaining({
        accountId: 'a1',
        reason: 'channel_unavailable',
      })
    );

    vi.useRealTimers();
  });
});
