import {
  safeRequest,
  SafeRequestError,
  type SafeRequestInput,
  type SafeResponse,
} from '@/lib/http/safe-request';
import { supabaseAdmin } from '../admin-client';
import { validateHeaders } from './http-headers';
import {
  parseHttpArgs,
  toModelSchema,
  type HttpArgs,
  type HttpInputSchema,
} from './http-schema';
import type { AgentTool, ToolContext, ToolResult, ToolRisk } from './types';

// ============================================================
// Account-defined HTTP tools (SPEC 089 F6): execution.
//
// The URL is FIXED by the admin. The model fills only the fields of the
// input schema, and they go into the JSON body (POST) or the query string
// (GET) as DATA: never a host, a scheme, a port or a path (the URL object is
// built from the admin's URL and `searchParams.append` encodes the rest).
//
// Before every call: the guarded transport (`safeRequest`: `isDeliverableUrl`,
// a connect-time address check against DNS rebinding, a port allow-list, no
// redirect, a deadline, a capped stream, JSON/text only). The encrypted
// headers are decrypted HERE, right before the call, and never leave this
// function: not to a log, not to `ai_tool_calls` (shape-only audit), not to
// the model (the endpoint's answer is scrubbed of every header value).
//
// Modes: `auto_reply` calls for real; `draft` calls for real only a tool the
// admin marked `read`; `playground` and `eval` never call (they describe the
// call); a write tool never runs in a draft.
// ============================================================

/** The non-secret part of a stored tool (what a turn needs to offer it). */
export interface HttpToolSpec {
  id: string;
  accountId: string;
  name: string;
  description: string;
  inputSchema: HttpInputSchema;
  url: string;
  method: 'GET' | 'POST';
  risk: ToolRisk;
  timeoutMs: number;
}

export type HeadersLoad =
  | { ok: true; headers: Record<string, string> }
  | { ok: false; reason: 'unreadable' };

export interface HttpToolDeps {
  request?: (input: SafeRequestInput) => Promise<SafeResponse>;
  /** Fetch + decrypt the tool's headers (default: service role + decrypt). */
  loadHeaders?: (accountId: string, toolId: string) => Promise<HeadersLoad>;
}

/**
 * The URL as the ADMIN screen may show it: no query string, no fragment.
 * Never for the model or the playground (an agent can open it): the path of a
 * multi-tenant webhook (Zapier, Make, n8n) is a bearer credential. Use
 * `displayOrigin` there.
 */
export function displayUrl(raw: string): string {
  try {
    const u = new URL(raw);
    return `${u.origin}${u.pathname}`;
  } catch {
    return '[invalid url]';
  }
}

/**
 * What the model and the playground may see of the URL: the origin only,
 * then `/…` when there is a path or a query that was left out.
 */
export function displayOrigin(raw: string): string {
  try {
    const u = new URL(raw);
    const more = u.pathname !== '/' || u.search !== '';
    return `${u.origin}${more ? '/…' : ''}`;
  } catch {
    return '[invalid url]';
  }
}

async function defaultLoadHeaders(
  accountId: string,
  toolId: string
): Promise<HeadersLoad> {
  try {
    // Imported here so a module that only validates never needs the key.
    const { decrypt } = await import('@/lib/whatsapp/encryption');
    const { data, error } = await supabaseAdmin()
      .from('ai_custom_tools')
      .select('headers_encrypted')
      .eq('id', toolId)
      .eq('account_id', accountId)
      .maybeSingle();
    if (error) return { ok: false, reason: 'unreadable' };
    const cipher = (data as { headers_encrypted?: string | null } | null)
      ?.headers_encrypted;
    if (!cipher) return { ok: true, headers: {} };
    const checked = validateHeaders(JSON.parse(decrypt(cipher)));
    return checked.ok
      ? { ok: true, headers: checked.headers }
      : { ok: false, reason: 'unreadable' };
  } catch {
    // Never the error itself: a decrypt failure message is not for the model.
    return { ok: false, reason: 'unreadable' };
  }
}

/** Shortest variant of a secret that may be erased from a text. */
const MIN_VARIANT = 4;

/** Every shape in which an endpoint may echo one header value. */
function secretVariants(value: string): string[] {
  const out = new Set<string>();
  const add = (v: string | undefined) => {
    if (v && v.length >= MIN_VARIANT) out.add(v);
  };
  if (value.length >= 3) out.add(value);
  add(encodeURIComponent(value));
  // The token on its own (`Bearer <token>` / `Basic <b64>`).
  const space = value.search(/\s/);
  if (space > 0) {
    const scheme = value.slice(0, space);
    const token = value.slice(space).trim();
    add(token);
    if (token) add(encodeURIComponent(token));
    if (/^basic$/i.test(scheme) && token) {
      let decoded = '';
      try {
        decoded = Buffer.from(token, 'base64').toString('utf8');
      } catch {
        decoded = '';
      }
      // Real text only: not the replacement char of a bad decode.
      if (decoded && !decoded.includes('\uFFFD') && decoded.includes(':')) {
        add(decoded);
        add(encodeURIComponent(decoded));
        const colon = decoded.indexOf(':');
        add(decoded.slice(0, colon));
        add(decoded.slice(colon + 1));
      }
    }
  }
  return [...out];
}

/**
 * Replace every occurrence of a secret header value in `text`, and of the
 * shapes an endpoint may echo it in: URL-encoded, the token after the
 * scheme, and for `Basic` the decoded `user:password` and each part. A
 * variant under 4 characters is ignored (it would erase ordinary text).
 */
export function scrubSecrets(
  text: string,
  headers: Record<string, string>
): string {
  const variants = new Set<string>();
  for (const value of Object.values(headers)) {
    for (const v of secretVariants(value)) variants.add(v);
  }
  // Longest first: a part must not leave a half-erased remainder of the whole.
  let out = text;
  for (const v of [...variants].sort((a, b) => b.length - a.length)) {
    out = out.split(v).join('[redacted]');
  }
  return out;
}

function errorCodeFor(err: SafeRequestError): string {
  switch (err.code) {
    case 'invalid_url':
    case 'blocked_url':
    case 'blocked_port':
      return 'endpoint_not_allowed';
    case 'redirect_blocked':
      return 'endpoint_redirect';
    case 'unsupported_content_type':
      return 'unsupported_response';
    case 'response_too_large':
      return 'response_too_large';
    case 'timeout':
      return 'endpoint_timeout';
    default:
      return 'endpoint_unreachable';
  }
}

/**
 * What the call would have been, for the playground and the test route. The
 * URL is the ORIGIN only: this reaches the model and the playground, which
 * the `agent` role can open.
 */
export function describeCall(
  spec: HttpToolSpec,
  args: HttpArgs
): { method: string; url: string; arguments: HttpArgs } {
  return {
    method: spec.method,
    url: displayOrigin(spec.url),
    arguments: args,
  };
}

/** The request the code builds from the FIXED url and the validated args. */
export function buildRequest(
  spec: HttpToolSpec,
  args: HttpArgs,
  headers: Record<string, string>,
  timeoutMs: number
): SafeRequestInput {
  const url = new URL(spec.url);
  url.hash = '';
  const base: Record<string, string> = {
    Accept: 'application/json, text/*;q=0.8',
    'User-Agent': 'ZapCRM-AgentTool/1.0',
  };
  if (spec.method === 'GET') {
    for (const [k, v] of Object.entries(args)) {
      url.searchParams.append(k, String(v));
    }
    return {
      url: url.toString(),
      method: 'GET',
      headers: { ...base, ...headers },
      timeoutMs,
    };
  }
  return {
    url: url.toString(),
    method: 'POST',
    headers: { ...base, 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(args),
    timeoutMs,
  };
}

/** `scrubSecrets` over every string (and key) of a parsed JSON value. */
export function scrubDeep(
  value: unknown,
  headers: Record<string, string>,
  depth = 0
): unknown {
  if (typeof value === 'string') return scrubSecrets(value, headers);
  if (depth > 20 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    return value.map((v) => scrubDeep(v, headers, depth + 1));
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[scrubSecrets(k, headers)] = scrubDeep(v, headers, depth + 1);
  }
  return out;
}

/** Parse the (scrubbed) body: JSON when the type says so, else text. */
function shapeBody(contentType: string, text: string): unknown {
  const type = contentType.split(';')[0].trim().toLowerCase();
  if (type === 'application/json' || type.endsWith('+json')) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return text;
}

/** Build the catalog entry of one stored tool. */
export function buildHttpTool(
  spec: HttpToolSpec,
  deps: HttpToolDeps = {}
): AgentTool<HttpArgs> {
  const request = deps.request ?? ((input) => safeRequest(input));
  const loadHeaders = deps.loadHeaders ?? defaultLoadHeaders;

  const handler = async (
    ctx: ToolContext,
    args: HttpArgs,
    run?: { budgetMs: number }
  ): Promise<ToolResult> => {
    // The row was loaded for one account; a context of another never runs it.
    if (ctx.accountId !== spec.accountId) {
      return { ok: false, error: 'not_available' };
    }
    // A write never runs in a draft (D-18).
    if (ctx.mode === 'draft' && spec.risk === 'write') {
      return { ok: false, error: 'not_available' };
    }

    const live =
      ctx.mode === 'auto_reply' ||
      (ctx.mode === 'draft' && spec.risk === 'read');
    if (!live) {
      // playground / eval: describe the call, never make it.
      return {
        ok: true,
        simulated: true,
        data: {
          status: 'simulated',
          tool: spec.name,
          would_call: describeCall(spec, args),
          note: 'Test mode: the external endpoint was not called.',
        },
      };
    }

    // A live call needs the conversation and the audit row (fail closed).
    if (!ctx.conversationId || !ctx.contactId || !ctx.audit) {
      return { ok: false, error: 'not_available' };
    }

    const headers = await loadHeaders(spec.accountId, spec.id);
    if (!headers.ok) return { ok: false, error: 'headers_unreadable' };

    const budget = run?.budgetMs ?? spec.timeoutMs;
    const timeoutMs = Math.max(500, Math.min(spec.timeoutMs, budget - 300));

    let res: SafeResponse;
    try {
      res = await request(buildRequest(spec, args, headers.headers, timeoutMs));
    } catch (err) {
      const code =
        err instanceof SafeRequestError
          ? errorCodeFor(err)
          : 'endpoint_unreachable';
      const sent = err instanceof SafeRequestError ? err.sent : true;
      return {
        ok: false,
        error: code,
        auditSummary: `http error ${code}`,
        ...(sent ? { outcomeUnknown: true } : {}),
      };
    }

    // Scrubbed as raw text AND again value by value after parsing: a JSON
    // encoder may escape a character of the secret (`/` → `\/`), which the
    // raw-text pass would miss.
    const scrubbed = scrubSecrets(res.body, headers.headers);
    const body = scrubDeep(
      shapeBody(res.contentType, scrubbed),
      headers.headers
    );
    const type = res.contentType.split(';')[0].trim().toLowerCase();
    const summary = `http ${res.status} ${type} ${res.bytes}b`;

    if (res.status < 200 || res.status >= 300) {
      return {
        ok: false,
        error: 'http_error',
        detail: { status: res.status, body },
        auditSummary: summary,
        // A 5xx on a write may have been applied before it failed.
        ...(res.status >= 500 ? { outcomeUnknown: true } : {}),
      };
    }

    return {
      ok: true,
      data: { status: res.status, body },
      auditSummary: summary,
      ...(spec.risk === 'write'
        ? {
            activity: {
              action: 'ai.tool_http_called' as const,
              label: spec.name,
              metadata: { method: spec.method, status: res.status },
            },
          }
        : {}),
    };
  };

  return {
    key: spec.name,
    description: spec.description,
    inputSchema: toModelSchema(spec.inputSchema),
    risk: spec.risk,
    external: true,
    parse: (input) => parseHttpArgs(spec.inputSchema, input),
    handler,
  };
}
