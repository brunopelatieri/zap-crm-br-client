import { beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// ---------------------------------------------------------------------------
// SPEC 089 F2 — rotas da base de conhecimento. As rotas, os extratores e a
// guarda de SSRF são os reais; o banco é um fake mínimo que registra o que
// foi gravado, e o `after()` só guarda o callback (a indexação em si tem o
// teste dela em `src/lib/ai/ingest/indexer.test.ts`).
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

const h = vi.hoisted(() => ({
  orExpressions: [] as string[],
  role: 'admin' as 'admin' | 'agent',
  inPlan: true,
  tables: {} as Record<string, Row[]>,
  writes: [] as {
    op: 'insert' | 'update';
    payload: Row;
    filters: [string, unknown][];
  }[],
  insertError: null as null | { message: string },
  afters: [] as (() => Promise<void> | void)[],
  indexPending: vi.fn(),
  target: { target: null as unknown, corrupt: false },
}));

function fakeSupabase() {
  const from = (table: string) => {
    const filters: [string, unknown][] = [];
    const orExpressions = h.orExpressions;
    let pendingUpdate: Row | null = null;
    let pendingInsert: Row | null = null;
    const rows = () =>
      (h.tables[table] ?? []).filter((r) =>
        filters.every(([k, v]) =>
          Array.isArray(v) ? v.includes(r[k]) : r[k] === v
        )
      );
    const exec = () => {
      if (pendingInsert) {
        if (h.insertError) return { data: null, error: h.insertError };
        const row = { id: `new-${h.writes.length}`, ...pendingInsert };
        h.writes.push({ op: 'insert', payload: pendingInsert, filters: [] });
        (h.tables[table] ??= []).push(row);
        return { data: row, error: null };
      }
      if (pendingUpdate) {
        h.writes.push({
          op: 'update',
          payload: pendingUpdate,
          filters: [...filters],
        });
        const hit = rows();
        hit.forEach((r) => Object.assign(r, pendingUpdate));
        return { data: hit, error: null };
      }
      return { data: rows(), error: null };
    };
    const chain: Record<string, unknown> = {
      select: () => chain,
      eq: (k: string, v: unknown) => {
        filters.push([k, v]);
        return chain;
      },
      in: (k: string, v: unknown[]) => {
        filters.push([k, v]);
        return chain;
      },
      // O `or` do PostgREST não é interpretado aqui: só registrado, para o
      // teste conferir que a rota o mandou. (Fica de fora do filtro de linhas.)
      or: (expr: string) => {
        orExpressions.push(expr);
        return chain;
      },
      order: () => chain,
      limit: () => chain,
      insert: (payload: Row) => {
        pendingInsert = payload;
        return chain;
      },
      update: (payload: Row) => {
        pendingUpdate = payload;
        return chain;
      },
      single: () => {
        const r = exec();
        return Promise.resolve(r);
      },
      maybeSingle: () => {
        const r = exec();
        const data = Array.isArray(r.data) ? (r.data[0] ?? null) : r.data;
        return Promise.resolve({ data, error: r.error });
      },
      then: (resolve: (v: unknown) => void) => resolve(exec()),
    };
    return chain;
  };
  return { from };
}

vi.mock('next/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('next/server')>();
  return {
    ...actual,
    after: (fn: () => Promise<void> | void) => void h.afters.push(fn),
  };
});

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
      if (!hasMinRole(h.role, min))
        throw new actual.ForbiddenError('requires role');
      return ctx();
    }),
    getCurrentAccount: vi.fn(async () => ctx()),
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

vi.mock('@/lib/ai/config', () => ({
  loadEmbeddingsTarget: vi.fn(async () => h.target),
}));

vi.mock('@/lib/ai/admin-client', () => ({
  supabaseAdmin: () => ({ admin: true }),
}));

vi.mock('@/lib/ai/ingest/indexer', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ai/ingest/indexer')>()),
  indexPendingDocuments: h.indexPending,
}));

import { GET, POST } from './route';
import { POST as UPLOAD } from './upload/route';
import { POST as IMPORT_URL } from './import-url/route';
import { POST as REINDEX } from './reindex/route';
import { GET as GET_ONE, PATCH } from './[id]/route';
import { hashContent } from '@/lib/ai/ingest/indexer';
import { buildFaqText } from '@/lib/ai/ingest/faq';
import { MAX_FILE_BYTES } from '@/lib/ai/ingest/limits';

const json = (body: unknown) =>
  new Request('http://test/api/ai/knowledge', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

const fixture = (name: string) =>
  new Uint8Array(
    fs.readFileSync(
      path.join(process.cwd(), 'src/lib/ai/ingest/__fixtures__', name)
    )
  );

/** Multipart de verdade: o `Request` calcula o Content-Length sozinho. */
async function multipart(
  file: { name: string; bytes: Uint8Array; type?: string },
  fields: Record<string, string> = {}
) {
  const form = new FormData();
  form.set(
    'file',
    new File([file.bytes as BlobPart], file.name, { type: file.type ?? '' })
  );
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  const probe = new Request('http://test/api/ai/knowledge/upload', {
    method: 'POST',
    body: form,
  });
  // O `Request` não põe Content-Length sozinho: um cliente real põe.
  const body = await probe.arrayBuffer();
  return new Request('http://test/api/ai/knowledge/upload', {
    method: 'POST',
    headers: {
      'content-type': probe.headers.get('content-type')!,
      'content-length': String(body.byteLength),
    },
    body,
  });
}

const inserts = () => h.writes.filter((w) => w.op === 'insert');

beforeEach(() => {
  h.role = 'admin';
  h.inPlan = true;
  h.tables = { ai_knowledge_documents: [] };
  h.writes = [];
  h.orExpressions = [];
  h.insertError = null;
  h.afters = [];
  h.indexPending.mockReset();
  h.target = { target: null, corrupt: false };
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('POST /api/ai/knowledge (text and Q&A)', () => {
  it('saves pasted text as pending and schedules indexing with after()', async () => {
    const res = await POST(
      json({
        title: ' Horários ',
        content: ' Seg a sex, 9h. ',
        tags: 'Loja, horário, loja',
      })
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      success: true,
      status: 'pending',
    });
    expect(inserts()).toHaveLength(1);
    expect(inserts()[0].payload).toMatchObject({
      account_id: 'acct-1',
      created_by: 'user-1',
      title: 'Horários',
      content: 'Seg a sex, 9h.',
      source_type: 'text',
      status: 'pending',
      index_attempts: 0,
      char_count: 'Seg a sex, 9h.'.length,
      content_hash: hashContent('Seg a sex, 9h.'),
      tags: ['Loja', 'horário'], // sem repetir, sem diferenciar caixa
    });
    // A rota responde sem indexar: o trabalho está só agendado.
    expect(h.indexPending).not.toHaveBeenCalled();
    expect(h.afters).toHaveLength(1);
    await h.afters[0]();
    expect(h.indexPending).toHaveBeenCalledWith({ admin: true }, 'acct-1', [
      'new-0',
    ]);
  });

  it('saves question/answer pairs as a faq document in the canonical text format', async () => {
    const pairs = [{ question: 'Aceita Pix?', answer: 'Sim.' }];
    const res = await POST(json({ source: 'faq', title: 'FAQ', pairs }));
    expect(res.status).toBe(200);
    expect(inserts()[0].payload).toMatchObject({
      source_type: 'faq',
      content: buildFaqText(pairs),
    });
  });

  it('rejects invalid pairs without saving anything', async () => {
    const res = await POST(
      json({ source: 'faq', title: 'FAQ', pairs: [{ question: 'P?' }] })
    );
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('faq_invalid');
    expect(inserts()).toHaveLength(0);
    expect(h.afters).toHaveLength(0);
  });

  it('requires title and content, and a non-agent role', async () => {
    expect((await POST(json({ title: 'x' }))).status).toBe(422);
    expect((await POST(json({ content: 'x' }))).status).toBe(400);
    h.role = 'agent';
    expect((await POST(json({ title: 'x', content: 'y' }))).status).toBe(403);
  });

  it('returns 409 for the same text again and does not create or index a second document (idempotence)', async () => {
    h.tables.ai_knowledge_documents = [
      {
        id: 'old',
        title: 'Antigo',
        account_id: 'acct-1',
        content_hash: hashContent('mesmo texto'),
      },
    ];
    const res = await POST(json({ title: 'Novo', content: 'mesmo texto' }));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      code: 'duplicate_content',
      existing: { id: 'old', title: 'Antigo' },
    });
    expect(inserts()).toHaveLength(0);
    expect(h.afters).toHaveLength(0);
  });

  it('does not treat the same text in ANOTHER account as a duplicate', async () => {
    h.tables.ai_knowledge_documents = [
      {
        id: 'old',
        title: 'Antigo',
        account_id: 'outra-conta',
        content_hash: hashContent('mesmo texto'),
      },
    ];
    expect(
      (await POST(json({ title: 'Novo', content: 'mesmo texto' }))).status
    ).toBe(200);
  });

  it('translates the database quota error into 403 quota_exceeded', async () => {
    h.insertError = { message: 'QUOTA_EXCEEDED:knowledge_documents:51:50' };
    const res = await POST(json({ title: 'Novo', content: 'texto' }));
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({
      code: 'quota_exceeded',
      quota: { metric: 'knowledge_documents', used: 51, limit: 50 },
    });
    expect(h.afters).toHaveLength(0);
  });

  it('another quota metric is not mistaken for the knowledge quota', async () => {
    h.insertError = { message: 'QUOTA_EXCEEDED:contacts:11:10' };
    expect((await POST(json({ title: 'Novo', content: 'texto' }))).status).toBe(
      500
    );
  });

  it('refuses text over 500k characters', async () => {
    const res = await POST(
      json({ title: 'Grande', content: 'x'.repeat(500_001) })
    );
    expect(res.status).toBe(413);
    expect((await res.json()).code).toBe('text_too_long');
  });

  it('answers 403 FEATURE_NOT_IN_PLAN when the plan has no AI (D-20)', async () => {
    h.inPlan = false;
    const res = await POST(json({ title: 'x', content: 'y' }));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('FEATURE_NOT_IN_PLAN');
    expect(inserts()).toHaveLength(0);
  });
});

describe('GET /api/ai/knowledge', () => {
  it('lists documents with the indexing state, without the body', async () => {
    h.tables.ai_knowledge_documents = [
      { id: 'a', account_id: 'acct-1', title: 'A', status: 'ready' },
    ];
    const res = await GET();
    expect(res.status).toBe(200);
    expect((await res.json()).documents).toHaveLength(1);
  });
});

describe('POST /api/ai/knowledge/upload', () => {
  it('extracts a real PDF and saves only its text as a pending file document', async () => {
    const res = await UPLOAD(
      await multipart(
        {
          name: 'politica-trocas.pdf',
          bytes: fixture('politica-trocas.pdf'),
          type: 'application/pdf',
        },
        { tags: 'trocas' }
      )
    );
    expect(res.status).toBe(200);
    const payload = inserts()[0].payload;
    expect(payload).toMatchObject({
      source_type: 'file',
      source_name: 'politica-trocas.pdf',
      mime_type: 'application/pdf',
      status: 'pending',
      title: 'politica-trocas',
      tags: ['trocas'],
    });
    expect(payload.content).toContain(
      'O prazo para troca é de 7 dias corridos'
    );
    // Só o texto é guardado: nenhum campo carrega os bytes do arquivo.
    expect(JSON.stringify(payload)).not.toContain('%PDF');
    expect(h.afters).toHaveLength(1);
  });

  it('accepts a DOCX and uses the typed title when given', async () => {
    const res = await UPLOAD(
      await multipart(
        { name: 'p.docx', bytes: fixture('politica-trocas.docx') },
        { title: 'Minha política' }
      )
    );
    expect(res.status).toBe(200);
    expect(inserts()[0].payload).toMatchObject({
      title: 'Minha política',
      source_type: 'file',
    });
    expect(String(inserts()[0].payload.content)).toContain('## Frete');
  });

  it('maps extraction failures to 4xx codes and saves nothing', async () => {
    const scanned = await UPLOAD(
      await multipart({ name: 'a.pdf', bytes: fixture('digitalizado.pdf') })
    );
    expect(scanned.status).toBe(422);
    expect((await scanned.json()).code).toBe('empty_text');

    const locked = await UPLOAD(
      await multipart({ name: 'a.pdf', bytes: fixture('protegido.pdf') })
    );
    expect((await locked.json()).code).toBe('pdf_encrypted');

    const wrongType = await UPLOAD(
      await multipart({ name: 'a.xlsx', bytes: new Uint8Array([1]) })
    );
    expect(wrongType.status).toBe(415);

    expect(inserts()).toHaveLength(0);
    expect(h.afters).toHaveLength(0);
  });

  it('refuses by the declared size before reading the body (413), and without Content-Length (411)', async () => {
    const huge = new Request('http://test/api/ai/knowledge/upload', {
      method: 'POST',
      headers: {
        'content-type': 'multipart/form-data; boundary=x',
        'content-length': String(MAX_FILE_BYTES + 1024 * 1024),
      },
      body: 'x',
    });
    const res = await UPLOAD(huge);
    expect(res.status).toBe(413);
    expect((await res.json()).code).toBe('file_too_large');

    const noLength = new Request('http://test/api/ai/knowledge/upload', {
      method: 'POST',
      headers: { 'content-type': 'multipart/form-data; boundary=x' },
      body: 'x',
    });
    expect((await UPLOAD(noLength)).status).toBe(411);
  });

  it('refuses an upload that has no file', async () => {
    const form = new FormData();
    form.set('title', 'sem arquivo');
    const probe = new Request('http://test/u', { method: 'POST', body: form });
    const body = await probe.arrayBuffer();
    const res = await UPLOAD(
      new Request('http://test/u', {
        method: 'POST',
        headers: {
          'content-type': probe.headers.get('content-type')!,
          'content-length': String(body.byteLength),
        },
        body,
      })
    );
    expect(res.status).toBe(400);
  });

  it('requires admin and the AI plan feature', async () => {
    h.role = 'agent';
    expect(
      (
        await UPLOAD(
          await multipart({ name: 'a.txt', bytes: new Uint8Array([97]) })
        )
      ).status
    ).toBe(403);
    h.role = 'admin';
    h.inPlan = false;
    expect(
      (
        await UPLOAD(
          await multipart({ name: 'a.txt', bytes: new Uint8Array([97]) })
        )
      ).status
    ).toBe(403);
  });
});

describe('POST /api/ai/knowledge/import-url', () => {
  it('refuses an address blocked by the SSRF guard (400 url_blocked) without saving or scheduling anything', async () => {
    for (const url of [
      'http://127.0.0.1:3000/',
      'http://169.254.169.254/latest/meta-data/',
      'http://localhost/admin',
      'http://10.0.0.5/',
    ]) {
      const res = await IMPORT_URL(json({ url }));
      expect(res.status).toBe(400);
      expect((await res.json()).code).toBe('url_blocked');
    }
    expect(inserts()).toHaveLength(0);
    expect(h.afters).toHaveLength(0);
  });

  it('refuses a malformed or non-http URL', async () => {
    expect(
      (await (await IMPORT_URL(json({ url: 'file:///etc/passwd' }))).json())
        .code
    ).toBe('invalid_url');
    expect((await IMPORT_URL(json({}))).status).toBe(400);
  });

  it('imports a public page: only its text is saved, with the final URL as the source', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        '<html><head><title>Frete da Loja</title></head><body><h1>Frete</h1><p>Entrega em 5 dias.</p></body></html>',
        {
          headers: { 'content-type': 'text/html' },
        }
      )
    );
    vi.stubGlobal('fetch', fetchMock);
    try {
      const res = await IMPORT_URL(
        json({ url: 'http://93.184.216.34/frete#topo', tags: ['site'] })
      );
      expect(res.status).toBe(200);
      expect(fetchMock.mock.calls[0][1]).toMatchObject({ redirect: 'manual' });
      expect(inserts()[0].payload).toMatchObject({
        source_type: 'url',
        source_url: 'http://93.184.216.34/frete',
        mime_type: 'text/html',
        title: 'Frete da Loja',
        tags: ['site'],
        status: 'pending',
      });
      expect(String(inserts()[0].payload.content)).toContain(
        'Entrega em 5 dias.'
      );
      expect(h.afters).toHaveLength(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('PATCH /api/ai/knowledge/[id]', () => {
  const params = (id = 'doc-1') => ({ params: Promise.resolve({ id }) });
  const patch = (body: unknown, id = 'doc-1') =>
    PATCH(
      new Request('http://test/x', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
      params(id)
    );

  beforeEach(() => {
    h.tables.ai_knowledge_documents = [
      {
        id: 'doc-1',
        account_id: 'acct-1',
        title: 'Título',
        source_type: 'text',
        content: 'texto atual',
        content_hash: hashContent('texto atual'),
        status: 'ready',
      },
    ];
  });

  it('does not reindex when the text is the same (content_hash)', async () => {
    const res = await patch({ title: 'Título', content: 'texto atual' });
    expect(await res.json()).toEqual({ success: true, reindexed: false });
    expect(h.writes).toHaveLength(0);
    expect(h.afters).toHaveLength(0);
  });

  it('changing only tags or the enabled switch takes effect without reindexing', async () => {
    const res = await patch({ tags: 'a, b', is_enabled: false });
    expect(await res.json()).toEqual({ success: true, reindexed: false });
    expect(h.writes[0].payload).toEqual({
      tags: ['a', 'b'],
      is_enabled: false,
    });
    expect(h.afters).toHaveLength(0);
  });

  it('changed text goes back to pending with the attempts zeroed, and is re-indexed in after()', async () => {
    const res = await patch({ content: 'texto novo' });
    expect(await res.json()).toEqual({ success: true, reindexed: true });
    expect(h.writes[0].payload).toMatchObject({
      content: 'texto novo',
      content_hash: hashContent('texto novo'),
      char_count: 10,
      status: 'pending',
      index_attempts: 0,
      index_error: null,
    });
    expect(h.afters).toHaveLength(1);
  });

  it('a changed title also re-indexes (the title is prefixed to every chunk)', async () => {
    await patch({ title: 'Outro título' });
    expect(h.writes[0].payload).toMatchObject({
      title: 'Outro título',
      status: 'pending',
    });
  });

  it('rejects a non-boolean switch, empty title and pairs on a non-faq document', async () => {
    expect((await patch({ is_enabled: 'sim' })).status).toBe(400);
    expect((await patch({ title: '  ' })).status).toBe(400);
    expect((await patch({ pairs: [] })).status).toBe(400);
  });

  it('is 404 for a document of another account', async () => {
    h.tables.ai_knowledge_documents[0].account_id = 'outra';
    expect((await patch({ tags: 'x' })).status).toBe(404);
  });

  it('rebuilds a faq document from pairs', async () => {
    h.tables.ai_knowledge_documents[0].source_type = 'faq';
    await patch({ pairs: [{ question: 'P?', answer: 'R' }] });
    expect(h.writes[0].payload.content).toBe('Q: P?\nA: R');
  });

  it('GET returns the pairs of a faq document', async () => {
    h.tables.ai_knowledge_documents[0].source_type = 'faq';
    h.tables.ai_knowledge_documents[0].content = 'Q: P?\nA: R';
    const res = await GET_ONE(new Request('http://test/x'), params());
    expect((await res.json()).pairs).toEqual([{ question: 'P?', answer: 'R' }]);
  });
});

describe('POST /api/ai/knowledge/reindex', () => {
  const reindex = (body?: unknown) =>
    REINDEX(
      new Request('http://test/x', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
    );
  const A = '11111111-1111-4111-8111-111111111111';

  beforeEach(() => {
    h.tables.ai_knowledge_documents = [
      { id: A, account_id: 'acct-1', status: 'error' },
      {
        id: '22222222-2222-4222-8222-222222222222',
        account_id: 'acct-1',
        status: 'ready',
      },
      {
        id: '33333333-3333-4333-8333-333333333333',
        account_id: 'outra',
        status: 'ready',
      },
    ];
  });

  it('puts the chosen documents back to pending and indexes them in after()', async () => {
    const res = await reindex({ ids: [A] });
    expect(await res.json()).toEqual({ success: true, queued: 1 });
    expect(h.writes[0].payload).toMatchObject({
      status: 'pending',
      index_attempts: 0,
      index_error: null,
    });
    expect(h.afters).toHaveLength(1);
    await h.afters[0]();
    expect(h.indexPending).toHaveBeenCalledWith({ admin: true }, 'acct-1', [A]);
  });

  it('without ids reindexes every document of the ACCOUNT only', async () => {
    const res = await reindex();
    expect((await res.json()).queued).toBe(2);
    expect(h.writes[0].filters).toContainEqual(['account_id', 'acct-1']);
  });

  it('does not pull back a document that is indexing right now (only an orphaned one)', async () => {
    await reindex({ ids: [A] });
    expect(h.orExpressions).toHaveLength(1);
    expect(h.orExpressions[0]).toMatch(
      /^status\.neq\.indexing,index_started_at\.lt\.\d{4}-\d{2}-\d{2}T/
    );
  });

  it('cannot queue a document of another account by id', async () => {
    const res = await reindex({
      ids: ['33333333-3333-4333-8333-333333333333'],
    });
    expect((await res.json()).queued).toBe(0);
    expect(h.afters).toHaveLength(0);
  });

  it('rejects malformed ids', async () => {
    expect((await reindex({ ids: ['x'] })).status).toBe(400);
    expect((await reindex({ ids: [] })).status).toBe(400);
  });

  it('stops when the embeddings key cannot be decrypted, instead of faking a keyword-only pass', async () => {
    h.target = { target: null, corrupt: true };
    const res = await reindex({ ids: [A] });
    expect(await res.json()).toMatchObject({ success: false, queued: 0 });
    expect(h.writes).toHaveLength(0);
  });
});
