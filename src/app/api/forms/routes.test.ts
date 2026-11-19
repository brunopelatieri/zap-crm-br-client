// ============================================================
// Rotas da conta `/api/forms/**` (SPEC 085 §7.1, F2).
//
// O Supabase é um dublê que grava a cadeia de chamadas e entrega o
// resultado pelo `resolver` do teste (tabela + operações). Nenhum banco,
// nenhuma rede. O que se confere: papel, plano, códigos de erro, o que
// vai para o INSERT/UPDATE/RPC e o ciclo de vida dos 4 modelos.
// ============================================================

import { beforeEach, describe, expect, it, vi } from 'vitest';

type Op = { method: string; args: unknown[] };
type Res = { data?: unknown; error?: unknown; count?: number | null };

const h = vi.hoisted(() => ({
  requireRole: vi.fn(),
  hasFeature: vi.fn(),
  recordFormActivity: vi.fn(),
  getAccountPlan: vi.fn(),
  resolver: null as null | ((table: string, ops: Op[]) => Res),
  rpcResolver: null as null | ((name: string, args: unknown) => Res),
  rpcCalls: [] as { name: string; args: Record<string, unknown> }[],
  storage: {
    createSignedUploadUrl: vi.fn(),
    createSignedUrls: vi.fn(),
  },
}));

vi.mock('@/lib/auth/account', async (orig) => {
  const real = await orig<typeof import('@/lib/auth/account')>();
  return { ...real, requireRole: (min: string) => h.requireRole(min) };
});
vi.mock('@/lib/forms/plan-gate', async (orig) => {
  const real = await orig<typeof import('@/lib/forms/plan-gate')>();
  return {
    ...real,
    hasFormsFeature: () => h.hasFeature(),
    requireFormsFeature: async () => {
      if (!(await h.hasFeature())) {
        throw new ForbiddenError(real.FEATURE_NOT_IN_PLAN);
      }
    },
  };
});
vi.mock('@/lib/forms/activity', async (orig) => ({
  ...(await orig<typeof import('@/lib/forms/activity')>()),
  recordFormActivity: (...a: unknown[]) => h.recordFormActivity(...a),
}));
vi.mock('@/lib/plans/account-plan', () => ({
  getAccountPlan: (...a: unknown[]) => h.getAccountPlan(...a),
}));

import { ForbiddenError } from '@/lib/auth/account';
import { validateFormForPublish } from '@/lib/forms/validate';
import { FORM_TEMPLATE_IDS } from '@/lib/forms/templates';
import type { Form, FormField } from '@/lib/forms/types';
import {
  ACCOUNT_ID,
  CONTACT_ID,
  FORM_ID,
  makeField,
  makeForm,
  USER_ID,
} from '@/lib/forms/test-fixtures';

import { GET as listForms, POST as createForm } from './route';
import {
  DELETE as deleteForm,
  GET as getForm,
  PUT as putForm,
} from './[id]/route';
import { POST as archive } from './[id]/archive/route';
import { POST as duplicate } from './[id]/duplicate/route';
import { PUT as putFields } from './[id]/fields/route';
import { GET as getLink, POST as postLink } from './[id]/link/route';
import { GET as getMedia, POST as postMedia } from './[id]/media/route';
import { POST as publish } from './[id]/publish/route';
import { POST as restore } from './[id]/restore/route';
import { POST as unpublish } from './[id]/unpublish/route';

const BASE = 'https://app.example.com';
const SECRET = 'a'.repeat(48);
const CTX_PARAMS = { params: Promise.resolve({ id: FORM_ID }) };
const OTHER_ID = '99999999-9999-4999-8999-999999999991';

const req = (method: string, body?: unknown, path = '/api/forms') =>
  new Request(`${BASE}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

/** Cadeia `from(t).select().eq()…` que resolve no `resolver` ao ser aguardada. */
function makeDb() {
  const from = (table: string) => {
    const ops: Op[] = [];
    const proxy: unknown = new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === 'then') {
            return (
              resolve: (v: unknown) => unknown,
              reject: (e: unknown) => unknown
            ) => {
              const r = h.resolver?.(table, ops) ?? {};
              return Promise.resolve({
                data: null,
                error: null,
                count: null,
                ...r,
              }).then(resolve, reject);
            };
          }
          return (...args: unknown[]) => {
            ops.push({ method: String(prop), args });
            return proxy;
          };
        },
      }
    );
    return proxy;
  };
  return {
    from,
    rpc: async (name: string, args: Record<string, unknown>) => {
      h.rpcCalls.push({ name, args });
      return {
        data: null,
        error: null,
        ...(h.rpcResolver?.(name, args) ?? {}),
      };
    },
    storage: { from: () => h.storage },
  };
}

const opArg = (ops: Op[], method: string, i = 0) =>
  ops.find((o) => o.method === method)?.args[i];
const has = (ops: Op[], method: string) => ops.some((o) => o.method === method);
const selectedColumns = (ops: Op[]) =>
  opArg(ops, 'select') as string | undefined;

function roleIs(role: 'viewer' | 'agent' | 'admin' | 'owner') {
  const rank = { viewer: 1, agent: 2, admin: 3, owner: 4 };
  h.requireRole.mockImplementation(async (min: keyof typeof rank) => {
    if (rank[role] < rank[min]) throw new ForbiddenError('Insufficient role');
    return {
      supabase: makeDb(),
      userId: USER_ID,
      accountId: ACCOUNT_ID,
      role,
      account: { id: ACCOUNT_ID, name: 'Conta' },
    };
  });
}

/** Estado em memória para os fluxos de criação/publicação. */
function memoryForms(initial?: { form?: Form; fields?: FormField[] }) {
  const state = {
    form: initial?.form ?? (null as Form | null),
    fields: initial?.fields ?? ([] as FormField[]),
    insertedSlugs: [] as string[],
  };
  h.resolver = (table, ops) => {
    if (table === 'forms') {
      if (has(ops, 'insert')) {
        const row = opArg(ops, 'insert') as Record<string, unknown>;
        state.insertedSlugs.push(row.slug as string);
        state.form = makeForm({ ...(row as Partial<Form>), version: 1 });
        return { data: state.form };
      }
      if (has(ops, 'update')) {
        if (!state.form) return { data: null };
        state.form = { ...state.form, ...(opArg(ops, 'update') as object) };
        return { data: state.form };
      }
      if (has(ops, 'delete')) {
        state.form = null;
        return {};
      }
      if (selectedColumns(ops) === 'slug') {
        return { data: state.form ? [{ slug: state.form.slug }] : [] };
      }
      return { data: state.form };
    }
    if (table === 'form_fields') return { data: state.fields };
    if (table === 'form_responses') return { count: 0 };
    return {};
  };
  h.rpcResolver = (name, args) => {
    if (name === 'form_fields_replace') {
      const list = (args as { p_fields: Record<string, unknown>[] }).p_fields;
      state.fields = list.map((f, i) =>
        makeField({
          ...(f as Partial<FormField>),
          key: f.key as string,
          type: f.type as FormField['type'],
          id: (f.id as string) ?? `f-${i}`,
          position: i,
        })
      );
      return { data: state.fields };
    }
    return {};
  };
  return state;
}

beforeEach(() => {
  h.requireRole.mockReset();
  h.hasFeature.mockReset().mockResolvedValue(true);
  h.recordFormActivity.mockReset();
  h.getAccountPlan.mockReset().mockResolvedValue({
    usage: {
      buckets: [
        { key: 'forms', used: 1, limit: 5, status: 'ok' },
        { key: 'contacts', used: 9, limit: 10, status: 'warn' },
      ],
    },
  });
  h.resolver = null;
  h.rpcResolver = null;
  h.rpcCalls.length = 0;
  h.storage.createSignedUploadUrl.mockReset().mockResolvedValue({
    data: { token: 'tok', signedUrl: 'https://storage/upload' },
    error: null,
  });
  h.storage.createSignedUrls
    .mockReset()
    .mockResolvedValue({ data: [], error: null });
  vi.stubEnv('FORM_LINK_SECRET', SECRET);
  vi.stubEnv('NEXT_PUBLIC_SITE_URL', BASE);
  roleIs('admin');
});

// ------------------------------------------------------------
// Papéis e plano (valem para todas as rotas)
// ------------------------------------------------------------

describe('papéis (PRD 084 §5)', () => {
  it('rotas de admin recusam agent e viewer com 403 antes de tocar no banco', async () => {
    roleIs('agent');
    const calls = [
      () => createForm(req('POST', {})),
      () => getForm(req('GET'), CTX_PARAMS),
      () => putForm(req('PUT', { name: 'x' }), CTX_PARAMS),
      () => deleteForm(req('DELETE'), CTX_PARAMS),
      () => putFields(req('PUT', { fields: [] }), CTX_PARAMS),
      () => publish(req('POST'), CTX_PARAMS),
      () => unpublish(req('POST'), CTX_PARAMS),
      () => archive(req('POST'), CTX_PARAMS),
      () => restore(req('POST'), CTX_PARAMS),
      () => duplicate(req('POST'), CTX_PARAMS),
      () => postMedia(req('POST', {}), CTX_PARAMS),
      () => getMedia(req('GET'), CTX_PARAMS),
    ];
    for (const call of calls) expect((await call()).status).toBe(403);
    expect(h.rpcCalls).toHaveLength(0);
  });

  it('GET /api/forms: viewer lê; link: agent+ (viewer recebe 403)', async () => {
    roleIs('viewer');
    h.resolver = () => ({ data: [] });
    expect((await listForms()).status).toBe(200);
    expect((await getLink(req('GET'), CTX_PARAMS)).status).toBe(403);
    expect(
      (await postLink(req('POST', { contact_id: CONTACT_ID }), CTX_PARAMS))
        .status
    ).toBe(403);
  });
});

describe('plano sem o item (PRD 084 D-11)', () => {
  it('GET /api/forms responde 200 com featureInPlan:false e lista vazia', async () => {
    h.hasFeature.mockResolvedValue(false);
    const res = await listForms();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      featureInPlan: false,
      forms: [],
      usage: [],
      canCreate: false,
    });
  });

  it('as demais respondem 403 FEATURE_NOT_IN_PLAN', async () => {
    h.hasFeature.mockResolvedValue(false);
    const calls = [
      () => createForm(req('POST', {})),
      () => getForm(req('GET'), CTX_PARAMS),
      () => putForm(req('PUT', { name: 'x' }), CTX_PARAMS),
      () => deleteForm(req('DELETE'), CTX_PARAMS),
      () => putFields(req('PUT', { fields: [] }), CTX_PARAMS),
      () => publish(req('POST'), CTX_PARAMS),
      () => unpublish(req('POST'), CTX_PARAMS),
      () => archive(req('POST'), CTX_PARAMS),
      () => restore(req('POST'), CTX_PARAMS),
      () => duplicate(req('POST'), CTX_PARAMS),
      () => postMedia(req('POST', {}), CTX_PARAMS),
      () => getMedia(req('GET'), CTX_PARAMS),
      () => getLink(req('GET'), CTX_PARAMS),
      () => postLink(req('POST', { contact_id: CONTACT_ID }), CTX_PARAMS),
    ];
    for (const call of calls) {
      const res = await call();
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: 'FEATURE_NOT_IN_PLAN' });
    }
  });
});

// ------------------------------------------------------------
// GET /api/forms
// ------------------------------------------------------------

describe('GET /api/forms', () => {
  it('junta os contadores da RPC agregada e calcula a taxa de conclusão', async () => {
    h.resolver = () => ({
      data: [
        { id: 'f1', name: 'A', slug: 'a', status: 'published' },
        { id: 'f2', name: 'B', slug: 'b', status: 'draft' },
      ],
    });
    h.rpcResolver = () => ({
      data: [
        {
          form_id: 'f1',
          started_count: '10',
          completed_count: 4,
          completed_month: '3',
          last_response_at: '2026-11-01T10:00:00Z',
        },
      ],
    });
    const res = await listForms();
    const body = await res.json();
    expect(h.rpcCalls[0]).toEqual({
      name: 'forms_list_stats',
      args: { p_account_id: ACCOUNT_ID },
    });
    expect(body.forms[0]).toMatchObject({
      id: 'f1',
      started_count: 10,
      completed_count: 4,
      completed_month: 3,
      completion_rate: 0.4,
      last_response_at: '2026-11-01T10:00:00Z',
    });
    expect(body.forms[1]).toMatchObject({
      completed_count: 0,
      completion_rate: null,
    });
    // Só as quotas de formulário, e `canCreate` da quota `forms`.
    expect(body.usage.map((b: { key: string }) => b.key)).toEqual(['forms']);
    expect(body.canCreate).toBe(true);
  });

  it('quota `forms` cheia → canCreate false', async () => {
    h.resolver = () => ({ data: [] });
    h.getAccountPlan.mockResolvedValue({
      usage: { buckets: [{ key: 'forms', used: 5, limit: 5, status: 'full' }] },
    });
    expect((await (await listForms()).json()).canCreate).toBe(false);
  });
});

// ------------------------------------------------------------
// POST /api/forms — os 4 modelos criam e publicam sem erro
// ------------------------------------------------------------

describe('POST /api/forms', () => {
  it.each(FORM_TEMPLATE_IDS)(
    'modelo %s: cria e publica sem erro de validação',
    async (template) => {
      const state = memoryForms();
      const created = await createForm(
        req('POST', { template, locale: 'pt-BR' })
      );
      expect(created.status).toBe(201);
      expect(h.rpcCalls[0].name).toBe('form_fields_replace');
      expect(state.fields.length).toBeGreaterThan(0);
      // O que foi gravado passa na validação de publicação do servidor.
      expect(validateFormForPublish(state.form!, state.fields)).toEqual([]);

      const published = await publish(req('POST'), CTX_PARAMS);
      expect(published.status).toBe(200);
      expect((await published.json()).form.status).toBe('published');
      expect(h.recordFormActivity).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ action: 'form.published' })
      );
    }
  );

  it('grava dono, conta e rascunho; slug vem do nome do modelo', async () => {
    const state = memoryForms();
    await createForm(req('POST', { template: 'lead_capture', locale: 'en' }));
    expect(state.form).toMatchObject({
      account_id: ACCOUNT_ID,
      user_id: USER_ID,
      status: 'draft',
      locale: 'en',
      slug: 'lead-capture',
    });
    expect(state.form?.scoring.bands).toHaveLength(3);
  });

  it('colisão de slug com outra conta tenta de novo com sufixo', async () => {
    let inserts = 0;
    h.resolver = (table, ops) => {
      if (table !== 'forms') return {};
      if (has(ops, 'insert')) {
        inserts += 1;
        const row = opArg(ops, 'insert') as Record<string, unknown>;
        if (inserts === 1) {
          return {
            error: {
              code: '23505',
              message:
                'duplicate key value violates unique constraint "forms_slug_key"',
            },
          };
        }
        return { data: makeForm({ slug: row.slug as string }) };
      }
      return { data: [] };
    };
    h.rpcResolver = () => ({ data: [] });
    const res = await createForm(req('POST', { template: 'blank' }));
    expect(res.status).toBe(201);
    expect(inserts).toBe(2);
  });

  it('QUOTA_EXCEEDED:forms da trigger vira 409 com métrica, uso e limite', async () => {
    h.resolver = (table, ops) =>
      table === 'forms' && has(ops, 'insert')
        ? {
            error: {
              code: 'P0001',
              message: 'QUOTA_EXCEEDED:forms:5:5',
            },
          }
        : { data: [] };
    const res = await createForm(req('POST', { template: 'blank' }));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: 'QUOTA_EXCEEDED',
      metric: 'forms',
      used: 5,
      limit: 5,
    });
    expect(h.rpcCalls).toHaveLength(0);
  });

  it('falha ao gravar os blocos desfaz o formulário', async () => {
    const state = memoryForms();
    h.rpcResolver = () => ({ error: { code: '23514', message: 'check' } });
    const res = await createForm(req('POST', { template: 'blank' }));
    expect(res.status).toBe(400);
    expect(state.form).toBeNull();
  });

  it('modelo desconhecido → 400', async () => {
    expect((await createForm(req('POST', { template: 'x' }))).status).toBe(400);
  });
});

// ------------------------------------------------------------
// GET/PUT/DELETE /api/forms/[id]
// ------------------------------------------------------------

describe('GET /api/forms/[id]', () => {
  it('devolve formulário, blocos, URLs assinadas e capacidades do deploy', async () => {
    const path = `account-${ACCOUNT_ID}/${FORM_ID}/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.png`;
    memoryForms({
      form: makeForm({ theme: { logo_path: path } }),
      fields: [makeField({ key: 'phone', type: 'phone' })],
    });
    h.storage.createSignedUrls.mockResolvedValue({
      data: [{ path, signedUrl: 'https://signed/logo' }],
      error: null,
    });
    const body = await (await getForm(req('GET'), CTX_PARAMS)).json();
    expect(body.fields).toHaveLength(1);
    expect(body.media_urls).toEqual({ [path]: 'https://signed/logo' });
    expect(body.capabilities).toEqual({ link_token: true, turnstile: false });
  });

  it('id inválido e formulário de outra conta → 404', async () => {
    memoryForms();
    expect(
      (await getForm(req('GET'), { params: Promise.resolve({ id: 'x' }) }))
        .status
    ).toBe(404);
    expect((await getForm(req('GET'), CTX_PARAMS)).status).toBe(404);
  });
});

describe('PUT /api/forms/[id]', () => {
  it('só grava o que o saneador deixou passar (nada de status/account_id)', async () => {
    const state = memoryForms({ form: makeForm() });
    const res = await putForm(
      req('PUT', {
        name: 'Novo nome',
        status: 'published',
        account_id: 'x',
        portal_visibility: 'fill',
      }),
      CTX_PARAMS
    );
    expect(res.status).toBe(200);
    expect(state.form).toMatchObject({
      name: 'Novo nome',
      status: 'draft',
      account_id: ACCOUNT_ID,
      portal_visibility: 'fill',
    });
  });

  it('slug reservado ou fora do formato → 422 INVALID_FORM', async () => {
    memoryForms({ form: makeForm() });
    for (const [slug, code] of [
      ['admin', 'slug_reserved'],
      ['a', 'slug_invalid'],
    ]) {
      const res = await putForm(req('PUT', { slug }), CTX_PARAMS);
      expect(res.status).toBe(422);
      expect(await res.json()).toEqual({
        error: 'INVALID_FORM',
        issues: [{ code }],
      });
    }
  });

  it('slug em uso (UNIQUE) → 409 SLUG_TAKEN', async () => {
    h.resolver = (table, ops) => {
      if (table === 'forms' && has(ops, 'update')) {
        return {
          error: { code: '23505', message: 'violates "forms_slug_key"' },
        };
      }
      return { data: makeForm() };
    };
    const res = await putForm(req('PUT', { slug: 'outro-slug' }), CTX_PARAMS);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'SLUG_TAKEN' });
  });

  it('imagem de tema de outra conta → 400', async () => {
    memoryForms({ form: makeForm() });
    const res = await putForm(
      req('PUT', {
        theme: {
          logo_path: `account-99999999-9999-4999-8999-999999999999/${FORM_ID}/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.png`,
        },
      }),
      CTX_PARAMS
    );
    expect(res.status).toBe(400);
  });

  it('formulário ARQUIVADO não edita (409 INVALID_STATE)', async () => {
    memoryForms({ form: makeForm({ status: 'archived' }) });
    const res = await putForm(req('PUT', { name: 'x' }), CTX_PARAMS);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'INVALID_STATE' });
  });

  it('formulário PUBLICADO não salva algo que a publicação recusaria', async () => {
    memoryForms({
      form: makeForm({ status: 'published' }),
      fields: [
        makeField({
          key: 'phone',
          type: 'phone',
          is_identity: true,
          position: 0,
        }),
      ],
    });
    const res = await putForm(
      req('PUT', { settings: { token_ttl_days: 9999 } }),
      CTX_PARAMS
    );
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.issues).toEqual([{ code: 'token_ttl_invalid' }]);
  });

  it('corpo vazio → 400', async () => {
    memoryForms({ form: makeForm() });
    expect((await putForm(req('PUT', {}), CTX_PARAMS)).status).toBe(400);
  });
});

describe('DELETE /api/forms/[id]', () => {
  it('sem respostas e fora do ar: apaga e registra', async () => {
    const state = memoryForms({ form: makeForm() });
    const res = await deleteForm(req('DELETE'), CTX_PARAMS);
    expect(res.status).toBe(200);
    expect(state.form).toBeNull();
    expect(h.recordFormActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'form.deleted' })
    );
  });

  it('com respostas → 409 FORM_HAS_RESPONSES (e nada é apagado)', async () => {
    const state = memoryForms({ form: makeForm() });
    const base = h.resolver!;
    h.resolver = (table, ops) =>
      table === 'form_responses' ? { count: 3 } : base(table, ops);
    const res = await deleteForm(req('DELETE'), CTX_PARAMS);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'FORM_HAS_RESPONSES', count: 3 });
    expect(state.form).not.toBeNull();
  });

  it('publicado → 409 INVALID_STATE (despublique antes)', async () => {
    memoryForms({ form: makeForm({ status: 'published' }) });
    const res = await deleteForm(req('DELETE'), CTX_PARAMS);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'INVALID_STATE' });
  });
});

// ------------------------------------------------------------
// PUT /api/forms/[id]/fields
// ------------------------------------------------------------

describe('PUT /api/forms/[id]/fields', () => {
  const block = (over: Record<string, unknown> = {}) => ({
    key: 'phone',
    type: 'phone',
    label: 'WhatsApp',
    required: true,
    is_identity: true,
    ...over,
  });

  it('chama a RPC com os blocos saneados, na ordem, mantendo ids', async () => {
    const existing = '12121212-1212-4121-8121-121212121212';
    memoryForms({ form: makeForm() });
    const res = await putFields(
      req('PUT', {
        fields: [
          block({ id: existing }),
          { key: 'nome', type: 'short_text', label: 'Nome', lixo: 1 },
        ],
      }),
      CTX_PARAMS
    );
    expect(res.status).toBe(200);
    const sent = h.rpcCalls[0].args.p_fields as Record<string, unknown>[];
    expect(h.rpcCalls[0].args.p_form_id).toBe(FORM_ID);
    expect(sent.map((f) => [f.id, f.key, f.position])).toEqual([
      [existing, 'phone', 0],
      [undefined, 'nome', 1],
    ]);
    expect(sent[1]).not.toHaveProperty('lixo');
  });

  it('corpo inválido → 400 sem chamar a RPC', async () => {
    memoryForms({ form: makeForm() });
    expect(
      (
        await putFields(
          req('PUT', { fields: [{ key: 'X', type: 'phone' }] }),
          CTX_PARAMS
        )
      ).status
    ).toBe(400);
    expect(h.rpcCalls).toHaveLength(0);
  });

  it('chave duplicada (23505 da RPC) → 400 INVALID_FORM', async () => {
    memoryForms({ form: makeForm() });
    h.rpcResolver = () => ({
      error: {
        code: '23505',
        message: 'violates unique constraint "form_fields_form_key_unique"',
      },
    });
    const res = await putFields(
      req('PUT', { fields: [block(), block({ is_identity: false })] }),
      CTX_PARAMS
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('INVALID_FORM');
  });

  it('formulário publicado: lista sem identidade → 422 com os problemas', async () => {
    memoryForms({ form: makeForm({ status: 'published' }) });
    const res = await putFields(
      req('PUT', {
        fields: [{ key: 'nome', type: 'short_text', label: 'Nome' }],
      }),
      CTX_PARAMS
    );
    expect(res.status).toBe(422);
    const codes = (await res.json()).issues.map(
      (i: { code: string }) => i.code
    );
    expect(codes).toContain('identity_required');
    expect(h.rpcCalls).toHaveLength(0);
  });

  it('RPC recusa não-admin (42501) → 404', async () => {
    memoryForms({ form: makeForm() });
    h.rpcResolver = () => ({ error: { code: '42501', message: 'nope' } });
    expect(
      (await putFields(req('PUT', { fields: [block()] }), CTX_PARAMS)).status
    ).toBe(404);
  });
});

// ------------------------------------------------------------
// Transições
// ------------------------------------------------------------

describe('publish / unpublish / archive / restore', () => {
  const okFields = () => [
    makeField({
      key: 'phone',
      type: 'phone',
      is_identity: true,
      required: true,
      position: 0,
      label: 'Tel',
    }),
  ];

  it('publish recusa formulário inválido com a lista (422 INVALID_FORM)', async () => {
    memoryForms({ form: makeForm(), fields: [] });
    const res = await publish(req('POST'), CTX_PARAMS);
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toBe('INVALID_FORM');
    expect(body.issues.map((i: { code: string }) => i.code)).toContain(
      'no_fields'
    );
  });

  it('publish só sai de rascunho (publicado e arquivado → 409)', async () => {
    for (const status of ['published', 'archived'] as const) {
      memoryForms({ form: makeForm({ status }), fields: okFields() });
      const res = await publish(req('POST'), CTX_PARAMS);
      expect(res.status).toBe(409);
    }
  });

  it('o UPDATE leva o filtro de estado de origem (corrida entre duas transições)', async () => {
    const seen: Op[][] = [];
    const state = memoryForms({ form: makeForm(), fields: okFields() });
    const base = h.resolver!;
    h.resolver = (table, ops) => {
      if (table === 'forms' && has(ops, 'update')) seen.push(ops);
      return base(table, ops);
    };
    await publish(req('POST'), CTX_PARAMS);
    expect(opArg(seen[0], 'in', 0)).toBe('status');
    expect(opArg(seen[0], 'in', 1)).toEqual(['draft']);
    expect(state.form?.status).toBe('published');
    expect(state.form?.published_at).toEqual(expect.any(String));
  });

  it('unpublish: publicado → rascunho; rascunho → 409', async () => {
    const state = memoryForms({ form: makeForm({ status: 'published' }) });
    expect((await unpublish(req('POST'), CTX_PARAMS)).status).toBe(200);
    expect(state.form?.status).toBe('draft');
    expect((await unpublish(req('POST'), CTX_PARAMS)).status).toBe(409);
  });

  it('archive: rascunho/publicado → arquivado, com data; já arquivado → 409', async () => {
    const state = memoryForms({ form: makeForm({ status: 'published' }) });
    expect((await archive(req('POST'), CTX_PARAMS)).status).toBe(200);
    expect(state.form?.status).toBe('archived');
    expect(state.form?.archived_at).toEqual(expect.any(String));
    expect((await archive(req('POST'), CTX_PARAMS)).status).toBe(409);
  });

  it('restore volta a rascunho; sem vaga na quota → 409 QUOTA_EXCEEDED', async () => {
    const state = memoryForms({ form: makeForm({ status: 'archived' }) });
    expect((await restore(req('POST'), CTX_PARAMS)).status).toBe(200);
    expect(state.form).toMatchObject({ status: 'draft', archived_at: null });

    memoryForms({ form: makeForm({ status: 'archived' }) });
    const base = h.resolver!;
    h.resolver = (table, ops) =>
      table === 'forms' && has(ops, 'update')
        ? { error: { code: 'P0001', message: 'QUOTA_EXCEEDED:forms:3:3' } }
        : base(table, ops);
    const res = await restore(req('POST'), CTX_PARAMS);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      error: 'QUOTA_EXCEEDED',
      limit: 3,
    });
  });
});

// ------------------------------------------------------------
// duplicate
// ------------------------------------------------------------

describe('POST /api/forms/[id]/duplicate', () => {
  it('cria rascunho novo com slug novo e blocos SEM os ids do original', async () => {
    const original = makeForm({
      name: 'Captação',
      slug: 'captacao',
      status: 'published',
    });
    const fields = [
      makeField({
        key: 'phone',
        type: 'phone',
        is_identity: true,
        position: 0,
      }),
      makeField({ key: 'nome', type: 'short_text', position: 1 }),
    ];
    const state = memoryForms({ form: original, fields });
    // `loadForm` lê o original; o INSERT devolve a cópia.
    const base = h.resolver!;
    h.resolver = (table, ops) => {
      if (table === 'forms' && has(ops, 'insert')) {
        const row = opArg(ops, 'insert') as Record<string, unknown>;
        return { data: makeForm({ ...(row as Partial<Form>), id: OTHER_ID }) };
      }
      if (table === 'forms' && selectedColumns(ops) === 'slug') {
        return { data: [{ slug: 'captacao' }] };
      }
      return base(table, ops);
    };
    const res = await duplicate(
      req('POST', { name: 'Captação (cópia)' }),
      CTX_PARAMS
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.form).toMatchObject({
      id: OTHER_ID,
      name: 'Captação (cópia)',
      slug: 'captacao-copia',
      status: 'draft',
    });
    const sent = h.rpcCalls[0].args.p_fields as Record<string, unknown>[];
    expect(h.rpcCalls[0].args.p_form_id).toBe(OTHER_ID);
    expect(sent).toHaveLength(2);
    for (const f of sent) expect(f).not.toHaveProperty('id');
    expect(state.fields).toHaveLength(2);
  });

  it('quota cheia → 409 QUOTA_EXCEEDED e nenhum bloco é copiado', async () => {
    memoryForms({ form: makeForm(), fields: [] });
    const base = h.resolver!;
    h.resolver = (table, ops) =>
      table === 'forms' && has(ops, 'insert')
        ? { error: { code: 'P0001', message: 'QUOTA_EXCEEDED:forms:5:5' } }
        : base(table, ops);
    const res = await duplicate(req('POST'), CTX_PARAMS);
    expect(res.status).toBe(409);
    expect(h.rpcCalls).toHaveLength(0);
  });
});

// ------------------------------------------------------------
// media
// ------------------------------------------------------------

describe('POST/GET /api/forms/[id]/media', () => {
  it('assina o upload de imagem dentro da pasta da conta e do formulário', async () => {
    memoryForms({ form: makeForm() });
    const res = await postMedia(
      req('POST', { name: 'logo.png', mime: 'image/png', size: 1000 }),
      CTX_PARAMS
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.path).toMatch(
      new RegExp(`^account-${ACCOUNT_ID}/${FORM_ID}/[0-9a-f-]{36}\\.png$`)
    );
    expect(body).toMatchObject({
      token: 'tok',
      signed_url: 'https://storage/upload',
    });
    expect(h.storage.createSignedUploadUrl).toHaveBeenCalledWith(body.path);
  });

  it('PDF, extensão trocada e arquivo grande são recusados ANTES de assinar', async () => {
    memoryForms({ form: makeForm() });
    for (const file of [
      { name: 'a.pdf', mime: 'application/pdf', size: 10 },
      { name: 'a.png', mime: 'image/jpeg', size: 10 },
      { name: 'a.png', mime: 'image/png', size: 6 * 1024 * 1024 },
    ]) {
      const res = await postMedia(req('POST', file), CTX_PARAMS);
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe('INVALID_FILE');
    }
    expect(h.storage.createSignedUploadUrl).not.toHaveBeenCalled();
  });

  it('GET só assina caminho desta conta e deste formulário', async () => {
    memoryForms({ form: makeForm() });
    const own = `account-${ACCOUNT_ID}/${FORM_ID}/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.png`;
    h.storage.createSignedUrls.mockResolvedValue({
      data: [{ path: own, signedUrl: 'https://signed/x' }],
      error: null,
    });
    const ok = await getMedia(
      req('GET', undefined, `/m?path=${own}`),
      CTX_PARAMS
    );
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ path: own, url: 'https://signed/x' });

    for (const path of [
      `account-99999999-9999-4999-8999-999999999999/${FORM_ID}/x.png`,
      `account-${ACCOUNT_ID}/${OTHER_ID}/x.png`,
      `account-${ACCOUNT_ID}/${FORM_ID}/../x.png`,
      '',
    ]) {
      const res = await getMedia(
        req('GET', undefined, `/m?path=${path}`),
        CTX_PARAMS
      );
      expect(res.status).toBe(404);
    }
  });
});

// ------------------------------------------------------------
// link
// ------------------------------------------------------------

describe('GET /api/forms/[id]/link', () => {
  it('link genérico, snippet de embed e tokenAvailable', async () => {
    memoryForms({ form: makeForm({ slug: 'captacao', status: 'published' }) });
    const body = await (await getLink(req('GET'), CTX_PARAMS)).json();
    expect(body.url).toBe(`${BASE}/f/captacao`);
    expect(body.tokenAvailable).toBe(true);
    expect(body.embed.iframe).toContain(`src="${BASE}/f/captacao"`);
    expect(body).not.toHaveProperty('qr');
  });

  it('sem FORM_LINK_SECRET: tokenAvailable false (o link genérico continua)', async () => {
    vi.stubEnv('FORM_LINK_SECRET', '');
    memoryForms({ form: makeForm({ status: 'published' }) });
    const body = await (await getLink(req('GET'), CTX_PARAMS)).json();
    expect(body.tokenAvailable).toBe(false);
    expect(body.url).toContain('/f/');
  });
});

describe('POST /api/forms/[id]/link', () => {
  const withContact = (found = true) => {
    memoryForms({ form: makeForm({ slug: 'captacao', status: 'published' }) });
    const base = h.resolver!;
    h.resolver = (table, ops) =>
      table === 'contacts'
        ? { data: found ? { id: CONTACT_ID } : null }
        : base(table, ops);
  };

  it('devolve o link com token (?t=) e a expiração', async () => {
    withContact();
    const res = await postLink(
      req('POST', { contact_id: CONTACT_ID, source: 'inbox' }),
      CTX_PARAMS
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.url).toMatch(new RegExp(`^${BASE}/f/captacao\\?t=.+`));
    expect(Date.parse(body.expires_at)).toBeGreaterThan(Date.now());
  });

  it('sem FORM_LINK_SECRET → 503 FORM_LINK_SECRET_MISSING', async () => {
    vi.stubEnv('FORM_LINK_SECRET', 'curto');
    withContact();
    const res = await postLink(
      req('POST', { contact_id: CONTACT_ID }),
      CTX_PARAMS
    );
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'FORM_LINK_SECRET_MISSING' });
  });

  it('contato de outra conta/inexistente → 404; formulário não publicado → 409', async () => {
    withContact(false);
    expect(
      (await postLink(req('POST', { contact_id: CONTACT_ID }), CTX_PARAMS))
        .status
    ).toBe(404);

    memoryForms({ form: makeForm({ status: 'draft' }) });
    expect(
      (await postLink(req('POST', { contact_id: CONTACT_ID }), CTX_PARAMS))
        .status
    ).toBe(409);
  });

  it('corpo inválido → 400', async () => {
    withContact();
    expect(
      (await postLink(req('POST', { contact_id: 'x' }), CTX_PARAMS)).status
    ).toBe(400);
  });
});
