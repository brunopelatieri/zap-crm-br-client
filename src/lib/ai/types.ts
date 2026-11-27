// ============================================================
// Shared types for the AI reply assistant (bring-your-own-key).
//
// One small provider-agnostic surface so the inbox draft route and the
// inbound auto-reply bot both talk to `generateReply` without caring
// whether the account is on OpenAI or Anthropic.
// ============================================================

import type { ToolsConfig } from './tools/types';

export type AiProvider = 'openai' | 'anthropic' | 'openrouter';

/** All providers, in the order the settings screen lists them. */
export const AI_PROVIDERS: readonly AiProvider[] = [
  'openai',
  'anthropic',
  'openrouter',
];

/**
 * Where a retrieved excerpt came from (SPEC 089 F3): the vector search, the
 * lexical search, or both (the strongest signal).
 */
export type KnowledgeHitOrigin = 'semantic' | 'lexical' | 'both';

/**
 * What the retrieval reports about an excerpt that went into the prompt
 * (SPEC 089 D-14). `documentId` / `title` are null only on the legacy
 * fallback path (the old RPCs do not return them). Never sent to the
 * customer.
 */
export interface KnowledgeSource {
  chunkId: string;
  documentId: string | null;
  title: string | null;
  /** Sum of the reciprocal-rank-fusion contributions (0 on the legacy path). */
  score: number;
}

/** A retrieved excerpt with everything the "Test retrieval" screen shows. */
export interface KnowledgeHit extends KnowledgeSource {
  content: string;
  heading: string | null;
  /** Cosine distance (0–2); null when the vector search did not see it. */
  distance: number | null;
  /** Raw `ts_rank`; null when the lexical search did not match it. */
  lexicalRank: number | null;
  origin: KnowledgeHitOrigin;
}

/** Who serves the knowledge-base embeddings (SPEC 089 D-3). */
export type EmbeddingsProvider = 'openai' | 'openrouter';

/** Where to send an embeddings request: provider + the key to use. */
export interface EmbeddingsTarget {
  provider: EmbeddingsProvider;
  apiKey: string;
}

/**
 * Per-account provider options (`ai_configs.provider_options`), parsed.
 * `denyDataCollection` (SPEC 089 D-5, born OFF): when true, OpenRouter chat
 * requests ask for endpoints that do not retain data for training
 * (`provider: { data_collection: "deny" }`).
 */
export interface AiProviderOptions {
  denyDataCollection: boolean;
}

/**
 * Account AI setup, decrypted and ready to use. Produced by
 * `loadAiConfig` — `apiKey` is the plaintext BYO provider key
 * (stored AES-256-GCM-encrypted at rest).
 */
export interface AiConfig {
  provider: AiProvider;
  model: string;
  apiKey: string;
  systemPrompt: string | null;
  isActive: boolean;
  autoReplyEnabled: boolean;
  autoReplyMaxPerConversation: number;
  /** Where auto-reply hands a conversation off when the model bails: an
   *  agent's `auth.users.id`, or null to leave it unassigned (drop into
   *  the shared queue). */
  handoffAgentId: string | null;
  /** Who serves embeddings and with which key, already resolved (own
   *  embeddings key, or — on OpenRouter — the chat key reused, D-3). When
   *  set, the knowledge base is embedded and semantic retrieval turns on;
   *  when null, retrieval falls back to lexical full-text search. */
  embeddingsTarget: EmbeddingsTarget | null;
  /** Provider options (privacy filter etc.). */
  providerOptions: AiProviderOptions;
  /** Per-tool on/off and allow-lists (`tools_config`, migration 105,
   *  SPEC 089 D-16). Absent = every tool off. */
  toolsConfig?: ToolsConfig;
}

/** A single conversation turn in the shape both providers accept. */
export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

// ------------------------------------------------------------
// Tool calling (SPEC 089 F4, D-15): provider-neutral turns. Each adapter
// translates these to its own wire format (`tools`/`tool_calls` on the
// OpenAI-compatible APIs, `tool_use`/`tool_result` on Anthropic).
// ------------------------------------------------------------

/** The JSON Schema subset the tool catalog uses for its inputs. */
export interface JsonSchemaObject {
  type: 'object';
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
}

/** A tool as the model sees it: name, description, input schema. */
export interface ToolSpec {
  name: string;
  description: string;
  parameters: JsonSchemaObject;
}

/**
 * One tool call the model asked for. `id` is opaque (its format varies by
 * provider: `toolu_…`, `call_…`, F0 §1.3); `arguments` is the raw JSON
 * text, parsed and validated by the engine, never by the adapter.
 */
export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

/**
 * A turn in the engine's history. The leading run of plain user/assistant
 * turns is the conversation transcript; after it come the loop's own
 * turns: an assistant turn carrying `toolCalls`, then one `tool` turn per
 * call, possibly repeated.
 */
export type AgentMessage =
  | { role: 'user'; content: string }
  | {
      role: 'assistant';
      content: string;
      toolCalls?: ToolCall[];
      /** Opaque provider data that must be echoed back on the next call
       *  (OpenRouter `reasoning_details`). Only the adapter that produced
       *  it reads it. */
      providerState?: unknown;
    }
  | {
      role: 'tool';
      toolCallId: string;
      name: string;
      /** Already wrapped and truncated by the engine (data, not instructions). */
      content: string;
      isError?: boolean;
    };

/** Why the provider stopped, normalized across providers. */
export type FinishReason = 'stop' | 'tool_calls' | 'length' | 'other';

/**
 * Token counts for one provider call, normalized across OpenAI
 * (`prompt`/`completion`) and Anthropic (`input`/`output`). Null when
 * the provider didn't return usage. Logged to `ai_usage_log`.
 */
export interface AiUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** Call cost in USD when the provider reports it (OpenRouter
   *  `usage.cost`). Absent for OpenAI / Anthropic direct. */
  costUsd?: number;
}

/**
 * Raw text + usage a provider adapter returns before handoff parsing.
 * `text` may be empty only when `toolCalls` is not (a pure tool step);
 * a step with neither is an `empty_response` error in the adapter.
 */
export interface ProviderResult {
  text: string;
  usage: AiUsage | null;
  /** Tool calls the model asked for (empty/absent = a final answer). */
  toolCalls?: ToolCall[];
  finishReason?: FinishReason;
  /** See `AgentMessage` (assistant) `providerState`. */
  providerState?: unknown;
}

/** One tool call the engine handled, for the playground and the usage log. */
export interface ToolCallTrace {
  /** 1-based model call that asked for it. */
  step: number;
  name: string;
  /** Parsed arguments when they were valid JSON, else the raw text (cut). */
  arguments: unknown;
  status: 'ok' | 'error' | 'simulated';
  /** Stable code when `status` is `error`. */
  error?: string;
  durationMs: number;
  /**
   * Risk of the tool that was OFFERED under this name (built-in or the
   * account's HTTP tool). Absent for a name that was not offered.
   */
  risk?: 'read' | 'write';
  /**
   * The call failed AFTER it may have taken effect elsewhere (an HTTP
   * request that was sent and then failed, F6). Treated like a write that
   * landed by whoever has to decide whether a human must be told.
   */
  outcomeUnknown?: true;
}

/** Spend of a turn that ended in an error (see `AiError.partial`). */
export interface PartialTurn {
  usage: AiUsage | null;
  steps: number;
  toolCalls: ToolCallTrace[];
}

/**
 * What an agent turn had already spent when it threw, for ANY error (the
 * loop attaches it to whatever it rethrows, not only to `AiError`).
 */
export function partialOf(err: unknown): PartialTurn | undefined {
  if (err === null || typeof err !== 'object') return undefined;
  const p = (err as { partial?: unknown }).partial;
  return p && typeof p === 'object' ? (p as PartialTurn) : undefined;
}

/** Outcome of a generation call. */
export interface GenerateResult {
  /** The reply text, with any handoff sentinel stripped. */
  text: string;
  /** True when the model asked to hand off to a human (auto-reply mode). */
  handoff: boolean;
  /** Provider token usage, summed over every model call of the turn, or
   *  null when unavailable. */
  usage: AiUsage | null;
  /** Model calls made (1 without tools). */
  steps?: number;
  /** Tool calls handled in the turn (absent without tools). */
  toolCalls?: ToolCallTrace[];
  /** Knowledge excerpts surfaced by `search_knowledge` calls (D-14). */
  toolSources?: KnowledgeSource[];
  /** Set when the turn ran without tools because the model rejected them. */
  toolsDisabled?: 'unsupported';
  /** Why a tool turn stopped without an answer (`step_limit`: 4 steps used;
   *  `handoff`: the model called `handoff_to_human`). */
  stopReason?: 'answer' | 'step_limit' | 'handoff';
  /** Set with `stopReason: 'handoff'`: what the model wrote for the team. */
  handoffRequest?: { reason: string; summary: string };
}

/**
 * Typed error for every AI failure mode. `status` maps cleanly to an
 * HTTP response in the draft route; `code` lets the UI/tests branch
 * (invalid_key vs rate_limited vs timeout, etc.).
 */
export class AiError extends Error {
  readonly code: string;
  readonly status: number;
  /**
   * What an agent turn had already spent when it failed (SPEC 089 F5): the
   * tokens, steps and tool calls of the calls that DID happen, so the caller
   * can still record the usage and the quota stays honest.
   */
  partial?: PartialTurn;
  constructor(message: string, opts: { code?: string; status?: number } = {}) {
    super(message);
    this.name = 'AiError';
    this.code = opts.code ?? 'ai_error';
    this.status = opts.status ?? 502;
  }
}
