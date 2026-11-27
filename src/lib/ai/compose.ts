import type { SupabaseClient } from '@supabase/supabase-js';
import type { ChannelType } from '@/lib/channels/types';
import { resolveChannelTypeForConversation } from '@/lib/channels/conversation-channel';
import { buildSystemPrompt } from './defaults';
import { retrieveKnowledge } from './knowledge';
import { buildRetrievalQuery } from './query';
import { retrieveExamples } from './tuning/examples';
import type { ExampleHit } from './tuning/types';
import { buildToolContext } from './tools/context';
import { loadCustomToolsForTurn } from './tools/custom-tools';
import { isWriteSwitchedOff } from './tools/kill-switch';
import { toolsForTurn } from './tools/registry';
import type { AgentTool, ToolContext } from './tools/types';
import type { AiConfig, ChatMessage, KnowledgeSource } from './types';

// ============================================================
// compose.ts — the single place that assembles one agent turn
// (SPEC 089 P-7). Auto-reply, the inbox draft and the playground all go
// through `composeAgentTurn`, so a new input (lead profile, dynamic
// examples — SPEC 086 I-14/I-15, SPEC 089 F7) is added here once instead
// of in each caller.
//
// Knowledge retrieval (best-effort, hybrid — SPEC 089 F3; the query is the
// customer's last up-to-3 messages, D-13) → channel type → tools (F4:
// the account's enabled tools narrowed by mode, bound to the conversation
// by `buildToolContext`) → `buildSystemPrompt`. The excerpts' sources
// (D-14) come back beside the prompt and are never put in the
// customer-facing text.
// ============================================================

/** `eval` (SPEC 089 F7): a run of the evaluation set: the real prompt, tools
 *  in dry run, nothing sent. */
export type ComposeMode = 'auto_reply' | 'draft' | 'playground' | 'eval';

export interface ComposeArgs {
  /** Client the retrieval / channel / tool lookups run under (service role
   *  from the webhook, the RLS-scoped client from a route). */
  db: SupabaseClient;
  accountId: string;
  config: Pick<AiConfig, 'systemPrompt' | 'embeddingsTarget' | 'toolsConfig'>;
  mode: ComposeMode;
  /** Recent conversation turns, oldest first. */
  messages: ChatMessage[];
  /** The conversation the reply goes to. Null in the playground (no
   *  conversation to resolve a channel from → WhatsApp-style prompt). */
  conversationId?: string | null;
}

export interface ComposedTurn {
  systemPrompt: string;
  /** Present only with tools: the same prompt without the tools paragraph,
   *  for the "model rejects tools" retry (§5.3 rule 5). */
  fallbackSystemPrompt?: string;
  messages: ChatMessage[];
  /** Knowledge excerpts that went into the prompt. */
  knowledge: string[];
  /** Where each excerpt came from (same order as `knowledge`). */
  sources: KnowledgeSource[];
  /** Approved examples that went into the prompt (F7), most similar first. */
  examples: ExampleHit[];
  /** Channel the reply will go out on; undefined in the playground. */
  channelType: ChannelType | undefined;
  /** Tools offered this turn (empty = a single model call, as before F4). */
  tools: AgentTool[];
  /** Null when no tool is offered. */
  toolContext: ToolContext | null;
}

/**
 * Build everything `generateReply` needs for one turn. Never throws on a
 * retrieval failure (retrieval is best-effort); channel resolution
 * errors propagate as they did before. A conversation that does not
 * resolve for the account turns the tools off (never on with a wrong
 * contact).
 */
export async function composeAgentTurn(
  args: ComposeArgs
): Promise<ComposedTurn> {
  const { db, accountId, config, mode, messages, conversationId } = args;

  // Ground the reply in the account's knowledge base (best-effort).
  // The dynamic examples (SPEC 089 F7: the 3 approved ones most similar to the
  // same query) are also best-effort and run alongside the knowledge search.
  const retrievalQuery = buildRetrievalQuery(messages);
  const [hits, examples] = await Promise.all([
    retrieveKnowledge(db, accountId, config, retrievalQuery),
    retrieveExamples(db, accountId, config, retrievalQuery),
  ]);
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

  // Tools (SPEC 089 F4). Nothing is queried when the account has none on,
  // so a tool-less account costs exactly what it did before.
  // Built-in tools (per the account's `tools_config`) plus the account's own
  // HTTP tools (F6, `ai_custom_tools`: each one is its own switch). A custom
  // name that collides with a built-in one is dropped: the built-in wins.
  const builtin = toolsForTurn(config.toolsConfig, mode);
  const custom = (await loadCustomToolsForTurn({ accountId, mode })).filter(
    (c) =>
      !builtin.some((b) => b.key === c.key) &&
      // Global kill switch (SPEC 089 F8): no HTTP write in a live turn.
      !(
        mode === 'auto_reply' &&
        c.risk === 'write' &&
        isWriteSwitchedOff(c.key)
      )
  );
  let tools = [...builtin, ...custom];
  let toolContext: ToolContext | null = null;
  if (tools.length > 0) {
    toolContext = await buildToolContext({
      db,
      accountId,
      conversationId: conversationId ?? null,
      mode,
      toolsConfig: config.toolsConfig ?? {},
      // Only what the handlers need: never the chat API key.
      aiConfig: { embeddingsTarget: config.embeddingsTarget },
    });
    if (!toolContext) tools = [];
  }

  const promptArgs = {
    userPrompt: config.systemPrompt,
    // The playground runs the exact auto-reply path (handoff protocol
    // included), so what the admin sees is what a customer would get.
    mode: mode === 'draft' ? ('draft' as const) : ('auto_reply' as const),
    knowledge,
    examples,
    channelType,
  };
  const systemPrompt = buildSystemPrompt({
    ...promptArgs,
    toolsEnabled: tools.length > 0,
    writeToolsEnabled: tools.some((t) => t.risk === 'write'),
  });

  return {
    systemPrompt,
    // The retry without tools (model rejects them) must not be told to use
    // tools it does not have.
    ...(tools.length > 0
      ? { fallbackSystemPrompt: buildSystemPrompt(promptArgs) }
      : {}),
    messages,
    knowledge,
    sources,
    examples,
    channelType,
    tools,
    toolContext,
  };
}
