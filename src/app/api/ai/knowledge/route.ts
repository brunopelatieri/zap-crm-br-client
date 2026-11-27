import { NextResponse } from 'next/server';
import { requireAiFeature } from '@/lib/ai/plan-gate';
import {
  getCurrentAccount,
  requireRole,
  toErrorResponse,
} from '@/lib/auth/account';
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit';
import {
  cleanContent,
  cleanTitle,
  createKnowledgeDocument,
  normalizeTags,
} from '@/lib/ai/ingest/documents';
import { IngestError } from '@/lib/ai/ingest/errors';
import { buildFaqText, normalizeFaqPairs } from '@/lib/ai/ingest/faq';
import {
  createResultResponse,
  ingestErrorResponse,
  scheduleIndexing,
} from '@/lib/ai/ingest/route-helpers';

// `after()` indexa fora da requisição, dentro deste teto (D-9).
export const maxDuration = 300;

/**
 * GET /api/ai/knowledge
 *
 * List the account's knowledge-base documents (any member), with the
 * indexing state, source, tags and enabled switch. The body (`content`)
 * is not listed — GET /api/ai/knowledge/[id] returns it.
 */
export async function GET() {
  try {
    const { supabase, accountId } = await getCurrentAccount();
    // SPEC 089 D-20: ai_enabled em modo estrito (chave ausente = bloqueado).
    await requireAiFeature(accountId);
    const { data, error } = await supabase
      .from('ai_knowledge_documents')
      .select(
        'id, title, source_type, source_name, source_url, mime_type, status, index_error, chunk_count, char_count, is_enabled, tags, indexed_at, updated_at'
      )
      .eq('account_id', accountId)
      .order('updated_at', { ascending: false });
    if (error) {
      console.error('[ai/knowledge GET] error:', error);
      return NextResponse.json(
        { error: 'Failed to load knowledge base' },
        { status: 500 }
      );
    }
    return NextResponse.json({ documents: data ?? [] });
  } catch (err) {
    return toErrorResponse(err);
  }
}

/**
 * POST /api/ai/knowledge  (admin+)
 *
 * Two shapes (SPEC 089 D-7):
 *   { title, content, tags? }                       pasted text
 *   { source: 'faq', title, pairs: [{question, answer}], tags? }
 *
 * The document is saved as `pending` and the response returns at once;
 * chunking + embedding run in `after()` (D-9), retried by the cron sweep.
 */
export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('admin');
    // SPEC 089 D-20: ai_enabled em modo estrito (chave ausente = bloqueado).
    await requireAiFeature(accountId);
    const limit = checkRateLimit(`ai-kb:${userId}`, RATE_LIMITS.adminAction);
    if (!limit.success) return rateLimitResponse(limit);

    const body = await request.json().catch(() => null);
    const title = cleanTitle(body?.title);
    if (!title) {
      return NextResponse.json(
        { error: 'title and content are required', code: 'invalid_input' },
        { status: 400 }
      );
    }

    try {
      const tags = normalizeTags(body?.tags);
      const isFaq = body?.source === 'faq';
      const content = isFaq
        ? buildFaqText(normalizeFaqPairs(body?.pairs))
        : cleanContent(body?.content);

      const result = await createKnowledgeDocument(
        supabase,
        accountId,
        userId,
        {
          title,
          content,
          sourceType: isFaq ? 'faq' : 'text',
          tags,
        }
      );
      if (result.ok) scheduleIndexing(accountId, [result.id]);
      return createResultResponse(result);
    } catch (err) {
      if (err instanceof IngestError) return ingestErrorResponse(err);
      throw err;
    }
  } catch (err) {
    return toErrorResponse(err);
  }
}
