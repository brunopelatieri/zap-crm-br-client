import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { fakeDb, type Row } from '@/lib/ai/tools/test-fake-db';

// SPEC 089 F6 — `/api/ai/custom-tools`: the routes are real; the database is
// the in-memory two-account fake and the encryption is the real AES-GCM.

const A = 'aaaaaaaa-0000-4000-8000-000000000001';
const B = 'bbbbbbbb-0000-4000-8000-000000000002';
const TOOL_A = 'aaaaaaaa-7777-4000-8000-000000000001';
const TOOL_B = 'bbbbbbbb-7777-4000-8000-000000000002';
const SECRET = 'Bearer sk_live_SUPER_SECRET_TOKEN_123';

const h = vi.hoisted(() => ({
  role: 'admin' as 'admin' | 'agent',
  inPlan: true,
  db: null as unknown as SupabaseClient,
  deliverable: true,
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

vi.mock('@/lib/ai/admin-client', () => ({ supabaseAdmin: () => h.db }));
vi.mock('@/lib/webhooks/ssrf', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/webhooks/ssrf')>()),
  isDeliverableUrl: async () => h.deliverable,
}));
vi.mock('@/lib/rate-limit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/rate-limit')>()),
  checkRateLimit: () => ({ success: true }),
}));

import { decrypt, encrypt } from '@/lib/whatsapp/encryption';
import { GET, POST } from './route';
import { DELETE, PATCH } from './[id]/route';
import { POST as TEST } from './[id]/test/route';

function toolRow(id: string, account: string, over: Row = {}): Row {
  return {
    id,
    account_id: account,
    name: id === TOOL_A ? 'check_stock' : 'other_tool',
    description: 'Check the stock of a product by its SKU.',
    input_schema: {
      type: 'object',
      properties: { sku: { type: 'string', maxLength: 200 } },
      required: ['sku'],
      additionalProperties: false,
    },
    url: 'https://api.shop.example/v1/stock?channel=wa',
    method: 'POST',
    risk: 'write',
    header_names: ['Authorization'],
    headers_encrypted: encrypt(JSON.stringify({ Authorization: SECRET })),
    timeout_ms: 8000,
    is_active: false,
    created_at: '2026-11-27T10:00:00Z',
    updated_at: '2026-11-27T10:00:00Z',
    ...over,
  };
}

let tables: Record<string, Row[]>;

beforeEach(() => {
  h.role = 'admin';
  h.inPlan = true;
  h.deliverable = true;
  const fake = fakeDb({
    ai_custom_tools: [toolRow(TOOL_A, A), toolRow(TOOL_B, B)],
  });
  h.db = fake.db;
  tables = fake.tables;
});

const json = (body: unknown, method = 'POST') =>
  new Request('http://localhost/api/ai/custom-tools', {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
const params = (id: string) => ({ params: Promise.resolve({ id }) });

const NEW_TOOL = {
  name: 'lookup_order',
  description: 'Look an order up by its number.',
  input_schema: {
    type: 'object',
    properties: { order: { type: 'string' } },
    required: ['order'],
  },
  url: 'https://api.shop.example/v1/orders',
  method: 'GET',
  risk: 'read',
  headers: [{ name: 'X-Api-Key', value: 'key-9f8e7d6c' }],
};

describe('GET /api/ai/custom-tools', () => {
  it("lists the account's tools, with header names and no value", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.tools.map((t: { id: string }) => t.id)).toEqual([TOOL_A]);
    expect(body.tools[0].header_names).toEqual(['Authorization']);
    expect(body.tools[0].has_headers).toBe(true);
    expect(body.max_tools).toBe(20);
    const text = JSON.stringify(body);
    expect(text).not.toContain('SUPER_SECRET');
    expect(text).not.toContain('headers_encrypted');
  });

  it('only admin and above (an agent gets 403) and only with ai_enabled', async () => {
    h.role = 'agent';
    expect((await GET()).status).toBe(403);
    h.role = 'admin';
    h.inPlan = false;
    expect((await GET()).status).toBe(403);
  });
});

describe('POST /api/ai/custom-tools', () => {
  it('creates the tool OFF; the response and the table never expose the header value', async () => {
    const res = await POST(json(NEW_TOOL));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.tool.is_active).toBe(false);
    expect(body.tool.header_names).toEqual(['X-Api-Key']);
    expect(JSON.stringify(body)).not.toContain('key-9f8e7d6c');

    const stored = tables.ai_custom_tools.find(
      (t) => t.name === 'lookup_order'
    )!;
    expect(stored.account_id).toBe(A);
    expect(stored.headers_encrypted).not.toContain('key-9f8e7d6c');
    expect(JSON.parse(decrypt(stored.headers_encrypted as string))).toEqual({
      'X-Api-Key': 'key-9f8e7d6c',
    });
  });

  it('refuses a built-in name, an internal url, a secret in the url', async () => {
    for (const [over, code] of [
      [{ name: 'create_deal' }, 'name_reserved'],
      [{ url: 'https://127.0.0.1/x' }, 'url_blocked'],
      [{ url: 'https://api.shop.example/x?api_key=1' }, 'url_secret'],
    ] as const) {
      const res = await POST(json({ ...NEW_TOOL, ...over }));
      expect(res.status).toBe(400);
      expect((await res.json()).code).toBe(code);
    }
  });

  it('refuses a host the DNS guard blocks (resolves to an internal address)', async () => {
    h.deliverable = false;
    const res = await POST(json(NEW_TOOL));
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('url_blocked');
  });

  it('an agent cannot create; a body that is not an object is a 400', async () => {
    h.role = 'agent';
    expect((await POST(json(NEW_TOOL))).status).toBe(403);
    h.role = 'admin';
    expect((await POST(json([1]))).status).toBe(400);
  });

  it('error messages are in English and never echo the database', async () => {
    const res = await POST(json({ ...NEW_TOOL, name: 'AB' }));
    const body = await res.json();
    expect(body.error).toMatch(/snake_case/);
  });
});

describe('PATCH / DELETE / test', () => {
  it('turns the tool on; the response has no secret', async () => {
    const res = await PATCH(json({ is_active: true }, 'PATCH'), params(TOOL_A));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.tool.is_active).toBe(true);
    expect(JSON.stringify(body)).not.toContain('SUPER_SECRET');
  });

  it("another account's tool is a 404 for every verb, and stays untouched", async () => {
    expect(
      (await PATCH(json({ is_active: true }, 'PATCH'), params(TOOL_B))).status
    ).toBe(404);
    expect((await DELETE(json({}, 'DELETE'), params(TOOL_B))).status).toBe(404);
    expect(
      (await TEST(json({ arguments: { sku: 'x' } }), params(TOOL_B))).status
    ).toBe(404);
    const b = tables.ai_custom_tools.find((t) => t.id === TOOL_B)!;
    expect(b.is_active).toBe(false);
  });

  it('a malformed id is a 404', async () => {
    expect((await PATCH(json({}, 'PATCH'), params('not-a-uuid'))).status).toBe(
      404
    );
  });

  it('delete works even when the plan lost ai_enabled (cleanup)', async () => {
    h.inPlan = false;
    const res = await DELETE(json({}, 'DELETE'), params(TOOL_A));
    expect(res.status).toBe(200);
    expect(tables.ai_custom_tools.map((t) => t.id)).toEqual([TOOL_B]);
  });

  it('the test is a simulation: method, origin only, arguments; called false; no header', async () => {
    const res = await TEST(
      json({ arguments: { sku: 'A1', url: 'http://evil.test' } }),
      params(TOOL_A)
    );
    expect(res.status).toBe(200);
    const { simulation } = await res.json();
    expect(simulation).toMatchObject({
      called: false,
      would_call: {
        method: 'POST',
        url: 'https://api.shop.example/…',
        arguments: { sku: 'A1' },
      },
    });
    expect(JSON.stringify(simulation)).not.toContain('SUPER_SECRET');
    expect(JSON.stringify(simulation)).not.toContain('/v1/stock');
  });

  it('the test validates the arguments (400) and an agent cannot run it', async () => {
    const bad = await TEST(json({ arguments: {} }), params(TOOL_A));
    expect(bad.status).toBe(400);
    expect((await bad.json()).code).toBe('invalid_arguments');
    h.role = 'agent';
    expect(
      (await TEST(json({ arguments: { sku: 'x' } }), params(TOOL_A))).status
    ).toBe(403);
  });
});
