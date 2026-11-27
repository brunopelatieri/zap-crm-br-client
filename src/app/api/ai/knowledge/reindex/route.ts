import { NextResponse } from 'next/server';
import { requireAiFeature } from '@/lib/ai/plan-gate';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit';
import { loadEmbeddingsTarget } from '@/lib/ai/config';
import { INDEXING_STALE_MINUTES } from '@/lib/ai/ingest/limits';
import { scheduleIndexing } from '@/lib/ai/ingest/route-helpers';

export const maxDuration = 300;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * POST /api/ai/knowledge/reindex  (admin+)   { ids?: string[] }
 *
 * Queues documents for (re)indexing and returns at once: each goes back to
 * `pending` with the attempt count zeroed, and the indexing runs in
 * `after()` (SPEC 089 D-9); whatever does not fit in one batch is picked
 * up by the cron sweep. Without `ids`, every document of the account.
 *
 * Main uses: retry a document in `error`; backfill vectors after adding an
 * embeddings key (existing documents were stored lexical-only).
 */
export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('admin');
    // SPEC 089 D-20: ai_enabled em modo estrito (chave ausente = bloqueado).
    await requireAiFeature(accountId);
    const limit = checkRateLimit(
      `ai-kb-reindex:${userId}`,
      RATE_LIMITS.adminAction
    );
    if (!limit.success) return rateLimitResponse(limit);

    const body = await request.json().catch(() => null);
    let ids: string[] | null = null;
    if (body?.ids !== undefined) {
      if (
        !Array.isArray(body.ids) ||
        body.ids.length === 0 ||
        body.ids.length > 500 ||
        !body.ids.every((x: unknown) => typeof x === 'string' && UUID.test(x))
      ) {
        return NextResponse.json(
          { error: 'ids must be a non-empty list of document ids' },
          { status: 400 }
        );
      }
      ids = body.ids;
    }

    // If a key is configured but can't be decrypted, don't quietly do a
    // lexical-only pass and report success. Stop and tell the admin.
    const { corrupt } = await loadEmbeddingsTarget(supabase, accountId);
    if (corrupt) {
      return NextResponse.json(
        {
          success: false,
          queued: 0,
          error:
            'Your embeddings key could not be decrypted (check ENCRYPTION_KEY, then re-enter the key in Settings → AI Assistant). Nothing was reindexed.',
        },
        { status: 200 }
      );
    }

    let query = supabase
      .from('ai_knowledge_documents')
      .update({
        status: 'pending',
        index_attempts: 0,
        index_error: null,
        index_started_at: null,
      })
      .eq('account_id', accountId);
    if (ids) query = query.in('id', ids);
    // Não puxa de volta o que está indexando AGORA (duas indexações do mesmo
    // documento intercalariam o DELETE/INSERT das fatias). `indexing` parado
    // há mais de 10 min é órfão: esse pode.
    const orphanCutoff = new Date(
      Date.now() - INDEXING_STALE_MINUTES * 60_000
    ).toISOString();
    query = query.or(`status.neq.indexing,index_started_at.lt.${orphanCutoff}`);
    const { data, error } = await query.select('id');
    if (error) {
      console.error('[ai/knowledge/reindex] error:', error);
      return NextResponse.json(
        { error: 'Failed to queue documents' },
        { status: 500 }
      );
    }

    const queued = (data ?? []).map((d) => d.id as string);
    scheduleIndexing(accountId, queued);
    return NextResponse.json({ success: true, queued: queued.length });
  } catch (err) {
    return toErrorResponse(err);
  }
}
