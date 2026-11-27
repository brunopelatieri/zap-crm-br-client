import type { KnowledgeSource } from './types';

/**
 * The unique, non-null document ids behind a turn's knowledge sources
 * (SPEC 089 D-14), in first-seen order — what
 * `ai_usage_log.knowledge_document_ids` stores. Pure.
 */
export function documentIdsOf(sources: KnowledgeSource[]): string[] {
  const ids = new Set<string>();
  for (const s of sources) if (s.documentId) ids.add(s.documentId);
  return Array.from(ids);
}
