// ============================================================
// Outbound webhook delivery.
//
// `dispatchWebhookEvent` finds the account's active endpoints
// subscribed to an event, signs one JSON payload, and POSTs it to
// each in parallel. It is best-effort and never throws — callers fire
// it from the inbound webhook's `after()` block, where a failed
// delivery must not affect the 200 OK returned to Meta.
//
// Delivery semantics (documented in docs/public-api.md):
//   - At-most-once per event, single attempt with a short timeout.
//   - Each consecutive failure bumps `failure_count`; once it crosses
//     MAX_CONSECUTIVE_FAILURES the endpoint is auto-disabled
//     (`is_active = false`) so a dead sink stops being hit. A success
//     resets the counter and stamps `last_delivery_at`.
//   - Durable retry-with-backoff would need a queue/worker (a
//     follow-up); in-process retries inside `after()` would burn the
//     route's duration budget without a real durability guarantee.
// ============================================================

import { randomUUID } from 'node:crypto';

import type { SupabaseClient } from '@supabase/supabase-js';

import { decrypt } from '@/lib/whatsapp/encryption';
import { buildSignatureHeader } from '@/lib/webhooks/sign';
import { isDeliverableUrl } from '@/lib/webhooks/ssrf';
import type { WebhookEvent } from '@/lib/webhooks/events';

/** Per-endpoint HTTP timeout. Kept short — this runs in `after()`. */
export const DELIVERY_TIMEOUT_MS = 5000;

/** Auto-disable an endpoint after this many consecutive failures. */
export const MAX_CONSECUTIVE_FAILURES = 15;

interface EndpointRow {
  id: string;
  url: string;
  secret: string;
}

/** Outcome of one signed POST. Never carries the response body. */
export type PostSignedResult =
  | { ok: true; status: number; durationMs: number }
  | {
      ok: false;
      error: 'timeout' | 'not_public' | 'http_error' | 'network';
      /** HTTP status when the target answered (`http_error`); else null. */
      status: number | null;
      durationMs: number;
      /**
       * Short diagnostic for logs. Always a fixed string or a bare error
       * class/code: never the URL (nor its credentials, path or query),
       * the body or the secret, and never the raw `fetch` error message
       * (undici puts the whole URL in it).
       */
      message: string;
    };

export interface PostSignedPayloadInput {
  url: string;
  /** Plaintext HMAC key (already decrypted by the caller). */
  secret: string;
  /** Exact bytes sent AND signed. */
  body: string;
  /** Extra headers; `Content-Type` and `X-Wacrm-Signature` always win. */
  headers?: Record<string, string>;
  /** Signature clock (seconds). Defaults to now. */
  tsSeconds?: number;
}

/**
 * One signed POST to a user-supplied URL: SSRF guard, short timeout, no
 * redirect following, `X-Wacrm-Signature` over the exact body. Shared by
 * the outbound webhooks and the Meta webhook relay (SPEC 088). Never
 * throws: every failure comes back as a typed result.
 */
export async function postSignedPayload(
  input: PostSignedPayloadInput
): Promise<PostSignedResult> {
  const started = Date.now();
  const elapsed = () => Date.now() - started;

  // Shape guard, before any DNS or network I/O: only https, and no
  // credentials in the URL (they would travel as Basic auth and leak
  // into logs). Reuses `not_public` so the relay test button keeps its
  // `timeout | not_public | http_error | network` contract.
  if (!isSafeTargetShape(input.url)) {
    return {
      ok: false,
      error: 'not_public',
      status: null,
      durationMs: elapsed(),
      message: 'target must be https without embedded credentials',
    };
  }

  // SSRF guard: refuse to POST to a host that resolves to a private /
  // loopback / link-local address.
  let deliverable = false;
  try {
    deliverable = await isDeliverableUrl(input.url);
  } catch {
    deliverable = false;
  }
  if (!deliverable) {
    return {
      ok: false,
      error: 'not_public',
      status: null,
      durationMs: elapsed(),
      message: 'target is not a public address',
    };
  }

  const tsSeconds = input.tsSeconds ?? Math.floor(Date.now() / 1000);
  try {
    const res = await fetch(input.url, {
      method: 'POST',
      headers: {
        ...input.headers,
        'Content-Type': 'application/json',
        'X-Wacrm-Signature': buildSignatureHeader(
          input.body,
          input.secret,
          tsSeconds
        ),
      },
      body: input.body,
      // Do NOT follow redirects — a public URL could 3xx-bounce to an
      // internal address, bypassing the SSRF check above. A 3xx is a
      // misconfiguration; treat it as a failure.
      redirect: 'manual',
      signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
    });
    // Free the connection without reading the target's answer.
    try {
      void res.body?.cancel().catch(() => {});
    } catch {
      /* best effort */
    }
    if (!res.ok) {
      return {
        ok: false,
        error: 'http_error',
        status: res.status,
        durationMs: elapsed(),
        message: `endpoint responded ${res.status}`,
      };
    }
    return { ok: true, status: res.status, durationMs: elapsed() };
  } catch (err) {
    const name = (err as { name?: string } | null)?.name;
    const timedOut = name === 'TimeoutError' || name === 'AbortError';
    return {
      ok: false,
      error: timedOut ? 'timeout' : 'network',
      status: null,
      durationMs: elapsed(),
      message: describeFetchError(err, timedOut),
    };
  }
}

/** True for an absolute `https:` URL with no `user:pass@` part. */
function isSafeTargetShape(rawUrl: string): boolean {
  try {
    const u = new URL(rawUrl);
    return u.protocol === 'https:' && !u.username && !u.password;
  } catch {
    return false;
  }
}

/**
 * Loggable summary of a `fetch` failure. undici's `TypeError: fetch
 * failed` is harmless, but other messages embed the full URL, so only
 * the error class and a bare system code (`ENOTFOUND`, ...) are kept.
 */
function describeFetchError(err: unknown, timedOut: boolean): string {
  if (timedOut) return 'request timed out';
  const cause = (err as { cause?: { code?: unknown } } | null)?.cause;
  const code =
    typeof cause?.code === 'string' && /^[A-Z0-9_]{1,40}$/.test(cause.code)
      ? cause.code
      : null;
  return code ? `request failed (${code})` : 'request failed';
}

/**
 * Deliver `event` (+ `data`) to every active endpoint of `accountId`
 * subscribed to it. Never throws.
 */
export async function dispatchWebhookEvent(
  db: SupabaseClient,
  accountId: string,
  event: WebhookEvent,
  data: unknown
): Promise<void> {
  try {
    const { data: rows, error } = await db
      .from('webhook_endpoints')
      .select('id, url, secret')
      .eq('account_id', accountId)
      .eq('is_active', true)
      .contains('events', [event]);

    if (error || !rows || rows.length === 0) return;

    // Sign the exact bytes we send so a receiver can recompute the
    // HMAC over the raw request body. `id` is a per-delivery uuid the
    // receiver can dedupe on (deliveries are at-least-once and may
    // repeat / arrive out of order).
    const payload = JSON.stringify({
      id: randomUUID(),
      event,
      occurred_at: new Date().toISOString(),
      account_id: accountId,
      data,
    });
    const tsSeconds = Math.floor(Date.now() / 1000);

    await Promise.allSettled(
      (rows as EndpointRow[]).map((row) =>
        deliverOne(db, row, event, payload, tsSeconds)
      )
    );
  } catch (err) {
    // Never let a delivery problem bubble into the webhook response.
    console.error('[webhooks] dispatch failed:', err);
  }
}

async function deliverOne(
  db: SupabaseClient,
  row: EndpointRow,
  event: WebhookEvent,
  payload: string,
  tsSeconds: number
): Promise<void> {
  let secret: string;
  try {
    secret = decrypt(row.secret);
  } catch (err) {
    // A row whose secret can't be decrypted can never produce a valid
    // signature — count it as a failure so it eventually auto-disables.
    console.error('[webhooks] secret decrypt failed for', row.id, err);
    await recordFailure(db, row);
    return;
  }

  const result = await postSignedPayload({
    url: row.url,
    secret,
    body: payload,
    tsSeconds,
    headers: {
      'X-Wacrm-Event': event,
      'X-Wacrm-Webhook-Id': row.id,
    },
  });

  if (result.ok) {
    // Success: clear the failure streak.
    await db
      .from('webhook_endpoints')
      .update({ failure_count: 0, last_delivery_at: new Date().toISOString() })
      .eq('id', row.id);
    return;
  }

  if (result.error === 'not_public') {
    // Counts as a failure so a misconfigured internal URL surfaces and
    // eventually auto-disables.
    console.warn(
      `[webhooks] refusing delivery target for ${row.id}: ${result.message}`
    );
  } else {
    // `result.message` is URL-free by contract; log the class and status
    // only, never `row.url`.
    console.warn(
      `[webhooks] delivery to ${row.id} failed: ${result.error} status=${result.status ?? 'none'} (${result.message})`
    );
  }
  await recordFailure(db, row);
}

async function recordFailure(
  db: SupabaseClient,
  row: EndpointRow
): Promise<void> {
  // Atomic increment (+ auto-disable at the threshold) via a SQL
  // function — a read-modify-write here would lose increments when two
  // deliveries to the same endpoint run concurrently (e.g.
  // conversation.created + message.received for one inbound message),
  // so a dead endpoint might never reach the disable threshold.
  const { error } = await db.rpc('record_webhook_failure', {
    endpoint_id: row.id,
    max_failures: MAX_CONSECUTIVE_FAILURES,
  });
  if (error) {
    console.error(
      '[webhooks] record_webhook_failure failed for',
      row.id,
      error
    );
  }
}
