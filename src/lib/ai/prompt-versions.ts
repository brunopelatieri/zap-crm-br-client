import type { SupabaseClient } from '@supabase/supabase-js';

// ============================================================
// Prompt versions (SPEC 089 F1): every save that changes `system_prompt`
// appends a row to `ai_prompt_versions`. Restoring writes a NEW version
// (the history is append-only).
// ============================================================

export type PromptVersionSource = 'panel' | 'api';

export interface PromptVersion {
  id: string;
  system_prompt: string;
  note: string | null;
  source: PromptVersionSource;
  created_by: string | null;
  created_at: string;
}

/** How many versions the list returns. */
export const PROMPT_VERSIONS_LIMIT = 50;

/** Prompts compare after trimming; null and '' are the same (no prompt). */
export function normalizePrompt(p: string | null | undefined): string {
  return (p ?? '').trim();
}

/**
 * Should this save append a version? Only when the prompt text changed.
 * A first save with an empty prompt records nothing (nothing to version).
 */
export function promptChanged(
  previous: string | null | undefined,
  next: string | null | undefined
): boolean {
  return normalizePrompt(previous) !== normalizePrompt(next);
}

/**
 * Best-effort append. NEVER throws: a failed history write must not fail
 * a config save the admin just confirmed. Returns whether a row landed.
 */
export async function recordPromptVersion(
  db: SupabaseClient,
  args: {
    accountId: string;
    systemPrompt: string | null;
    note?: string | null;
    source?: PromptVersionSource;
    createdBy: string | null;
  }
): Promise<boolean> {
  try {
    const { error } = await db.from('ai_prompt_versions').insert({
      account_id: args.accountId,
      system_prompt: normalizePrompt(args.systemPrompt),
      note: args.note?.trim() ? args.note.trim().slice(0, 200) : null,
      source: args.source ?? 'panel',
      created_by: args.createdBy,
    });
    if (error) {
      console.error('[ai prompt-versions] insert failed:', error);
      return false;
    }
    return true;
  } catch (err) {
    console.error('[ai prompt-versions] insert threw:', err);
    return false;
  }
}

// ------------------------------------------------------------
// Line diff (for the compare view). Plain LCS over lines: prompts are a
// few hundred lines at most, so O(n*m) is fine.
// ------------------------------------------------------------

export interface DiffLine {
  type: 'same' | 'added' | 'removed';
  text: string;
}

/** Cap on lines per side, so a pathological prompt cannot blow the LCS table. */
const MAX_DIFF_LINES = 2000;

/**
 * Line diff from `from` to `to`: lines only in `from` are `removed`, only
 * in `to` are `added`. Order follows `to`, with removals just before the
 * line that replaced them.
 */
export function diffLines(from: string, to: string): DiffLine[] {
  const a = from === '' ? [] : from.split('\n').slice(0, MAX_DIFF_LINES);
  const b = to === '' ? [] : to.split('\n').slice(0, MAX_DIFF_LINES);
  const n = a.length;
  const m = b.length;

  // lcs[i][j] = LCS length of a[i..] and b[j..]
  const lcs: Uint32Array[] = Array.from(
    { length: n + 1 },
    () => new Uint32Array(m + 1)
  );
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] =
        a[i] === b[j]
          ? lcs[i + 1][j + 1] + 1
          : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }

  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ type: 'same', text: a[i] });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      out.push({ type: 'removed', text: a[i] });
      i++;
    } else {
      out.push({ type: 'added', text: b[j] });
      j++;
    }
  }
  while (i < n) out.push({ type: 'removed', text: a[i++] });
  while (j < m) out.push({ type: 'added', text: b[j++] });
  return out;
}
