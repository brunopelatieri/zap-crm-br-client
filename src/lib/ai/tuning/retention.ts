import type { SupabaseClient } from '@supabase/supabase-js';

// ============================================================
// Retention of the tuning data (SPEC 089 P-5, F7). PROPOSAL, implemented in
// its most conservative form; the maintainer has the last word (see the
// SPEC §5.5 and §12).
//
// What is kept, and for how long (by age, from the row's own date):
//
//   ai_drafts          2 days    the link draft → send; useless afterwards.
//   candidates         60 days   an unreviewed candidate is a pending
//                                decision, not an archive: if nobody judged
//                                it in two months it is not going to be.
//   rejected examples  30 days   kept just long enough to undo a click.
//   evaluation runs    180 days  the history to compare against; their
//                                results go with them (ON DELETE CASCADE).
//
// NEVER deleted by age: approved examples and evaluation cases (curated by
// an admin on purpose; they are also masked, and deleting the account
// deletes them in cascade).
//
// Alignment with `atividade-painel-retencao.md`: that domain's rule is that
// deleting is the only operation with no undo, so retention there is off
// until configured. These tables are different in kind (a review queue and a
// transient link, masked at capture, never customer-facing history), so the
// sweep is on, with fixed short ages. Setting `AI_TUNING_RETENTION=off` in
// the server environment turns it off.
//
// The sweep runs inside `/api/automations/cron` (phase 9). Never throws.
// ============================================================

const DAY_MS = 24 * 60 * 60 * 1000;

export const TUNING_RETENTION = {
  draftDays: 2,
  candidateDays: 60,
  rejectedDays: 30,
  evalRunDays: 180,
} as const;

/** The sweep runs at most this often per process (the cron fires every 5 min). */
const MIN_INTERVAL_MS = 60 * 60 * 1000;

let lastRunAt = 0;

export interface TuningSweepResult {
  ran: boolean;
  drafts: number;
  candidates: number;
  rejected: number;
  evalRuns: number;
  /** Rows of `ai_tool_calls` purged (90 days, see `purgeToolCalls`). */
  toolCalls: number;
}

export function tuningRetentionEnabled(
  env: Record<string, string | undefined> = process.env
): boolean {
  return (env.AI_TUNING_RETENTION ?? '').trim().toLowerCase() !== 'off';
}

async function deleteOlder(
  db: SupabaseClient,
  table: string,
  column: string,
  cutoff: string,
  extra?: { column: string; value: string }
): Promise<number> {
  let query = db.from(table).delete();
  if (extra) query = query.eq(extra.column, extra.value);
  const { data, error } = await query.lt(column, cutoff).select('id');
  if (error) {
    console.error(
      `[ai tuning] retention on ${table} failed:`,
      error.code,
      error.message
    );
    return 0;
  }
  return data?.length ?? 0;
}

/**
 * Audit of the agent's tool calls (`ai_tool_calls`, F5): kept for
 * `TOOL_CALLS_RETENTION_DAYS` (decided by the maintainer in the F8: 90 days),
 * at most `TOOL_CALLS_PURGE_LIMIT` rows per sweep. The table grants DELETE to
 * nobody; `purge_ai_tool_calls` (migration 110, service role only) is the one
 * way. Not tied to `AI_TUNING_RETENTION`: it is the audit, not tuning data.
 */
export const TOOL_CALLS_RETENTION_DAYS = 90;
export const TOOL_CALLS_PURGE_LIMIT = 1000;

async function purgeToolCalls(db: SupabaseClient): Promise<number> {
  const { data, error } = await db.rpc('purge_ai_tool_calls', {
    p_older_than_days: TOOL_CALLS_RETENTION_DAYS,
    p_limit: TOOL_CALLS_PURGE_LIMIT,
  });
  if (error) {
    // 42883 / PGRST202: migration 110 not applied yet — nothing to purge with.
    if (error.code !== '42883' && error.code !== 'PGRST202') {
      console.error(
        '[ai tuning] ai_tool_calls retention failed:',
        error.code,
        error.message
      );
    }
    return 0;
  }
  return typeof data === 'number' ? data : 0;
}

/**
 * Delete what passed its age (see the header). `db` is the service-role
 * client. Throttled to once an hour per process unless `force`.
 */
export async function sweepAiTuningRetention(
  db: SupabaseClient,
  now: Date,
  opts: { force?: boolean } = {}
): Promise<TuningSweepResult> {
  const none: TuningSweepResult = {
    ran: false,
    drafts: 0,
    candidates: 0,
    rejected: 0,
    evalRuns: 0,
    toolCalls: 0,
  };
  if (!opts.force && now.getTime() - lastRunAt < MIN_INTERVAL_MS) return none;
  lastRunAt = now.getTime();

  let toolCalls = 0;
  try {
    toolCalls = await purgeToolCalls(db);
  } catch (err) {
    console.error('[ai tuning] ai_tool_calls retention threw:', err);
  }
  if (!tuningRetentionEnabled()) return { ...none, ran: true, toolCalls };

  const before = (days: number) =>
    new Date(now.getTime() - days * DAY_MS).toISOString();
  try {
    const [drafts, candidates, rejected, evalRuns] = await Promise.all([
      deleteOlder(
        db,
        'ai_drafts',
        'created_at',
        before(TUNING_RETENTION.draftDays)
      ),
      // By the last touch, not the creation: an old example that an admin
      // just reopened or edited is a decision in progress, not a stale one.
      deleteOlder(
        db,
        'ai_examples',
        'updated_at',
        before(TUNING_RETENTION.candidateDays),
        { column: 'status', value: 'candidate' }
      ),
      deleteOlder(
        db,
        'ai_examples',
        'updated_at',
        before(TUNING_RETENTION.rejectedDays),
        { column: 'status', value: 'rejected' }
      ),
      deleteOlder(
        db,
        'ai_eval_runs',
        'created_at',
        before(TUNING_RETENTION.evalRunDays)
      ),
    ]);
    return { ran: true, drafts, candidates, rejected, evalRuns, toolCalls };
  } catch (err) {
    console.error('[ai tuning] retention sweep failed:', err);
    return { ...none, ran: true, toolCalls };
  }
}

/** Test hook: forget the throttle. */
export function resetTuningRetentionThrottle(): void {
  lastRunAt = 0;
}
