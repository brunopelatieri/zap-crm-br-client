import { NextResponse, after } from 'next/server';

import { supabaseAdmin } from '@/lib/ai/admin-client';

import type { CreateResult } from './documents';
import { IngestError } from './errors';
import { indexPendingDocuments } from './indexer';
import { AFTER_INDEX_BATCH } from './limits';

// ============================================================
// Pedaços comuns das rotas de `/api/ai/knowledge/**` (SPEC 089 F2).
// Mensagens em inglês (é `/api/**`); `code` é estável e a tela o traduz.
// ============================================================

export function ingestErrorResponse(err: IngestError): NextResponse {
  return NextResponse.json(
    { error: err.message, code: err.code },
    { status: err.status }
  );
}

export function createResultResponse(result: CreateResult): NextResponse {
  if (result.ok) {
    return NextResponse.json({
      success: true,
      id: result.id,
      status: 'pending',
    });
  }
  if (result.reason === 'duplicate') {
    return NextResponse.json(
      {
        error: 'An identical document already exists in the knowledge base.',
        code: 'duplicate_content',
        existing: result.existing,
      },
      { status: 409 }
    );
  }
  if (result.reason === 'quota') {
    return NextResponse.json(
      {
        error: `Knowledge document quota exceeded (${result.quota.used}/${result.quota.limit}).`,
        code: 'quota_exceeded',
        quota: result.quota,
      },
      { status: 403 }
    );
  }
  return NextResponse.json(
    { error: 'Failed to save document' },
    { status: 500 }
  );
}

/**
 * Indexa fora da requisição (D-9). A rota já validou a conta e o papel; o
 * `after()` roda com o client de service_role, porque o de sessão depende
 * de cookies da requisição. O que passar de `AFTER_INDEX_BATCH` fica
 * `pending` para a varredura do cron.
 */
export function scheduleIndexing(
  accountId: string,
  documentIds: string[]
): void {
  const batch = documentIds.slice(0, AFTER_INDEX_BATCH);
  if (batch.length === 0) return;
  after(async () => {
    await indexPendingDocuments(supabaseAdmin(), accountId, batch);
  });
}
