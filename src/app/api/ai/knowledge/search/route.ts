import { NextResponse } from 'next/server';
import { requireAiFeature } from '@/lib/ai/plan-gate';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit';
import { loadEmbeddingsTarget } from '@/lib/ai/config';
import { supabaseAdmin } from '@/lib/ai/admin-client';
import { KNOWLEDGE_MAX_DISTANCE, KNOWLEDGE_TOP_K } from '@/lib/ai/defaults';
import { searchKnowledge } from '@/lib/ai/knowledge';
import { buildLexicalQuery, buildRetrievalQuery } from '@/lib/ai/query';

/**
 * POST /api/ai/knowledge/search  (admin+)   { query: string, max_distance?: number }
 *
 * "Test retrieval" (SPEC 089 F3): runs the exact retrieval the agent runs
 * for a customer message — hybrid RPC, same top-k, same distance ceiling —
 * and returns the ranked excerpts with score, origin and document. It does
 * NOT call the LLM. It does spend one embedding call on the account's own
 * key (when one is configured), hence admin-only and rate limited.
 *
 * `max_distance` (0–2) overrides the ceiling for this call only, to calibrate
 * it against a real base (SPEC 089 P-6); the agent's ceiling does not change.
 */
export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('admin');
    // SPEC 089 D-20: ai_enabled em modo estrito (chave ausente = bloqueado).
    await requireAiFeature(accountId);
    const limit = checkRateLimit(
      `ai-kb-search:${userId}`,
      RATE_LIMITS.adminAction
    );
    if (!limit.success) return rateLimitResponse(limit);

    const body = await request.json().catch(() => null);
    const raw = typeof body?.query === 'string' ? body.query.trim() : '';
    if (!raw) {
      return NextResponse.json({ error: 'query is required' }, { status: 400 });
    }
    // The same cap the agent applies (600 chars, newest text wins), so what
    // the admin sees is what a customer message would retrieve.
    const query = buildRetrievalQuery([{ role: 'user', content: raw }]);

    let maxDistance = KNOWLEDGE_MAX_DISTANCE;
    if (body?.max_distance !== undefined) {
      const v = body.max_distance;
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 2) {
        return NextResponse.json(
          { error: 'max_distance must be a number between 0 and 2' },
          { status: 400 }
        );
      }
      maxDistance = v;
    }

    // A key that is set but unreadable is reported, not hidden: the search
    // then runs on words only and the screen says why.
    const { target, corrupt } = await loadEmbeddingsTarget(
      supabaseAdmin(),
      accountId
    );

    const search = await searchKnowledge(
      supabase,
      accountId,
      { embeddingsTarget: target },
      query,
      { k: KNOWLEDGE_TOP_K, maxDistance }
    );

    return NextResponse.json({
      search_failed: search.searchFailed,
      used_embedding: search.usedEmbedding,
      embedding_failed: search.embeddingFailed,
      knowledge_empty: search.knowledgeEmpty,
      embeddings_key_unreadable: corrupt,
      lexical_query: buildLexicalQuery(query),
      max_distance: maxDistance,
      hits: search.hits.map((h) => ({
        chunk_id: h.chunkId,
        document_id: h.documentId,
        title: h.title,
        heading: h.heading,
        content: h.content,
        distance: h.distance,
        lexical_rank: h.lexicalRank,
        score: h.score,
        origin: h.origin,
      })),
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
