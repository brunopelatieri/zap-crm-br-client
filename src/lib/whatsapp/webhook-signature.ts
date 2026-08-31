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
  const secrets = [
    ...(process.env.META_APP_SECRET ? [process.env.META_APP_SECRET] : []),
    ...extraSecrets,
  ];
  if (secrets.length === 0) {
    console.error(
      '[webhook] No App Secret configured (META_APP_SECRET env var, ' +
        'nor any channel app_secret) — rejecting request. Configure at ' +
        'least one (Meta → App Settings → Basic → App Secret) to enable ' +
        'signature verification.'
    );
    return false;
  }

  if (!signatureHeader) return false;
  if (!signatureHeader.startsWith('sha256=')) return false;

  const b = Buffer.from(signatureHeader);
  for (const secret of secrets) {
    const expected =
      'sha256=' +
      crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
    const a = Buffer.from(expected);
    // Bail if lengths differ — timingSafeEqual throws otherwise.
    if (a.length !== b.length) continue;
    if (crypto.timingSafeEqual(a, b)) return true;
  }
  return false;
}

/**
 * Every channel-specific App Secret on file, decrypted — the
 * `extraSecrets` argument for `verifyMetaWebhookSignature` above.
 *
 * Read failures and undecryptable rows are skipped rather than thrown:
 * one broken row (wrong `ENCRYPTION_KEY` generation, malformed cipher
 * text) must not take down signature verification for every OTHER
 * channel's webhook — that would turn "one bad row" into "no inbound
 * messages anywhere," strictly worse than the gap this migration
 * closes.
 */
export async function resolveWebhookAppSecrets(
  db: SupabaseClient
): Promise<string[]> {
  // Filtra no banco, não em JS: esta consulta roda em TODO POST de
  // webhook (inclusive não-autenticado, antes da assinatura ser
  // validada) — `.not(...)` evita trazer e decriptar linhas que o loop
  // ia descartar de qualquer forma.
  const { data, error } = await db
    .from('whatsapp_config')
    .select('app_secret')
    .not('app_secret', 'is', null);

  if (error || !data) {
    console.error(
      '[webhook] failed to read channel app_secrets — falling back to META_APP_SECRET only:',
      error?.message
    );
    return [];
  }

  const secrets: string[] = [];
  for (const row of data as { app_secret: string | null }[]) {
    if (!row.app_secret) continue;
    try {
      secrets.push(decrypt(row.app_secret));
    } catch {
      // Malformed / wrong-key row — skip it and keep checking the rest.
    }
  }
  return secrets;
}
