// ============================================================
// Meta webhook relay — per-account configuration (SPEC 088).
//
// One row per account in `meta_webhook_relays`. The table has RLS on and
// NO policy on purpose: only the server (service_role) reads or writes
// it, so every function here takes the db client as a parameter and the
// caller (a route handler that already validated the role) passes the
// admin client. Nothing here imports `admin.ts`.
//
// The signing key is stored AES-256-GCM-encrypted (`encryption.ts`),
// returned in plaintext exactly once (creation / rotation) and never
// included in the columns the UI can read.
// ============================================================

import { randomBytes } from 'node:crypto';

import type { SupabaseClient } from '@supabase/supabase-js';

import { decrypt, encrypt } from '@/lib/whatsapp/encryption';

/** Key prefix — self-identifying, like `whsec_` for outbound webhooks. */
export const META_RELAY_SECRET_PREFIX = 'whrelay_';

/**
 * Columns safe to return to the browser: everything except `secret`.
 * Never select `*` from this table in a path that reaches the UI.
 */
export const META_RELAY_PUBLIC_COLUMNS =
  'url, is_enabled, failure_count, last_delivery_at, last_failure_at, auto_disabled_at, updated_at';

export interface ApiMetaRelay {
  url: string;
  is_enabled: boolean;
  failure_count: number;
  last_delivery_at: string | null;
  last_failure_at: string | null;
  auto_disabled_at: string | null;
  updated_at: string;
}

/** Generate a fresh signing key (full-entropy, header-safe). */
export function generateRelaySecret(): string {
  return `${META_RELAY_SECRET_PREFIX}${randomBytes(32).toString('base64url')}`;
}

/**
 * Project a row into the UI shape. Built field by field (never a
 * spread) so a stray `secret` in the input cannot leak through.
 */
export function serializeMetaRelay(row: Record<string, unknown>): ApiMetaRelay {
  return {
    url: row.url as string,
    is_enabled: Boolean(row.is_enabled),
    failure_count: (row.failure_count as number | null) ?? 0,
    last_delivery_at: (row.last_delivery_at as string | null) ?? null,
    last_failure_at: (row.last_failure_at as string | null) ?? null,
    auto_disabled_at: (row.auto_disabled_at as string | null) ?? null,
    updated_at: row.updated_at as string,
  };
}

/** The saved config for the account, or `null` when none exists. */
export async function readRelayConfig(
  db: SupabaseClient,
  accountId: string
): Promise<ApiMetaRelay | null> {
  const { data, error } = await db
    .from('meta_webhook_relays')
    .select(META_RELAY_PUBLIC_COLUMNS)
    .eq('account_id', accountId)
    .maybeSingle();
  if (error) throw new Error(`meta relay read failed: ${error.message}`);
  return data ? serializeMetaRelay(data as Record<string, unknown>) : null;
}

/**
 * Saved URL + decrypted key, for delivery only (connectivity test).
 * `null` when there is no config. Throws if the stored key cannot be
 * decrypted. The result must never reach the browser.
 */
export async function readRelayDeliveryConfig(
  db: SupabaseClient,
  accountId: string
): Promise<{ url: string; secret: string } | null> {
  const { data, error } = await db
    .from('meta_webhook_relays')
    .select('url, secret')
    .eq('account_id', accountId)
    .maybeSingle();
  if (error) throw new Error(`meta relay read failed: ${error.message}`);
  if (!data) return null;
  const row = data as { url: string; secret: string };
  return { url: row.url, secret: decrypt(row.secret) };
}

export interface SaveRelayInput {
  url: string;
  isEnabled: boolean;
  /** `auth.users.id` of the admin saving; stored in `updated_by`. */
  userId: string | null;
}

export interface SaveRelayResult {
  relay: ApiMetaRelay;
  /** Plaintext key — present ONLY when the row was just created. */
  secret?: string;
}

/**
 * Create or update the account's config. On creation a key is generated
 * and returned once. Turning the relay back on (or changing the URL)
 * clears the failure streak and the auto-disable marker.
 */
export async function saveRelayConfig(
  db: SupabaseClient,
  accountId: string,
  input: SaveRelayInput,
  /** Internal: one retry when a concurrent first save won the insert. */
  retried = false
): Promise<SaveRelayResult> {
  const now = new Date().toISOString();

  const { data: existing, error: readError } = await db
    .from('meta_webhook_relays')
    .select('url, is_enabled')
    .eq('account_id', accountId)
    .maybeSingle();
  if (readError) {
    throw new Error(`meta relay read failed: ${readError.message}`);
  }

  if (!existing) {
    const secret = generateRelaySecret();
    const { data, error } = await db
      .from('meta_webhook_relays')
      .insert({
        account_id: accountId,
        url: input.url,
        secret: encrypt(secret),
        is_enabled: input.isEnabled,
        updated_by: input.userId,
        updated_at: now,
      })
      .select(META_RELAY_PUBLIC_COLUMNS)
      .single();
    if (error?.code === '23505' && !retried) {
      // A concurrent first save created the row: apply ours as an update.
      return saveRelayConfig(db, accountId, input, true);
    }
    if (error || !data) {
      throw new Error(
        `meta relay create failed: ${error?.message ?? 'no row'}`
      );
    }
    return {
      relay: serializeMetaRelay(data as Record<string, unknown>),
      secret,
    };
  }

  const prev = existing as { url: string; is_enabled: boolean };
  const patch: Record<string, unknown> = {
    url: input.url,
    is_enabled: input.isEnabled,
    updated_by: input.userId,
    updated_at: now,
  };
  if (input.isEnabled && (!prev.is_enabled || prev.url !== input.url)) {
    patch.failure_count = 0;
    patch.auto_disabled_at = null;
  }

  const { data, error } = await db
    .from('meta_webhook_relays')
    .update(patch)
    .eq('account_id', accountId)
    .select(META_RELAY_PUBLIC_COLUMNS)
    .maybeSingle();
  if (error) throw new Error(`meta relay update failed: ${error.message}`);
  if (!data) throw new Error('meta relay update failed: row vanished');
  return { relay: serializeMetaRelay(data as Record<string, unknown>) };
}

/**
 * Replace the key; the previous one stops signing immediately. Returns
 * the new plaintext key once, or `null` when the account has no config.
 */
export async function rotateRelaySecret(
  db: SupabaseClient,
  accountId: string,
  userId: string | null
): Promise<string | null> {
  const secret = generateRelaySecret();
  const { data, error } = await db
    .from('meta_webhook_relays')
    .update({
      secret: encrypt(secret),
      updated_by: userId,
      updated_at: new Date().toISOString(),
    })
    .eq('account_id', accountId)
    .select('account_id');
  if (error) throw new Error(`meta relay rotate failed: ${error.message}`);
  if (!data || data.length === 0) return null;
  return secret;
}

/** Remove the account's config (URL and key). `true` if a row existed. */
export async function deleteRelayConfig(
  db: SupabaseClient,
  accountId: string
): Promise<boolean> {
  const { data, error } = await db
    .from('meta_webhook_relays')
    .delete()
    .eq('account_id', accountId)
    .select('account_id');
  if (error) throw new Error(`meta relay delete failed: ${error.message}`);
  return Boolean(data && data.length > 0);
}
