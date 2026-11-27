import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// SPEC 089 F3 — POST /api/ai/knowledge/search ("Testar recuperação"). A rota é
// a real; a sessão, o portão do plano, o limite de taxa e a busca são
// substituídos (a busca tem o teste dela em `src/lib/ai/knowledge.test.ts`).
// ---------------------------------------------------------------------------

const h = vi.hoisted(() => ({
  role: 'admin' as 'admin' | 'agent',
  inPlan: true,
  rateOk: true,
  target: { target: null as unknown, corrupt: false },
  search: vi.fn(),
  loadTarget: vi.fn(),
}));

vi.mock('@/lib/auth/account', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/account')>();
  const { hasMinRole } = await import('@/lib/auth/roles');
  return {
    ...actual,
    requireRole: vi.fn(async (min: 'admin' | 'agent') => {
      if (!hasMinRole(h.role, min))
        throw new actual.ForbiddenError('requires role');
      return { supabase: { rls: true }, userId: 'user-1', accountId: 'acct-1' };
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
  checkRateLimit: () => ({ success: h.rateOk, retryAfter: 1, resetAt: 0 }),
}));

vi.mock('@/lib/ai/config', () => ({
  loadEmbeddingsTarget: h.loadTarget,
}));

// P-14 (migração 111): a chave cifrada só se lê com service role.
vi.mock('@/lib/ai/admin-client', () => ({
  supabaseAdmin: () => ({ admin: true }),
}));

vi.mock('@/lib/ai/knowledge', () => ({ searchKnowledge: h.search }));

import { POST } from './route';
import { KNOWLEDGE_MAX_DISTANCE } from '@/lib/ai/defaults';

const call = (body: unknown) =>
  POST(
    new Request('http://test/api/ai/knowledge/search', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  );

const HIT = {
  chunkId: 'chunk-1',
  documentId: 'doc-1',
  title: 'Tabela de preços',
  heading: 'Tabela de preços › Planos',
  content: 'O plano básico custa R$ 99 por mês.',
  distance: 0.21,
  lexicalRank: 0.068,
  score: 2 / 61,
  origin: 'both' as const,
};

beforeEach(() => {
  h.role = 'admin';
  h.inPlan = true;
  h.rateOk = true;
  h.target = { target: { provider: 'openai', apiKey: 'sk' }, corrupt: false };
  h.loadTarget.mockReset().mockImplementation(async () => h.target);
  h.search.mockReset().mockResolvedValue({
    hits: [HIT],
    searchFailed: false,
    usedEmbedding: true,
    embeddingFailed: false,
    knowledgeEmpty: false,
  });
});

describe('POST /api/ai/knowledge/search', () => {
  it('runs the agent retrieval with the RLS client and returns the ranked excerpts', async () => {
    const res = await call({ query: '  quanto custa o plano básico?  ' });
    expect(res.status).toBe(200);
    expect(h.search).toHaveBeenCalledWith(
      { rls: true },
      'acct-1',
      { embeddingsTarget: { provider: 'openai', apiKey: 'sk' } },
      'quanto custa o plano básico?',
      { k: 5, maxDistance: KNOWLEDGE_MAX_DISTANCE }
    );
    const body = await res.json();
    expect(body).toMatchObject({
      search_failed: false,
      used_embedding: true,
      embeddings_key_unreadable: false,
      embedding_failed: false,
      knowledge_empty: false,
      lexical_query: 'custa or plano or básico',
      max_distance: KNOWLEDGE_MAX_DISTANCE,
    });
    expect(body.hits).toEqual([
      {
        chunk_id: 'chunk-1',
        document_id: 'doc-1',
        title: 'Tabela de preços',
        heading: 'Tabela de preços › Planos',
        content: 'O plano básico custa R$ 99 por mês.',
        distance: 0.21,
        lexical_rank: 0.068,
        score: 2 / 61,
        origin: 'both',
      },
    ]);
  });

  it("applies the agent's 600-char cap, keeping the END of a long question", async () => {
    await call({ query: `${'antigo '.repeat(120)}pergunta final sobre prazo` });
    const sent = h.search.mock.calls[0][3] as string;
    expect(sent.length).toBeLessThanOrEqual(600);
    expect(sent.endsWith('pergunta final sobre prazo')).toBe(true);
  });

  it('reports a failed query embedding, so the screen does not claim "no embeddings"', async () => {
    h.search.mockResolvedValue({
      hits: [],
      searchFailed: false,
      usedEmbedding: false,
      embeddingFailed: true,
    });
    const body = await (await call({ query: 'prazo' })).json();
    expect(body.embedding_failed).toBe(true);
  });

  it('loads the embeddings key with the service-role client, never the RLS one (P-14, migration 111)', async () => {
    await call({ query: 'prazo' });
    expect(h.loadTarget).toHaveBeenCalledTimes(1);
    expect(h.loadTarget.mock.calls[0][0]).toEqual({ admin: true });
    expect(h.loadTarget.mock.calls[0][1]).toBe('acct-1');
  });

  it('lets the admin try another distance ceiling for this call only', async () => {
    const res = await call({ query: 'prazo', max_distance: 0.4 });
    expect(h.search.mock.calls[0][4]).toEqual({ k: 5, maxDistance: 0.4 });
    expect((await res.json()).max_distance).toBe(0.4);
  });

  it('rejects a missing question and an out-of-range ceiling', async () => {
    expect((await call({})).status).toBe(400);
    expect((await call({ query: '   ' })).status).toBe(400);
    expect((await call({ query: 'x', max_distance: 3 })).status).toBe(400);
    expect((await call({ query: 'x', max_distance: '1' })).status).toBe(400);
    expect(h.search).not.toHaveBeenCalled();
  });

  it('says so when the embeddings key cannot be read (words-only search)', async () => {
    h.target = { target: null, corrupt: true };
    h.search.mockResolvedValue({
      hits: [],
      searchFailed: false,
      usedEmbedding: false,
      embeddingFailed: false,
      knowledgeEmpty: false,
    });
    const body = await (await call({ query: 'prazo de entrega' })).json();
    expect(body).toMatchObject({
      embeddings_key_unreadable: true,
      used_embedding: false,
      hits: [],
    });
    expect(h.search.mock.calls[0][2]).toEqual({ embeddingsTarget: null });
  });

  it('reports a failed search so "no result" is not confused with an error', async () => {
    h.search.mockResolvedValue({
      hits: [],
      searchFailed: true,
      usedEmbedding: true,
      embeddingFailed: false,
      knowledgeEmpty: false,
    });
    const body = await (await call({ query: 'prazo' })).json();
    expect(body.search_failed).toBe(true);
  });

  it('requires admin, the AI plan feature and respects the rate limit', async () => {
    h.role = 'agent';
    expect((await call({ query: 'x' })).status).toBe(403);
    h.role = 'admin';
    h.inPlan = false;
    expect((await call({ query: 'x' })).status).toBe(403);
    h.inPlan = true;
    h.rateOk = false;
    expect((await call({ query: 'x' })).status).toBe(429);
    expect(h.search).not.toHaveBeenCalled();
  });
});
