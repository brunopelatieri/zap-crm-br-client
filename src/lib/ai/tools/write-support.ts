import type { ToolContext, ToolKey, ToolResult } from './types';

// ============================================================
// Shared by the write tools (SPEC 089 F5): the mode/context guard, the
// simulation result, the name → id resolvers that stay inside the account
// AND the admin's allow-list, and typed errors.
//
// A name is only ever resolved among rows (a) of THIS account and (b) in
// the allow-list the admin set. A name that exists but is not allowed gets
// the same answer as a name that does not exist, so the model cannot probe
// the account's catalog through the refusals.
// ============================================================

/** Case- and accent-insensitive comparison key for names. */
export function normName(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/\p{Diacritic}/gu, '')
    .trim()
    .toLowerCase();
}

/**
 * The second line of defense of a write handler (`toolsForTurn` is the
 * first): the mode and the context are re-checked here, so a handler never
 * depends on the caller having filtered the catalog.
 *   - `draft` never writes (D-18);
 *   - a REAL write (`dryRun = false`) only runs in the live auto-reply,
 *     bound to a conversation and a contact, with the audit attached.
 * Returns the refusal, or null when the handler may go on.
 */
export function guardWrite(ctx: ToolContext): ToolResult | null {
  if (ctx.mode === 'draft') return { ok: false, error: 'not_available' };
  if (ctx.dryRun) return null;
  if (
    ctx.mode !== 'auto_reply' ||
    !ctx.conversationId ||
    !ctx.contactId ||
    !ctx.audit
  ) {
    return { ok: false, error: 'not_available' };
  }
  return null;
}

const SIMULATED_NOTE = 'Test mode: nothing was changed in the CRM.';

/** D-18: what a write tool would have done, without doing it. */
export function simulated(
  key: ToolKey,
  args: unknown,
  extra: Record<string, unknown> = {}
): ToolResult {
  return {
    ok: true,
    simulated: true,
    data: {
      status: 'simulated',
      tool: key,
      arguments: args,
      ...extra,
      note: SIMULATED_NOTE,
    },
  };
}

/** True when a PostgREST write returned exactly the one row we targeted. */
export function oneRow(data: unknown): boolean {
  return Array.isArray(data) && data.length === 1;
}

export interface Named {
  id: string;
  name: string;
}

/** Match a requested name against candidates; `ambiguous` if several fit. */
export function findByName<T extends Named>(
  candidates: readonly T[],
  wanted: string
): { found: T } | { found: null; ambiguous: boolean } {
  const key = normName(wanted);
  const hits = candidates.filter((c) => normName(c.name) === key);
  if (hits.length === 1) return { found: hits[0] };
  return { found: null, ambiguous: hits.length > 1 };
}
