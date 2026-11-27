import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { fakeDb, type Row } from '@/lib/ai/tools/test-fake-db';

// SPEC 089 F5 — `/api/ai/tools`: the admin's switches and allow-lists. The
// route is real; the database is the in-memory two-account fake, so a list
// that points at another tenant's row is refused for real.

const A = 'aaaaaaaa-0000-4000-8000-000000000001';
const B = 'bbbbbbbb-0000-4000-8000-000000000002';
const TAG_A = 'aaaaaaaa-5555-4000-8000-000000000001';
const TAG_B = 'bbbbbbbb-5555-4000-8000-000000000002';
const PIPE_A = 'aaaaaaaa-4444-4000-8000-000000000001';
const PIPE_B = 'bbbbbbbb-4444-4000-8000-000000000002';
const STAGE_A = 'aaaaaaaa-6666-4000-8000-000000000001';
const STAGE_B = 'bbbbbbbb-6666-4000-8000-000000000002';
const FIELD_A = 'aaaaaaaa-3333-4000-8000-000000000001';
const FIELD_B = 'bbbbbbbb-3333-4000-8000-000000000002';

const h = vi.hoisted(() => ({
  role: 'admin' as 'admin' | 'agent',
  inPlan: true,
  db: null as unknown as SupabaseClient,
}));

vi.mock('@/lib/auth/account', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/account')>();
  const { hasMinRole } = await import('@/lib/auth/roles');
  return {
    ...actual,
    requireRole: vi.fn(async (min: 'admin' | 'agent') => {
      if (!hasMinRole(h.role, min))
        throw new actual.ForbiddenError('requires role');
      return { supabase: h.db, userId: 'user-1', accountId: A, role: h.role };
    }),
  };
});

vi.mock('@/lib/ai/plan-gate', async () => {
  const { ForbiddenError } = await import('@/lib/auth/account');
  return {
    requireAiFeature: vi.fn(async () => {
      if (!h.inPlan) throw new ForbiddenError('FEATURE_NOT_IN_PLAN');
    }),
  };
});

vi.mock('@/lib/rate-limit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/rate-limit')>()),
  checkRateLimit: () => ({ success: true }),
}));

import { GET, PUT } from './route';

function seed(
  over: Partial<Record<string, Row[]>> = {}
): Record<string, Row[]> {
  return {
    ai_configs: [{ id: 'cfg-a', account_id: A, tools_config: {} }],
    tags: [
      { id: TAG_A, account_id: A, name: 'VIP' },
      { id: TAG_B, account_id: B, name: 'VIP' },
    ],
    pipelines: [
      { id: PIPE_A, account_id: A, name: 'Vendas' },
      { id: PIPE_B, account_id: B, name: 'Vendas' },
    ],
    pipeline_stages: [
      { id: STAGE_A, pipeline_id: PIPE_A, name: 'Novo', position: 0 },
      { id: STAGE_B, pipeline_id: PIPE_B, name: 'Novo', position: 0 },
    ],
    custom_fields: [
      { id: FIELD_A, account_id: A, field_name: 'CPF' },
      { id: FIELD_B, account_id: B, field_name: 'CPF' },
    ],
    ...over,
  } as Record<string, Row[]>;
}

const put = (body: unknown) =>
  PUT(
    new Request('http://test/api/ai/tools', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  );

let writes: ReturnType<typeof fakeDb>['writes'];
let tables: ReturnType<typeof fakeDb>['tables'];

function use(data: Record<string, Row[]>) {
  const f = fakeDb(data);
  h.db = f.db;
  writes = f.writes;
  tables = f.tables;
}

beforeEach(() => {
  h.role = 'admin';
  h.inPlan = true;
  use(seed());
});

describe('GET /api/ai/tools', () => {
  it('returns the catalog and the stored config, normalized (unknown keys dropped)', async () => {
    tables.ai_configs[0].tools_config = {
      add_contact_tags: { enabled: true, tag_ids: [TAG_A] },
      made_up_tool: { enabled: true },
    };
    const res = await GET();
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.configured).toBe(true);
    expect(body.migration_pending).toBe(false);
    expect(body.write_calls_per_conversation).toBe(10);
    expect(body.tools_config).toEqual({
      add_contact_tags: { enabled: true, tag_ids: [TAG_A] },
    });
    expect(body.catalog.map((c: { key: string }) => c.key)).toContain(
      'handoff_to_human'
    );
    expect(
      body.catalog.find((c: { key: string }) => c.key === 'create_deal').risk
    ).toBe('write');
  });

  it('is admin-only and needs the plan feature', async () => {
    h.role = 'agent';
    expect((await GET()).status).toBe(403);
    h.role = 'admin';
    h.inPlan = false;
    expect((await GET()).status).toBe(403);
  });
});

describe('PUT /api/ai/tools', () => {
  it('stores lists that belong to THIS account, scoped by account on the update', async () => {
    const res = await put({
      tools_config: {
        add_contact_tags: { enabled: true, tag_ids: [TAG_A] },
        create_deal: {
          enabled: true,
          pipeline_ids: [PIPE_A],
          stage_ids: [STAGE_A],
        },
        update_contact_fields: {
          enabled: true,
          writable_fields: ['email', `custom:${FIELD_A}`],
        },
      },
    });
    expect(res.status).toBe(200);
    const update = writes.find((w) => w.op === 'update')!;
    expect(update.table).toBe('ai_configs');
    expect(update.filters).toContainEqual({
      op: 'eq',
      column: 'account_id',
      value: A,
    });
    expect(tables.ai_configs[0].tools_config).toEqual({
      add_contact_tags: { enabled: true, tag_ids: [TAG_A] },
      create_deal: {
        enabled: true,
        pipeline_ids: [PIPE_A],
        stage_ids: [STAGE_A],
      },
      update_contact_fields: {
        enabled: true,
        writable_fields: ['email', `custom:${FIELD_A}`],
      },
    });
  });

  it("refuses a list that points at ANOTHER account's tag, funnel, stage or field (nothing stored)", async () => {
    const cases: Record<string, unknown>[] = [
      { add_contact_tags: { enabled: true, tag_ids: [TAG_A, TAG_B] } },
      { create_deal: { enabled: true, pipeline_ids: [PIPE_B], stage_ids: [] } },
      {
        create_deal: {
          enabled: true,
          pipeline_ids: [PIPE_A],
          stage_ids: [STAGE_B],
        },
      },
      {
        update_contact_fields: {
          enabled: true,
          writable_fields: [`custom:${FIELD_B}`],
        },
      },
      {
        get_contact_profile: {
          enabled: true,
          visible_fields: [`custom:${FIELD_B}`],
        },
      },
    ];
    for (const tools_config of cases) {
      const res = await put({ tools_config });
      expect(res.status, JSON.stringify(tools_config)).toBe(400);
      expect((await res.json()).code).toBe('invalid_reference');
    }
    expect(writes).toHaveLength(0);
    expect(tables.ai_configs[0].tools_config).toEqual({});
  });

  it('refuses an unknown tool and a malformed body', async () => {
    const unknown = await put({ tools_config: { rm_rf: { enabled: true } } });
    expect(unknown.status).toBe(400);
    expect((await unknown.json()).code).toBe('unknown_tool');
    expect((await put({ tools_config: [] })).status).toBe(400);
    expect((await put({})).status).toBe(400);
    expect(writes).toHaveLength(0);
  });

  it('a tool is only ON with an explicit true; junk lists are dropped, never widened', async () => {
    await put({
      tools_config: {
        add_contact_tags: { enabled: 'yes', tag_ids: ['not-a-uuid', TAG_A] },
      },
    });
    expect(tables.ai_configs[0].tools_config).toEqual({
      add_contact_tags: { enabled: false, tag_ids: [TAG_A] },
    });
  });

  it('is admin-only and needs the plan feature', async () => {
    h.role = 'agent';
    expect((await put({ tools_config: {} })).status).toBe(403);
    h.role = 'admin';
    h.inPlan = false;
    expect((await put({ tools_config: {} })).status).toBe(403);
    expect(writes).toHaveLength(0);
  });

  it('an account without an agent configured gets 409, not a silent success', async () => {
    use(seed({ ai_configs: [] }));
    const res = await put({
      tools_config: { search_knowledge: { enabled: true } },
    });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('ai_not_configured');
  });
});
