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
  normalizeTags,
} from '@/lib/ai/ingest/documents';
import { IngestError } from '@/lib/ai/ingest/errors';
import {
  buildFaqText,
  normalizeFaqPairs,
  parseFaqText,
} from '@/lib/ai/ingest/faq';
import { hashContent } from '@/lib/ai/ingest/indexer';
import {
  ingestErrorResponse,
  scheduleIndexing,
} from '@/lib/ai/ingest/route-helpers';

export const maxDuration = 300;

type Params = { params: Promise<{ id: string }> };

/**
 * GET /api/ai/knowledge/[id] — full document (any member). `faq`
 * documents also return their `pairs`.
 */
export async function GET(_request: Request, { params }: Params) {
  try {
    const { supabase, accountId } = await getCurrentAccount();
    // SPEC 089 D-20: ai_enabled em modo estrito (chave ausente = bloqueado).
    await requireAiFeature(accountId);
    const { id } = await params;
    const { data, error } = await supabase
      .from('ai_knowledge_documents')
      .select(
        'id, title, content, source_type, source_name, source_url, mime_type, status, index_error, chunk_count, char_count, is_enabled, tags, indexed_at, updated_at'
      )
      .eq('account_id', accountId)
      .eq('id', id)
      .maybeSingle();
    if (error) {
      console.error('[ai/knowledge/[id] GET] error:', error);
      return NextResponse.json(
        { error: 'Failed to load document' },
        { status: 500 }
      );
    }
    if (!data)
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    return NextResponse.json({
      ...data,
      pairs:
        data.source_type === 'faq' ? parseFaqText(data.content) : undefined,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

/**
 * PATCH /api/ai/knowledge/[id]  (admin+)
 *
 * Any of: `title`, `content` (or `pairs` on a `faq` document), `tags`,
 * `is_enabled`. Tags and the enabled switch take effect at once and never
 * re-index. A changed title or text sets the document back to `pending`
 * (the title is prefixed to every chunk, D-12) unless the content hash
 * says nothing changed (idempotence, §5.2); indexing runs in `after()`.
 */
export async function PATCH(request: Request, { params }: Params) {
  try {
    const { supabase, accountId, userId } = await requireRole('admin');
    // SPEC 089 D-20: ai_enabled em modo estrito (chave ausente = bloqueado).
    await requireAiFeature(accountId);
    const limit = checkRateLimit(`ai-kb:${userId}`, RATE_LIMITS.adminAction);
    if (!limit.success) return rateLimitResponse(limit);

    const { id } = await params;
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: 'Nothing to update' }, { status: 400 });
    }

    const { data: current, error: loadErr } = await supabase
      .from('ai_knowledge_documents')
      .select('id, title, source_type, content_hash')
      .eq('account_id', accountId)
      .eq('id', id)
      .maybeSingle();
    if (loadErr) {
      console.error('[ai/knowledge/[id] PATCH] load error:', loadErr);
      return NextResponse.json(
        { error: 'Failed to update document' },
        { status: 500 }
      );
    }
    if (!current)
      return NextResponse.json({ error: 'Not found' }, { status: 404 });

    try {
      const update: Record<string, unknown> = {};
      let reindex = false;

      if (body.title !== undefined) {
        const title = cleanTitle(body.title);
        if (!title) {
          return NextResponse.json(
            { error: 'title cannot be empty', code: 'invalid_input' },
            { status: 400 }
          );
        }
        if (title !== current.title) {
          update.title = title;
          reindex = true;
        }
      }

      const isFaq = current.source_type === 'faq';
      if (body.pairs !== undefined && !isFaq) {
        return NextResponse.json(
          {
            error: 'pairs only apply to question/answer documents',
            code: 'invalid_input',
          },
          { status: 400 }
        );
      }
      if (body.content !== undefined || body.pairs !== undefined) {
        const content = isFaq
          ? buildFaqText(normalizeFaqPairs(body.pairs))
          : cleanContent(body.content);
        const hash = hashContent(content);
        if (hash !== current.content_hash) {
          update.content = content;
          update.content_hash = hash;
          update.char_count = content.length;
          reindex = true;
        }
      }

      if (body.tags !== undefined) update.tags = normalizeTags(body.tags);
      if (body.is_enabled !== undefined) {
        if (typeof body.is_enabled !== 'boolean') {
          return NextResponse.json(
            { error: 'is_enabled must be a boolean', code: 'invalid_input' },
            { status: 400 }
          );
        }
        update.is_enabled = body.is_enabled;
      }

      if (Object.keys(update).length === 0) {
        // Nada mudou (por exemplo, o mesmo texto de novo): não reindexa.
        return NextResponse.json({ success: true, reindexed: false });
      }

      if (reindex) {
        update.status = 'pending';
        update.index_attempts = 0;
        update.index_error = null;
        update.index_started_at = null;
      }

      const { data: updated, error } = await supabase
        .from('ai_knowledge_documents')
        .update(update)
        .eq('account_id', accountId)
        .eq('id', id)
        .select('id')
        .maybeSingle();
      if (error) {
        console.error('[ai/knowledge/[id] PATCH] error:', error);
        return NextResponse.json(
          { error: 'Failed to update document' },
          { status: 500 }
        );
      }
      if (!updated)
        return NextResponse.json({ error: 'Not found' }, { status: 404 });

      if (reindex) scheduleIndexing(accountId, [id]);
      return NextResponse.json({ success: true, reindexed: reindex });
    } catch (err) {
      if (err instanceof IngestError) return ingestErrorResponse(err);
      throw err;
    }
  } catch (err) {
    return toErrorResponse(err);
  }
}

/**
 * DELETE /api/ai/knowledge/[id]  (admin+) — chunks cascade; the plan
 * counter is released by the trigger (103).
 */
export async function DELETE(_request: Request, { params }: Params) {
  try {
    const { supabase, accountId } = await requireRole('admin');
    const { id } = await params;
    const { error } = await supabase
      .from('ai_knowledge_documents')
      .delete()
      .eq('account_id', accountId)
      .eq('id', id);
    if (error) {
      console.error('[ai/knowledge/[id] DELETE] error:', error);
      return NextResponse.json(
        { error: 'Failed to delete document' },
        { status: 500 }
      );
    }
    return NextResponse.json({ success: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
