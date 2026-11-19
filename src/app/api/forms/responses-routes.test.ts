// ============================================================
// Rotas de respostas (SPEC 085 §7.1, F4): listar, baixar arquivo,
// apagar, exportar e as respostas de um contato.
//
// Supabase é um dublê que grava a cadeia de chamadas (sessão e service
// role separados); nenhum banco, nenhuma rede. Confere: papel e plano,
// filtros que chegam ao builder, o que NÃO é selecionado (hash/IP), o
// caminho do arquivo, a confirmação de apagar, a trilha da exportação.
// ============================================================

import { beforeEach, describe, expect, it, vi } from 'vitest';

type Op = { method: string; args: unknown[] };
type Res = { data?: unknown; error?: unknown; count?: number | null };

const h = vi.hoisted(() => ({
  requireRole: vi.fn(),
  hasFeature: vi.fn(),
  recordFormActivity: vi.fn(),
  resolver: null as null | ((table: string, ops: Op[]) => Res),
  rpcResolver: null as null | ((name: string, args: unknown) => Res),
  rpcCalls: [] as { name: string; args: Record<string, unknown> }[],
  calls: [] as { table: string; method: string; args: unknown[] }[],
  adminInserts: [] as { table: string; row: Record<string, unknown> }[],
  adminInsertThrows: false,
  adminRpcCalls: [] as { name: string; args: Record<string, unknown> }[],
  removed: [] as string[][],
  removeError: null as unknown,
  storage: { createSignedUrl: vi.fn() },
}));

vi.mock('@/lib/auth/account', async (orig) => {
  const real = await orig<typeof import('@/lib/auth/account')>();
  return { ...real, requireRole: (min: string) => h.requireRole(min) };
});
vi.mock('@/lib/forms/plan-gate', async (orig) => {
  const real = await orig<typeof import('@/lib/forms/plan-gate')>();
  return {
    ...real,
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
vi.mock('@/lib/forms/admin-client', () => ({
  supabaseAdmin: () => ({
    from: (table: string) => ({
      insert: async (row: Record<string, unknown>) => {
        if (h.adminInsertThrows) throw new Error('audit down');
        h.adminInserts.push({ table, row });
        return { error: null };
      },
    }),
    rpc: async (name: string, args: Record<string, unknown>) => {
      h.adminRpcCalls.push({ name, args });
      return { data: null, error: null };
    },
    storage: {
      from: () => ({
        remove: async (paths: string[]) => {
          h.removed.push(paths);
          return { data: null, error: h.removeError };
        },
      }),
    },
  }),
}));
vi.mock('next-intl/server', () => ({
  getLocale: async () => 'pt-BR',
  getTranslations: async () => (key: string) => key,
}));

import { ForbiddenError } from '@/lib/auth/account';
import {
  ACCOUNT_ID,
  CONTACT_ID,
  FORM_ID,
  RESPONSE_ID,
  USER_ID,
  makeField,
  makeForm,
} from '@/lib/forms/test-fixtures';

import { GET as listResponses } from './[id]/responses/route';
import { GET as getFile } from './[id]/responses/[rid]/files/[idx]/route';
import { POST as deleteResponses } from './[id]/responses/delete/route';
import { POST as exportResponses } from './[id]/responses/export/route';
import { GET as contactResponses } from '../contacts/[id]/form-responses/route';

const BASE = 'https://app.example.com';
const FORM_PARAMS = { params: Promise.resolve({ id: FORM_ID }) };
const fileParams = (idx: string, rid = RESPONSE_ID, id = FORM_ID) => ({
  params: Promise.resolve({ id, rid, idx }),
});
const CONTACT_PARAMS = { params: Promise.resolve({ id: CONTACT_ID }) };
const R2 = '55555555-5555-4555-8555-555555555556';

const req = (method: string, path: string, body?: unknown) =>
  new Request(`${BASE}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

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
            ) =>
              Promise.resolve({
                data: null,
                error: null,
                count: null,
                ...(h.resolver?.(table, ops) ?? {}),
              }).then(resolve, reject);
          }
          return (...args: unknown[]) => {
            h.calls.push({ table, method: String(prop), args });
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

const calls = h.calls;
const callsTo = (table: string, method: string) =>
  calls.filter((c) => c.table === table && c.method === method);

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

const FORM = makeForm({
  name: 'Captação',
  slug: 'captacao',
  scoring: {
    bands: [{ key: 'hot', label: 'Quente', min: 0, max: 100, actions: {} }],
  },
});
const FIELDS = [
  makeField({ key: 'nome', type: 'short_text', label: 'Nome', position: 0 }),
  makeField({
    key: 'interesse',
    type: 'single_select',
    label: 'Interesse',
    position: 1,
    options: [{ id: 'o1', label: 'Compra', points: 5 }],
  }),
  makeField({
    key: 'tags',
    type: 'multi_select',
    label: 'Tags',
    position: 2,
    options: [{ id: 't1', label: 'A', points: 0 }],
  }),
  makeField({ key: 'obs', type: 'long_text', label: 'Obs', position: 3 }),
];

const FILE_PATH = `account-${ACCOUNT_ID}/${FORM_ID}/${RESPONSE_ID}/abc.pdf`;
const ANSWERS = {
  nome: { label: 'Nome', type: 'short_text', value: 'Ana', points: 0 },
  interesse: {
    label: 'Interesse',
    type: 'single_select',
    value: 'o1',
    points: 5,
    option_labels: ['Compra'],
  },
  cnh: {
    label: 'CNH',
    type: 'file_upload',
    value: [
      { path: FILE_PATH, name: 'cnh.pdf', mime: 'application/pdf', size: 2048 },
    ],
    points: 0,
  },
};

function world(extra?: (table: string, ops: Op[]) => Res | undefined) {
  h.resolver = (table, ops) => {
    const r = extra?.(table, ops);
    if (r) return r;
    if (table === 'forms') return { data: FORM };
    if (table === 'form_fields') return { data: FIELDS };
    return {};
  };
}

beforeEach(() => {
  calls.length = 0;
  h.requireRole.mockReset();
  h.hasFeature.mockReset().mockResolvedValue(true);
  h.recordFormActivity.mockReset();
  h.resolver = null;
  h.rpcResolver = null;
  h.rpcCalls.length = 0;
  h.adminInserts.length = 0;
  h.adminInsertThrows = false;
  h.adminRpcCalls.length = 0;
  h.removed.length = 0;
  h.removeError = null;
  h.storage.createSignedUrl.mockReset().mockResolvedValue({
    data: { signedUrl: 'https://storage/x?token=t' },
    error: null,
  });
  roleIs('admin');
});

// ------------------------------------------------------------
// Papéis e plano
// ------------------------------------------------------------

describe('papéis e plano', () => {
  it('viewer lê; apagar e exportar exigem admin (403 antes de tocar no banco)', async () => {
    roleIs('viewer');
    world();
    expect((await listResponses(req('GET', '/x'), FORM_PARAMS)).status).toBe(
      200
    );
    expect((await getFile(req('GET', '/x'), fileParams('0'))).status).toBe(404);
    expect(
      (await contactResponses(req('GET', '/x'), CONTACT_PARAMS)).status
    ).toBe(200);

    roleIs('agent');
    h.rpcCalls.length = 0;
    const del = await deleteResponses(
      req('POST', '/x', { all: true, confirm_name: 'Captação' }),
      FORM_PARAMS
    );
    const exp = await exportResponses(
      req('POST', '/x', { format: 'csv', scope: { mode: 'filter' } }),
      FORM_PARAMS
    );
    expect([del.status, exp.status]).toEqual([403, 403]);
    expect(h.rpcCalls).toHaveLength(0);
    expect(h.adminInserts).toHaveLength(0);
  });

  it('conta sem o item: 403 FEATURE_NOT_IN_PLAN em todas', async () => {
    h.hasFeature.mockResolvedValue(false);
    const results = [
      await listResponses(req('GET', '/x'), FORM_PARAMS),
      await getFile(req('GET', '/x'), fileParams('0')),
      await deleteResponses(req('POST', '/x', {}), FORM_PARAMS),
      await exportResponses(req('POST', '/x', {}), FORM_PARAMS),
      await contactResponses(req('GET', '/x'), CONTACT_PARAMS),
    ];
    for (const res of results) {
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: 'FEATURE_NOT_IN_PLAN' });
    }
  });

  it('id que não é UUID: 404', async () => {
    const bad = { params: Promise.resolve({ id: 'nope' }) };
    expect((await listResponses(req('GET', '/x'), bad)).status).toBe(404);
    expect((await contactResponses(req('GET', '/x'), bad)).status).toBe(404);
  });
});

// ------------------------------------------------------------
// GET /api/forms/[id]/responses
// ------------------------------------------------------------

describe('GET /api/forms/[id]/responses', () => {
  it('pagina no servidor, filtra e devolve colunas/faixas para a tela', async () => {
    world((table) =>
      table === 'form_responses'
        ? { data: [{ id: RESPONSE_ID, answers: ANSWERS }], count: 51 }
        : undefined
    );
    const res = await listResponses(
      req(
        'GET',
        '/x?page=2&pageSize=10&status=completed&band=hot&source=link&from=2026-11-01&to=2026-11-30&block=interesse&value=o1'
      ),
      FORM_PARAMS
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      total: 51,
      page: 2,
      pageSize: 10,
      form: { id: FORM_ID, name: 'Captação', slug: 'captacao' },
      bands: [{ key: 'hot', label: 'Quente' }],
    });
    expect(body.fields.map((f: { key: string }) => f.key)).toEqual([
      'nome',
      'interesse',
      'tags',
      'obs',
    ]);
    expect(body.fields[1].options).toEqual([{ id: 'o1', label: 'Compra' }]);

    const eq = callsTo('form_responses', 'eq').map((c) => c.args);
    expect(eq).toEqual(
      expect.arrayContaining([
        ['form_id', FORM_ID],
        ['account_id', ACCOUNT_ID],
        ['status', 'completed'],
        ['band_key', 'hot'],
        ['source', 'link'],
      ])
    );
    expect(callsTo('form_responses', 'gte')[0].args).toEqual([
      'started_at',
      '2026-11-01T03:00:00.000Z',
    ]);
    expect(callsTo('form_responses', 'lt')[0].args).toEqual([
      'started_at',
      '2026-12-01T03:00:00.000Z',
    ]);
    expect(callsTo('form_responses', 'contains')[0].args).toEqual([
      'answers',
      { interesse: { value: 'o1' } },
    ]);
    expect(callsTo('form_responses', 'range')[0].args).toEqual([10, 19]);
  });

  it('nunca seleciona hash do token, IP nem user agent', async () => {
    world();
    await listResponses(req('GET', '/x'), FORM_PARAMS);
    const select = callsTo('form_responses', 'select')[0].args[0] as string;
    expect(select).not.toMatch(/resume_token_hash|ip_hash|user_agent/);
    expect(select).toContain('answers');
  });

  it('busca por contato usa o embed !inner e o or() no contato', async () => {
    world();
    await listResponses(req('GET', '/x?q=Maria,x'), FORM_PARAMS);
    expect(callsTo('form_responses', 'select')[0].args[0]).toContain(
      'contacts!inner('
    );
    const or = callsTo('form_responses', 'or')[0].args;
    expect(or[1]).toEqual({ referencedTable: 'contacts' });
    expect(or[0]).not.toContain('Maria,x');
  });

  it.each([
    ['?page=0'],
    ['?status=nope'],
    ['?from=2026-12-01&to=2026-11-01'],
    ['?block=obs&value=x'], // long_text não filtra
    ['?block=ghost&value=x'], // bloco inexistente
    ['?block=tags'], // sem valor
  ])('filtro inválido %s → 400', async (qs) => {
    world();
    const res = await listResponses(req('GET', `/x${qs}`), FORM_PARAMS);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('Invalid filter');
  });

  it('formulário de outra conta (RLS não devolve) → 404', async () => {
    h.resolver = () => ({ data: null });
    expect((await listResponses(req('GET', '/x'), FORM_PARAMS)).status).toBe(
      404
    );
  });

  it('erro do banco → 500 sem vazar a mensagem', async () => {
    world((t) =>
      t === 'form_responses'
        ? { error: { code: 'XX000', message: 'segredo interno' } }
        : undefined
    );
    const res = await listResponses(req('GET', '/x'), FORM_PARAMS);
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain('segredo');
  });
});

// ------------------------------------------------------------
// GET …/responses/[rid]/files/[idx]
// ------------------------------------------------------------

describe('GET /api/forms/[id]/responses/[rid]/files/[idx]', () => {
  const withResponse = (answers: unknown = ANSWERS) =>
    world((t) =>
      t === 'form_responses'
        ? { data: { id: RESPONSE_ID, answers } }
        : undefined
    );

  it('302 para URL assinada de 10 min com download=<nome>, sem cache', async () => {
    withResponse();
    const res = await getFile(req('GET', '/x'), fileParams('0'));
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('https://storage/x?token=t');
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(h.storage.createSignedUrl).toHaveBeenCalledWith(FILE_PATH, 600, {
      download: 'cnh.pdf',
    });
  });

  it('índice fora do intervalo ou malformado → 404', async () => {
    withResponse();
    expect((await getFile(req('GET', '/x'), fileParams('1'))).status).toBe(404);
    expect((await getFile(req('GET', '/x'), fileParams('-1'))).status).toBe(
      404
    );
    expect((await getFile(req('GET', '/x'), fileParams('abc'))).status).toBe(
      404
    );
    expect(h.storage.createSignedUrl).not.toHaveBeenCalled();
  });

  it('caminho fora da pasta desta resposta nunca é assinado', async () => {
    for (const path of [
      `account-${ACCOUNT_ID}/${FORM_ID}/${R2}/abc.pdf`, // outra resposta
      `account-99999999-9999-4999-8999-999999999999/${FORM_ID}/${RESPONSE_ID}/a.pdf`,
      `account-${ACCOUNT_ID}/${FORM_ID}/${RESPONSE_ID}/../../x.pdf`,
    ]) {
      withResponse({
        cnh: {
          label: 'CNH',
          type: 'file_upload',
          points: 0,
          value: [{ path, name: 'x.pdf', mime: 'application/pdf', size: 1 }],
        },
      });
      expect((await getFile(req('GET', '/x'), fileParams('0'))).status).toBe(
        404
      );
    }
    expect(h.storage.createSignedUrl).not.toHaveBeenCalled();
  });

  it('resposta inexistente → 404; falha ao assinar → 404', async () => {
    h.resolver = () => ({ data: null });
    expect((await getFile(req('GET', '/x'), fileParams('0'))).status).toBe(404);
    withResponse();
    h.storage.createSignedUrl.mockResolvedValue({
      data: null,
      error: { message: 'x' },
    });
    expect((await getFile(req('GET', '/x'), fileParams('0'))).status).toBe(404);
  });
});

// ------------------------------------------------------------
// POST …/responses/delete
// ------------------------------------------------------------

describe('POST /api/forms/[id]/responses/delete', () => {
  const del = (body: unknown) =>
    deleteResponses(req('POST', '/x', body), FORM_PARAMS);

  beforeEach(() => {
    world();
    h.rpcResolver = () => ({
      data: [
        { storage_path: FILE_PATH, deleted_count: 2, freed_bytes: 4096 },
        {
          storage_path: `account-${ACCOUNT_ID}/${FORM_ID}/${R2}/b.png`,
          deleted_count: 2,
          freed_bytes: 4096,
        },
        // Caminho adulterado no instantâneo: nunca vai para o remove.
        {
          storage_path: `account-99999999-9999-4999-8999-999999999999/${FORM_ID}/${R2}/c.png`,
          deleted_count: 2,
          freed_bytes: 4096,
        },
        {
          storage_path: `account-${ACCOUNT_ID}/${FORM_ID}/../x`,
          deleted_count: 2,
          freed_bytes: 4096,
        },
      ],
    });
  });

  it('apaga as selecionadas: RPC, objetos do bucket, bytes devolvidos e atividade', async () => {
    const res = await del({ ids: [RESPONSE_ID, R2], confirm_name: 'Captação' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: 2, filesRemoved: 2 });
    expect(h.rpcCalls).toEqual([
      {
        name: 'form_responses_delete',
        args: { p_form_id: FORM_ID, p_ids: [RESPONSE_ID, R2] },
      },
    ]);
    expect(h.removed).toEqual([
      [FILE_PATH, `account-${ACCOUNT_ID}/${FORM_ID}/${R2}/b.png`],
    ]);
    expect(h.adminRpcCalls).toEqual([
      {
        name: 'form_upload_bytes_add',
        args: { p_account_id: ACCOUNT_ID, p_delta: -4096 },
      },
    ]);
    expect(h.recordFormActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'form.responses_deleted',
        metadata: { count: 2, all: false },
      })
    );
  });

  it('all: true manda p_ids nulo', async () => {
    const res = await del({ all: true, confirm_name: ' Captação ' });
    expect(res.status).toBe(200);
    expect(h.rpcCalls[0].args).toEqual({ p_form_id: FORM_ID, p_ids: null });
  });

  it('sem arquivos nem bytes: não toca no Storage nem na quota', async () => {
    h.rpcResolver = () => ({
      data: [{ storage_path: null, deleted_count: 1, freed_bytes: 0 }],
    });
    const res = await del({ ids: [RESPONSE_ID], confirm_name: 'Captação' });
    expect(await res.json()).toEqual({ deleted: 1, filesRemoved: 0 });
    expect(h.removed).toEqual([]);
    expect(h.adminRpcCalls).toEqual([]);
  });

  it.each([
    [{ confirm_name: 'Captação' }, 'sem ids nem all'],
    [{ ids: [], confirm_name: 'Captação' }, 'ids vazio'],
    [{ ids: ['x'], confirm_name: 'Captação' }, 'ids não UUID'],
    [{ ids: [RESPONSE_ID], all: true, confirm_name: 'Captação' }, 'ids e all'],
    [
      { ids: Array(501).fill(RESPONSE_ID), confirm_name: 'Captação' },
      'ids demais',
    ],
  ] as [unknown, string][])(
    'corpo inválido (%#: %s) → 400 sem chamar a RPC',
    async (...args) => {
      expect((await del(args[0])).status).toBe(400);
      expect(h.rpcCalls).toHaveLength(0);
    }
  );

  it('confirmação com nome errado ou ausente → 400 sem apagar', async () => {
    expect((await del({ all: true, confirm_name: 'captacao' })).status).toBe(
      400
    );
    expect((await del({ all: true })).status).toBe(400);
    expect((await del({ all: true, confirm_name: 42 })).status).toBe(400);
    expect(h.rpcCalls).toHaveLength(0);
  });

  it('RPC recusa (42501: não é admin/da conta) → 404 e nada é removido', async () => {
    h.rpcResolver = () => ({ error: { code: '42501', message: 'x' } });
    expect((await del({ all: true, confirm_name: 'Captação' })).status).toBe(
      404
    );
    expect(h.removed).toEqual([]);
    expect(h.adminRpcCalls).toEqual([]);
  });

  it('falha ao remover do bucket não derruba a resposta (a varredura recolhe)', async () => {
    h.removeError = { message: 'down' };
    const res = await del({ all: true, confirm_name: 'Captação' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: 2, filesRemoved: 0 });
  });

  it('JSON inválido → 400', async () => {
    const res = await deleteResponses(
      new Request(`${BASE}/x`, { method: 'POST', body: '{' }),
      FORM_PARAMS
    );
    expect(res.status).toBe(400);
  });
});

// ------------------------------------------------------------
// POST …/responses/export
// ------------------------------------------------------------

describe('POST /api/forms/[id]/responses/export', () => {
  const rows = [
    {
      status: 'completed',
      source: 'link',
      started_at: '2026-11-10T12:00:00Z',
      completed_at: '2026-11-10T12:05:00Z',
      score: 5,
      band_key: 'hot',
      answers: {
        ...ANSWERS,
        nome: {
          label: 'Nome',
          type: 'short_text',
          value: '=HYPERLINK("http://evil")',
          points: 0,
        },
      },
      contacts: { name: 'Ana', phone: '5511999990000' },
    },
  ];
  const exp = (body: unknown) =>
    exportResponses(req('POST', '/x', body), FORM_PARAMS);
  const withRows = (data: unknown[] = rows, count = data.length) =>
    world((t) => (t === 'form_responses' ? { data, count } : undefined));

  it('CSV: BOM, cabeçalho traduzido, fórmula neutralizada e trilha em contact_exports', async () => {
    withRows();
    const res = await exp({
      format: 'csv',
      scope: { mode: 'filter', filter: { status: 'completed', band: 'hot' } },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    expect(res.headers.get('content-disposition')).toContain(
      'export.filenamePrefix-captacao-'
    );
    expect(res.headers.get('x-export-row-count')).toBe('1');
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]); // BOM UTF-8
    const text = new TextDecoder().decode(bytes);
    expect(text).toContain('"columns.contact_name"');
    expect(text).toContain('"\'=HYPERLINK(""http://evil"")"');
    expect(text).toContain('"Quente"');
    expect(text).toContain('"cnh.pdf"');

    expect(h.adminInserts).toHaveLength(1);
    expect(h.adminInserts[0].table).toBe('contact_exports');
    expect(h.adminInserts[0].row).toMatchObject({
      account_id: ACCOUNT_ID,
      user_id: USER_ID,
      source: 'form_responses',
      format: 'csv',
      scope: 'filter',
      row_count: 1,
      filter: { form_id: FORM_ID, statuses: ['completed'], band: 'hot' },
    });
    expect(h.adminInserts[0].row.fields).toEqual(
      expect.arrayContaining(['contact_name', 'block:nome', 'block:cnh'])
    );
    expect(h.recordFormActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'form.exported',
        metadata: expect.objectContaining({ row_count: 1, format: 'csv' }),
      })
    );
  });

  it('XLSX: tipo do arquivo e mesma trilha', async () => {
    withRows();
    const res = await exp({ format: 'xlsx', scope: { mode: 'filter' } });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('spreadsheetml.sheet');
    const buf = new Uint8Array(await res.arrayBuffer());
    expect(String.fromCharCode(buf[0], buf[1])).toBe('PK'); // zip
    expect(h.adminInserts[0].row.format).toBe('xlsx');
  });

  it('seleção: filtra por ids e não aplica os filtros da tela', async () => {
    withRows();
    const res = await exp({
      format: 'csv',
      scope: { mode: 'selection', ids: [RESPONSE_ID, R2] },
    });
    expect(res.status).toBe(200);
    expect(callsTo('form_responses', 'in')[0].args).toEqual([
      'id',
      [RESPONSE_ID, R2],
    ]);
    expect(h.adminInserts[0].row).toMatchObject({
      scope: 'selection',
      filter: { form_id: FORM_ID, selected: 2 },
    });
  });

  it('columns restringe os blocos exportados', async () => {
    withRows();
    const res = await exp({
      format: 'csv',
      scope: { mode: 'filter' },
      columns: ['interesse'],
    });
    const text = await res.text();
    expect(text).toContain('"Interesse"');
    expect(text).not.toContain('"Nome"');
    expect(h.adminInserts[0].row.fields).toEqual(
      expect.not.arrayContaining(['block:nome'])
    );
  });

  it('acima do teto → 413 sem gerar arquivo nem trilha', async () => {
    withRows([], 50_001);
    const res = await exp({ format: 'csv', scope: { mode: 'filter' } });
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({
      error: 'export_too_large',
      total: 50_001,
    });
    expect(h.adminInserts).toHaveLength(0);
  });

  it.each([
    [{ scope: { mode: 'filter' } }, 'sem formato'],
    [{ format: 'pdf', scope: { mode: 'filter' } }, 'formato desconhecido'],
    [{ format: 'csv' }, 'sem scope'],
    [{ format: 'csv', scope: { mode: 'all' } }, 'modo desconhecido'],
    [
      { format: 'csv', scope: { mode: 'selection', ids: ['x'] } },
      'ids inválidos',
    ],
    [{ format: 'csv', scope: { mode: 'selection', ids: [] } }, 'ids vazio'],
    [
      { format: 'csv', scope: { mode: 'filter' }, columns: [1] },
      'columns inválido',
    ],
    [
      { format: 'csv', scope: { mode: 'filter', filter: { status: 'x' } } },
      'filtro inválido',
    ],
  ] as [unknown, string][])(
    'corpo inválido (%#: %s) → 400',
    async (...args) => {
      withRows();
      expect((await exp(args[0])).status).toBe(400);
      expect(h.adminInserts).toHaveLength(0);
    }
  );

  it('a falha ao gravar a trilha não derruba o download', async () => {
    withRows();
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    h.adminInsertThrows = true;
    const res = await exp({ format: 'csv', scope: { mode: 'filter' } });
    expect(res.status).toBe(200);
    spy.mockRestore();
  });
});

// ------------------------------------------------------------
// GET /api/contacts/[id]/form-responses
// ------------------------------------------------------------

describe('GET /api/contacts/[id]/form-responses', () => {
  it('padrão: concluídas, limite 20, com a ordem dos blocos de cada formulário', async () => {
    h.resolver = (table) => {
      if (table === 'form_responses') {
        return {
          data: [
            { id: RESPONSE_ID, form_id: FORM_ID, answers: ANSWERS },
            { id: R2, form_id: FORM_ID, answers: ANSWERS },
          ],
        };
      }
      if (table === 'form_fields') {
        return {
          data: [
            { form_id: FORM_ID, key: 'nome' },
            { form_id: FORM_ID, key: 'interesse' },
          ],
        };
      }
      return {};
    };
    const res = await contactResponses(req('GET', '/x'), CONTACT_PARAMS);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.responses).toHaveLength(2);
    expect(body.fieldOrders).toEqual({ [FORM_ID]: ['nome', 'interesse'] });
    expect(callsTo('form_responses', 'eq').map((c) => c.args)).toEqual(
      expect.arrayContaining([
        ['contact_id', CONTACT_ID],
        ['account_id', ACCOUNT_ID],
      ])
    );
    expect(callsTo('form_responses', 'in')[0].args).toEqual([
      'status',
      ['completed'],
    ]);
    expect(callsTo('form_responses', 'limit')[0].args).toEqual([20]);
    const select = callsTo('form_responses', 'select')[0].args[0] as string;
    expect(select).not.toMatch(/resume_token_hash|ip_hash|user_agent/);
  });

  it('sem respostas: não consulta os blocos', async () => {
    h.resolver = () => ({ data: [] });
    const res = await contactResponses(
      req('GET', '/x?status=completed,partial&limit=1'),
      CONTACT_PARAMS
    );
    expect(await res.json()).toEqual({ responses: [], fieldOrders: {} });
    expect(callsTo('form_fields', 'select')).toHaveLength(0);
    expect(callsTo('form_responses', 'limit')[0].args).toEqual([1]);
  });

  it.each(['?status=x', '?limit=0', '?limit=51', '?limit=abc'])(
    'filtro inválido %s → 400',
    async (qs) => {
      h.resolver = () => ({ data: [] });
      expect(
        (await contactResponses(req('GET', `/x${qs}`), CONTACT_PARAMS)).status
      ).toBe(400);
    }
  );
});
