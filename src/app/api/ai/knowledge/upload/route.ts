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
import { extractFileText } from '@/lib/ai/ingest/extract-file';
import { MAX_FILE_BYTES } from '@/lib/ai/ingest/limits';
import {
  createResultResponse,
  ingestErrorResponse,
  scheduleIndexing,
} from '@/lib/ai/ingest/route-helpers';

export const maxDuration = 300;

/** Folga para o envelope multipart (cabeçalhos das partes e campos de texto). */
const MULTIPART_OVERHEAD_BYTES = 256 * 1024;

/**
 * POST /api/ai/knowledge/upload  (admin+) — multipart/form-data
 *
 * Fields: `file` (PDF, DOCX, TXT, MD or CSV, up to 10 MB), `title?`,
 * `tags?` (comma-separated). The text is extracted on the server and ONLY
 * the text is stored; the original file is not kept (SPEC 089 D-7).
 *
 * ATENÇÃO: o middleware de sessão (`src/middleware.ts`) bufferiza o corpo
 * de toda rota que ele roda, com teto de 10 MB, e entrega o corpo
 * TRUNCADO sem erro — um PDF perto do limite chegaria cortado. Esta rota
 * está fora do `matcher` por isso e confere a sessão sozinha
 * (`requireRole`).
 */
export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('admin');
    // SPEC 089 D-20: ai_enabled em modo estrito (chave ausente = bloqueado).
    await requireAiFeature(accountId);
    const limit = checkRateLimit(
      `ai-kb-upload:${userId}`,
      RATE_LIMITS.adminAction
    );
    if (!limit.success) return rateLimitResponse(limit);

    // Recusa pelo tamanho declarado ANTES de ler o corpo para a memória.
    const declared = Number(request.headers.get('content-length'));
    if (!Number.isFinite(declared) || declared <= 0) {
      return NextResponse.json(
        { error: 'Content-Length is required', code: 'invalid_input' },
        { status: 411 }
      );
    }
    if (declared > MAX_FILE_BYTES + MULTIPART_OVERHEAD_BYTES) {
      return NextResponse.json(
        { error: 'The file is larger than 10 MB.', code: 'file_too_large' },
        { status: 413 }
      );
    }

    const form = await request.formData().catch(() => null);
    const file = form?.get('file');
    if (!form || !(file instanceof File) || file.size === 0) {
      return NextResponse.json(
        { error: 'file is required', code: 'invalid_input' },
        { status: 400 }
      );
    }

    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const extracted = await extractFileText({ name: file.name, bytes });
      const rawTitle = form.get('title');
      const title =
        cleanTitle(typeof rawTitle === 'string' ? rawTitle : '') ||
        cleanTitle(extracted.title) ||
        cleanTitle(file.name);
      const rawTags = form.get('tags');
      const tags = normalizeTags(typeof rawTags === 'string' ? rawTags : []);

      const result = await createKnowledgeDocument(
        supabase,
        accountId,
        userId,
        {
          title: title || 'Document',
          content: extracted.text,
          sourceType: 'file',
          sourceName: file.name.slice(0, 255),
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
