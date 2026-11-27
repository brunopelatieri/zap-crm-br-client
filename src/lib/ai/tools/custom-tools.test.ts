import { describe, expect, it, vi } from 'vitest';
import { decrypt, encrypt } from '@/lib/whatsapp/encryption';
import {
  createCustomTool,
  deleteCustomTool,
  listCustomTools,
  loadCustomToolsForTurn,
  simulateCustomTool,
  updateCustomTool,
  validateName,
  validateToolUrl,
  type CustomToolsDeps,
} from './custom-tools';
import { TOOL_KEYS } from './types';
import { fakeDb, type Row } from './test-fake-db';

// The service layer against an in-memory two-account database. Real
// AES-GCM (`encryption.ts`, the test key) so "the headers are ciphertext at
// rest and no view returns them" is proved against the real mechanism.

const A = 'aaaaaaaa-0000-4000-8000-00000000000a';
const B = 'bbbbbbbb-0000-4000-8000-00000000000b';
const USER = 'uuuuuuuu-0000-4000-8000-000000000001';

const SECRET = 'Bearer sk_live_SUPER_SECRET_TOKEN_123';

const SCHEMA = {
  type: 'object',
  properties: { sku: { type: 'string' } },
  required: ['sku'],
};

function deps(
  seed: Record<string, Row[]> = {},
  isDeliverable = async () => true
) {
  const fake = fakeDb(seed);
  const d: CustomToolsDeps = {
    db: fake.db,
    encrypt,
    decrypt,
    isDeliverable,
  };
  return { ...fake, d };
}

const valid = (over: Record<string, unknown> = {}) => ({
  name: 'check_stock',
  description: 'Check the stock of a product by its SKU.',
  input_schema: SCHEMA,
  url: 'https://api.shop.example/v1/stock',
  method: 'POST',
  headers: [{ name: 'Authorization', value: SECRET }],
  ...over,
});

function row(over: Row = {}): Row {
  return {
    id: 'tool-a1',
    account_id: A,
    name: 'check_stock',
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
    is_active: true,
    created_at: '2026-11-27T10:00:00Z',
    updated_at: '2026-11-27T10:00:00Z',
    ...over,
  };
}

describe('validateName', () => {
  it('accepts snake_case', () => {
    expect(validateName('check_stock')).toEqual({
      ok: true,
      name: 'check_stock',
    });
  });

  it.each([
    'ab',
    'Check',
    '1abc',
    'a-b-c',
    'a b c',
    'x'.repeat(49),
    '',
    5,
    null,
  ])('rejects %j', (raw) => {
    expect(validateName(raw).ok).toBe(false);
  });

  it.each([...TOOL_KEYS])('COLLISION: %s belongs to a built-in tool', (key) => {
    expect(validateName(key)).toMatchObject({
      ok: false,
      code: 'name_reserved',
    });
  });
});

describe('validateToolUrl', () => {
  const ok = async () => true;

  it('accepts a public https url and drops the fragment', async () => {
    expect(
      await validateToolUrl('https://api.shop.example/v1/x?a=1#f', ok)
    ).toEqual({
      ok: true,
      url: 'https://api.shop.example/v1/x?a=1',
    });
  });

  it.each([
    [
      'http (clear text carries the secret headers)',
      'http://api.shop.example/x',
    ],
    ['credentials in the url', 'https://u:p@api.shop.example/x'],
    ['loopback', 'https://127.0.0.1/x'],
    ['metadata ip', 'https://169.254.169.254/latest'],
    ['private ip', 'https://10.0.0.8/x'],
    ['ipv6 mapped loopback', 'https://[::ffff:7f00:1]/x'],
    ['unusual port', 'https://api.shop.example:3306/x'],
    ['not a url', 'api.shop.example'],
  ])('rejects %s', async (_l, url) => {
    const r = await validateToolUrl(url, ok);
    expect(r.ok).toBe(false);
  });

  it.each([
    'api_key',
    'apikey',
    'token',
    'access_token',
    'key',
    'secret',
    'password',
    'auth',
    'signature',
  ])('rejects a secret in the query string (?%s=)', async (param) => {
    const r = await validateToolUrl(
      `https://api.shop.example/x?${param}=abc`,
      ok
    );
    expect(r).toMatchObject({ ok: false, code: 'url_secret' });
  });

  it('rejects a host the DNS guard refuses (resolves to an internal address / unresolvable)', async () => {
    const r = await validateToolUrl(
      'https://internal.shop.example/x',
      async () => false
    );
    expect(r).toMatchObject({ ok: false, code: 'url_blocked' });
  });

  it('allows ordinary query parameters', async () => {
    expect(
      (
        await validateToolUrl(
          'https://api.shop.example/x?channel=wa&format=json',
          ok
        )
      ).ok
    ).toBe(true);
  });
});

describe('createCustomTool', () => {
  it('creates the tool OFF and `write`, headers encrypted at rest, view without secret', async () => {
    const { d, tables } = deps();
    const r = await createCustomTool(d, A, USER, valid());
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const stored = tables.ai_custom_tools[0];
    expect(stored.is_active).toBe(false);
    expect(stored.risk).toBe('write');
    expect(stored.account_id).toBe(A);
    expect(stored.created_by).toBe(USER);
    expect(stored.header_names).toEqual(['Authorization']);
    // Ciphertext at rest: no plaintext, GCM format, decrypts back.
    const cipher = stored.headers_encrypted as string;
    expect(cipher).not.toContain('SUPER_SECRET');
    expect(cipher).toMatch(/^[0-9a-f]{24}:[0-9a-f]+:[0-9a-f]{32}$/);
    expect(JSON.parse(decrypt(cipher))).toEqual({ Authorization: SECRET });

    // The view: names and a flag, never a value.
    expect(r.value.header_names).toEqual(['Authorization']);
    expect(r.value.has_headers).toBe(true);
    const text = JSON.stringify(r.value);
    expect(text).not.toContain('SUPER_SECRET');
    expect(text).not.toContain('headers_encrypted');
    expect(r.value.is_active).toBe(false);
  });

  it('a tool without headers stores no cipher', async () => {
    const { d, tables } = deps();
    const r = await createCustomTool(d, A, USER, valid({ headers: undefined }));
    expect(r.ok).toBe(true);
    expect(tables.ai_custom_tools[0].headers_encrypted).toBeNull();
    expect(tables.ai_custom_tools[0].header_names).toEqual([]);
  });

  it('refuses a name that collides with a built-in tool', async () => {
    const { d, tables } = deps();
    const r = await createCustomTool(
      d,
      A,
      USER,
      valid({ name: 'add_contact_tags' })
    );
    expect(r).toMatchObject({ ok: false, status: 400, code: 'name_reserved' });
    expect(tables.ai_custom_tools ?? []).toHaveLength(0);
  });

  it.each([
    ['bad description', { description: 'short' }, 'invalid_description'],
    ['bad schema', { input_schema: { type: 'array' } }, 'invalid_schema'],
    [
      'identity field in the schema',
      {
        input_schema: {
          type: 'object',
          properties: { contact_id: { type: 'string' } },
        },
      },
      'invalid_schema',
    ],
    ['bad method', { method: 'DELETE' }, 'invalid_method'],
    ['bad risk', { risk: 'danger' }, 'invalid_risk'],
    ['timeout over 10 s', { timeout_ms: 30_000 }, 'invalid_timeout'],
    ['timeout under 1 s', { timeout_ms: 100 }, 'invalid_timeout'],
    [
      'forbidden header',
      { headers: [{ name: 'Host', value: 'evil' }] },
      'invalid_headers',
    ],
    [
      'header without a value',
      { headers: [{ name: 'X-Key' }] },
      'invalid_headers',
    ],
    [
      'CRLF in a header value',
      { headers: [{ name: 'X-Key', value: 'a\r\nB: c' }] },
      'invalid_headers',
    ],
    ['internal url', { url: 'https://10.1.1.1/x' }, 'url_blocked'],
    [
      'secret in the url',
      { url: 'https://api.shop.example/x?token=abc' },
      'url_secret',
    ],
  ])('rejects %s', async (_l, over, code) => {
    const { d, tables } = deps();
    const r = await createCustomTool(d, A, USER, valid(over));
    expect(r).toMatchObject({ ok: false, status: 400, code });
    expect(tables.ai_custom_tools ?? []).toHaveLength(0);
  });

  it('accepts `read` and a GET', async () => {
    const { d } = deps();
    const r = await createCustomTool(
      d,
      A,
      USER,
      valid({ risk: 'read', method: 'GET' })
    );
    expect(r).toMatchObject({
      ok: true,
      value: { risk: 'read', method: 'GET' },
    });
  });

  it('maps the database errors: unique name, per-account cap, missing migration', async () => {
    const fail = (error: unknown): CustomToolsDeps => ({
      ...deps().d,
      db: {
        from: () => ({
          insert: () => ({
            select: () => ({ single: async () => ({ data: null, error }) }),
          }),
        }),
      } as never,
    });
    expect(
      await createCustomTool(fail({ code: '23505' }), A, USER, valid())
    ).toMatchObject({ ok: false, status: 409, code: 'name_taken' });
    expect(
      await createCustomTool(
        fail({ code: 'P0001', message: 'AI_CUSTOM_TOOL_LIMIT:20' }),
        A,
        USER,
        valid()
      )
    ).toMatchObject({ ok: false, status: 409, code: 'limit_reached' });
    expect(
      await createCustomTool(fail({ code: 'PGRST205' }), A, USER, valid())
    ).toMatchObject({ ok: false, status: 409, code: 'migration_pending' });
    const generic = await createCustomTool(
      fail({ code: 'XX000', message: 'column secret_x leaked' }),
      A,
      USER,
      valid()
    );
    expect(generic).toMatchObject({
      ok: false,
      status: 500,
      code: 'database_error',
    });
    expect(JSON.stringify(generic)).not.toContain('secret_x');
  });
});

describe('listCustomTools / isolation between accounts', () => {
  const seed = () => ({
    ai_custom_tools: [
      row(),
      row({ id: 'tool-b1', account_id: B, name: 'other_tool' }),
    ],
  });

  it('lists only the caller account, never a secret', async () => {
    const { d } = deps(seed());
    const r = await listCustomTools(d.db, A);
    expect(r.ok && r.value.map((t) => t.id)).toEqual(['tool-a1']);
    expect(JSON.stringify(r)).not.toContain('SUPER_SECRET');
    expect(JSON.stringify(r)).not.toContain('headers_encrypted');
  });

  it('account A cannot update, delete or simulate the tool of account B', async () => {
    const { d, tables } = deps(seed());
    expect(
      await updateCustomTool(d, A, 'tool-b1', { is_active: false })
    ).toMatchObject({ ok: false, status: 404 });
    expect(
      await updateCustomTool(d, A, 'tool-b1', {
        headers: [{ name: 'Authorization' }],
      })
    ).toMatchObject({ ok: false, status: 404 });
    expect(await deleteCustomTool(d.db, A, 'tool-b1')).toMatchObject({
      ok: false,
      status: 404,
    });
    expect(
      await simulateCustomTool(d.db, A, 'tool-b1', { sku: 'x' })
    ).toMatchObject({ ok: false, status: 404 });
    const b = tables.ai_custom_tools.find((t) => t.id === 'tool-b1')!;
    expect(b.is_active).toBe(true);
    expect(tables.ai_custom_tools).toHaveLength(2);
  });

  it('delete removes the tool of the account', async () => {
    const { d, tables } = deps(seed());
    expect(await deleteCustomTool(d.db, A, 'tool-a1')).toMatchObject({
      ok: true,
    });
    expect(tables.ai_custom_tools.map((t) => t.id)).toEqual(['tool-b1']);
  });
});

describe('updateCustomTool', () => {
  it('turns a tool on and off', async () => {
    const { d, tables } = deps({
      ai_custom_tools: [row({ is_active: false })],
    });
    const r = await updateCustomTool(d, A, 'tool-a1', { is_active: true });
    expect(r).toMatchObject({ ok: true, value: { is_active: true } });
    expect(tables.ai_custom_tools[0].is_active).toBe(true);
  });

  it('headers: a value left out is KEPT (the screen never has it), a new one replaces, others are removed', async () => {
    const original = row({
      header_names: ['Authorization', 'X-Old'],
      headers_encrypted: encrypt(
        JSON.stringify({ Authorization: SECRET, 'X-Old': 'old-value' })
      ),
    });
    const { d, tables } = deps({ ai_custom_tools: [original] });
    const r = await updateCustomTool(d, A, 'tool-a1', {
      headers: [
        { name: 'Authorization' },
        { name: 'X-New', value: 'new-value' },
      ],
    });
    expect(r).toMatchObject({
      ok: true,
      value: { header_names: ['Authorization', 'X-New'] },
    });
    const stored = JSON.parse(
      decrypt(tables.ai_custom_tools[0].headers_encrypted as string)
    );
    expect(stored).toEqual({ Authorization: SECRET, 'X-New': 'new-value' });
    expect(JSON.stringify(r)).not.toContain('SUPER_SECRET');
    expect(JSON.stringify(r)).not.toContain('new-value');
  });

  it('headers: [] clears them', async () => {
    const { d, tables } = deps({ ai_custom_tools: [row()] });
    const r = await updateCustomTool(d, A, 'tool-a1', { headers: [] });
    expect(r).toMatchObject({ ok: true, value: { has_headers: false } });
    expect(tables.ai_custom_tools[0].headers_encrypted).toBeNull();
    expect(tables.ai_custom_tools[0].header_names).toEqual([]);
  });

  it('keeping a header whose cipher cannot be read is refused with a generic message', async () => {
    const { d } = deps({
      ai_custom_tools: [row({ headers_encrypted: 'aa:bb:cc' })],
    });
    const r = await updateCustomTool(d, A, 'tool-a1', {
      headers: [{ name: 'Authorization' }],
    });
    expect(r).toMatchObject({
      ok: false,
      status: 409,
      code: 'headers_unreadable',
    });
  });

  it('SECRET REDIRECT: a new host with stored headers needs every value typed again', async () => {
    const { d, tables } = deps({ ai_custom_tools: [row()] });
    const original = tables.ai_custom_tools[0].headers_encrypted;
    // Only the url: the stored secret would follow to the new host.
    expect(
      await updateCustomTool(d, A, 'tool-a1', {
        url: 'https://evil.example/collect',
      })
    ).toMatchObject({ ok: false, status: 400, code: 'headers_required' });
    // Keep-value: same hole by another door.
    expect(
      await updateCustomTool(d, A, 'tool-a1', {
        url: 'https://evil.example/collect',
        headers: [{ name: 'Authorization' }],
      })
    ).toMatchObject({ ok: false, code: 'headers_required' });
    expect(tables.ai_custom_tools[0].url).toContain('api.shop.example');
    expect(tables.ai_custom_tools[0].headers_encrypted).toBe(original);
    // Retyped values, or an explicit clear, are allowed.
    expect(
      await updateCustomTool(d, A, 'tool-a1', {
        url: 'https://other.example/v1',
        headers: [{ name: 'Authorization', value: 'Bearer new-token-123' }],
      })
    ).toMatchObject({ ok: true });
    expect(
      await updateCustomTool(d, A, 'tool-a1', {
        url: 'https://third.example/v1',
        headers: [],
      })
    ).toMatchObject({ ok: true, value: { has_headers: false } });
  });

  it.each([
    ['only the path', { url: 'https://api.shop.example/v2/stock?channel=wa' }],
    [
      'only the query',
      { url: 'https://api.shop.example/v1/stock?channel=other' },
    ],
    ['the query removed', { url: 'https://api.shop.example/v1/stock' }],
    ['only the method', { method: 'GET' }],
  ])(
    'SECRET REUSE: changing %s needs every header value typed again',
    async (_label, change) => {
      const { d, tables } = deps({ ai_custom_tools: [row()] });
      const original = tables.ai_custom_tools[0].headers_encrypted;
      // Nothing resent: refused.
      expect(await updateCustomTool(d, A, 'tool-a1', change)).toMatchObject({
        ok: false,
        status: 400,
        code: 'headers_required',
      });
      // Keep-value (name without value): refused too.
      expect(
        await updateCustomTool(d, A, 'tool-a1', {
          ...change,
          headers: [{ name: 'Authorization' }],
        })
      ).toMatchObject({ ok: false, code: 'headers_required' });
      expect(tables.ai_custom_tools[0].headers_encrypted).toBe(original);
      expect(tables.ai_custom_tools[0].url).toBe(
        'https://api.shop.example/v1/stock?channel=wa'
      );
      expect(tables.ai_custom_tools[0].method).toBe('POST');
      // Retyped: accepted, and the new value is the one stored.
      const ok = await updateCustomTool(d, A, 'tool-a1', {
        ...change,
        headers: [{ name: 'Authorization', value: 'Bearer retyped-token-1' }],
      });
      expect(ok).toMatchObject({ ok: true });
      expect(
        JSON.parse(
          decrypt(tables.ai_custom_tools[0].headers_encrypted as string)
        )
      ).toEqual({ Authorization: 'Bearer retyped-token-1' });
    }
  );

  it('changing the path or the method with the headers removed is allowed', async () => {
    const { d } = deps({ ai_custom_tools: [row()] });
    expect(
      await updateCustomTool(d, A, 'tool-a1', {
        url: 'https://api.shop.example/v2/stock',
        headers: [],
      })
    ).toMatchObject({ ok: true, value: { has_headers: false } });
    const other = deps({ ai_custom_tools: [row()] });
    expect(
      await updateCustomTool(other.d, A, 'tool-a1', {
        method: 'GET',
        headers: [],
      })
    ).toMatchObject({ ok: true, value: { has_headers: false } });
  });

  it('a tool with no headers can change path and method freely', async () => {
    const { d } = deps({
      ai_custom_tools: [row({ header_names: [], headers_encrypted: null })],
    });
    expect(
      await updateCustomTool(d, A, 'tool-a1', {
        url: 'https://api.shop.example/v2/other',
        method: 'GET',
      })
    ).toMatchObject({ ok: true });
  });

  it('the same url and method resent keep the stored headers; so do description, timeout and is_active', async () => {
    const { d, tables } = deps({ ai_custom_tools: [row()] });
    expect(
      await updateCustomTool(d, A, 'tool-a1', {
        url: 'https://api.shop.example/v1/stock?channel=wa',
        method: 'POST',
        headers: [{ name: 'Authorization' }],
      })
    ).toMatchObject({ ok: true, value: { has_headers: true } });
    expect(
      await updateCustomTool(d, A, 'tool-a1', {
        description: 'Another description for the same tool.',
        timeout_ms: 5000,
        is_active: false,
      })
    ).toMatchObject({ ok: true, value: { has_headers: true } });
    // (a keep-value save re-encrypts: compare the plaintext, not the cipher)
    expect(
      JSON.parse(decrypt(tables.ai_custom_tools[0].headers_encrypted as string))
    ).toEqual({ Authorization: SECRET });
  });

  it('a new url goes through the same checks', async () => {
    const { d } = deps({ ai_custom_tools: [row()] });
    expect(
      await updateCustomTool(d, A, 'tool-a1', {
        url: 'https://169.254.169.254/x',
      })
    ).toMatchObject({ ok: false, code: 'url_blocked' });
    expect(
      await updateCustomTool(d, A, 'tool-a1', { name: 'handoff_to_human' })
    ).toMatchObject({ ok: false, code: 'name_reserved' });
    expect(await updateCustomTool(d, A, 'tool-a1', {})).toMatchObject({
      ok: false,
      code: 'nothing_to_update',
    });
  });

  it('never writes `account_id`, `headers_encrypted` plaintext or unknown fields from the input', async () => {
    const { d, writes } = deps({ ai_custom_tools: [row()] });
    await updateCustomTool(d, A, 'tool-a1', {
      is_active: false,
      account_id: B,
      headers_encrypted: 'plain',
      id: 'x',
    } as never);
    const patch = writes.find((w) => w.op === 'update')!.values as Row;
    expect(Object.keys(patch)).toEqual(['is_active']);
  });
});

describe('simulateCustomTool (the "test" button)', () => {
  it('describes the call: method, url without query, arguments; never calls, never reads the headers', async () => {
    const { d, calls } = deps({ ai_custom_tools: [row()] });
    const r = await simulateCustomTool(d.db, A, 'tool-a1', {
      sku: 'A1',
      url: 'http://evil.test',
    });
    expect(r).toMatchObject({
      ok: true,
      value: {
        called: false,
        would_call: {
          method: 'POST',
          // The ORIGIN only: the path may be a webhook credential.
          url: 'https://api.shop.example/…',
          arguments: { sku: 'A1' },
        },
        header_names: ['Authorization'],
      },
    });
    expect(JSON.stringify(r)).not.toContain('SUPER_SECRET');
    expect(JSON.stringify(r)).not.toContain('channel=wa');
    expect(JSON.stringify(r)).not.toContain('/v1/stock');
    // Only the tool row was read.
    expect(calls.map((c) => c.table)).toEqual(['ai_custom_tools']);
  });

  it('validates the arguments against the schema', async () => {
    const { d } = deps({ ai_custom_tools: [row()] });
    expect(await simulateCustomTool(d.db, A, 'tool-a1', {})).toMatchObject({
      ok: false,
      status: 400,
      code: 'invalid_arguments',
      error: 'missing_sku',
    });
  });
});

describe('loadCustomToolsForTurn', () => {
  const seed = () => ({
    ai_custom_tools: [
      row(),
      row({ id: 'tool-a2', name: 'lookup_order', risk: 'read', method: 'GET' }),
      row({ id: 'tool-a3', name: 'off_tool', is_active: false }),
      row({ id: 'tool-a4', name: 'search_knowledge' }), // collides with a built-in
      row({
        id: 'tool-a5',
        name: 'broken_schema',
        input_schema: { type: 'array' },
      }),
      row({ id: 'tool-b1', account_id: B, name: 'other_tool' }),
    ],
  });

  it('auto-reply: the active tools of the account; built-in names, broken schemas and other accounts are out', async () => {
    const { db } = fakeDb(seed());
    const tools = await loadCustomToolsForTurn({
      accountId: A,
      mode: 'auto_reply',
      db,
    });
    expect(tools.map((t) => t.key).sort()).toEqual([
      'check_stock',
      'lookup_order',
    ]);
    expect(tools.every((t) => t.external)).toBe(true);
  });

  // SPEC 089 F8: the global kill switch drops every HTTP tool that may change
  // something elsewhere — `write`, and a POST the admin marked `read`.
  it('AI_TOOL_WRITES=off: a live turn gets only GET tools marked read', async () => {
    const prev = process.env.AI_TOOL_WRITES;
    process.env.AI_TOOL_WRITES = 'off';
    try {
      const { db } = fakeDb({
        ai_custom_tools: [
          row({ id: 't1', name: 'write_tool', risk: 'write', method: 'POST' }),
          row({ id: 't2', name: 'post_read', risk: 'read', method: 'POST' }),
          row({ id: 't3', name: 'get_read', risk: 'read', method: 'GET' }),
        ],
      });
      const live = await loadCustomToolsForTurn({
        accountId: A,
        mode: 'auto_reply',
        db,
      });
      expect(live.map((t) => t.key)).toEqual(['get_read']);
      // The playground still simulates them all.
      const { db: db2 } = fakeDb({
        ai_custom_tools: [
          row({ id: 't1', name: 'write_tool', risk: 'write', method: 'POST' }),
          row({ id: 't2', name: 'post_read', risk: 'read', method: 'POST' }),
        ],
      });
      expect(
        (
          await loadCustomToolsForTurn({
            accountId: A,
            mode: 'playground',
            db: db2,
          })
        ).length
      ).toBe(2);
    } finally {
      if (prev === undefined) delete process.env.AI_TOOL_WRITES;
      else process.env.AI_TOOL_WRITES = prev;
    }
  });

  it('playground and eval are offered the same tools (they simulate)', async () => {
    for (const mode of ['playground', 'eval'] as const) {
      const { db } = fakeDb(seed());
      const tools = await loadCustomToolsForTurn({ accountId: A, mode, db });
      expect(tools.map((t) => t.key).sort()).toEqual([
        'check_stock',
        'lookup_order',
      ]);
    }
  });

  it('draft: only the tools marked read', async () => {
    const { db } = fakeDb(seed());
    const tools = await loadCustomToolsForTurn({
      accountId: A,
      mode: 'draft',
      db,
    });
    expect(tools.map((t) => t.key)).toEqual(['lookup_order']);
  });

  it('a database failure (or a missing migration) means no custom tool, never a thrown error', async () => {
    const { db } = fakeDb(seed(), { failOn: ['ai_custom_tools'] });
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(
      await loadCustomToolsForTurn({ accountId: A, mode: 'auto_reply', db })
    ).toEqual([]);
    spy.mockRestore();
  });

  it('the loaded tool carries no ciphertext', async () => {
    const { db } = fakeDb(seed());
    const [tool] = await loadCustomToolsForTurn({
      accountId: A,
      mode: 'auto_reply',
      db,
    });
    expect(
      JSON.stringify({ ...tool, handler: undefined, parse: undefined })
    ).not.toContain('headers_encrypted');
    expect(JSON.stringify(tool.inputSchema)).not.toContain('SUPER_SECRET');
  });
});
