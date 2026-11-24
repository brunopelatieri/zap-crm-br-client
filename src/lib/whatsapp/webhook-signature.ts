import crypto from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { decrypt } from '@/lib/whatsapp/encryption';

/**
 * Verify the HMAC-SHA256 signature Meta attaches to webhook POSTs.
 *
 * Meta signs the raw request body with your App Secret and sends the
 * result in the `x-hub-signature-256: sha256=<hex>` header. Without
 * verification, anyone who knows our webhook URL can POST fabricated
 * status updates and drift broadcast counts arbitrarily.
 *
 * Reference:
 *   https://developers.facebook.com/docs/graph-api/webhooks/getting-started#verify-payloads
 *
 * Contract:
 *   `META_APP_SECRET` is the account's default App Secret; if it's
 *   missing AND no `extraSecrets` are given, we fail closed — every
 *   request is rejected until the operator configures a secret. A
 *   previous version fell open with a warning log, which is unsafe for
 *   a public template: anyone who forgets the env var would be running
 *   a fully spoofable webhook.
 *
 * `extraSecrets` (SPEC 064 gap, migration 073)
 *
 *   A second official number can be connected under a DIFFERENT Meta
 *   App (own WABA, own credentials) — and each Meta App signs its
 *   webhooks with its OWN App Secret. A single `META_APP_SECRET`
 *   verifies only the default App; every event from the other App
 *   fails this check and is rejected with 401, even though Meta
 *   delivered it correctly (confirmed in production: `[webhook]
 *   rejected request with invalid signature` at the exact moment of
 *   each test message — the number LOOKED fully connected because
 *   `/register` + `/subscribed_apps` both succeed independently of
 *   this check). `resolveWebhookAppSecrets` below collects one
 *   candidate per channel that has its own `app_secret` on file;
 *   passing them here means ANY of them (plus the env var) can
 *   validate the request — same "any config wins" shape as the
 *   `verify_token` loop in the GET handler.
 */
export function verifyMetaWebhookSignature(
  rawBody: string,
  signatureHeader: string | null,
  extraSecrets: string[] = []
): boolean {
  return (
    verifyMetaWebhookSigner(
      rawBody,
      signatureHeader,
      extraSecrets.map((secret) => ({ secret, phoneNumberId: null }))
    ) !== null
  );
}

/** One channel's own App Secret (migration 073), with the number it serves. */
export interface ChannelAppSecret {
  secret: string;
  phoneNumberId: string | null;
}

/**
 * WHICH secret validated a webhook POST — and so which numbers that POST
 * may speak for (security review of SPEC 088, finding 1).
 *
 * - `default`: `META_APP_SECRET`, the operator's own App. Trusted for
 *   every number, as before.
 * - `channels`: a channel's `app_secret`. Any account admin can store
 *   one (it is not validated against Meta), so it only vouches for the
 *   numbers whose `whatsapp_config` holds that SAME secret — never for
 *   another account's number. Without this, admin A signs a POST with
 *   A's own secret carrying B's `phone_number_id` and it passes.
 */
export type MetaWebhookSigner =
  | { kind: 'default' }
  | { kind: 'channels'; phoneNumberIds: ReadonlySet<string> };

/**
 * Shape of the header Meta sends: `sha256=` + 64 lowercase hex digits.
 * Uppercase (prefix or digits) is refused on purpose — the comparison in
 * `signatureMatches` was always against the lowercase digest, so such a
 * header never validated anyway.
 */
const SIGNATURE_HEADER_PATTERN = /^sha256=[0-9a-f]{64}$/;

/**
 * Could this header validate at all? Cheap gate for the route to refuse
 * an anonymous POST BEFORE reading the body or touching the database
 * (finding M-1 of the SPEC 088 security review).
 */
export function isMetaSignatureHeader(
  signatureHeader: string | null
): signatureHeader is string {
  return (
    signatureHeader !== null && SIGNATURE_HEADER_PATTERN.test(signatureHeader)
  );
}

function signatureMatches(
  rawBody: string,
  signatureHeader: string,
  secret: string
): boolean {
  const expected =
    'sha256=' +
    crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(signatureHeader);
  // Bail if lengths differ — timingSafeEqual throws otherwise.
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * What the webhook route uses: `META_APP_SECRET` is tried first and, when
 * it validates, `loadChannelSecrets` is NEVER called — no query and no
 * decryption (finding M-1). Only a POST the env secret did not sign pays
 * for the channel secrets. Same verdict as `verifyMetaWebhookSigner` with
 * every secret loaded upfront.
 */
export async function resolveMetaWebhookSigner(
  rawBody: string,
  signatureHeader: string | null,
  loadChannelSecrets: () => Promise<ChannelAppSecret[]>
): Promise<MetaWebhookSigner | null> {
  if (!isMetaSignatureHeader(signatureHeader)) return null;
  return (
    matchDefaultSigner(rawBody, signatureHeader) ??
    matchChannelSigner(rawBody, signatureHeader, await loadChannelSecrets())
  );
}

/**
 * Same check as `verifyMetaWebhookSignature`, but says which secret
 * matched: `null` when none did. The env secret is tried first, so a
 * channel that stored the default App's secret is still `default`.
 */
export function verifyMetaWebhookSigner(
  rawBody: string,
  signatureHeader: string | null,
  channelSecrets: ChannelAppSecret[] = []
): MetaWebhookSigner | null {
  return (
    matchDefaultSigner(rawBody, signatureHeader) ??
    matchChannelSigner(rawBody, signatureHeader, channelSecrets)
  );
}

/** Env half of the check. An empty `META_APP_SECRET` never validates. */
function matchDefaultSigner(
  rawBody: string,
  signatureHeader: string | null
): MetaWebhookSigner | null {
  const envSecret = process.env.META_APP_SECRET;
  if (!envSecret || !isMetaSignatureHeader(signatureHeader)) return null;
  return signatureMatches(rawBody, signatureHeader, envSecret)
    ? { kind: 'default' }
    : null;
}

/** Channel half of the check, once the env secret did not validate. */
function matchChannelSigner(
  rawBody: string,
  signatureHeader: string | null,
  channelSecrets: ChannelAppSecret[]
): MetaWebhookSigner | null {
  // Distinct channel secrets → the numbers each one is on file for.
  const numbersBySecret = new Map<string, Set<string>>();
  for (const { secret, phoneNumberId } of channelSecrets) {
    if (!secret) continue;
    const numbers = numbersBySecret.get(secret) ?? new Set<string>();
    if (phoneNumberId) numbers.add(phoneNumberId);
    numbersBySecret.set(secret, numbers);
  }

  if (!process.env.META_APP_SECRET && numbersBySecret.size === 0) {
    console.error(
      '[webhook] No App Secret configured (META_APP_SECRET env var, ' +
        'nor any channel app_secret) — rejecting request. Configure at ' +
        'least one (Meta → App Settings → Basic → App Secret) to enable ' +
        'signature verification.'
    );
    return null;
  }

  if (!isMetaSignatureHeader(signatureHeader)) return null;

  for (const [secret, phoneNumberIds] of numbersBySecret) {
    if (signatureMatches(rawBody, signatureHeader, secret)) {
      return { kind: 'channels', phoneNumberIds };
    }
  }
  return null;
}

/**
 * May a POST validated by `signer` speak for `phoneNumberId`? The env
 * secret covers every number — and a `change` without a number, as
 * before. A channel secret covers only the numbers that store that same
 * secret; a `change` without a number is never covered (fail-closed).
 * Shared by the relay (`phoneNumberIdsForSigner`) and the ingest.
 */
export function signerCoversPhoneNumber(
  signer: MetaWebhookSigner,
  phoneNumberId: string | null | undefined
): boolean {
  if (signer.kind === 'default') return true;
  return (
    typeof phoneNumberId === 'string' &&
    phoneNumberId !== '' &&
    signer.phoneNumberIds.has(phoneNumberId)
  );
}

/**
 * Accounts a POST validated by `signer` may speak for, for the events
 * that carry no `phone_number_id` (template lifecycle). `null` = no
 * restriction (env secret, as before). For a channel secret: the
 * accounts owning the numbers that store it — empty on a read failure
 * (fail-closed), so admin A can never touch account B's templates.
 */
export async function accountIdsForSigner(
  db: SupabaseClient,
  signer: MetaWebhookSigner
): Promise<string[] | null> {
  if (signer.kind === 'default') return null;
  const numbers = [...signer.phoneNumberIds];
  if (numbers.length === 0) return [];
  let data: unknown[] | null = null;
  let errorMessage: string | undefined;
  try {
    const res = await db
      .from('whatsapp_config')
      .select('account_id')
      .in('phone_number_id', numbers);
    data = res.data;
    errorMessage = res.error?.message;
  } catch (err) {
    // Nunca rejeita: o chamador memoriza esta promessa, e uma rejeição
    // abortaria os demais `changes` do POST.
    errorMessage = err instanceof Error ? err.message : String(err);
  }
  if (errorMessage !== undefined || !data) {
    console.error(
      '[webhook] failed to resolve the accounts of the signing App Secret:',
      errorMessage
    );
    return [];
  }
  const accounts = new Set<string>();
  for (const row of data as { account_id?: unknown }[]) {
    if (typeof row.account_id === 'string' && row.account_id) {
      accounts.add(row.account_id);
    }
  }
  return [...accounts];
}

/**
 * Every channel-specific App Secret on file, decrypted — the
 * `extraSecrets` argument for `verifyMetaWebhookSignature` above.
 */
export async function resolveWebhookAppSecrets(
  db: SupabaseClient
): Promise<string[]> {
  return (await resolveWebhookChannelSecrets(db)).map((c) => c.secret);
}

/**
 * Every channel-specific App Secret on file, decrypted, with the
 * `phone_number_id` of its channel — the input of
 * `verifyMetaWebhookSigner`.
 *
 * Read failures and undecryptable rows are skipped rather than thrown:
 * one broken row (wrong `ENCRYPTION_KEY` generation, malformed cipher
 * text) must not take down signature verification for every OTHER
 * channel's webhook — that would turn "one bad row" into "no inbound
 * messages anywhere," strictly worse than the gap this migration
 * closes.
 */
export async function resolveWebhookChannelSecrets(
  db: SupabaseClient
): Promise<ChannelAppSecret[]> {
  // Filtra no banco, não em JS: esta consulta roda em todo POST que o
  // `META_APP_SECRET` não validou (inclusive não-autenticado, com
  // cabeçalho bem formado e falso) — `.not(...)` evita trazer e decriptar
  // linhas que o loop ia descartar de qualquer forma.
  const { data, error } = await db
    .from('whatsapp_config')
    .select('app_secret, phone_number_id')
    .not('app_secret', 'is', null);

  if (error || !data) {
    console.error(
      '[webhook] failed to read channel app_secrets — falling back to META_APP_SECRET only:',
      error?.message
    );
    return [];
  }

  const secrets: ChannelAppSecret[] = [];
  for (const row of data as {
    app_secret: string | null;
    phone_number_id?: string | null;
  }[]) {
    if (!row.app_secret) continue;
    try {
      secrets.push({
        secret: decrypt(row.app_secret),
        phoneNumberId:
          typeof row.phone_number_id === 'string' && row.phone_number_id
            ? row.phone_number_id
            : null,
      });
    } catch {
      // Malformed / wrong-key row — skip it and keep checking the rest.
    }
  }
  return secrets;
}
