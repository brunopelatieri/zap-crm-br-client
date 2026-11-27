import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

const h = vi.hoisted(() => ({
  ingestDocument: vi.fn(),
  loadEmbeddingsTarget: vi.fn(),
}));
vi.mock('@/lib/ai/knowledge', () => ({ ingestDocument: h.ingestDocument }));
vi.mock('@/lib/ai/config', () => ({
  loadEmbeddingsTarget: h.loadEmbeddingsTarget,
}));

import {
  hashContent,
  indexPendingDocuments,
  sweepKnowledgeIndexing,
} from './indexer';
import { MAX_INDEX_ATTEMPTS } from './limits';

// ------------------------------------------------------------
// Banco em memória: só o que o indexador usa de `ai_knowledge_documents`
// (select/update com eq, lt, or, order, limit, maybeSingle). O `or` do
// PostgREST é INTERPRETADO (`and(a.eq.x,b.lt.y),and(...)`), então o teste
// da varredura exercita o filtro real, não um stub.
// ------------------------------------------------------------
type Row = Record<string, unknown>;

function compare(op: string, a: unknown, b: string): boolean {
  if (op === 'eq') return String(a) === b;
  if (a === null || a === undefined) return false;
  const left = new Date(String(a)).getTime();
  const right = new Date(b).getTime();
  if (op === 'lt') return left < right;
  throw new Error(`op ${op} não suportado no fake`);
}

class Query {
  private filters: ((r: Row) => boolean)[] = [];
  private patch: Row | null = null;
  private max = Infinity;
  private orderCol: string | null = null;

  constructor(private rows: Row[]) {}

  select() {
    return this;
  }
  update(patch: Row) {
    this.patch = patch;
    return this;
  }
  eq(col: string, val: unknown) {
    this.filters.push((r) => compare('eq', r[col], String(val)));
    return this;
  }
  lt(col: string, val: string) {
    this.filters.push((r) => compare('lt', r[col], val));
    return this;
  }
  or(expr: string) {
    const groups = [...expr.matchAll(/and\(([^)]*)\)/g)].map((m) =>
      m[1].split(',').map((c) => {
        const [col, op, ...rest] = c.split('.');
        return { col, op, val: rest.join('.') };
      })
    );
    this.filters.push((r) =>
      groups.some((g) => g.every((c) => compare(c.op, r[c.col], c.val)))
    );
    return this;
  }
  in() {
    return this;
  }
  order(col: string) {
    this.orderCol = col;
    return this;
  }
  limit(n: number) {
    this.max = n;
    return this;
  }
  private run(): Row[] {
    let hit = this.rows.filter((r) => this.filters.every((f) => f(r)));
    if (this.orderCol)
      hit = [...hit].sort((a, b) =>
        String(a[this.orderCol!]).localeCompare(String(b[this.orderCol!]))
      );
    hit = hit.slice(0, this.max);
    if (this.patch) {
      for (const r of hit) Object.assign(r, this.patch);
    }
    return hit.map((r) => ({ ...r }));
  }
  maybeSingle() {
    const [first] = this.run();
    return Promise.resolve({ data: first ?? null, error: null });
  }
  then<T>(
    resolve: (v: { data: Row[]; error: null }) => T | PromiseLike<T>
  ): PromiseLike<T> {
    return Promise.resolve(resolve({ data: this.run(), error: null }));
  }
}

const NOW = new Date('2026-11-27T12:00:00.000Z');
const ago = (minutes: number) =>
  new Date(NOW.getTime() - minutes * 60_000).toISOString();

function doc(over: Row = {}): Row {
  return {
    id: 'd1',
    account_id: 'acct',
    title: 'Política',
    source_type: 'text',
    content: 'Texto do documento.',
    status: 'pending',
    index_attempts: 0,
    index_started_at: null,
    index_error: null,
    chunk_count: 0,
    indexed_at: null,
    created_at: ago(60),
    updated_at: ago(30),
    ...over,
  };
}

function makeDb(rows: Row[]) {
  return {
    rows,
    db: { from: () => new Query(rows) } as unknown as SupabaseClient,
  };
}

const T = { provider: 'openai' as const, apiKey: 'sk-x' };

beforeEach(() => {
  h.ingestDocument.mockReset();
  h.loadEmbeddingsTarget.mockReset();
  h.loadEmbeddingsTarget.mockResolvedValue({ target: T, corrupt: false });
  h.ingestDocument.mockResolvedValue({
    chunkCount: 3,
    embeddingModel: 'text-embedding-3-small',
    embedError: null,
  });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

describe('hashContent', () => {
  it('is a stable SHA-256 hex of the UTF-8 text', () => {
    expect(hashContent('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
    );
    expect(hashContent('ç')).toBe(hashContent('ç'));
    expect(hashContent('a')).not.toBe(hashContent('b'));
  });
});

describe('indexPendingDocuments (the after() path)', () => {
  it('claims a pending document, indexes it and marks it ready', async () => {
    const { db, rows } = makeDb([doc()]);
    const out = await indexPendingDocuments(db, 'acct', ['d1']);
    expect(out.ready).toBe(1);
    expect(rows[0]).toMatchObject({
      status: 'ready',
      index_error: null,
      index_attempts: 0,
      chunk_count: 3,
    });
    expect(rows[0].indexed_at).toBeTruthy();
    expect(h.ingestDocument).toHaveBeenCalledWith(
      db,
      'acct',
      { embeddingsTarget: T },
      {
        id: 'd1',
        title: 'Política',
        sourceType: 'text',
        content: 'Texto do documento.',
      }
    );
  });

  it('marks the document `indexing` with an attempt counted while it works', async () => {
    const { db, rows } = makeDb([doc()]);
    let seen: Row | null = null;
    h.ingestDocument.mockImplementation(async () => {
      seen = { ...rows[0] };
      return { chunkCount: 1, embeddingModel: null, embedError: null };
    });
    await indexPendingDocuments(db, 'acct', ['d1']);
    expect(seen).toMatchObject({ status: 'indexing', index_attempts: 1 });
    expect(seen!.index_started_at).toBeTruthy();
  });

  it('ignores a document that is not pending, or belongs to another account', async () => {
    const { db } = makeDb([
      doc({ id: 'ready1', status: 'ready' }),
      doc({ id: 'busy', status: 'indexing', index_started_at: ago(1) }),
      doc({ id: 'other', account_id: 'outra' }),
    ]);
    const out = await indexPendingDocuments(db, 'acct', [
      'ready1',
      'busy',
      'other',
      'nao-existe',
    ]);
    expect(out.skipped).toBe(4);
    expect(h.ingestDocument).not.toHaveBeenCalled();
  });

  it('on an embeddings failure keeps the lexical chunks, goes back to pending and records the code', async () => {
    const { db, rows } = makeDb([doc()]);
    h.ingestDocument.mockResolvedValue({
      chunkCount: 3,
      embeddingModel: null,
      embedError: Object.assign(new Error('Insufficient credits'), {
        code: 'insufficient_credits',
      }),
    });
    const out = await indexPendingDocuments(db, 'acct', ['d1']);
    expect(out.retry).toBe(1);
    expect(rows[0]).toMatchObject({
      status: 'pending',
      index_attempts: 1,
      index_error: 'embeddings_failed:insufficient_credits',
      chunk_count: 3, // já pesquisável por palavra
    });
  });

  it('becomes `error` once the attempts are used up (the last one still stores lexical chunks)', async () => {
    const { db, rows } = makeDb([
      doc({ index_attempts: MAX_INDEX_ATTEMPTS - 1 }),
    ]);
    h.ingestDocument.mockResolvedValue({
      chunkCount: 3,
      embeddingModel: null,
      embedError: new Error('boom'),
    });
    const out = await indexPendingDocuments(db, 'acct', ['d1']);
    expect(out.error).toBe(1);
    expect(rows[0]).toMatchObject({
      status: 'error',
      index_attempts: MAX_INDEX_ATTEMPTS,
      index_error: 'embeddings_failed',
      chunk_count: 3,
    });
  });

  it('a thrown DB error is a state, not an exception', async () => {
    const { db, rows } = makeDb([doc()]);
    h.ingestDocument.mockRejectedValue(new Error('connection reset'));
    const out = await indexPendingDocuments(db, 'acct', ['d1']);
    expect(out.retry).toBe(1);
    expect(rows[0]).toMatchObject({
      status: 'pending',
      index_error: 'indexing_failed',
    });
  });

  it('a document with no text becomes `error` at once (nothing to retry)', async () => {
    const { db, rows } = makeDb([doc()]);
    h.ingestDocument.mockResolvedValue({
      chunkCount: 0,
      embeddingModel: null,
      embedError: null,
    });
    await indexPendingDocuments(db, 'acct', ['d1']);
    expect(rows[0]).toMatchObject({
      status: 'error',
      index_error: 'empty_text',
      index_attempts: 1,
    });
  });

  it('an unreadable embeddings key indexes by keywords only and says so', async () => {
    h.loadEmbeddingsTarget.mockResolvedValue({ target: null, corrupt: true });
    const { db, rows } = makeDb([doc()]);
    await indexPendingDocuments(db, 'acct', ['d1']);
    expect(rows[0]).toMatchObject({
      status: 'ready',
      index_error: 'embeddings_key_unreadable',
    });
    expect(h.ingestDocument.mock.calls[0][2]).toEqual({
      embeddingsTarget: null,
    });
  });

  it('does not overwrite a document that went back to pending while it was being indexed', async () => {
    const { db, rows } = makeDb([doc()]);
    h.ingestDocument.mockImplementation(async () => {
      // O admin editou o texto no meio da indexação: a rota volta o documento a `pending`.
      rows[0].status = 'pending';
      rows[0].index_attempts = 0;
      return { chunkCount: 3, embeddingModel: null, embedError: null };
    });
    await indexPendingDocuments(db, 'acct', ['d1']);
    expect(rows[0]).toMatchObject({ status: 'pending', index_attempts: 0 });
  });

  it('indexes several documents one at a time, claiming each only on its turn', async () => {
    const { db, rows } = makeDb([doc({ id: 'a' }), doc({ id: 'b' })]);
    const statusOfOtherWhileFirstRuns: unknown[] = [];
    h.ingestDocument.mockImplementation(
      async (_d, _a, _c, d: { id: string }) => {
        const other = rows.find((r) => r.id !== d.id)!;
        statusOfOtherWhileFirstRuns.push(other.status);
        return { chunkCount: 1, embeddingModel: null, embedError: null };
      }
    );
    await indexPendingDocuments(db, 'acct', ['a', 'b']);
    // Enquanto `a` indexa, `b` ainda é `pending` (não "indexing parado").
    expect(statusOfOtherWhileFirstRuns[0]).toBe('pending');
    expect(rows.map((r) => r.status)).toEqual(['ready', 'ready']);
  });

  it('never throws', async () => {
    h.loadEmbeddingsTarget.mockRejectedValue(new Error('db down'));
    const { db } = makeDb([doc()]);
    await expect(
      indexPendingDocuments(db, 'acct', ['d1'])
    ).resolves.toBeDefined();
  });
});

describe('sweepKnowledgeIndexing (cron phase, D-9)', () => {
  it('picks up pending documents (past the grace period) and indexing stalled for over 10 minutes', async () => {
    const { db, rows } = makeDb([
      doc({ id: 'pend', updated_at: ago(5) }),
      doc({
        id: 'stuck',
        status: 'indexing',
        index_attempts: 1,
        index_started_at: ago(11),
      }),
    ]);
    const out = await sweepKnowledgeIndexing(db, NOW);
    expect(out).toMatchObject({ candidates: 2, claimed: 2, ready: 2 });
    expect(rows.map((r) => r.status)).toEqual(['ready', 'ready']);
    // O retomado conta a tentativa a mais: 1 → 2 ao ser reivindicado.
    expect(h.ingestDocument).toHaveBeenCalledTimes(2);
  });

  it('leaves alone a pending document that is brand new (the route after() is on it) and a live indexing', async () => {
    const { db, rows } = makeDb([
      doc({ id: 'novo', updated_at: ago(1) }),
      doc({ id: 'vivo', status: 'indexing', index_started_at: ago(9) }),
      doc({ id: 'pronto', status: 'ready' }),
      doc({ id: 'erro', status: 'error' }),
    ]);
    const out = await sweepKnowledgeIndexing(db, NOW);
    expect(out.candidates).toBe(0);
    expect(h.ingestDocument).not.toHaveBeenCalled();
    expect(rows.map((r) => r.status)).toEqual([
      'pending',
      'indexing',
      'ready',
      'error',
    ]);
  });

  it('respects the per-cycle limit, oldest first', async () => {
    const { db, rows } = makeDb(
      Array.from({ length: 8 }, (_, i) =>
        doc({ id: `d${i}`, created_at: ago(100 - i), updated_at: ago(50) })
      )
    );
    const out = await sweepKnowledgeIndexing(db, NOW, { limit: 3 });
    expect(out.candidates).toBe(3);
    expect(rows.filter((r) => r.status === 'ready').map((r) => r.id)).toEqual([
      'd0',
      'd1',
      'd2',
    ]);
    expect(rows.filter((r) => r.status === 'pending')).toHaveLength(5);
  });

  it('turns a document that stalls every time into `error` instead of retrying forever', async () => {
    const { db, rows } = makeDb([
      doc({
        status: 'indexing',
        index_attempts: MAX_INDEX_ATTEMPTS,
        index_started_at: ago(30),
      }),
    ]);
    const out = await sweepKnowledgeIndexing(db, NOW);
    expect(out.failed).toBe(1);
    expect(h.ingestDocument).not.toHaveBeenCalled();
    expect(rows[0]).toMatchObject({
      status: 'error',
      index_error: 'indexing_stalled',
    });
  });

  it('a retry that fails again moves on the attempt count and finally errors', async () => {
    const { db, rows } = makeDb([doc({ updated_at: ago(5) })]);
    h.ingestDocument.mockRejectedValue(new Error('x'));
    for (let cycle = 0; cycle < MAX_INDEX_ATTEMPTS; cycle++) {
      rows[0].updated_at = ago(5); // passou o tempo de espera
      await sweepKnowledgeIndexing(db, NOW);
    }
    expect(rows[0]).toMatchObject({
      status: 'error',
      index_attempts: MAX_INDEX_ATTEMPTS,
    });
    // Uma rodada a mais não mexe mais nele.
    await sweepKnowledgeIndexing(db, NOW);
    expect(h.ingestDocument).toHaveBeenCalledTimes(MAX_INDEX_ATTEMPTS);
  });

  it('loads the embeddings target once per account in a cycle', async () => {
    const { db } = makeDb([
      doc({ id: 'a1', account_id: 'A', updated_at: ago(5) }),
      doc({ id: 'a2', account_id: 'A', updated_at: ago(5) }),
      doc({ id: 'b1', account_id: 'B', updated_at: ago(5) }),
    ]);
    await sweepKnowledgeIndexing(db, NOW);
    expect(h.loadEmbeddingsTarget).toHaveBeenCalledTimes(2);
  });

  it('does not index a document another process claimed first', async () => {
    const { db, rows } = makeDb([doc({ updated_at: ago(5) })]);
    // Entre o SELECT e o UPDATE condicional, o `after()` da rota levou o documento.
    const realFrom = (db as unknown as { from: () => Query }).from;
    let first = true;
    (db as unknown as { from: () => Query }).from = () => {
      const q = realFrom();
      if (first) {
        first = false;
        return q;
      }
      rows[0].status = 'indexing';
      rows[0].index_attempts = 1;
      rows[0].index_started_at = ago(0);
      return q;
    };
    const out = await sweepKnowledgeIndexing(db, NOW);
    expect(out.candidates).toBe(1);
    expect(out.claimed).toBe(0);
    expect(h.ingestDocument).not.toHaveBeenCalled();
  });

  it('never throws, even when the query fails', async () => {
    const db = {
      from: () => ({
        select: () => ({
          or: () => ({
            order: () => ({
              limit: () =>
                Promise.resolve({ data: null, error: { message: 'boom' } }),
            }),
          }),
        }),
      }),
    } as unknown as SupabaseClient;
    await expect(sweepKnowledgeIndexing(db, NOW)).resolves.toMatchObject({
      candidates: 0,
    });
  });
});
