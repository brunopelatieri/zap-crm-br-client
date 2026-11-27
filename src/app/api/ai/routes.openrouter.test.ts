import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// SPEC 089 F1 — rotas de IA: config (OpenRouter, privacidade, versões de
// prompt), restauração de versão e catálogo de modelos. As rotas são as
// reais; o banco é um fake mínimo que registra o que foi gravado.
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

const h = vi.hoisted(() => ({
  role: 'admin' as 'admin' | 'agent',
  tables: {} as Record<string, Row[]>,
  writes: [] as { table: string; op: 'insert' | 'update'; payload: Row }[],
  validate: vi.fn(),
  models: vi.fn(),
  inPlan: true,
}));

function fakeSupabase() {
  const from = (table: string) => {
    const filters: [string, unknown][] = [];
    let limitN: number | null = null;
    const rows = () =>
      (h.tables[table] ?? []).filter((r) =>
        filters.every(([k, v]) => r[k] === v)
      );
    const chain: Record<string, unknown> = {
      select: () => chain,
      eq: (k: string, v: unknown) => {
        filters.push([k, v]);
        return chain;
      },
      order: () => chain,
      limit: (n: number) => {
        limitN = n;
        return chain;
      },
      maybeSingle: () =>
        Promise.resolve({ data: rows()[0] ?? null, error: null }),
      insert: (payload: Row) => {
        h.writes.push({ table, op: 'insert', payload });
        return Promise.resolve({ error: null });
      },
      update: (payload: Row) => {
        h.writes.push({ table, op: 'update', payload });
        return {
          eq: () => Promise.resolve({ error: null }),
        };
      },
      then: (resolve: (v: unknown) => void) =>
        resolve({ data: rows().slice(0, limitN ?? undefined), error: null }),
    };
    return chain;
  };
  return { from };
}

vi.mock('@/lib/auth/account', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/account')>();
  const { hasMinRole } = await import('@/lib/auth/roles');
  const ctx = () => ({
    supabase: fakeSupabase(),
    userId: 'user-1',
    accountId: 'acct-1',
    role: h.role,
  });
  return {
    ...actual,
    requireRole: vi.fn(async (min: 'admin' | 'agent') => {
      if (!hasMinRole(h.role, min)) {
        throw new actual.ForbiddenError('requires role');
      }
      return ctx();
    }),
    getCurrentAccount: vi.fn(async () => ctx()),
  };
});

vi.mock('@/lib/whatsapp/encryption', () => ({
  encrypt: (s: string) => `enc(${s})`,
  decrypt: (s: string) => s.replace(/^enc\((.*)\)$/, '$1'),
}));
vi.mock('@/lib/ai/validate', () => ({ validateAiCredentials: h.validate }));
vi.mock('@/lib/ai/plan-gate', async () => {
  const { ForbiddenError } = await import('@/lib/auth/account');
  return {
    hasAiFeature: vi.fn(async () => h.inPlan),
    requireAiFeature: vi.fn(async () => {
      if (!h.inPlan) throw new ForbiddenError('FEATURE_NOT_IN_PLAN');
    }),
  };
});
vi.mock('@/lib/ai/openrouter-models', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/lib/ai/openrouter-models')>();
  return { ...actual, getOpenRouterModels: h.models };
});

import { __resetRateLimitForTests } from '@/lib/rate-limit';
import { GET as getConfig, POST as postConfig } from './config/route';
import { GET as getVersions } from './prompt-versions/route';
import { POST as restore } from './prompt-versions/[id]/restore/route';
import { GET as getModels } from './models/route';

const post = (body: unknown) =>
  new Request('http://x/api/ai/config', {
    method: 'POST',
    body: JSON.stringify(body),
  });

const CONFIG_ROW: Row = {
  account_id: 'acct-1',
  provider: 'openrouter',
  model: 'anthropic/claude-haiku-5.5',
  api_key: 'enc(sk-or-stored)',
  system_prompt: 'Old prompt',
  embeddings_provider: 'openai',
  provider_options: {},
  embeddings_api_key: null,
  is_active: true,
  auto_reply_enabled: false,
  auto_reply_max_per_conversation: 3,
  handoff_agent_id: null,
};

beforeEach(() => {
  h.role = 'admin';
  h.inPlan = true;
  h.tables = {};
  h.writes = [];
  h.validate.mockReset().mockResolvedValue(undefined);
  h.models.mockReset();
  __resetRateLimitForTests();
});
afterEach(() => vi.restoreAllMocks());

describe('POST /api/ai/config — OpenRouter', () => {
  it('accepts openrouter, validates the key, stores it encrypted and never echoes it', async () => {
    const res = await postConfig(
      post({
        provider: 'openrouter',
        model: 'anthropic/claude-haiku-5.5',
        api_key: 'sk-or-secret',
        is_active: true,
      })
    );
    expect(res.status).toBe(200);
    expect(JSON.stringify(await res.json())).not.toContain('sk-or-secret');
    expect(h.validate).toHaveBeenCalledWith({
      provider: 'openrouter',
      model: 'anthropic/claude-haiku-5.5',
      apiKey: 'sk-or-secret',
    });
    const insert = h.writes.find((w) => w.table === 'ai_configs')!;
    expect(insert.op).toBe('insert');
    expect(insert.payload.provider).toBe('openrouter');
    expect(insert.payload.api_key).toBe('enc(sk-or-secret)');
  });

  it('rejects an unknown provider', async () => {
    const res = await postConfig(
      post({ provider: 'nope', model: 'x', api_key: 'k' })
    );
    expect(res.status).toBe(400);
    expect(h.writes).toHaveLength(0);
  });

  it('rejects a bad embeddings_provider', async () => {
    const res = await postConfig(
      post({
        provider: 'openrouter',
        model: 'm',
        api_key: 'k',
        embeddings_provider: 'anthropic',
      })
    );
    expect(res.status).toBe(400);
  });

  it('stores the privacy switch in provider_options (born off: absent = untouched)', async () => {
    h.tables.ai_configs = [CONFIG_ROW];
    await postConfig(
      post({
        provider: 'openrouter',
        model: 'anthropic/claude-haiku-5.5',
        system_prompt: 'Old prompt',
        deny_data_collection: true,
        embeddings_provider: 'openrouter',
      })
    );
    const upd = h.writes.find((w) => w.table === 'ai_configs')!;
    expect(upd.payload.provider_options).toEqual({
      deny_data_collection: true,
    });
    expect(upd.payload.embeddings_provider).toBe('openrouter');

    h.writes = [];
    await postConfig(
      post({
        provider: 'openrouter',
        model: 'anthropic/claude-haiku-5.5',
        system_prompt: 'Old prompt',
      })
    );
    const upd2 = h.writes.find((w) => w.table === 'ai_configs')!;
    expect(upd2.payload).not.toHaveProperty('provider_options');
    expect(upd2.payload).not.toHaveProperty('embeddings_provider');
  });

  it('turning the privacy switch off clears the stored option', async () => {
    h.tables.ai_configs = [
      { ...CONFIG_ROW, provider_options: { deny_data_collection: true } },
    ];
    await postConfig(
      post({
        provider: 'openrouter',
        model: 'anthropic/claude-haiku-5.5',
        system_prompt: 'Old prompt',
        deny_data_collection: false,
      })
    );
    expect(
      h.writes.find((w) => w.table === 'ai_configs')!.payload.provider_options
    ).toEqual({});
  });

  it('only an admin can save', async () => {
    h.role = 'agent';
    const res = await postConfig(
      post({ provider: 'openrouter', model: 'm', api_key: 'k' })
    );
    expect(res.status).toBe(403);
  });
});

describe('POST /api/ai/config — prompt versions', () => {
  const save = (system_prompt: string | null) =>
    postConfig(
      post({
        provider: 'openrouter',
        model: 'anthropic/claude-haiku-5.5',
        system_prompt,
      })
    );
  const versionWrites = () =>
    h.writes.filter((w) => w.table === 'ai_prompt_versions');

  it('records a version when the prompt changes', async () => {
    h.tables.ai_configs = [CONFIG_ROW];
    await save('New prompt');
    expect(versionWrites()).toHaveLength(1);
    expect(versionWrites()[0].payload).toMatchObject({
      account_id: 'acct-1',
      system_prompt: 'New prompt',
      source: 'panel',
      created_by: 'user-1',
    });
  });

  it('records nothing when the prompt did not change (e.g. a toggle save)', async () => {
    h.tables.ai_configs = [CONFIG_ROW];
    await save('  Old prompt  ');
    expect(versionWrites()).toHaveLength(0);
  });

  it('records the first prompt of a new config, but nothing for an empty one', async () => {
    await postConfig(
      post({
        provider: 'openrouter',
        model: 'm',
        api_key: 'k',
        system_prompt: 'First',
      })
    );
    expect(versionWrites()).toHaveLength(1);

    h.writes = [];
    h.tables = {};
    await postConfig(
      post({ provider: 'openrouter', model: 'm', api_key: 'k' })
    );
    expect(versionWrites()).toHaveLength(0);
  });

  it('records the cleared prompt as an empty version', async () => {
    h.tables.ai_configs = [CONFIG_ROW];
    await save(null);
    expect(versionWrites()[0].payload.system_prompt).toBe('');
  });
});

describe('GET /api/ai/config', () => {
  it('returns the options without the keys', async () => {
    h.tables.ai_configs = [
      {
        ...CONFIG_ROW,
        embeddings_api_key: 'enc(sk-emb)',
        provider_options: { deny_data_collection: true },
      },
    ];
    const body = await (await getConfig()).json();
    expect(body).toMatchObject({
      configured: true,
      provider: 'openrouter',
      has_key: true,
      has_embeddings_key: true,
      embeddings_provider: 'openai',
      deny_data_collection: true,
    });
    expect(JSON.stringify(body)).not.toContain('sk-or-stored');
    expect(JSON.stringify(body)).not.toContain('sk-emb');
    expect(body).not.toHaveProperty('api_key');
    expect(body).not.toHaveProperty('provider_options');
  });
});

describe('prompt versions list + restore', () => {
  const V = {
    id: 'v1',
    account_id: 'acct-1',
    system_prompt: 'Older prompt',
    note: null,
    source: 'panel',
    created_by: 'user-1',
    created_at: '2026-11-26T10:00:00Z',
  };
  const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
  const req = new Request('http://x', { method: 'POST' });

  it('lists the account versions (admin only)', async () => {
    h.tables.ai_prompt_versions = [V, { ...V, id: 'other', account_id: 'b' }];
    const body = await (await getVersions()).json();
    expect(body.versions.map((v: Row) => v.id)).toEqual(['v1']);

    h.role = 'agent';
    expect((await getVersions()).status).toBe(403);
  });

  it('restores: updates the prompt and appends a NEW version noted with the origin', async () => {
    h.tables.ai_prompt_versions = [V];
    h.tables.ai_configs = [CONFIG_ROW];
    const res = await restore(req, ctx('v1'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, changed: true });
    const upd = h.writes.find((w) => w.table === 'ai_configs')!;
    expect(upd.payload).toEqual({ system_prompt: 'Older prompt' });
    const ver = h.writes.find((w) => w.table === 'ai_prompt_versions')!;
    expect(ver.op).toBe('insert');
    expect(ver.payload).toMatchObject({
      system_prompt: 'Older prompt',
      note: 'restore:v1',
    });
  });

  it('is a no-op when the version equals the live prompt', async () => {
    h.tables.ai_prompt_versions = [{ ...V, system_prompt: 'Old prompt' }];
    h.tables.ai_configs = [CONFIG_ROW];
    const res = await restore(req, ctx('v1'));
    expect(await res.json()).toEqual({ success: true, changed: false });
    expect(h.writes).toHaveLength(0);
  });

  it('404 for a version of another account, 400 without a config', async () => {
    h.tables.ai_prompt_versions = [{ ...V, account_id: 'other-acct' }];
    h.tables.ai_configs = [CONFIG_ROW];
    expect((await restore(req, ctx('v1'))).status).toBe(404);

    h.tables.ai_prompt_versions = [V];
    h.tables.ai_configs = [];
    expect((await restore(req, ctx('v1'))).status).toBe(400);
  });

  it('only an admin can restore', async () => {
    h.role = 'agent';
    expect((await restore(req, ctx('v1'))).status).toBe(403);
  });
});

describe('GET /api/ai/models', () => {
  const get = (qs: string) =>
    getModels(new Request(`http://x/api/ai/models${qs}`));

  it('suggests models from the catalog, filtered by q', async () => {
    h.models.mockResolvedValue([
      {
        id: 'anthropic/claude-haiku-5.5',
        name: 'Haiku',
        contextLength: 1,
        supportsTools: true,
        promptPricePerM: 0.1,
        completionPricePerM: 0.5,
      },
      {
        id: 'x/other',
        name: 'Other',
        contextLength: 1,
        supportsTools: false,
        promptPricePerM: 1,
        completionPricePerM: 1,
      },
    ]);
    const res = await get('?provider=openrouter&q=haiku');
    const body = await res.json();
    expect(body.models.map((m: Row) => m.id)).toEqual([
      'anthropic/claude-haiku-5.5',
    ]);
  });

  it('only openrouter has a catalog', async () => {
    expect((await get('?provider=openai')).status).toBe(400);
    expect((await get('')).status).toBe(400);
  });

  it('answers 502 (not a stack trace) when the catalog is down', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    h.models.mockRejectedValue(new Error('boom'));
    const res = await get('?provider=openrouter');
    expect(res.status).toBe(502);
    expect(JSON.stringify(await res.json())).not.toContain('boom');
  });
});

describe('portão ai_enabled estrito (SPEC 089 D-20)', () => {
  const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

  it('GET /api/ai/config responde 200 com feature_in_plan:false, sem ler a config', async () => {
    h.inPlan = false;
    h.tables.ai_configs = [CONFIG_ROW];
    const res = await getConfig();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      configured: false,
      feature_in_plan: false,
    });
  });

  it('as rotas que mudam ou usam a IA respondem 403 FEATURE_NOT_IN_PLAN', async () => {
    h.inPlan = false;
    h.tables.ai_configs = [CONFIG_ROW];
    h.tables.ai_prompt_versions = [
      { id: 'v1', account_id: 'acct-1', system_prompt: 'x' },
    ];
    const responses = [
      await postConfig(
        post({ provider: 'openrouter', model: 'm', api_key: 'k' })
      ),
      await getVersions(),
      await restore(new Request('http://x', { method: 'POST' }), ctx('v1')),
      await getModels(
        new Request('http://x/api/ai/models?provider=openrouter')
      ),
    ];
    for (const res of responses) {
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: 'FEATURE_NOT_IN_PLAN' });
    }
    expect(h.writes).toHaveLength(0);
    expect(h.validate).not.toHaveBeenCalled();
  });

  it('plano com a chave segue normalmente', async () => {
    h.inPlan = true;
    h.tables.ai_configs = [CONFIG_ROW];
    expect((await getConfig()).status).toBe(200);
    expect((await getVersions()).status).toBe(200);
  });
});
