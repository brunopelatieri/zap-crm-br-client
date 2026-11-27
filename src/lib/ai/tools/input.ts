import type { ParseResult } from './types';

// ============================================================
// Tiny validators for tool arguments (no schema library in the project).
// Each tool's `parse` reads ONLY the keys it declares, so anything else
// the model sends (an `account_id`, a `contact_id`…) is dropped.
// ============================================================

export type Obj = Record<string, unknown>;

/** The arguments must be a JSON object; null/absent counts as `{}`. */
export function asObject(input: unknown): ParseResult<Obj> {
  if (input === null || input === undefined) return { ok: true, value: {} };
  if (typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, error: 'invalid_arguments' };
  }
  return { ok: true, value: input as Obj };
}

/**
 * Strips control characters (NUL included: Postgres `text` rejects it, and a
 * value that passes the audit but fails the write would leave a half-done
 * call). Tabs and newlines stay.
 */
const CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
export function stripControl(s: string): string {
  return s.replace(CONTROL_RE, '');
}

export function readString(
  obj: Obj,
  key: string,
  opts: { required?: boolean; min?: number; max: number }
): ParseResult<string | undefined> {
  const raw = obj[key];
  if (raw === undefined || raw === null) {
    return opts.required
      ? { ok: false, error: `missing_${key}` }
      : { ok: true, value: undefined };
  }
  if (typeof raw !== 'string') return { ok: false, error: `invalid_${key}` };
  const v = stripControl(raw).trim();
  if (v.length < (opts.min ?? (opts.required ? 1 : 0))) {
    return { ok: false, error: `invalid_${key}` };
  }
  if (v.length > opts.max) return { ok: false, error: `${key}_too_long` };
  return { ok: true, value: v };
}

export function readStringArray(
  obj: Obj,
  key: string,
  opts: { required?: boolean; maxItems: number; maxLength: number }
): ParseResult<string[] | undefined> {
  const raw = obj[key];
  if (raw === undefined || raw === null) {
    return opts.required
      ? { ok: false, error: `missing_${key}` }
      : { ok: true, value: undefined };
  }
  if (!Array.isArray(raw)) return { ok: false, error: `invalid_${key}` };
  if (raw.length > opts.maxItems)
    return { ok: false, error: `too_many_${key}` };
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') return { ok: false, error: `invalid_${key}` };
    const v = stripControl(item).trim();
    if (!v || v.length > opts.maxLength)
      return { ok: false, error: `invalid_${key}` };
    out.push(v);
  }
  if (opts.required && out.length === 0)
    return { ok: false, error: `missing_${key}` };
  return { ok: true, value: out };
}
