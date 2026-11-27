// ============================================================
// Shared types for the AI reply assistant (bring-your-own-key).
//
// One small provider-agnostic surface so the inbox draft route and the
// inbound auto-reply bot both talk to `generateReply` without caring
// whether the account is on OpenAI or Anthropic.
// ============================================================

export type AiProvider = 'openai' | 'anthropic' | 'openrouter';

/** All providers, in the order the settings screen lists them. */
export const AI_PROVIDERS: readonly AiProvider[] = [
  'openai',
  'anthropic',
  'openrouter',
];

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
}

/** A single conversation turn in the shape both providers accept. */
export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

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

/** Raw text + usage a provider adapter returns before handoff parsing. */
export interface ProviderResult {
  text: string;
  usage: AiUsage | null;
}

/** Outcome of a generation call. */
export interface GenerateResult {
  /** The reply text, with any handoff sentinel stripped. */
  text: string;
  /** True when the model asked to hand off to a human (auto-reply mode). */
  handoff: boolean;
  /** Provider token usage for this call, or null when unavailable. */
  usage: AiUsage | null;
}

/**
 * Typed error for every AI failure mode. `status` maps cleanly to an
 * HTTP response in the draft route; `code` lets the UI/tests branch
 * (invalid_key vs rate_limited vs timeout, etc.).
 */
export class AiError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(message: string, opts: { code?: string; status?: number } = {}) {
    super(message);
    this.name = 'AiError';
    this.code = opts.code ?? 'ai_error';
    this.status = opts.status ?? 502;
  }
}
