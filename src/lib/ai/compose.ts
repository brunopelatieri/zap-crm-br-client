import type { SupabaseClient } from '@supabase/supabase-js';
import type { ChannelType } from '@/lib/channels/types';
import { resolveChannelTypeForConversation } from '@/lib/channels/conversation-channel';
import { buildSystemPrompt } from './defaults';
import { retrieveKnowledge } from './knowledge';
import { buildRetrievalQuery } from './query';
import type { AiConfig, ChatMessage, KnowledgeSource } from './types';

// ============================================================
// compose.ts — the single place that assembles one agent turn
// (SPEC 089 P-7). Auto-reply, the inbox draft and the playground all go
// through `composeAgentTurn`, so a new input (lead profile, dynamic
// examples, tools — SPEC 086 I-14/I-15, SPEC 089 F4+) is added here once
// instead of in each caller.
//
// Knowledge retrieval (best-effort, hybrid — SPEC 089 F3; the query is the
// customer's last up-to-3 messages, D-13) → channel type →
// `buildSystemPrompt`. The excerpts' sources (D-14) come back beside the
// prompt and are never put in the customer-facing text.
// ============================================================

export type ComposeMode = 'auto_reply' | 'draft' | 'playground';

export interface ComposeArgs {
  /** Client the retrieval / channel lookups run under (service role from
   *  the webhook, the RLS-scoped client from a route). */
  db: SupabaseClient;
  accountId: string;
  config: Pick<AiConfig, 'systemPrompt' | 'embeddingsTarget'>;
  mode: ComposeMode;
  /** Recent conversation turns, oldest first. */
  messages: ChatMessage[];
  /** The conversation the reply goes to. Null in the playground (no
   *  conversation to resolve a channel from → WhatsApp-style prompt). */
  conversationId?: string | null;
}

export interface ComposedTurn {
  systemPrompt: string;
  messages: ChatMessage[];
  /** Knowledge excerpts that went into the prompt. */
  knowledge: string[];
  /** Where each excerpt came from (same order as `knowledge`). */
  sources: KnowledgeSource[];
  /** Channel the reply will go out on; undefined in the playground. */
  channelType: ChannelType | undefined;
}

/**
 * Build everything `generateReply` needs for one turn. Never throws on a
 * retrieval failure (retrieval is best-effort); channel resolution
 * errors propagate as they did before.
 */
export async function composeAgentTurn(
  args: ComposeArgs
): Promise<ComposedTurn> {
  const { db, accountId, config, mode, messages, conversationId } = args;

  // Ground the reply in the account's knowledge base (best-effort).
  const hits = await retrieveKnowledge(
    db,
    accountId,
    config,
    buildRetrievalQuery(messages)
  );
  const knowledge = hits.map((h) => h.content);
  const sources: KnowledgeSource[] = hits.map(
    ({ chunkId, documentId, title, score }) => ({
      chunkId,
      documentId,
      title,
      score,
    })
  );

  const channelType = conversationId
    ? await resolveChannelTypeForConversation(db, accountId, conversationId)
    : undefined;

  const systemPrompt = buildSystemPrompt({
    userPrompt: config.systemPrompt,
    // The playground runs the exact auto-reply path (handoff protocol
    // included), so what the admin sees is what a customer would get.
    mode: mode === 'draft' ? 'draft' : 'auto_reply',
    knowledge,
    channelType,
  });

  return { systemPrompt, messages, knowledge, sources, channelType };
}
