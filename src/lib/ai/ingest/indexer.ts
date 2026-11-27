import { createHash } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';

import { loadEmbeddingsTarget } from '@/lib/ai/config';
import { ingestDocument } from '@/lib/ai/knowledge';
import type { EmbeddingsTarget } from '@/lib/ai/types';

import {
  INDEXING_STALE_MINUTES,
  MAX_INDEX_ATTEMPTS,
  SWEEP_DOCUMENTS_PER_CYCLE,
} from './limits';

// ============================================================
// Máquina de estados da indexação (SPEC 089 D-9).
//
//   pending ──claim──▶ indexing ──ok──▶ ready
//      ▲                  │
//      └── falha, ainda ──┤
//          há tentativas  └─ esgotou as tentativas ──▶ error
//
// Quem indexa:
//   1. o `after()` da rota que criou/editou/reindexou o documento
//      (`indexPendingDocuments`) — a tentativa 1;
//   2. a fase de varredura do `/api/automations/cron`
//      (`sweepKnowledgeIndexing`) — retoma `pending` e `indexing` parado há
//      mais de 10 minutos (processo reiniciado no meio), com limite de
//      documentos por ciclo.
//
// A reivindicação é um UPDATE condicional (status + nº de tentativas), então
// duas invocações sobrepostas nunca indexam o mesmo documento duas vezes
// pelo mesmo caminho. Roda sempre com o client de service_role e com a
// conta já validada por quem chama.
//
// Erro de DB/fatiamento nunca sobe daqui: vira estado do documento.
// ============================================================

export function hashContent(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

export interface IndexRow {
  id: string;
  account_id: string;
  title: string;
  source_type: string;
  content: string;
  status: string;
  index_attempts: number;
  index_started_at: string | null;
}

const ROW_COLUMNS =
  'id, account_id, title, source_type, content, status, index_attempts, index_started_at';

export type IndexOutcome = 'ready' | 'retry' | 'error' | 'skipped';

/** Código curto em `index_error`; a tela o traduz. `<código>:<detalhe>` quando há detalhe seguro. */
function embeddingsErrorCode(err: unknown): string {
  const code =
    err && typeof err === 'object' && 'code' in err
      ? String((err as { code?: unknown }).code ?? '')
      : '';
  return /^[a-z_]{3,40}$/.test(code)
    ? `embeddings_failed:${code}`
    : 'embeddings_failed';
}

/**
 * Reivindica o documento (CAS por status e nº de tentativas). `null` =
 * outro processo chegou antes, ou o documento mudou.
 */
async function claim(
  db: SupabaseClient,
  row: Pick<IndexRow, 'id' | 'status' | 'index_attempts'>,
  now: Date,
  staleCutoff: Date
): Promise<IndexRow | null> {
  let q = db
    .from('ai_knowledge_documents')
    .update({
      status: 'indexing',
      index_started_at: now.toISOString(),
      index_attempts: row.index_attempts + 1,
    })
    .eq('id', row.id)
    .eq('index_attempts', row.index_attempts);

  q =
    row.status === 'pending'
      ? q.eq('status', 'pending')
      : q
          .eq('status', 'indexing')
          .lt('index_started_at', staleCutoff.toISOString());

  const { data, error } = await q.select(ROW_COLUMNS).maybeSingle();
  if (error || !data) return null;
  return data as IndexRow;
}

async function finish(
  db: SupabaseClient,
  doc: IndexRow,
  patch: Record<string, unknown>
): Promise<void> {
  // Só escreve se o documento continua do MESMO claim: um PATCH que voltou
  // o documento a `pending` enquanto indexávamos não é sobrescrito. A
  // guarda é o nº de tentativas (inteiro, cada claim o incrementa), e não o
  // timestamp: igualdade de timestamptz depende do formato que o banco
  // devolve e do arredondamento, e um empate falho deixaria o documento
  // em `indexing` até a varredura.
  const { error } = await db
    .from('ai_knowledge_documents')
    .update(patch)
    .eq('id', doc.id)
    .eq('status', 'indexing')
    .eq('index_attempts', doc.index_attempts);
  if (error) {
    console.error('[ai knowledge] could not record indexing state:', error);
  }
}

/** Indexa um documento JÁ reivindicado e grava o estado final. */
async function runClaimed(
  db: SupabaseClient,
  doc: IndexRow,
  embeddings: { target: EmbeddingsTarget | null; corrupt: boolean }
): Promise<IndexOutcome> {
  const exhausted = doc.index_attempts >= MAX_INDEX_ATTEMPTS;
  const failure = (code: string): Promise<IndexOutcome> =>
    finish(
      db,
      doc,
      exhausted
        ? { status: 'error', index_error: code, index_started_at: null }
        : { status: 'pending', index_error: code, index_started_at: null }
    ).then(() => (exhausted ? 'error' : 'retry'));

  try {
    const result = await ingestDocument(
      db,
      doc.account_id,
      { embeddingsTarget: embeddings.target },
      {
        id: doc.id,
        title: doc.title,
        sourceType: doc.source_type,
        content: doc.content,
      }
    );

    if (result.chunkCount === 0) {
      // Sem fatia não há o que tentar de novo.
      await finish(db, doc, {
        status: 'error',
        index_error: 'empty_text',
        chunk_count: 0,
        index_started_at: null,
      });
      return 'error';
    }

    if (result.embedError) {
      console.error(
        `[ai knowledge] embeddings failed for document ${doc.id} (attempt ${doc.index_attempts}):`,
        result.embedError instanceof Error
          ? result.embedError.message
          : result.embedError
      );
      // As fatias léxicas ficaram gravadas: a busca por palavra já funciona.
      await finish(db, doc, { chunk_count: result.chunkCount });
      return failure(embeddingsErrorCode(result.embedError));
    }

    await finish(db, doc, {
      status: 'ready',
      // Chave de embeddings ilegível: indexou só por palavras e diz isso.
      index_error: embeddings.corrupt ? 'embeddings_key_unreadable' : null,
      index_attempts: 0,
      index_started_at: null,
      chunk_count: result.chunkCount,
      indexed_at: new Date().toISOString(),
    });
    return 'ready';
  } catch (err) {
    console.error(
      `[ai knowledge] indexing failed for document ${doc.id} (attempt ${doc.index_attempts}):`,
      err instanceof Error ? err.message : err
    );
    return failure('indexing_failed');
  }
}

/**
 * Caminho do `after()` das rotas: indexa os documentos `pending` pedidos,
 * um de cada vez (cada um reivindicado só na sua vez, para o resto não
 * parecer "indexando" enquanto espera). Nunca lança.
 */
export async function indexPendingDocuments(
  db: SupabaseClient,
  accountId: string,
  documentIds: string[]
): Promise<Record<IndexOutcome, number>> {
  const counts: Record<IndexOutcome, number> = {
    ready: 0,
    retry: 0,
    error: 0,
    skipped: 0,
  };
  try {
    const embeddings = await loadEmbeddingsTarget(db, accountId);
    for (const id of documentIds) {
      const { data } = await db
        .from('ai_knowledge_documents')
        .select(ROW_COLUMNS)
        .eq('id', id)
        .eq('account_id', accountId)
        .eq('status', 'pending')
        .maybeSingle();
      const row = data as IndexRow | null;
      const now = new Date();
      const claimed = row
        ? await claim(db, row, now, new Date(now.getTime()))
        : null;
      if (!claimed) {
        counts.skipped++;
        continue;
      }
      counts[await runClaimed(db, claimed, embeddings)]++;
    }
  } catch (err) {
    console.error('[ai knowledge] indexing batch failed:', err);
  }
  return counts;
}

export interface SweepResult {
  candidates: number;
  claimed: number;
  ready: number;
  retried: number;
  failed: number;
}

/** `pending` precisa estar parado antes de a varredura pegar: dá tempo ao `after()` da rota. */
const PENDING_GRACE_MINUTES = 2;

/**
 * Fase do `/api/automations/cron` (D-9): retoma `pending` e `indexing`
 * parado há mais de `INDEXING_STALE_MINUTES`, no máximo `limit`
 * documentos por ciclo. Nunca lança (ninguém lê a exceção no cron).
 */
export async function sweepKnowledgeIndexing(
  db: SupabaseClient,
  now: Date,
  opts: { limit?: number } = {}
): Promise<SweepResult> {
  const result: SweepResult = {
    candidates: 0,
    claimed: 0,
    ready: 0,
    retried: 0,
    failed: 0,
  };
  const limit = opts.limit ?? SWEEP_DOCUMENTS_PER_CYCLE;
  try {
    const staleCutoff = new Date(
      now.getTime() - INDEXING_STALE_MINUTES * 60_000
    );
    const pendingCutoff = new Date(
      now.getTime() - PENDING_GRACE_MINUTES * 60_000
    );

    const { data, error } = await db
      .from('ai_knowledge_documents')
      .select(ROW_COLUMNS)
      .or(
        `and(status.eq.pending,updated_at.lt.${pendingCutoff.toISOString()}),` +
          `and(status.eq.indexing,index_started_at.lt.${staleCutoff.toISOString()})`
      )
      .order('created_at', { ascending: true })
      .limit(limit);
    if (error) {
      console.error('[ai knowledge] sweep query failed:', error.message);
      return result;
    }

    const rows = (data ?? []) as IndexRow[];
    result.candidates = rows.length;
    const targets = new Map<
      string,
      { target: EmbeddingsTarget | null; corrupt: boolean }
    >();

    for (const row of rows) {
      // Tentativas esgotadas (ex.: o processo morre sempre no mesmo
      // documento): para de tentar e deixa o botão de reindexar.
      if (row.index_attempts >= MAX_INDEX_ATTEMPTS) {
        const claimedForError = await claim(db, row, now, staleCutoff);
        if (claimedForError) {
          await finish(db, claimedForError, {
            status: 'error',
            index_error: 'indexing_stalled',
            index_started_at: null,
          });
          result.failed++;
        }
        continue;
      }

      const claimed = await claim(db, row, now, staleCutoff);
      if (!claimed) continue;
      result.claimed++;

      let embeddings = targets.get(claimed.account_id);
      if (!embeddings) {
        embeddings = await loadEmbeddingsTarget(db, claimed.account_id);
        targets.set(claimed.account_id, embeddings);
      }
      const outcome = await runClaimed(db, claimed, embeddings);
      if (outcome === 'ready') result.ready++;
      else if (outcome === 'retry') result.retried++;
      else result.failed++;
    }
  } catch (err) {
    console.error('[ai knowledge] sweep failed:', err);
  }
  return result;
}
