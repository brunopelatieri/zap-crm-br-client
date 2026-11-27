import type { SupabaseClient } from '@supabase/supabase-js';
import type { ActivityAction } from '@/lib/activity/types';
import type { AiConfig, JsonSchemaObject, KnowledgeSource } from '../types';

// ============================================================
// Tool catalog contract (SPEC 089 §5.3, D-15/D-16/D-18).
//
// A tool is bound to the conversation it runs in: the account, the
// conversation and the contact come from `ToolContext`, built by the
// engine from server-side state (`buildToolContext`). The model never
// supplies an account, contact or conversation id — no input schema has
// such a field, and the parsers drop unknown keys.
// ============================================================

/** Where a turn runs. `eval` is reserved for SPEC 089 F7. */
export type ToolMode = 'auto_reply' | 'draft' | 'playground' | 'eval';

export type ToolRisk = 'read' | 'write';

/** What a handoff request carries (`handoff_to_human`, F5). */
export interface HandoffRequest {
  reason: string;
  summary: string;
}

/** Mutable per-turn state the tools write to (the engine reads it back). */
export interface TurnState {
  /** Set by `handoff_to_human`: the turn ends and the auto-reply hands off. */
  handoff?: HandoffRequest;
}

/** The audit row of one call, claimed before the tool runs (F5). */
export type AuditClaim =
  { ok: true; id: string | null } | { ok: false; error: string };

/** An activity-log line a successful write asks for (`ai.tool_*`). */
export interface ToolActivity {
  action: ActivityAction;
  /** Short, already masked; never a phone number. */
  label?: string;
  metadata?: Record<string, unknown>;
}

export interface AuditFinish {
  status: 'ok' | 'error' | 'timeout';
  errorCode?: string;
  /** Masked, short text (`summarizeForAudit`). */
  outputSummary: string;
  durationMs: number;
  /** An activity-log line for a real write (SPEC 075, actor `system`). */
  activity?: ToolActivity;
}

/**
 * Audit of the REAL tool calls of a turn (auto-reply only). `begin` writes
 * the row BEFORE the tool runs and decides the DB-side limits (write cap per
 * conversation, plan quota, idempotency); `finish` closes it.
 */
export interface ToolAudit {
  begin(args: {
    tool: string;
    risk: ToolRisk;
    callId: string;
    /** Parsed arguments (masked by the implementation before storing). */
    input: unknown;
    /**
     * An account-defined HTTP tool (F6): the call leaves the app, so the
     * audit stores only the SHAPE of the input (field names and lengths) and
     * the call is refused when the audit is unavailable, reads included.
     */
    external?: boolean;
  }): Promise<AuditClaim>;
  finish(id: string | null, outcome: AuditFinish): Promise<void>;
}

export interface ToolContext {
  /**
   * The caller's client: the RLS-scoped client in the dashboard routes,
   * the service role in the webhook. Every handler filters by
   * `accountId` anyway (defense in depth, rule 10 of ia-agentes.md).
   */
  db: SupabaseClient;
  accountId: string;
  /** Null in the playground (no conversation). */
  conversationId: string | null;
  /** Taken from the conversation row, never from the request. Null in the playground. */
  contactId: string | null;
  mode: ToolMode;
  /** D-18: write tools only describe what they would do. */
  dryRun: boolean;
  /** The account's per-tool settings (on/off and allow-lists). */
  toolsConfig: ToolsConfig;
  /** Retrieval needs the embeddings target (search_knowledge). */
  aiConfig: Pick<AiConfig, 'embeddingsTarget'>;
  /** Unique per turn: with the call id it makes a write idempotent (F5). */
  turnId: string;
  /**
   * Present when calls can be REAL: the auto-reply (`dryRun = false`) and the
   * draft, where only `external` tools (F6) use it; built-in tools in a draft
   * stay unaudited, as in F5.
   */
  audit?: ToolAudit;
  /** Written by tools, read by the engine and the caller. */
  turnState: TurnState;
}

/** What a handler returns. `data` is serialized for the model. */
export type ToolResult =
  | {
      ok: true;
      data: unknown;
      /** True when a write tool only described the call (D-18). */
      simulated?: boolean;
      /** Knowledge excerpts this call surfaced (D-14); never sent to the model. */
      sources?: KnowledgeSource[];
      /** `handoff`: the engine stops the turn after this step (F5). */
      endTurn?: 'handoff';
      /** A REAL write asks for an activity-log line (F5). */
      activity?: ToolActivity;
      /**
       * Short, already masked text for `ai_tool_calls.output_summary`. An
       * HTTP tool (F6) sets it so the endpoint's answer never reaches the
       * audit, not even masked.
       */
      auditSummary?: string;
    }
  | {
      ok: false;
      /** Stable snake_case code, shown to the model and the playground. */
      error: string;
      /** Data the model needs to recover (e.g. the allowed names). */
      detail?: Record<string, unknown>;
      /** See the `ok` variant. */
      auditSummary?: string;
      /**
       * True when the call may have taken effect on the other side (an HTTP
       * request that was sent and then failed or timed out): the engine does
       * NOT let the model repeat that write in the same turn.
       */
      outcomeUnknown?: boolean;
    };

/** Result of parsing the model's arguments. */
export type ParseResult<I> =
  { ok: true; value: I } | { ok: false; error: string };

/** What the engine tells a handler about THIS call. */
export interface ToolRun {
  /** Milliseconds left for the call (the engine times it out at this). */
  budgetMs: number;
}

export interface AgentTool<I = unknown> {
  /**
   * Stable, snake_case, English. A catalog key (`ToolKey`) or, for an
   * account-defined HTTP tool (F6), the admin's name (never a catalog key).
   */
  key: string;
  /** The call leaves the app (F6 HTTP tool): audited in a draft too. */
  external?: boolean;
  /** English, read by the model. */
  description: string;
  /** Never has an account, contact or conversation id. */
  inputSchema: JsonSchemaObject;
  risk: ToolRisk;
  /** Validates and normalizes the raw (already JSON-parsed) arguments. */
  parse(input: unknown): ParseResult<I>;
  handler(ctx: ToolContext, input: I, run?: ToolRun): Promise<ToolResult>;
}

/** Every tool the catalog knows (F4: reads + write contracts). */
export const TOOL_KEYS = [
  'search_knowledge',
  'get_contact_profile',
  'list_contact_deals',
  'update_contact_fields',
  'add_contact_tags',
  'remove_contact_tags',
  'create_deal',
  'move_deal_stage',
  'add_internal_note',
  'handoff_to_human',
] as const;

export type ToolKey = (typeof TOOL_KEYS)[number];

/**
 * Per-tool account settings (`ai_configs.tools_config`, migration 105).
 * Every tool is born OFF (D-16). Allow-lists are fail-closed: an empty list
 * means nothing is visible / allowed.
 */
export interface ToolSetting {
  enabled: boolean;
  /** get_contact_profile: `email`, `company`, `phone`, `tags`, `custom:<uuid>`. */
  visibleFields?: string[];
  /** list_contact_deals / create_deal / move_deal_stage. */
  pipelineIds?: string[];
  /** move_deal_stage / create_deal. */
  stageIds?: string[];
  /** add_contact_tags / remove_contact_tags. */
  tagIds?: string[];
  /** update_contact_fields: `name`, `email`, `company`, `custom:<uuid>`. */
  writableFields?: string[];
}

export type ToolsConfig = Partial<Record<ToolKey, ToolSetting>>;
