import type { SupabaseClient } from '@supabase/supabase-js';
import type { AiConfig } from '../types';
import { supabaseAdmin } from '../admin-client';
import { createToolAudit } from './audit';
import { isDryRunMode } from './registry';
import type { ToolContext, ToolMode, ToolsConfig } from './types';

// ============================================================
// The ONE place a ToolContext is built (SPEC 089 D-16).
//
// The contact is read from the conversation row, filtered by the account;
// a contact id coming from anywhere else (webhook payload, request body,
// the model) is never used. A conversation that does not belong to the
// account resolves to `null` and the turn runs without tools.
// ============================================================

export interface BuildToolContextArgs {
  db: SupabaseClient;
  accountId: string;
  /** Null in the playground: no conversation, no contact. */
  conversationId: string | null;
  mode: ToolMode;
  toolsConfig: ToolsConfig;
  aiConfig: Pick<AiConfig, 'embeddingsTarget'>;
}

export async function buildToolContext(
  args: BuildToolContextArgs
): Promise<ToolContext | null> {
  const { db, accountId, conversationId, mode, toolsConfig, aiConfig } = args;
  const base = {
    db,
    accountId,
    mode,
    dryRun: isDryRunMode(mode),
    toolsConfig,
    aiConfig,
    turnId: crypto.randomUUID(),
    turnState: {},
  };

  if (!conversationId) {
    return { ...base, conversationId: null, contactId: null };
  }

  const { data, error } = await db
    .from('conversations')
    .select('id, contact_id, account_id')
    .eq('id', conversationId)
    .eq('account_id', accountId)
    .maybeSingle();
  if (error || !data) return null;
  const row = data as {
    id: string;
    contact_id: string | null;
    account_id: string;
  };
  // Re-check what the filter promised (a mocked or misbehaving client must
  // not widen the scope).
  if (row.id !== conversationId || row.account_id !== accountId) return null;

  const contactId = row.contact_id ?? null;
  // Real calls (auto-reply) are audited and bounded by the database; a dry
  // run never calls anything. A draft never writes, but a read-only HTTP
  // tool (F6) does call out, so the draft gets the audit too (the engine
  // only uses it for those `external` tools).
  const audit =
    base.dryRun && mode !== 'draft'
      ? undefined
      : createToolAudit({
          // The audit RPCs are service-role only; the draft route's client is
          // the member's, so the draft audits through the service role.
          db: mode === 'draft' ? supabaseAdmin() : db,
          accountId,
          conversationId,
          mode,
          turnId: base.turnId,
          contactId,
        });
  return { ...base, conversationId, contactId, ...(audit ? { audit } : {}) };
}
