// ============================================================
// Meta webhook relay — activity log entries (SPEC 088 D-10).
//
// Turning the relay on/off, changing the destination, rotating the key
// and removing it leave a trace in `account_activity_log`: the relay
// sends contact data outside the CRM.
//
// Privacy: the log never carries the full URL (paths and query strings
// often hold tokens) nor the key. The only thing recorded about the
// destination is its HOST, as the row label.
// ============================================================

import type { ActivityActionFor } from '@/lib/activity/types';

export type RelayActivityAction = Extract<
  ActivityActionFor<'webhook'>,
  `webhook.relay_${string}`
>;

/** Host of a URL (no scheme, port, path, query or credentials). */
export function relayHost(url: string): string | null {
  try {
    return new URL(url).hostname || null;
  } catch {
    return null;
  }
}

interface RelayState {
  url: string;
  is_enabled: boolean;
}

/**
 * Which activity entries a save produces. `prev` is `null` on the first
 * save. Changing the URL and flipping the switch in one save yield two
 * entries; a save that changes neither yields none.
 *
 * First save: with the relay on it is one `relay_enabled`; saved off it
 * is one `relay_url_changed` (a destination was set).
 */
export function planRelaySaveActivity(
  prev: RelayState | null,
  next: RelayState
): RelayActivityAction[] {
  if (!prev) {
    return [
      next.is_enabled ? 'webhook.relay_enabled' : 'webhook.relay_url_changed',
    ];
  }
  const actions: RelayActivityAction[] = [];
  if (prev.url !== next.url) actions.push('webhook.relay_url_changed');
  if (prev.is_enabled !== next.is_enabled) {
    actions.push(
      next.is_enabled ? 'webhook.relay_enabled' : 'webhook.relay_disabled'
    );
  }
  return actions;
}
