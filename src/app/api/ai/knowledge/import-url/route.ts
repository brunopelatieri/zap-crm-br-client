import { NextResponse } from 'next/server';
import { requireAiFeature } from '@/lib/ai/plan-gate';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit';
import {
  cleanTitle,
  createKnowledgeDocument,
  normalizeTags,
} from '@/lib/ai/ingest/documents';
import { IngestError } from '@/lib/ai/ingest/errors';
import { extractUrlText } from '@/lib/ai/ingest/extract-url';
import {
  createResultResponse,
  ingestErrorResponse,
  scheduleIndexing,
} from '@/lib/ai/ingest/route-helpers';

export const maxDuration = 300;

/**
 * POST /api/ai/knowledge/import-url  (admin+)  { url, title?, tags? }
 *
 * Downloads ONE page on the server and stores its text (SPEC 089 D-7/D-8).
 * SSRF guard in `extractUrlText`: `isDeliverableUrl` on every hop and
 * `redirect: 'manual'`, 10 s deadline, only text/html and text/plain,
 * body capped at 2 MB.
 */
export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('admin');
    // SPEC 089 D-20: ai_enabled em modo estrito (chave ausente = bloqueado).
    await requireAiFeature(accountId);
    const limit = checkRateLimit(
      `ai-kb-url:${userId}`,
      RATE_LIMITS.adminAction
    );
    if (!limit.success) return rateLimitResponse(limit);

    const body = await request.json().catch(() => null);
    if (typeof body?.url !== 'string' || !body.url.trim()) {
      return NextResponse.json(
        { error: 'url is required', code: 'invalid_input' },
        { status: 400 }
      );
    }

    try {
      const tags = normalizeTags(body?.tags);
      const extracted = await extractUrlText(body.url);
      const host = new URL(extracted.finalUrl).hostname;
      const title =
        cleanTitle(body?.title) || cleanTitle(extracted.title) || host;

      const result = await createKnowledgeDocument(
        supabase,
        accountId,
        userId,
        {
          title,
          content: extracted.text,
          sourceType: 'url',
          sourceUrl: extracted.finalUrl.slice(0, 2048),
          mimeType: extracted.mimeType,
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
