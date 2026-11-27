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

/**
 * The turn's sources: the automatic retrieval's, then any surfaced by
 * `search_knowledge` calls (SPEC 089 F4), without repeating an excerpt.
 */
export function turnSources(
  composed: KnowledgeSource[],
  fromTools: KnowledgeSource[] | undefined
): KnowledgeSource[] {
  const out = [...composed];
  for (const s of fromTools ?? []) {
    if (!out.some((x) => x.chunkId === s.chunkId)) out.push(s);
  }
  return out;
}

/** `ai_usage_log.tool_calls` CHECK ceiling (migration 105). */
const MAX_LOGGED_TOOL_CALLS = 200;

/** Tool-turn usage fields for `logAiUsage` (absent on a tool-less turn). */
export function toolUsageOf(result: {
  steps?: number;
  toolCalls?: unknown[];
}): { steps?: number; toolCalls?: number } {
  if (!result.toolCalls) return {};
  // Clamped to the column CHECK (migration 105): an overflow would make
  // the insert fail and the whole usage row (tokens, cost) would be lost.
  return {
    steps: result.steps,
    toolCalls: Math.min(result.toolCalls.length, MAX_LOGGED_TOOL_CALLS),
  };
}
