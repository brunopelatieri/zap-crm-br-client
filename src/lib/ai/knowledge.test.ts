import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

const T = { provider: 'openai' as const, apiKey: 'sk-x' };

const h = vi.hoisted(() => ({ embedTexts: vi.fn() }));
vi.mock('./embeddings', () => ({
  EMBEDDINGS_PROVIDER_CONFIG: {
    openai: { model: 'text-embedding-3-small' },
    openrouter: { model: 'openai/text-embedding-3-small' },
  },
  embedTexts: h.embedTexts,
  toVectorLiteral: (v: number[]) => `[${v.join(',')}]`,
}));

import {
  retrieveKnowledge,
  searchKnowledge,
  mapHybridRow,
  ingestDocument,
  type IngestDoc,
} from './knowledge';
import { KNOWLEDGE_MAX_DISTANCE } from './defaults';
// Rows of `match_ai_knowledge_hybrid` as the function returned them on a
// real Postgres 17 + pgvector (migration 104, verify harness): one chunk that
// matched both halves and one above the distance ceiling that only matched
// the words. Regenerate against the `vn` after the 104 is applied.
import hybridRows from './__fixtures__/match-hybrid-rows.json';

interface RpcCall {
  name: string;
  args: Record<string, unknown>;
}

interface FakeState {
  hybrid: unknown[];
  hybridError: { message: string } | null;
  chunkCount: number;
  rpcCalls: RpcCall[];
  inserted: Record<string, unknown>[] | null;
  insertCalls: number;
  deletedFor: string | null;
}

function makeDb() {
  const state: FakeState = {
    hybrid: [],
    hybridError: null,
    chunkCount: 5, // account has a non-empty KB by default
    rpcCalls: [],
    inserted: null,
    insertCalls: 0,
    deletedFor: null,
  };
  const db = {
    rpc: (name: string, args: Record<string, unknown>) => {
      state.rpcCalls.push({ name, args });
      if (name === 'match_ai_knowledge_hybrid')
        return Promise.resolve(
          state.hybridError
            ? { data: null, error: state.hybridError }
            : { data: state.hybrid, error: null }
        );
      return Promise.resolve({ data: null, error: null });
    },
    from: () => ({
      // retrieveKnowledge's empty-KB count guard.
      select: () => ({
        eq: () => Promise.resolve({ count: state.chunkCount, error: null }),
      }),
      delete: () => {
        const chain = {
          eq: (col: string, val: string) => {
            if (col === 'document_id') state.deletedFor = val;
            return chain;
          },
          then: (resolve: (v: { error: null }) => unknown) =>
            resolve({ error: null }),
        };
        return chain;
      },
      insert: (rows: Record<string, unknown>[]) => {
        state.insertCalls++;
        state.inserted = [...(state.inserted ?? []), ...rows];
        return Promise.resolve({ error: null });
      },
    }),
  };
  return { db: db as unknown as SupabaseClient, state };
}

const names = (s: FakeState) => s.rpcCalls.map((c) => c.name);

const doc = (content: string): IngestDoc => ({
  id: 'doc-1',
  title: 'Política',
  sourceType: 'text',
  content,
});

beforeEach(() => {
  h.embedTexts.mockReset();
  h.embedTexts.mockImplementation(async (_target: unknown, inputs: string[]) =>
    inputs.map((_, i) => [i, i])
  );
});

describe('mapHybridRow', () => {
  it('maps a real RPC row to a hit', () => {
    expect(mapHybridRow(hybridRows[0])).toEqual({
      chunkId: 'aaaaaaaa-0000-4000-8000-000000000001',
      documentId: '11111111-1111-4111-8111-111111111111',
      title: 'Tabela de preços',
      heading: 'Tabela de preços › Planos',
      content:
        'Tabela de preços › Planos\n\nO plano básico custa R$ 99 por mês.',
      distance: 0,
      lexicalRank: 0.0683918,
      score: 0.03278688524590164,
      origin: 'both',
    });
  });

  it('keeps the distance of a lexical-origin row that the vector search also saw', () => {
    const hit = mapHybridRow(hybridRows[1]);
    expect(hit?.origin).toBe('lexical');
    expect(hit?.distance).toBe(1);
  });

  it('rejects malformed rows instead of throwing', () => {
    expect(mapHybridRow(null)).toBeNull();
    expect(mapHybridRow({ chunk_id: 'x' })).toBeNull();
    expect(mapHybridRow({ ...hybridRows[0], source: 'magic' })).toBeNull();
    expect(mapHybridRow({ ...hybridRows[0], content: 3 })).toBeNull();
  });

  it('tolerates null optional columns (no vector, no word match)', () => {
    const hit = mapHybridRow({
      ...hybridRows[0],
      distance: null,
      lexical_rank: null,
      heading: null,
      title: null,
    });
    expect(hit).toMatchObject({
      distance: null,
      lexicalRank: null,
      heading: null,
      title: null,
    });
  });
});

describe('retrieveKnowledge', () => {
  it('returns [] for an empty query without touching the DB', async () => {
    const { db, state } = makeDb();
    expect(
      await retrieveKnowledge(db, 'acct', { embeddingsTarget: null }, '  ')
    ).toEqual([]);
    expect(state.rpcCalls).toEqual([]);
  });

  it('short-circuits (no embed, no RPC) when the KB is empty', async () => {
    const { db, state } = makeDb();
    state.chunkCount = 0;
    const out = await retrieveKnowledge(
      db,
      'acct',
      { embeddingsTarget: T },
      'quanto custa o plano'
    );
    expect(out).toEqual([]);
    expect(h.embedTexts).not.toHaveBeenCalled();
    expect(state.rpcCalls).toEqual([]);
    // The test screen is told it was the base, not the key, that was empty.
    const search = await searchKnowledge(
      db,
      'acct',
      { embeddingsTarget: T },
      'quanto custa o plano'
    );
    expect(search).toMatchObject({ hits: [], knowledgeEmpty: true });
  });

  it('calls the hybrid RPC once with the vector, the model, the topical words and the ceiling', async () => {
    const { db, state } = makeDb();
    state.hybrid = hybridRows;
    const out = await retrieveKnowledge(
      db,
      'acct',
      { embeddingsTarget: T },
      'Oi, gostaria de saber o preço do plano'
    );
    expect(names(state)).toEqual(['match_ai_knowledge_hybrid']);
    expect(state.rpcCalls[0].args).toEqual({
      p_account_id: 'acct',
      p_query: 'preço or plano',
      p_query_embedding: '[0,0]',
      p_embedding_model: 'text-embedding-3-small',
      p_match_count: 5,
      p_max_distance: KNOWLEDGE_MAX_DISTANCE,
    });
    // The query is embedded as the whole text (not the word list).
    expect(h.embedTexts).toHaveBeenCalledWith(T, [
      'Oi, gostaria de saber o preço do plano',
    ]);
    expect(out.map((x) => x.origin)).toEqual(['both', 'lexical']);
    expect(out[0].title).toBe('Tabela de preços');
  });

  it('passes the OpenRouter model id for an OpenRouter target', async () => {
    const { db, state } = makeDb();
    await retrieveKnowledge(
      db,
      'acct',
      { embeddingsTarget: { provider: 'openrouter', apiKey: 'k' } },
      'prazo de entrega'
    );
    expect(state.rpcCalls[0].args.p_embedding_model).toBe(
      'openai/text-embedding-3-small'
    );
  });

  it('is lexical-only without an embeddings target: no embed, null vector and model', async () => {
    const { db, state } = makeDb();
    state.hybrid = [hybridRows[1]];
    const out = await retrieveKnowledge(
      db,
      'acct',
      { embeddingsTarget: null },
      'preços'
    );
    expect(h.embedTexts).not.toHaveBeenCalled();
    expect(state.rpcCalls[0].args).toMatchObject({
      p_query: 'preços',
      p_query_embedding: null,
      p_embedding_model: null,
    });
    expect(out).toHaveLength(1);
  });

  it('skips the RPC when there is neither a vector nor a topical word', async () => {
    const { db, state } = makeDb();
    const out = await retrieveKnowledge(
      db,
      'acct',
      { embeddingsTarget: null },
      'oi, o que é isso?'
    );
    expect(out).toEqual([]);
    expect(state.rpcCalls).toEqual([]);
  });

  it('keeps the lexical half when the query embedding fails', async () => {
    const { db, state } = makeDb();
    h.embedTexts.mockRejectedValue(new Error('provider down'));
    state.hybrid = [hybridRows[1]];
    const out = await retrieveKnowledge(
      db,
      'acct',
      { embeddingsTarget: T },
      'preços'
    );
    expect(state.rpcCalls[0].args).toMatchObject({
      p_query: 'preços',
      p_query_embedding: null,
      p_embedding_model: null,
    });
    expect(out).toHaveLength(1);
  });

  it('honours k and the distance override, and caps the rows it returns', async () => {
    const { db, state } = makeDb();
    state.hybrid = hybridRows;
    const out = await retrieveKnowledge(
      db,
      'acct',
      { embeddingsTarget: T },
      'preços do plano',
      { k: 1, maxDistance: 0.4 }
    );
    expect(state.rpcCalls[0].args).toMatchObject({
      p_match_count: 1,
      p_max_distance: 0.4,
    });
    expect(out).toHaveLength(1);
  });

  it('returns [] (no fallback) when the hybrid RPC answers with no row', async () => {
    const { db, state } = makeDb();
    state.hybrid = [];
    const out = await retrieveKnowledge(
      db,
      'acct',
      { embeddingsTarget: T },
      'pergunta sem resposta na base'
    );
    expect(out).toEqual([]);
    expect(names(state)).toEqual(['match_ai_knowledge_hybrid']);
  });

  it('drops malformed rows', async () => {
    const { db, state } = makeDb();
    state.hybrid = [hybridRows[0], { chunk_id: 1 }, null];
    const out = await retrieveKnowledge(
      db,
      'acct',
      { embeddingsTarget: T },
      'plano'
    );
    expect(out).toHaveLength(1);
  });

  describe('when the hybrid RPC fails', () => {
    it('returns no hits, flags searchFailed and does not call any other RPC', async () => {
      const { db, state } = makeDb();
      state.hybridError = { message: 'function does not exist' };
      const search = await searchKnowledge(
        db,
        'acct',
        { embeddingsTarget: T },
        'qual o prazo?\nplano',
        { k: 3 }
      );
      expect(search.hits).toEqual([]);
      expect(search.searchFailed).toBe(true);
      expect(names(state)).toEqual(['match_ai_knowledge_hybrid']);
    });

    it('never throws when the RPC itself throws', async () => {
      const { db } = makeDb();
      (db as unknown as { rpc: () => never }).rpc = () => {
        throw new Error('network');
      };
      await expect(
        retrieveKnowledge(db, 'acct', { embeddingsTarget: null }, 'plano')
      ).resolves.toEqual([]);
    });
  });
});

describe('searchKnowledge', () => {
  it('reports the mode and whether a vector was used (the "Test retrieval" screen)', async () => {
    const { db, state } = makeDb();
    state.hybrid = hybridRows;
    const withVec = await searchKnowledge(
      db,
      'acct',
      { embeddingsTarget: T },
      'preço'
    );
    expect(withVec).toMatchObject({ searchFailed: false, usedEmbedding: true });
    const noVec = await searchKnowledge(
      db,
      'acct',
      { embeddingsTarget: null },
      'preço'
    );
    expect(noVec).toMatchObject({ searchFailed: false, usedEmbedding: false });
  });

  it('flags a failed query embedding (so the screen can say why only words ran)', async () => {
    const { db, state } = makeDb();
    state.hybrid = hybridRows;
    h.embedTexts.mockRejectedValue(new Error('invalid key'));
    const out = await searchKnowledge(
      db,
      'acct',
      { embeddingsTarget: T },
      'preço'
    );
    expect(out).toMatchObject({ usedEmbedding: false, embeddingFailed: true });
    const none = await searchKnowledge(
      db,
      'acct',
      { embeddingsTarget: null },
      'preço'
    );
    expect(none.embeddingFailed).toBe(false);
  });
});

describe('ingestDocument', () => {
  it('embeds chunks when a target is present and records the requested model (D-4)', async () => {
    const { db, state } = makeDb();
    const out = await ingestDocument(
      db,
      'acct',
      { embeddingsTarget: T },
      doc('hello world')
    );
    expect(h.embedTexts).toHaveBeenCalledTimes(1);
    expect(state.deletedFor).toBe('doc-1');
    expect(state.inserted).toHaveLength(1);
    expect(state.inserted![0].embedding).toBe('[0,0]'); // literal from mocked embed
    expect(state.inserted![0].account_id).toBe('acct');
    expect(state.inserted![0].embedding_model).toBe('text-embedding-3-small');
    expect(out).toMatchObject({
      chunkCount: 1,
      embeddingModel: 'text-embedding-3-small',
      embedError: null,
    });
  });

  it('records the OpenRouter model id for an OpenRouter target', async () => {
    const { db, state } = makeDb();
    await ingestDocument(
      db,
      'acct',
      { embeddingsTarget: { provider: 'openrouter', apiKey: 'k' } },
      doc('hello world')
    );
    expect(state.inserted![0].embedding_model).toBe(
      'openai/text-embedding-3-small'
    );
  });

  it('embeds the prefixed content and stores the heading (D-12)', async () => {
    const { db, state } = makeDb();
    await ingestDocument(
      db,
      'acct',
      { embeddingsTarget: T },
      doc('## Frete\n\nO frete é grátis.')
    );
    const embedded = h.embedTexts.mock.calls[0][1] as string[];
    expect(embedded[0]).toBe('Política › Frete\n\nO frete é grátis.');
    expect(state.inserted![0].content).toBe(embedded[0]);
    expect(state.inserted![0].heading).toBe('Política › Frete');
  });

  it('stores chunks without embeddings when there is no target', async () => {
    const { db, state } = makeDb();
    const out = await ingestDocument(
      db,
      'acct',
      { embeddingsTarget: null },
      doc('hello world')
    );
    expect(h.embedTexts).not.toHaveBeenCalled();
    expect(state.inserted![0].embedding).toBeNull();
    expect(state.inserted![0].embedding_model).toBeNull();
    expect(out.embeddingModel).toBeNull();
  });

  it('deletes existing chunks and inserts nothing for empty content', async () => {
    const { db, state } = makeDb();
    const out = await ingestDocument(
      db,
      'acct',
      { embeddingsTarget: T },
      doc('   ')
    );
    expect(state.deletedFor).toBe('doc-1');
    expect(state.inserted).toBeNull();
    expect(out.chunkCount).toBe(0);
    expect(h.embedTexts).not.toHaveBeenCalled();
  });

  it('still stores lexical chunks when embedding fails, and reports the error', async () => {
    const { db, state } = makeDb();
    const boom = new Error('rate limited');
    h.embedTexts.mockRejectedValueOnce(boom);
    const out = await ingestDocument(
      db,
      'acct',
      { embeddingsTarget: T },
      doc('hello world')
    );
    // Chunks were inserted (lexical search works) despite the embed failure…
    expect(state.inserted).toHaveLength(1);
    expect(state.inserted![0].embedding).toBeNull();
    expect(state.inserted![0].embedding_model).toBeNull();
    // …and the caller's state machine gets the error instead of a throw.
    expect(out.embedError).toBe(boom);
    expect(out.embeddingModel).toBeNull();
  });

  it('keeps the old chunks until the new embeddings are ready (a reindex never empties the document)', async () => {
    const { db, state } = makeDb();
    let deletedWhenEmbedding: string | null | undefined;
    h.embedTexts.mockImplementation(async (_t: unknown, inputs: string[]) => {
      deletedWhenEmbedding = state.deletedFor;
      return inputs.map(() => [0, 0]);
    });
    await ingestDocument(
      db,
      'acct',
      { embeddingsTarget: T },
      doc('hello world')
    );
    // Quando o provedor foi chamado, as fatias antigas ainda existiam.
    expect(deletedWhenEmbedding).toBeNull();
    expect(state.deletedFor).toBe('doc-1');
  });

  it('inserts a large document in batches', async () => {
    const { db, state } = makeDb();
    const big = Array.from(
      { length: 120 },
      (_, i) => `Parágrafo ${i} ${'x'.repeat(900)}`
    ).join('\n\n');
    const out = await ingestDocument(
      db,
      'acct',
      { embeddingsTarget: null },
      doc(big)
    );
    expect(out.chunkCount).toBeGreaterThan(40);
    expect(state.inserted).toHaveLength(out.chunkCount);
    // 40 linhas por INSERT: o corpo com vetores de 1536 floats não estoura o PostgREST.
    expect(state.insertCalls).toBe(Math.ceil(out.chunkCount / 40));
  });
});
