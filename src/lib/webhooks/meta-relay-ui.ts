// ============================================================
// Meta webhook relay — pure helpers for the settings card (SPEC 088 §6).
//
// The non-trivial decisions of the card live here, not in the component,
// so they are testable without a browser: dirty-state, which buttons are
// enabled, how a test result and an API error are presented.
// Client-safe: imports only types (nothing from `deliver.ts` or the db).
// ============================================================

import type { ApiMetaRelay } from './meta-relay-config';

/** Mirror of `MAX_CONSECUTIVE_FAILURES` (deliver.ts, server-only). A test
 *  asserts they are equal. */
export const RELAY_AUTO_DISABLE_AFTER = 15;

/** A channel as the card needs it. */
export interface RelayChannelLike {
  type: string;
  status: string;
}

/**
 * Whether the account has at least one Cloud API number the relay can
 * forward events from (an active, non-disabled `whatsapp_cloud` channel).
 * Drives the "no official number" hint.
 */
export function hasOfficialChannel(
  channels: readonly RelayChannelLike[]
): boolean {
  return channels.some(
    (c) => c.type === 'whatsapp_cloud' && c.status !== 'disabled'
  );
}

export interface RelayDraft {
  url: string;
  isEnabled: boolean;
}

export interface RelayFormState {
  /** The form differs from what is saved (or nothing is saved yet). */
  dirty: boolean;
  /** The switch can be flipped: a URL has to be saved first. */
  canToggle: boolean;
  /** "Test connection" works only on the SAVED URL, without pending edits. */
  canTest: boolean;
  /** Save needs a non-empty URL and something to save. */
  canSave: boolean;
}

export function relayFormState(
  saved: ApiMetaRelay | null,
  draft: RelayDraft
): RelayFormState {
  const url = draft.url.trim();
  const dirty = saved
    ? saved.url !== url || saved.is_enabled !== draft.isEnabled
    : url !== '' || draft.isEnabled;
  return {
    dirty,
    canToggle: saved !== null,
    canTest: saved !== null && !dirty,
    canSave: url !== '' && dirty,
  };
}

/** The relay turned itself off after too many failures in a row. */
export function wasAutoDisabled(relay: ApiMetaRelay | null): boolean {
  return Boolean(relay && !relay.is_enabled && relay.auto_disabled_at);
}

export type RelayTestView =
  | { kind: 'connected'; status: number; durationMs: number }
  | {
      kind: 'failed';
      reason: 'timeout' | 'not_public' | 'http_error' | 'network';
      status: number | null;
    };

/** Shape of `POST /api/account/meta-relay/test`. */
export interface RelayTestResponse {
  ok: boolean;
  status: number | null;
  duration_ms: number;
  error: 'timeout' | 'not_public' | 'http_error' | 'network' | null;
}

export function toTestView(result: RelayTestResponse): RelayTestView {
  if (result.ok && result.status !== null) {
    return {
      kind: 'connected',
      status: result.status,
      durationMs: Math.round(result.duration_ms),
    };
  }
  return {
    kind: 'failed',
    reason: result.error ?? 'network',
    status: result.status,
  };
}

/**
 * Map an API error (always English, for integrations) to a translation
 * key of the card. `null` means "no specific key: show the generic one".
 */
export function relayApiErrorKey(
  httpStatus: number,
  message: unknown
): 'invalidUrl' | 'urlNotPublic' | 'rateLimited' | null {
  const text = typeof message === 'string' ? message : '';
  if (httpStatus === 429) return 'rateLimited';
  if (httpStatus === 400 && text.includes('public host')) return 'urlNotPublic';
  if (httpStatus === 400 && text.includes("'url'")) return 'invalidUrl';
  return null;
}
