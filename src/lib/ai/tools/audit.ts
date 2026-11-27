import type { SupabaseClient } from '@supabase/supabase-js';
import { recordActivity } from '@/lib/activity/record';
import { WRITE_CALLS_PER_CONVERSATION } from '../defaults';
import { auditInputFor, auditShapeOnly, maskForAudit } from './mask';
import type { AuditClaim, ToolAudit, ToolMode } from './types';

// ============================================================
// Audit of the real tool calls of a turn (SPEC 089 F5, §5.3 rule 6).
//
//   begin()  → RPC claim_ai_tool_call (migration 106): ONE transaction
//              checks the conversation belongs to the account, the call
//              was not already claimed (idempotency), the per-conversation
//              write cap (P-6: 10) and the plan quota ai_tool_calls_month
//              (D-20, the database decides), and inserts the 'started' row.
//   finish() → RPC finish_ai_tool_call closes the row; a real write also
//              becomes an activity-log line (SPEC 075), actor `system`.
//
// Only the service role can run both RPCs, so this is attached to the
// context only when calls are real (auto-reply, `dryRun = false`).
//
// Failure policy: a WRITE never runs without its audit row (fail closed:
// `audit_unavailable`); a READ runs unaudited rather than break the answer
// when the audit RPC is unavailable (e.g. migration 106 not applied yet).
// ============================================================

/** Name the activity log shows for the AI agent (see `actorLabel`). */
export const AI_ACTOR_NAME = 'ai-agent';

/** Outcomes of `claim_ai_tool_call` that refuse the call, as tool errors. */
const REFUSALS: Record<string, string> = {
  write_cap_reached: 'write_limit_reached',
  quota_exceeded: 'quota_exceeded',
  conversation_not_found: 'conversation_not_found',
  duplicate: 'duplicate_call',
  // Migration 110: a human took the conversation (or the AI already handed
  // it off) while this turn was running.
  conversation_paused: 'conversation_paused',
};

interface ClaimRow {
  outcome: string;
  call_id: string | null;
  used: number | null;
  limit: number | null;
}

export interface CreateAuditArgs {
  db: SupabaseClient;
  accountId: string;
  conversationId: string;
  mode: ToolMode;
  turnId: string;
  contactId: string | null;
  /** Writes per conversation (default `WRITE_CALLS_PER_CONVERSATION`). */
  maxWrites?: number;
}

export function createToolAudit(args: CreateAuditArgs): ToolAudit {
  const { db, accountId, conversationId, mode, turnId, contactId } = args;
  const maxWrites = args.maxWrites ?? WRITE_CALLS_PER_CONVERSATION;

  return {
    async begin({ tool, risk, callId, input, external }): Promise<AuditClaim> {
      // A write, and any call that leaves the app, never runs unaudited.
      const unavailable = (): AuditClaim =>
        risk === 'write' || external
          ? { ok: false, error: 'audit_unavailable' }
          : { ok: true, id: null };
      try {
        const { data, error } = await db.rpc('claim_ai_tool_call', {
          p_account_id: accountId,
          p_conversation_id: conversationId,
          p_mode: mode,
          p_tool: tool,
          p_risk: risk,
          p_call_key: `${turnId}:${callId}`.slice(0, 200),
          p_input:
            maskForAudit(
              external ? auditShapeOnly(input) : auditInputFor(tool, input)
            ) ?? {},
          p_max_writes: maxWrites,
        });
        if (error) {
          console.error('[ai tools] claim_ai_tool_call failed:', error.message);
          return unavailable();
        }
        const row = (Array.isArray(data) ? data[0] : data) as
          ClaimRow | undefined;
        if (!row || typeof row.outcome !== 'string') return unavailable();
        if (row.outcome === 'claimed') return { ok: true, id: row.call_id };
        const refusal = REFUSALS[row.outcome];
        // An outcome this code does not know is a refusal, not a pass.
        return { ok: false, error: refusal ?? 'audit_unavailable' };
      } catch (err) {
        console.error('[ai tools] claim_ai_tool_call threw:', err);
        return unavailable();
      }
    },

    async finish(id, outcome): Promise<void> {
      try {
        if (id) {
          const { error } = await db.rpc('finish_ai_tool_call', {
            p_call_id: id,
            p_status: outcome.status,
            p_error_code: outcome.errorCode ?? null,
            p_output_summary: outcome.outputSummary,
            p_duration_ms: Math.round(outcome.durationMs),
          });
          if (error) {
            console.error(
              '[ai tools] finish_ai_tool_call failed:',
              error.message
            );
          }
        }
        if (outcome.activity && outcome.status === 'ok') {
          await recordActivity(db, {
            accountId,
            action: outcome.activity.action,
            resourceType: 'ai',
            resourceId: id,
            resourceLabel: outcome.activity.label ?? null,
            actor: { kind: 'system', name: AI_ACTOR_NAME },
            conversationId,
            contactId,
            source: id ? { table: 'ai_tool_calls', id } : null,
            metadata: outcome.activity.metadata,
          });
        }
      } catch (err) {
        // Auditing must never break the turn the customer is waiting on.
        console.error('[ai tools] audit finish threw:', err);
      }
    },
  };
}
