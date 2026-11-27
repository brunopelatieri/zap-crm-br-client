import type { SupabaseClient } from '@supabase/supabase-js';

import { parseQuotaError, type QuotaError } from '@/lib/plans/errors';

import { IngestError } from './errors';
import { hashContent } from './indexer';
import {
  MAX_DOCUMENT_CHARS,
  MAX_TAG_LENGTH,
  MAX_TAGS,
  MAX_TITLE_CHARS,
} from './limits';

// ============================================================
// Criação e edição de documentos da base (SPEC 089 F2). Todas as fontes
// (texto colado, arquivo, URL, perguntas e respostas) chegam aqui já como
// texto puro e saem como uma linha `pending`: a indexação roda fora da
// requisição (`indexer.ts`).
// ============================================================

export const KNOWLEDGE_METRIC = 'knowledge_documents';

export type SourceType = 'text' | 'file' | 'url' | 'faq';

export interface NewDocument {
  title: string;
  content: string;
  sourceType: SourceType;
  sourceName?: string | null;
  sourceUrl?: string | null;
  mimeType?: string | null;
  tags?: string[];
}

export type CreateResult =
  | { ok: true; id: string }
  | { ok: false; reason: 'duplicate'; existing: { id: string; title: string } }
  | { ok: false; reason: 'quota'; quota: QuotaError }
  | { ok: false; reason: 'error' };

/** Título aparado e limitado; vazio é erro de entrada. */
export function cleanTitle(raw: unknown): string {
  const title = typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim() : '';
  return title.slice(0, MAX_TITLE_CHARS);
}

/**
 * Etiquetas: lista ou texto separado por vírgula. Aparadas, sem repetir
 * (sem diferenciar caixa), no máximo `MAX_TAGS`. Lança `IngestError` se
 * passar do limite — melhor recusar do que cortar em silêncio.
 */
export function normalizeTags(input: unknown): string[] {
  let list: unknown[] = [];
  if (Array.isArray(input)) list = input;
  else if (typeof input === 'string') list = input.split(',');
  else if (input === undefined || input === null) list = [];
  else
    throw new IngestError('invalid_input', 'tags must be a list of strings.');

  const seen = new Set<string>();
  const tags: string[] = [];
  for (const raw of list) {
    if (typeof raw !== 'string') {
      throw new IngestError('invalid_input', 'tags must be a list of strings.');
    }
    const tag = raw.replace(/\s+/g, ' ').trim().slice(0, MAX_TAG_LENGTH);
    if (!tag || seen.has(tag.toLowerCase())) continue;
    seen.add(tag.toLowerCase());
    tags.push(tag);
  }
  if (tags.length > MAX_TAGS) {
    throw new IngestError(
      'invalid_input',
      `At most ${MAX_TAGS} tags per document.`
    );
  }
  return tags;
}

/** Texto do documento: aparado, não vazio, dentro de 500 mil caracteres. */
export function cleanContent(raw: unknown): string {
  const content = typeof raw === 'string' ? raw.trim() : '';
  if (!content) throw new IngestError('empty_text', 'The text is empty.');
  if (content.length > MAX_DOCUMENT_CHARS) {
    throw new IngestError(
      'text_too_long',
      'The text is over 500,000 characters.'
    );
  }
  return content;
}

/**
 * Cria o documento `pending`. Mesmo conteúdo já existente na conta
 * (`content_hash`) não cria nada: devolve o existente (idempotência, §5.2).
 * A quota `knowledge_documents` é decidida pela trigger do banco (103) e
 * volta como `QUOTA_EXCEEDED:…` no INSERT.
 */
export async function createKnowledgeDocument(
  db: SupabaseClient,
  accountId: string,
  userId: string,
  doc: NewDocument
): Promise<CreateResult> {
  const hash = hashContent(doc.content);

  const { data: existing } = await db
    .from('ai_knowledge_documents')
    .select('id, title')
    .eq('account_id', accountId)
    .eq('content_hash', hash)
    .limit(1)
    .maybeSingle();
  if (existing) {
    return {
      ok: false,
      reason: 'duplicate',
      existing: { id: existing.id as string, title: existing.title as string },
    };
  }

  const { data, error } = await db
    .from('ai_knowledge_documents')
    .insert({
      account_id: accountId,
      created_by: userId,
      title: doc.title,
      content: doc.content,
      source_type: doc.sourceType,
      source_name: doc.sourceName ?? null,
      source_url: doc.sourceUrl ?? null,
      mime_type: doc.mimeType ?? null,
      tags: doc.tags ?? [],
      status: 'pending',
      index_attempts: 0,
      char_count: doc.content.length,
      content_hash: hash,
    })
    .select('id')
    .single();

  if (error || !data) {
    const quota = parseQuotaError(error);
    if (quota && quota.metric === KNOWLEDGE_METRIC) {
      return { ok: false, reason: 'quota', quota };
    }
    console.error('[ai knowledge] insert failed:', error?.message ?? error);
    return { ok: false, reason: 'error' };
  }
  return { ok: true, id: data.id as string };
}
