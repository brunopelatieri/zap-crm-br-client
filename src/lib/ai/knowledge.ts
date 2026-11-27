import type { SupabaseClient } from '@supabase/supabase-js';
import type { AiConfig, KnowledgeHit, KnowledgeHitOrigin } from './types';
import { chunkDocument } from './chunk';
import { KNOWLEDGE_MAX_DISTANCE, KNOWLEDGE_TOP_K } from './defaults';
import { buildLexicalQuery } from './query';
import {
  EMBEDDINGS_PROVIDER_CONFIG,
  embedTexts,
  toVectorLiteral,
} from './embeddings';

// ============================================================
// Knowledge base: ingest (chunk + optionally embed) and hybrid retrieve
// (SPEC 089 F3: one RPC fuses the vector search and the Portuguese
// full-text search by reciprocal rank, behind a distance ceiling).
// ============================================================

export interface IngestDoc {
  id: string;
  title: string;
  /** `text` | `file` | `url` | `faq` — escolhe o fatiador (D-12). */
  sourceType: string;
  content: string;
}

export interface IngestResult {
  chunkCount: number;
  /** Identificador PEDIDO ao provedor (D-4); nulo = fatias só léxicas. */
  embeddingModel: string | null;
  /** Falha do provedor de embeddings: as fatias ficaram gravadas, só léxicas. */
  embedError: unknown;
}

// Linhas por INSERT: um vetor de 1536 floats pesa ~15 KB em texto, e um
// documento de 500 mil caracteres passa de 600 fatias — numa requisição só
// o corpo estoura o limite do PostgREST.
const INSERT_BATCH = 40;

/**
 * (Re)build the chunks for one document. Deletes the document's
 * existing chunks, re-chunks the content (section title prefixed,
 * 150-char overlap, Q&A pairs intact — D-12), and — when the account has
 * an embeddings target — embeds each chunk, recording the model on the
 * row (D-4). Runs under whatever client the caller passes (service-role
 * for the indexing paths).
 *
 * A DB error throws. An EMBEDDING failure does not: the chunks are still
 * stored (so the document stays searchable lexically) and the error comes
 * back in `embedError`, for the caller's state machine to decide between
 * retry and `error`.
 */
export async function ingestDocument(
  db: SupabaseClient,
  accountId: string,
  config: Pick<AiConfig, 'embeddingsTarget'>,
  doc: IngestDoc
): Promise<IngestResult> {
  const chunks = chunkDocument(doc);

  const replaceChunks = async () => {
    // Replace, don't append — re-ingest must be idempotent.
    const { error: delErr } = await db
      .from('ai_knowledge_chunks')
      .delete()
      .eq('document_id', doc.id)
      .eq('account_id', accountId);
    if (delErr) throw delErr;
  };

  if (chunks.length === 0) {
    await replaceChunks();
    return { chunkCount: 0, embeddingModel: null, embedError: null };
  }

  // Embed if a target is set, but DON'T let an embedding failure stop the
  // chunks from being stored: a failed embed must still leave the
  // document searchable lexically.
  let embeddings: number[][] | null = null;
  let embedError: unknown = null;
  const embeddingModel = config.embeddingsTarget
    ? EMBEDDINGS_PROVIDER_CONFIG[config.embeddingsTarget.provider].model
    : null;
  if (config.embeddingsTarget) {
    try {
      embeddings = await embedTexts(
        config.embeddingsTarget,
        chunks.map((c) => c.content)
      );
    } catch (err) {
      embedError = err;
    }
  }

  // Só agora troca as fatias: o embedding de um documento grande leva
  // segundos ou minutos, e apagar ANTES deixaria o documento (num
  // "Reindexar tudo", a base inteira) fora da recuperação durante todo
  // esse tempo.
  await replaceChunks();

  const rows = chunks.map((chunk, i) => ({
    document_id: doc.id,
    account_id: accountId,
    chunk_index: i,
    content: chunk.content,
    heading: chunk.heading,
    embedding: embeddings ? toVectorLiteral(embeddings[i]) : null,
    embedding_model: embeddings ? embeddingModel : null,
  }));

  for (let i = 0; i < rows.length; i += INSERT_BATCH) {
    const { error: insErr } = await db
      .from('ai_knowledge_chunks')
      .insert(rows.slice(i, i + INSERT_BATCH));
    if (insErr) throw insErr;
  }

  return {
    chunkCount: rows.length,
    embeddingModel: embeddings ? embeddingModel : null,
    embedError,
  };
}

export interface RetrieveOptions {
  /** Excerpts to return (default `KNOWLEDGE_TOP_K`). */
  k?: number;
  /** Cosine-distance ceiling for the semantic half (default
   *  `KNOWLEDGE_MAX_DISTANCE`). */
  maxDistance?: number;
}

export interface KnowledgeSearch {
  hits: KnowledgeHit[];
  /** The hybrid RPC failed (database error): `hits` is empty because the
   *  search did not run, not because nothing matched. */
  searchFailed: boolean;
  /** A query embedding went into the search. */
  usedEmbedding: boolean;
  /** The account has an embeddings target but the query embedding failed,
   *  so only the word search ran. */
  embeddingFailed: boolean;
  /** The account has no knowledge-base chunks at all (nothing was searched). */
  knowledgeEmpty: boolean;
}

interface HybridRow {
  chunk_id: string;
  document_id: string;
  title: string | null;
  heading: string | null;
  content: string;
  distance: number | null;
  lexical_rank: number | null;
  score: number;
  source: string;
}

const ORIGINS: readonly KnowledgeHitOrigin[] = ['semantic', 'lexical', 'both'];

/** Map one `match_ai_knowledge_hybrid` row; null when it is malformed. */
export function mapHybridRow(row: unknown): KnowledgeHit | null {
  if (!row || typeof row !== 'object') return null;
  const r = row as Partial<HybridRow>;
  if (typeof r.chunk_id !== 'string' || typeof r.content !== 'string') {
    return null;
  }
  const origin = ORIGINS.find((o) => o === r.source);
  if (!origin) return null;
  return {
    chunkId: r.chunk_id,
    documentId: typeof r.document_id === 'string' ? r.document_id : null,
    title: typeof r.title === 'string' ? r.title : null,
    heading: typeof r.heading === 'string' ? r.heading : null,
    content: r.content,
    distance: typeof r.distance === 'number' ? r.distance : null,
    lexicalRank: typeof r.lexical_rank === 'number' ? r.lexical_rank : null,
    score: typeof r.score === 'number' ? r.score : 0,
    origin,
  };
}

/**
 * Search the account's knowledge base for `queryText` (SPEC 089 D-10).
 *
 * One call to `match_ai_knowledge_hybrid`: the query embedding (when the
 * account has an embeddings target) and the topical words of the text go in
 * together; the RPC fuses both rankings by reciprocal rank and drops a
 * vector-only excerpt beyond the distance ceiling, so a question with no
 * answer in the base brings back nothing instead of the 5 "nearest" chunks.
 *
 * Best-effort (rule 9): every failure degrades to fewer or zero hits and
 * never throws. An embedding failure leaves the lexical half; a hybrid RPC
 * failure returns no hits with `searchFailed` set.
 */
export async function searchKnowledge(
  db: SupabaseClient,
  accountId: string,
  config: Pick<AiConfig, 'embeddingsTarget'>,
  queryText: string,
  opts: RetrieveOptions = {}
): Promise<KnowledgeSearch> {
  const k = opts.k ?? KNOWLEDGE_TOP_K;
  const empty: KnowledgeSearch = {
    hits: [],
    searchFailed: false,
    usedEmbedding: false,
    embeddingFailed: false,
    knowledgeEmpty: false,
  };
  const query = queryText.trim();
  if (!query || k <= 0) return empty;

  // Skip everything when the account has no knowledge base — otherwise
  // every draft / auto-reply would pay for a query embedding plus an RPC
  // just to get []. One cheap indexed COUNT (head, no rows) instead of a
  // paid embeddings call on the hot path.
  try {
    const { count, error } = await db
      .from('ai_knowledge_chunks')
      .select('id', { count: 'exact', head: true })
      .eq('account_id', accountId);
    if (error) return empty;
    if (!count) return { ...empty, knowledgeEmpty: true };
  } catch {
    return empty;
  }

  let embeddingLiteral: string | null = null;
  let embeddingModel: string | null = null;
  let embeddingFailed = false;
  if (config.embeddingsTarget) {
    try {
      const [queryEmbedding] = await embedTexts(config.embeddingsTarget, [
        query,
      ]);
      if (queryEmbedding) {
        embeddingLiteral = toVectorLiteral(queryEmbedding);
        embeddingModel =
          EMBEDDINGS_PROVIDER_CONFIG[config.embeddingsTarget.provider].model;
      } else {
        embeddingFailed = true;
      }
    } catch (err) {
      embeddingFailed = true;
      console.error(
        '[ai knowledge] query embedding failed, lexical only:',
        err
      );
    }
  }

  const lexical = buildLexicalQuery(query);
  // Nothing to search with (no vector, no topical word).
  if (!embeddingLiteral && !lexical) return { ...empty, embeddingFailed };

  try {
    const { data, error } = await db.rpc('match_ai_knowledge_hybrid', {
      p_account_id: accountId,
      p_query: lexical,
      p_query_embedding: embeddingLiteral,
      p_embedding_model: embeddingModel,
      p_match_count: k,
      p_max_distance: opts.maxDistance ?? KNOWLEDGE_MAX_DISTANCE,
    });
    if (!error && Array.isArray(data)) {
      const hits = data
        .map(mapHybridRow)
        .filter((h): h is KnowledgeHit => h !== null)
        .slice(0, k);
      return {
        hits,
        searchFailed: false,
        usedEmbedding: !!embeddingLiteral,
        embeddingFailed,
        knowledgeEmpty: false,
      };
    }
    console.error('[ai knowledge] hybrid retrieval failed:', error);
  } catch (err) {
    console.error('[ai knowledge] hybrid retrieval threw:', err);
  }

  return {
    hits: [],
    searchFailed: true,
    usedEmbedding: !!embeddingLiteral,
    embeddingFailed,
    knowledgeEmpty: false,
  };
}

/**
 * Convenience over `searchKnowledge` for the turn (compose.ts): the hits
 * only. Never throws.
 */
export async function retrieveKnowledge(
  db: SupabaseClient,
  accountId: string,
  config: Pick<AiConfig, 'embeddingsTarget'>,
  queryText: string,
  opts: RetrieveOptions = {}
): Promise<KnowledgeHit[]> {
  return (await searchKnowledge(db, accountId, config, queryText, opts)).hits;
}
