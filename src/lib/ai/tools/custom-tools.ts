import type { SupabaseClient } from '@supabase/supabase-js';
import { parseToolUrl } from '@/lib/http/safe-request';
import { isDeliverableUrl } from '@/lib/webhooks/ssrf';
import { supabaseAdmin } from '../admin-client';
import { buildHttpTool, describeCall, displayUrl } from './http';
import type { HttpToolDeps, HttpToolSpec } from './http';
import {
  mergeHeaders,
  parseHeaderInputs,
  validateHeaders,
} from './http-headers';
import {
  parseHttpArgs,
  readStoredSchema,
  validateInputSchema,
  type HttpArgs,
  type HttpInputSchema,
} from './http-schema';
import { isWriteSwitchedOff } from './kill-switch';
import { TOOL_KEYS, type AgentTool, type ToolMode } from './types';

// ============================================================
// Service layer of the account-defined HTTP tools (SPEC 089 F6).
//
// The routes (`/api/ai/custom-tools`), the playground and, later, the public
// API and the MCP (SPEC 090) all go through here, so the rules live ONCE:
// validation, the encrypted headers, the isolation by account and the list
// of tools a turn is offered. Every query filters by `account_id`. The
// caller has already checked the role (`admin`).
//
// The headers are write-only: this layer encrypts them on the way in and the
// ONLY place that decrypts them is the call itself (`http.ts`). No function
// here returns them; a view carries the NAMES and a flag.
// ============================================================

/** Columns safe to read: everything but the encrypted headers. */
export const PUBLIC_COLUMNS =
  'id, account_id, name, description, input_schema, url, method, risk, header_names, timeout_ms, is_active, created_by, created_at, updated_at';

/** Per-account cap, enforced by the database trigger (migration 107). */
export const MAX_CUSTOM_TOOLS = 20;

export const NAME_RE = /^[a-z][a-z0-9_]{2,47}$/;
export const MIN_DESCRIPTION = 10;
export const MAX_DESCRIPTION = 500;
export const DEFAULT_TIMEOUT_MS = 8000;
export const MIN_TIMEOUT_MS = 1000;
export const MAX_TIMEOUT_MS = 10_000;

/** What a route or the UI gets back of a tool. No secret in it. */
export interface CustomToolView {
  id: string;
  name: string;
  description: string;
  input_schema: unknown;
  url: string;
  method: 'GET' | 'POST';
  risk: 'read' | 'write';
  /** Names only; the values are never returned. */
  header_names: string[];
  has_headers: boolean;
  timeout_ms: number;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export type ServiceResult<T> =
  | { ok: true; value: T }
  | { ok: false; status: number; code: string; error: string };

const fail = (
  status: number,
  code: string,
  error: string
): { ok: false; status: number; code: string; error: string } => ({
  ok: false,
  status,
  code,
  error,
});

export interface CustomToolsDeps {
  /** Service-role client (the secret column is not readable otherwise). */
  db: SupabaseClient;
  encrypt: (text: string) => string;
  decrypt: (cipher: string) => string;
  /** DNS-resolving guard (default `isDeliverableUrl`). */
  isDeliverable: (url: string) => Promise<boolean>;
}

export async function defaultCustomToolsDeps(): Promise<CustomToolsDeps> {
  const { encrypt, decrypt } = await import('@/lib/whatsapp/encryption');
  return {
    db: supabaseAdmin(),
    encrypt,
    decrypt,
    isDeliverable: isDeliverableUrl,
  };
}

/** `42P01` (Postgres) / `PGRST205` (PostgREST): migration 107 not applied. */
function isMissingTable(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  return code === '42P01' || code === 'PGRST205';
}

function mapDbError(error: unknown): {
  status: number;
  code: string;
  error: string;
} {
  const e = error as { code?: string; message?: string } | null;
  if (isMissingTable(error)) {
    return {
      status: 409,
      code: 'migration_pending',
      error: 'The database is missing migration 107.',
    };
  }
  if (e?.code === '23505') {
    return {
      status: 409,
      code: 'name_taken',
      error: 'That name is already used.',
    };
  }
  if (e?.message?.includes('AI_CUSTOM_TOOL_LIMIT')) {
    return {
      status: 409,
      code: 'limit_reached',
      error: `At most ${MAX_CUSTOM_TOOLS} HTTP tools per account.`,
    };
  }
  // The raw message can name a column or a constraint: log it, do not return it.
  console.error('[ai custom tools] database error:', e?.code);
  return { status: 500, code: 'database_error', error: 'Database error.' };
}

// ------------------------------------------------------------
// Validation
// ------------------------------------------------------------

/** Query-string parameter names that look like a credential. */
const SECRET_PARAM_RE =
  /(^|[_-])(api[_-]?key|apikey|key|token|secret|password|passwd|pwd|auth|authorization|signature|sig|credential|credentials)$/i;

export type NameResult =
  { ok: true; name: string } | { ok: false; code: string; error: string };

export function validateName(raw: unknown): NameResult {
  if (typeof raw !== 'string') {
    return { ok: false, code: 'invalid_name', error: 'name is required' };
  }
  const name = raw.trim();
  if (!NAME_RE.test(name)) {
    return {
      ok: false,
      code: 'invalid_name',
      error:
        'name must be snake_case: 3 to 48 characters, a-z, 0-9 and _, starting with a letter',
    };
  }
  if ((TOOL_KEYS as readonly string[]).includes(name)) {
    return {
      ok: false,
      code: 'name_reserved',
      error: 'That name belongs to a built-in tool.',
    };
  }
  return { ok: true, name };
}

export type UrlResult =
  { ok: true; url: string } | { ok: false; code: string; error: string };

/**
 * The admin's URL: https, no credentials, an allowed port, a public host and
 * no secret in the query string. The same guard runs again on every call.
 */
export async function validateToolUrl(
  raw: unknown,
  isDeliverable: (url: string) => Promise<boolean>
): Promise<UrlResult> {
  if (typeof raw !== 'string' || !raw.trim()) {
    return { ok: false, code: 'invalid_url', error: 'url is required' };
  }
  const parsed = parseToolUrl(raw.trim());
  if ('error' in parsed) {
    const map = {
      invalid_url: 'The URL must be a valid https address without credentials.',
      blocked_port: 'That port is not allowed (443, 8443, 80, 8080).',
      blocked_url: 'That address is internal or private and is not allowed.',
    } as const;
    return {
      ok: false,
      code:
        parsed.error === 'blocked_port' ? 'url_port_blocked' : 'url_blocked',
      error: map[parsed.error],
    };
  }
  const url = parsed.url;
  url.hash = '';
  if (url.toString().length > 2000) {
    return { ok: false, code: 'invalid_url', error: 'The URL is too long.' };
  }
  for (const name of url.searchParams.keys()) {
    if (SECRET_PARAM_RE.test(name)) {
      return {
        ok: false,
        code: 'url_secret',
        error:
          'Do not put a key or token in the URL: use a header (it is stored encrypted).',
      };
    }
  }
  if (!(await isDeliverable(url.toString()))) {
    return {
      ok: false,
      code: 'url_blocked',
      error:
        'That address is internal, private or does not resolve, so it is not allowed.',
    };
  }
  return { ok: true, url: url.toString() };
}

function validateDescription(raw: unknown): ServiceResult<string> {
  if (typeof raw !== 'string') {
    return fail(400, 'invalid_description', 'description is required');
  }
  const d = raw
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .trim();
  if (d.length < MIN_DESCRIPTION || d.length > MAX_DESCRIPTION) {
    return fail(
      400,
      'invalid_description',
      `description must have ${MIN_DESCRIPTION} to ${MAX_DESCRIPTION} characters`
    );
  }
  return { ok: true, value: d };
}

function validateTimeout(raw: unknown): ServiceResult<number> {
  if (
    !Number.isInteger(raw) ||
    (raw as number) < MIN_TIMEOUT_MS ||
    (raw as number) > MAX_TIMEOUT_MS
  ) {
    return fail(
      400,
      'invalid_timeout',
      `timeout_ms must be an integer from ${MIN_TIMEOUT_MS} to ${MAX_TIMEOUT_MS}`
    );
  }
  return { ok: true, value: raw as number };
}

// ------------------------------------------------------------
// View
// ------------------------------------------------------------

interface Row {
  id: string;
  name: string;
  description: string;
  input_schema: unknown;
  url: string;
  method: 'GET' | 'POST';
  risk: 'read' | 'write';
  header_names: string[] | null;
  timeout_ms: number;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export function toView(row: Row): CustomToolView {
  const names = row.header_names ?? [];
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    input_schema: row.input_schema,
    url: row.url,
    method: row.method,
    risk: row.risk,
    header_names: names,
    has_headers: names.length > 0,
    timeout_ms: row.timeout_ms,
    is_active: row.is_active,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

// ------------------------------------------------------------
// CRUD
// ------------------------------------------------------------

export async function listCustomTools(
  db: SupabaseClient,
  accountId: string
): Promise<ServiceResult<CustomToolView[]>> {
  const { data, error } = await db
    .from('ai_custom_tools')
    .select(PUBLIC_COLUMNS)
    .eq('account_id', accountId)
    .order('created_at', { ascending: true })
    .limit(MAX_CUSTOM_TOOLS);
  if (error) {
    const m = mapDbError(error);
    return fail(m.status, m.code, m.error);
  }
  return { ok: true, value: ((data ?? []) as unknown as Row[]).map(toView) };
}

export interface CreateCustomToolInput {
  name?: unknown;
  description?: unknown;
  input_schema?: unknown;
  url?: unknown;
  method?: unknown;
  risk?: unknown;
  headers?: unknown;
  timeout_ms?: unknown;
}

function validateMethodRisk(
  input: { method?: unknown; risk?: unknown },
  defaults: { method?: 'GET' | 'POST'; risk?: 'read' | 'write' } = {}
): ServiceResult<{ method?: 'GET' | 'POST'; risk?: 'read' | 'write' }> {
  const out: { method?: 'GET' | 'POST'; risk?: 'read' | 'write' } = {
    ...defaults,
  };
  if (input.method !== undefined) {
    if (input.method !== 'GET' && input.method !== 'POST') {
      return fail(400, 'invalid_method', 'method must be GET or POST');
    }
    out.method = input.method;
  }
  if (input.risk !== undefined) {
    if (input.risk !== 'read' && input.risk !== 'write') {
      return fail(400, 'invalid_risk', 'risk must be read or write');
    }
    out.risk = input.risk;
  }
  return { ok: true, value: out };
}

/**
 * Create a tool. It is born OFF (D-16) and `write` unless the admin says
 * `read`: the admin turns it on after a test. The headers (a list of
 * `{ name, value }`) are validated and encrypted here.
 */
export async function createCustomTool(
  deps: CustomToolsDeps,
  accountId: string,
  userId: string | null,
  input: CreateCustomToolInput
): Promise<ServiceResult<CustomToolView>> {
  const name = validateName(input.name);
  if (!name.ok) return fail(400, name.code, name.error);
  const description = validateDescription(input.description);
  if (!description.ok) return description;
  const schema = validateInputSchema(
    input.input_schema ?? { type: 'object', properties: {} }
  );
  if (!schema.ok) return fail(400, 'invalid_schema', schema.error);
  const mr = validateMethodRisk(input, { method: 'POST', risk: 'write' });
  if (!mr.ok) return mr;
  const timeout = validateTimeout(input.timeout_ms ?? DEFAULT_TIMEOUT_MS);
  if (!timeout.ok) return timeout;
  const url = await validateToolUrl(input.url, deps.isDeliverable);
  if (!url.ok) return fail(400, url.code, url.error);

  let headersEncrypted: string | null = null;
  let headerNames: string[] = [];
  if (input.headers !== undefined) {
    const items = parseHeaderInputs(input.headers);
    if (!items.ok) return fail(400, 'invalid_headers', items.error);
    const merged = mergeHeaders({}, items.items);
    if (!merged.ok) return fail(400, 'invalid_headers', merged.error);
    headerNames = Object.keys(merged.headers);
    if (headerNames.length > 0) {
      headersEncrypted = deps.encrypt(JSON.stringify(merged.headers));
    }
  }

  const { data, error } = await deps.db
    .from('ai_custom_tools')
    .insert({
      account_id: accountId,
      name: name.name,
      description: description.value,
      input_schema: schema.schema,
      url: url.url,
      method: mr.value.method,
      risk: mr.value.risk,
      headers_encrypted: headersEncrypted,
      header_names: headerNames,
      timeout_ms: timeout.value,
      is_active: false,
      created_by: userId,
    })
    .select(PUBLIC_COLUMNS)
    .single();
  if (error || !data) {
    const m = mapDbError(error);
    return fail(m.status, m.code, m.error);
  }
  return { ok: true, value: toView(data as unknown as Row) };
}

/** Same destination, byte for byte after normalizing (path and query count). */
function sameUrl(a: string, b: string): boolean {
  try {
    return new URL(a).href === new URL(b).href;
  } catch {
    return a === b;
  }
}

export interface UpdateCustomToolInput extends CreateCustomToolInput {
  is_active?: unknown;
}

/**
 * Update a tool. Only the fields sent change. `headers` replaces the WHOLE
 * set by name: a `value` left out keeps the stored value of that name, a name
 * left out is removed, `[]` clears.
 */
export async function updateCustomTool(
  deps: CustomToolsDeps,
  accountId: string,
  id: string,
  input: UpdateCustomToolInput
): Promise<ServiceResult<CustomToolView>> {
  const patch: Record<string, unknown> = {};

  if (input.name !== undefined) {
    const name = validateName(input.name);
    if (!name.ok) return fail(400, name.code, name.error);
    patch.name = name.name;
  }
  if (input.description !== undefined) {
    const d = validateDescription(input.description);
    if (!d.ok) return d;
    patch.description = d.value;
  }
  if (input.input_schema !== undefined) {
    const schema = validateInputSchema(input.input_schema);
    if (!schema.ok) return fail(400, 'invalid_schema', schema.error);
    patch.input_schema = schema.schema;
  }
  const mr = validateMethodRisk(input);
  if (!mr.ok) return mr;
  if (mr.value.method) patch.method = mr.value.method;
  if (mr.value.risk) patch.risk = mr.value.risk;
  if (input.timeout_ms !== undefined) {
    const t = validateTimeout(input.timeout_ms);
    if (!t.ok) return t;
    patch.timeout_ms = t.value;
  }
  if (input.is_active !== undefined) {
    if (typeof input.is_active !== 'boolean') {
      return fail(400, 'invalid_is_active', 'is_active must be a boolean');
    }
    patch.is_active = input.is_active;
  }
  if (input.url !== undefined) {
    const url = await validateToolUrl(input.url, deps.isDeliverable);
    if (!url.ok) return fail(400, url.code, url.error);
    patch.url = url.url;
  }

  // The headers are write-only secrets and the destination is what makes
  // them safe: on a multi-tenant host the PATH identifies the owner
  // (`hook.eu1.make.com/<id>`) and one path or method of the same API may be
  // privileged. So ANY change of the url (origin, path or query) or of the
  // method needs every header value typed again (or the headers removed): no
  // admin can redirect, or reuse on another endpoint, a secret another admin
  // stored.
  if (patch.url !== undefined || patch.method !== undefined) {
    const { data: current, error: curErr } = await deps.db
      .from('ai_custom_tools')
      .select('url, method, header_names')
      .eq('id', id)
      .eq('account_id', accountId)
      .maybeSingle();
    if (curErr) {
      const m = mapDbError(curErr);
      return fail(m.status, m.code, m.error);
    }
    if (!current) return fail(404, 'not_found', 'Tool not found.');
    const cur = current as {
      url: string;
      method: string;
      header_names: string[] | null;
    };
    const urlChanged =
      patch.url !== undefined && !sameUrl(cur.url, patch.url as string);
    const methodChanged =
      patch.method !== undefined && patch.method !== cur.method;
    if ((urlChanged || methodChanged) && (cur.header_names ?? []).length > 0) {
      const items =
        input.headers === undefined ? null : parseHeaderInputs(input.headers);
      const retyped =
        items !== null &&
        items.ok &&
        items.items.every((i) => i.value !== undefined);
      if (!retyped) {
        return fail(
          400,
          'headers_required',
          'Changing the URL or the method requires entering the header values again, or removing the headers.'
        );
      }
    }
  }

  if (input.headers !== undefined) {
    const items = parseHeaderInputs(input.headers);
    if (!items.ok) return fail(400, 'invalid_headers', items.error);
    // The current set: read with the service role, decrypted here only to
    // carry the values the screen did not resend.
    let current: Record<string, string> = {};
    if (items.items.some((i) => i.value === undefined)) {
      const { data, error } = await deps.db
        .from('ai_custom_tools')
        .select('headers_encrypted')
        .eq('id', id)
        .eq('account_id', accountId)
        .maybeSingle();
      if (error) {
        const m = mapDbError(error);
        return fail(m.status, m.code, m.error);
      }
      if (!data) return fail(404, 'not_found', 'Tool not found.');
      const cipher = (data as { headers_encrypted: string | null })
        .headers_encrypted;
      if (cipher) {
        try {
          const parsed = validateHeaders(JSON.parse(deps.decrypt(cipher)));
          if (parsed.ok) current = parsed.headers;
        } catch {
          return fail(
            409,
            'headers_unreadable',
            'The stored headers cannot be read. Enter their values again.'
          );
        }
      }
    }
    const merged = mergeHeaders(current, items.items);
    if (!merged.ok) return fail(400, 'invalid_headers', merged.error);
    const names = Object.keys(merged.headers);
    patch.header_names = names;
    patch.headers_encrypted =
      names.length > 0 ? deps.encrypt(JSON.stringify(merged.headers)) : null;
  }

  if (Object.keys(patch).length === 0) {
    return fail(400, 'nothing_to_update', 'No field to update.');
  }

  const { data, error } = await deps.db
    .from('ai_custom_tools')
    .update(patch)
    .eq('id', id)
    .eq('account_id', accountId)
    .select(PUBLIC_COLUMNS);
  if (error) {
    const m = mapDbError(error);
    return fail(m.status, m.code, m.error);
  }
  const rows = (data ?? []) as unknown as Row[];
  if (rows.length !== 1) return fail(404, 'not_found', 'Tool not found.');
  return { ok: true, value: toView(rows[0]) };
}

export async function deleteCustomTool(
  db: SupabaseClient,
  accountId: string,
  id: string
): Promise<ServiceResult<{ id: string }>> {
  const { data, error } = await db
    .from('ai_custom_tools')
    .delete()
    .eq('id', id)
    .eq('account_id', accountId)
    .select('id');
  if (error) {
    const m = mapDbError(error);
    return fail(m.status, m.code, m.error);
  }
  if (!data || data.length !== 1)
    return fail(404, 'not_found', 'Tool not found.');
  return { ok: true, value: { id } };
}

// ------------------------------------------------------------
// Execution: simulation (admin test) and the tools a turn is offered
// ------------------------------------------------------------

function rowToSpec(accountId: string, row: Row): HttpToolSpec | null {
  const schema: HttpInputSchema | null = readStoredSchema(row.input_schema);
  if (!schema) return null;
  return {
    id: row.id,
    accountId,
    name: row.name,
    description: row.description,
    inputSchema: schema,
    url: row.url,
    method: row.method,
    risk: row.risk,
    timeoutMs: row.timeout_ms,
  };
}

export interface SimulationView {
  tool: string;
  would_call: { method: string; url: string; arguments: HttpArgs };
  risk: 'read' | 'write';
  header_names: string[];
  /** Always false: a simulation never calls the endpoint. */
  called: false;
}

/**
 * "Test" in the Tools tab: validates the arguments against the schema and
 * describes the call (method, the URL WITHOUT its query string, the
 * arguments). It never makes the request and never reads the headers.
 */
export async function simulateCustomTool(
  db: SupabaseClient,
  accountId: string,
  id: string,
  rawArguments: unknown
): Promise<ServiceResult<SimulationView>> {
  const { data, error } = await db
    .from('ai_custom_tools')
    .select(PUBLIC_COLUMNS)
    .eq('id', id)
    .eq('account_id', accountId)
    .maybeSingle();
  if (error) {
    const m = mapDbError(error);
    return fail(m.status, m.code, m.error);
  }
  if (!data) return fail(404, 'not_found', 'Tool not found.');
  const row = data as unknown as Row;
  const spec = rowToSpec(accountId, row);
  if (!spec)
    return fail(409, 'invalid_schema', 'The stored schema is not valid.');
  const args = parseHttpArgs(spec.inputSchema, rawArguments ?? {});
  if (!args.ok) return fail(400, 'invalid_arguments', args.error);
  return {
    ok: true,
    value: {
      tool: spec.name,
      would_call: describeCall(spec, args.value),
      risk: spec.risk,
      header_names: row.header_names ?? [],
      called: false,
    },
  };
}

export interface LoadForTurnArgs {
  accountId: string;
  mode: ToolMode;
  /** Service-role client; the default builds one. */
  db?: SupabaseClient;
  http?: HttpToolDeps;
}

/**
 * The account's active HTTP tools as catalog entries for one turn.
 *   - `draft` is offered only the tools marked `read` (a human is in the loop
 *     and nothing is written);
 *   - a name that collides with a built-in tool is dropped (the built-in wins);
 *   - best effort: a failure (or migration 107 missing) means NO custom tool,
 *     never a failed turn.
 * Loaded with the service role because a draft is asked by agents, who cannot
 * read the table; the rows are filtered by account and carry no secret.
 */
export async function loadCustomToolsForTurn(
  args: LoadForTurnArgs
): Promise<AgentTool[]> {
  try {
    const db = args.db ?? supabaseAdmin();
    let query = db
      .from('ai_custom_tools')
      .select(PUBLIC_COLUMNS)
      .eq('account_id', args.accountId)
      .eq('is_active', true)
      .limit(MAX_CUSTOM_TOOLS);
    if (args.mode === 'draft') query = query.eq('risk', 'read');
    const { data, error } = await query;
    if (error) {
      if (!isMissingTable(error)) {
        console.error(
          '[ai custom tools] load failed:',
          (error as { code?: string }).code
        );
      }
      return [];
    }
    const tools: AgentTool[] = [];
    for (const row of (data ?? []) as unknown as Row[]) {
      if ((TOOL_KEYS as readonly string[]).includes(row.name)) continue;
      // The filter above is the first line; this is the second.
      if (args.mode === 'draft' && row.risk !== 'read') continue;
      // Global kill switch (SPEC 089 F8): in a live turn, no HTTP tool that
      // may change something elsewhere — a `write` one, and also a POST the
      // admin marked `read` (a POST to a webhook is a write in practice).
      if (
        args.mode === 'auto_reply' &&
        (row.risk === 'write' || row.method === 'POST') &&
        isWriteSwitchedOff(row.name)
      ) {
        continue;
      }
      const spec = rowToSpec(args.accountId, row);
      if (!spec) continue;
      tools.push(buildHttpTool(spec, args.http) as unknown as AgentTool);
    }
    return tools;
  } catch (err) {
    console.error('[ai custom tools] load threw:', (err as Error)?.name);
    return [];
  }
}

export { displayUrl };
