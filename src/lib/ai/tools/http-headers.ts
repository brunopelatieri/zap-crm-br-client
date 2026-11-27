// ============================================================
// Headers of an account-defined HTTP tool (SPEC 089 F6).
//
// They carry the secret (Authorization, X-Api-Key…): stored ENCRYPTED, shown
// to nobody (the screen only lists the NAMES), decrypted at the moment of the
// call and never written to a log, to `ai_tool_calls`, to a tool result or to
// a route response. The checks here keep a header from rewriting the request
// the code builds (host, length, framing) and from smuggling a second header.
// ============================================================

export const MAX_HEADERS = 10;
export const MAX_HEADER_VALUE = 2000;
/** Serialized size of the whole set (the DB CHECK on the cipher is 20000). */
export const MAX_HEADERS_BYTES = 8000;

const NAME_RE = /^[A-Za-z0-9-]{1,64}$/;
// Visible ASCII and space only: no CR, LF, NUL or any control character.
const VALUE_RE = /^[\x20-\x7E]+$/;

/**
 * Headers the code owns: letting the admin set them would change where the
 * request goes or how it is framed.
 */
export const FORBIDDEN_HEADER_NAMES: ReadonlySet<string> = new Set([
  'host',
  'content-length',
  'content-type',
  'transfer-encoding',
  'connection',
  'keep-alive',
  'upgrade',
  'te',
  'trailer',
  'expect',
  'accept',
  'accept-encoding',
  'user-agent',
  'proxy-authorization',
  'proxy-connection',
  'forwarded',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-real-ip',
]);

export type HeadersResult =
  { ok: true; headers: Record<string, string> } | { ok: false; error: string };

/** Validate a name → value map. Names are unique ignoring case. */
export function validateHeaders(raw: unknown): HeadersResult {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'invalid_headers' };
  }
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length > MAX_HEADERS)
    return { ok: false, error: 'too_many_headers' };

  const out: Record<string, string> = {};
  const seen = new Set<string>();
  for (const [name, value] of entries) {
    if (!NAME_RE.test(name)) return { ok: false, error: 'invalid_header_name' };
    const lower = name.toLowerCase();
    if (FORBIDDEN_HEADER_NAMES.has(lower) || lower.startsWith('sec-')) {
      return { ok: false, error: 'forbidden_header' };
    }
    if (seen.has(lower)) return { ok: false, error: 'duplicate_header' };
    seen.add(lower);
    if (
      typeof value !== 'string' ||
      value.length === 0 ||
      value.length > MAX_HEADER_VALUE ||
      !VALUE_RE.test(value)
    ) {
      return { ok: false, error: 'invalid_header_value' };
    }
    out[name] = value;
  }
  if (
    new TextEncoder().encode(JSON.stringify(out)).length > MAX_HEADERS_BYTES
  ) {
    return { ok: false, error: 'headers_too_large' };
  }
  return { ok: true, headers: out };
}

/**
 * What a client sends to change headers: the WHOLE new set by name. A value
 * left out keeps the stored value of that name (the screen never has it), a
 * name left out is removed.
 */
export interface HeaderInput {
  name: string;
  value?: string;
}

export function parseHeaderInputs(
  raw: unknown
): { ok: true; items: HeaderInput[] } | { ok: false; error: string } {
  if (!Array.isArray(raw)) return { ok: false, error: 'invalid_headers' };
  if (raw.length > MAX_HEADERS) return { ok: false, error: 'too_many_headers' };
  const items: HeaderInput[] = [];
  for (const it of raw) {
    if (!it || typeof it !== 'object' || Array.isArray(it)) {
      return { ok: false, error: 'invalid_headers' };
    }
    const { name, value } = it as { name?: unknown; value?: unknown };
    if (typeof name !== 'string')
      return { ok: false, error: 'invalid_header_name' };
    if (value !== undefined && value !== null && typeof value !== 'string') {
      return { ok: false, error: 'invalid_header_value' };
    }
    // An empty string from a blank field means "keep".
    items.push({
      name,
      ...(typeof value === 'string' && value !== '' ? { value } : {}),
    });
  }
  return { ok: true, items };
}

/** Apply `HeaderInput[]` over the current stored set. */
export function mergeHeaders(
  current: Record<string, string>,
  items: readonly HeaderInput[]
): HeadersResult {
  const byLower = new Map(
    Object.entries(current).map(([n, v]) => [n.toLowerCase(), v])
  );
  const next: Record<string, string> = {};
  for (const it of items) {
    const value = it.value ?? byLower.get(it.name.toLowerCase());
    if (value === undefined)
      return { ok: false, error: 'header_value_required' };
    next[it.name] = value;
  }
  return validateHeaders(next);
}
