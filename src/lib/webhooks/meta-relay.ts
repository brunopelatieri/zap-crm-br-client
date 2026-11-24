// ============================================================
// Meta webhook relay (SPEC 088).
//
// When Meta POSTs a webhook for an official (Cloud API) number of an
// account, the account may have asked us to forward the same JSON to a
// URL of its own. This module decides WHAT each account receives
// (`planMetaRelay`, pure) and delivers it (`relayMetaWebhook`).
//
// Isolation (D-1, D-5, R-1) is the whole point, so it is fail-closed:
// a `change` belongs to an account only through its own
// `value.metadata.phone_number_id`, resolved against `whatsapp_config`
// and the channel's status. Anything else — no metadata (template and
// WABA-level events), a number that is not in the CRM, a duplicated
// number, a deleted or disabled channel — has NO owner and goes to
// nobody. Nor does a number the POST's signer cannot speak for: a
// channel's own App Secret vouches only for the numbers that store it
// (`phoneNumberIdsForSigner`).
//
// The relay deliberately has no parameter for Meta's
// `X-Hub-Signature-256` (D-1): it is never forwarded. Delivery is one
// attempt, best effort (D-7), and `relayMetaWebhook` never throws — it
// runs inside the webhook's `after()` and must not affect the 200 Meta
// already received.
//
// Logs carry only `account_id`, HTTP status and duration — never the
// body, the key or the full URL.
// ============================================================

import { randomUUID } from 'node:crypto';

import type { SupabaseClient } from '@supabase/supabase-js';

import { decrypt } from '@/lib/whatsapp/encryption';
import {
  signerCoversPhoneNumber,
  type MetaWebhookSigner,
} from '@/lib/whatsapp/webhook-signature';
import {
  SCHEMA_RETRY_MS,
  errMsg,
  isSchemaMissingError,
} from '@/lib/whatsapp/billing-schema';
import {
  MAX_CONSECUTIVE_FAILURES,
  postSignedPayload,
  type PostSignedResult,
} from '@/lib/webhooks/deliver';
import { readRelayDeliveryConfig } from '@/lib/webhooks/meta-relay-config';

/** `X-Wacrm-Event` of every relayed delivery. */
export const META_RELAY_EVENT = 'meta.webhook_raw';

// ============================================================
// Planning (pure)
// ============================================================

export type RelayPlan =
  /** The whole POST belongs to the account: send `rawBody` as received. */
  | { kind: 'raw' }
  /** Mixed POST: same envelope, reduced to the account's `changes`. */
  | { kind: 'filtered'; body: Record<string, unknown> };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `value.metadata.phone_number_id` of a `change`, or `null`. */
function phoneNumberIdOf(change: unknown): string | null {
  if (!isRecord(change)) return null;
  const value = change.value;
  if (!isRecord(value)) return null;
  const metadata = value.metadata;
  if (!isRecord(metadata)) return null;
  const id = metadata.phone_number_id;
  return typeof id === 'string' && id !== '' ? id : null;
}

/**
 * Every `phone_number_id` mentioned by the POST. Used to bound the
 * database lookups; never decides ownership by itself.
 */
export function collectPhoneNumberIds(body: unknown): string[] {
  const ids = new Set<string>();
  if (!isRecord(body) || !Array.isArray(body.entry)) return [];
  for (const entry of body.entry) {
    if (!isRecord(entry) || !Array.isArray(entry.changes)) continue;
    for (const change of entry.changes) {
      const id = phoneNumberIdOf(change);
      if (id) ids.add(id);
    }
  }
  return [...ids];
}

/**
 * What each account receives from one Meta POST.
 *
 * `owners` maps `phone_number_id` → `account_id` and must contain only
 * active numbers with a single `whatsapp_config` row. No I/O, never
 * throws: a body that is not a Meta envelope yields an empty map, and
 * an account that owns no `change` is absent from the result.
 *
 * `raw` is returned only when every `change` of the POST — and every
 * `entry` — is well-formed and belongs to that one account; in any
 * doubt the plan is `filtered`, which rebuilds the envelope from the
 * account's own `changes` only.
 */
export function planMetaRelay(
  body: unknown,
  owners: Map<string, string>
): Map<string, RelayPlan> {
  const plans = new Map<string, RelayPlan>();
  try {
    if (!isRecord(body) || !Array.isArray(body.entry)) return plans;

    // account → entry index → that account's changes (in order).
    const perAccount = new Map<string, Map<number, unknown[]>>();
    let totalChanges = 0;
    let wellFormed = true;

    body.entry.forEach((entry, entryIdx) => {
      if (!isRecord(entry) || !Array.isArray(entry.changes)) {
        wellFormed = false;
        return;
      }
      for (const change of entry.changes) {
        totalChanges += 1;
        if (!isRecord(change)) wellFormed = false;
        const pnid = phoneNumberIdOf(change);
        const accountId = pnid ? owners.get(pnid) : undefined;
        if (!accountId) continue;
        let entries = perAccount.get(accountId);
        if (!entries) {
          entries = new Map();
          perAccount.set(accountId, entries);
        }
        const list = entries.get(entryIdx);
        if (list) list.push(change);
        else entries.set(entryIdx, [change]);
      }
    });

    for (const [accountId, entries] of perAccount) {
      let ownedChanges = 0;
      for (const list of entries.values()) ownedChanges += list.length;

      if (wellFormed && ownedChanges === totalChanges) {
        plans.set(accountId, { kind: 'raw' });
        continue;
      }

      const filteredEntries: unknown[] = [];
      for (const [entryIdx, list] of entries) {
        filteredEntries.push({
          ...(body.entry[entryIdx] as Record<string, unknown>),
          changes: list,
        });
      }
      plans.set(accountId, {
        kind: 'filtered',
        body: { ...body, entry: filteredEntries },
      });
    }
  } catch {
    return new Map();
  }
  return plans;
}

// ============================================================
// Delivery
// ============================================================

/** One enabled relay, as `relayMetaWebhook` reads it. */
interface RelayRow {
  account_id: string;
  url: string;
  secret: string;
}

/**
 * The table exists only after migration 101. Code deployed before it
 * must stay inert: one warning per process, and the lookup is skipped
 * for `SCHEMA_RETRY_MS` instead of failing on every POST.
 */
let relaySchemaUnavailableUntil = 0;
let relaySchemaWarned = false;

function noteRelaySchemaMissing(error: unknown): boolean {
  if (!isSchemaMissingError(error)) return false;
  relaySchemaUnavailableUntil = Date.now() + SCHEMA_RETRY_MS;
  if (!relaySchemaWarned) {
    relaySchemaWarned = true;
    console.warn(
      '[meta-relay] meta_webhook_relays missing (migration 101 not applied?) — relay inert:',
      errMsg(error)
    );
  }
  return true;
}

/** Test hook: clears the per-process schema state. */
export function __resetMetaRelayStateForTests(): void {
  relaySchemaUnavailableUntil = 0;
  relaySchemaWarned = false;
}

/**
 * Resolve `phone_number_id` → `account_id` for the numbers in a POST:
 * exactly one `whatsapp_config` row, whose channel exists, belongs to the
 * same account and is not `disabled`. Anything else is left out
 * (fail-closed). Throws on a database error; the caller swallows it.
 */
async function resolveOwners(
  db: SupabaseClient,
  phoneNumberIds: string[]
): Promise<Map<string, string>> {
  const owners = new Map<string, string>();
  if (phoneNumberIds.length === 0) return owners;

  const { data: configs, error: configError } = await db
    .from('whatsapp_config')
    .select('account_id, channel_id, phone_number_id')
    .in('phone_number_id', phoneNumberIds);
  if (configError) throw new Error(`whatsapp_config: ${configError.message}`);

  const byNumber = new Map<
    string,
    { account_id: string; channel_id: string | null }[]
  >();
  for (const row of (configs ?? []) as {
    account_id: string;
    channel_id: string | null;
    phone_number_id: string;
  }[]) {
    const list = byNumber.get(row.phone_number_id) ?? [];
    list.push(row);
    byNumber.set(row.phone_number_id, list);
  }

  const channelIds = new Set<string>();
  for (const rows of byNumber.values()) {
    if (rows.length === 1 && rows[0].channel_id) {
      channelIds.add(rows[0].channel_id);
    }
  }
  if (channelIds.size === 0) return owners;

  const { data: channels, error: channelError } = await db
    .from('channels')
    .select('id, account_id, status')
    .in('id', [...channelIds]);
  if (channelError) throw new Error(`channels: ${channelError.message}`);

  const channelById = new Map<string, { account_id: string; status: string }>();
  for (const ch of (channels ?? []) as {
    id: string;
    account_id: string;
    status: string;
  }[]) {
    channelById.set(ch.id, ch);
  }

  for (const [pnid, rows] of byNumber) {
    if (rows.length !== 1) continue; // duplicated number → no owner
    const { account_id, channel_id } = rows[0];
    if (!channel_id) continue;
    const channel = channelById.get(channel_id);
    if (!channel || channel.account_id !== account_id) continue;
    if (channel.status === 'disabled') continue;
    owners.set(pnid, account_id);
  }
  return owners;
}

async function deliverRelay(
  db: SupabaseClient,
  relay: RelayRow,
  body: string
): Promise<void> {
  let result: PostSignedResult;
  let secretFailure = false;
  try {
    const secret = decrypt(relay.secret);
    result = await postSignedPayload({
      url: relay.url,
      secret,
      body,
      headers: {
        'X-Wacrm-Event': META_RELAY_EVENT,
        'X-Wacrm-Delivery-Id': randomUUID(),
      },
    });
  } catch {
    // Undecryptable key: it can never sign, so it counts as a failure
    // and eventually auto-disables, like a dead target.
    secretFailure = true;
    result = {
      ok: false,
      error: 'network',
      status: null,
      durationMs: 0,
      message: 'secret unavailable',
    };
  }

  if (result.ok) {
    const { error } = await db
      .from('meta_webhook_relays')
      .update({ failure_count: 0, last_delivery_at: new Date().toISOString() })
      .eq('account_id', relay.account_id)
      // Um sucesso tardio não zera o contador de quem acabou de ser
      // desligado (automática ou manualmente).
      .eq('is_enabled', true);
    if (error) {
      console.error(
        `[meta-relay] success bookkeeping failed account=${relay.account_id}:`,
        errMsg(error)
      );
    }
    return;
  }

  console.warn(
    `[meta-relay] delivery failed account=${relay.account_id} reason=${secretFailure ? 'secret' : result.error} status=${result.status ?? 'none'} duration_ms=${result.durationMs}`
  );
  const { error } = await db.rpc('record_meta_relay_failure', {
    p_account_id: relay.account_id,
    p_max_failures: MAX_CONSECUTIVE_FAILURES,
  });
  if (error) {
    console.error(
      `[meta-relay] record_meta_relay_failure failed account=${relay.account_id}:`,
      errMsg(error)
    );
  }
}

/**
 * The numbers of the POST that its signer may speak for. A channel's own
 * `app_secret` vouches only for the numbers that store that same secret:
 * any other number in the body gets no owner (fail-closed), so an admin
 * cannot sign with their own App Secret a `change` of another account's
 * number and have that account's relay forward it.
 */
export function phoneNumberIdsForSigner(
  body: unknown,
  signer: MetaWebhookSigner
): string[] {
  return collectPhoneNumberIds(body).filter((id) =>
    signerCoversPhoneNumber(signer, id)
  );
}

/**
 * Relay one Meta POST to every account that has the relay enabled and
 * owns at least one `change` of it. `rawBody` is the exact string the
 * route read with `request.text()`; `body` its parsed form; `signer`
 * which App Secret validated it (see `phoneNumberIdsForSigner`). Never
 * throws.
 */
export async function relayMetaWebhook(
  db: SupabaseClient,
  input: { rawBody: string; body: unknown; signer: MetaWebhookSigner }
): Promise<void> {
  try {
    if (Date.now() < relaySchemaUnavailableUntil) return;

    // Cost for accounts that do not use the relay: this one query.
    const { data: relays, error: relaysError } = await db
      .from('meta_webhook_relays')
      .select('account_id, url, secret')
      .eq('is_enabled', true);
    if (relaysError) {
      if (!noteRelaySchemaMissing(relaysError)) {
        console.error('[meta-relay] relay lookup failed:', errMsg(relaysError));
      }
      return;
    }
    const enabled = (relays ?? []) as RelayRow[];
    if (enabled.length === 0) return;

    const owners = await resolveOwners(
      db,
      phoneNumberIdsForSigner(input.body, input.signer)
    );
    const plans = planMetaRelay(input.body, owners);

    const jobs: Promise<void>[] = [];
    for (const relay of enabled) {
      const plan = plans.get(relay.account_id);
      if (!plan) continue;
      const body =
        plan.kind === 'raw' ? input.rawBody : JSON.stringify(plan.body);
      jobs.push(deliverRelay(db, relay, body));
    }
    await Promise.allSettled(jobs);
  } catch (error) {
    console.error('[meta-relay] relay failed:', errMsg(error));
  }
}

// ============================================================
// Connectivity test (§5.3)
// ============================================================

/**
 * Sample payload for the connectivity test: a text-message webhook in
 * Meta's shape (the `messages` change of the official v27 sample, see
 * `docs/references/example_webhook_whatsapp_meta_cloud_api.md`) with
 * obviously fake ids.
 */
export function buildRelayTestPayload(
  now: Date = new Date()
): Record<string, unknown> {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: '0',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: {
                display_phone_number: '0',
                phone_number_id: '0',
              },
              contacts: [
                {
                  profile: { name: 'ZAP CRM BR test' },
                  wa_id: '0',
                },
              ],
              messages: [
                {
                  id: 'wamid.TEST',
                  timestamp: String(Math.floor(now.getTime() / 1000)),
                  from: '0',
                  type: 'text',
                  text: {
                    body: 'This is a connectivity test from ZAP CRM BR.',
                  },
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

/** What the browser may learn about a connectivity test. Nothing else. */
export interface RelayTestResult {
  ok: boolean;
  status: number | null;
  duration_ms: number;
  error: 'timeout' | 'not_public' | 'http_error' | 'network' | null;
}

/**
 * Send the sample payload to the account's SAVED url with its saved key,
 * signed like a real delivery and marked `X-Wacrm-Test: true`. Works with
 * the relay switched off, never touches the counters, and never exposes
 * the target's response. `null` when the account has no saved config.
 * Never throws.
 */
export async function sendRelayTest(
  db: SupabaseClient,
  accountId: string
): Promise<RelayTestResult | null> {
  let config: { url: string; secret: string } | null;
  try {
    config = await readRelayDeliveryConfig(db, accountId);
  } catch (error) {
    console.error(
      `[meta-relay] test config unavailable account=${accountId}:`,
      errMsg(error)
    );
    return { ok: false, status: null, duration_ms: 0, error: 'network' };
  }
  if (!config) return null;

  const result = await postSignedPayload({
    url: config.url,
    secret: config.secret,
    body: JSON.stringify(buildRelayTestPayload()),
    headers: {
      'X-Wacrm-Event': META_RELAY_EVENT,
      'X-Wacrm-Delivery-Id': randomUUID(),
      'X-Wacrm-Test': 'true',
    },
  });

  if (result.ok) {
    return {
      ok: true,
      status: result.status,
      duration_ms: result.durationMs,
      error: null,
    };
  }
  return {
    ok: false,
    status: result.status,
    duration_ms: result.durationMs,
    error: result.error,
  };
}
