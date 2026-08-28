// ============================================================
// Outbound webhook event vocabulary — pure, no I/O.
//
// An endpoint subscribes to one or more of these. Adding an event is
// one entry here plus a `dispatchWebhookEvent` call at the source of
// the event (the DB stores subscriptions as a free `text[]`, so no
// migration is needed — same model as API scopes).
// ============================================================

export const WEBHOOK_EVENTS = [
  'message.received', // an inbound WhatsApp message landed
  'message.status_updated', // a sent message advanced (sent/delivered/read)
  'conversation.created', // a new conversation was opened for a contact
  // SPEC 062 §6.1, §8 — plan lifecycle. Dispatched through this same
  // account-scoped mechanism because the SPEC 063 SMTP/notification
  // outbox it was originally designed against doesn't exist yet
  // (sibling SPEC, not implemented) — an account only hears about
  // these once it registers an endpoint subscribed to them, same as
  // any other event here.
  'plan.changed', // self-service plan/cycle change applied immediately
  'plan.expiring', // current_period_end is 7 or 1 day(s) out
  'plan.expired', // current_period_end passed; account moved to past_due
  'plan.canceled', // self-service scheduled cancel_at_period_end = true
  'plan.cancel_reverted', // self-service reverted a scheduled cancellation
  'plan.canceled_applied', // a scheduled cancellation took effect at period end
  'plan.grace_ended', // the grace period after past_due ended (D-7: does not block)
  'plan.renewed', // POST /api/admin/accounts/{id}/billing/renew advanced the period
] as const;

export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

/** Human-readable descriptions (surfaced in docs / a future UI). */
export const WEBHOOK_EVENT_DESCRIPTIONS: Record<WebhookEvent, string> = {
  'message.received': 'An inbound message was received from a contact',
  'message.status_updated':
    'A message you sent changed delivery status (sent/delivered/read/failed)',
  'conversation.created': 'A new conversation was opened',
  'plan.changed': 'The account self-service changed its plan or billing cycle',
  'plan.expiring': "The account's plan is about to expire (7 or 1 day out)",
  'plan.expired': "The account's plan expired and moved to past_due",
  'plan.canceled': 'The account scheduled its plan to cancel at period end',
  'plan.cancel_reverted': 'The account reverted a scheduled cancellation',
  'plan.canceled_applied':
    'A scheduled plan cancellation took effect at period end',
  'plan.grace_ended':
    'The past_due grace period ended (access is not revoked by this alone)',
  'plan.renewed': 'An external payment renewed the account plan period',
};

/** Type-narrow an unknown value into a valid `WebhookEvent`. */
export function isWebhookEvent(value: unknown): value is WebhookEvent {
  return (
    typeof value === 'string' &&
    (WEBHOOK_EVENTS as readonly string[]).includes(value)
  );
}

/**
 * Validate + de-duplicate a caller-supplied event list. Returns the
 * cleaned list, or `null` if any entry is unknown (callers turn that
 * into a 400). An empty list is rejected as `null` too — an endpoint
 * subscribed to nothing is almost certainly a mistake.
 */
export function normalizeEvents(input: unknown): WebhookEvent[] | null {
  if (!Array.isArray(input) || input.length === 0) return null;
  const out: WebhookEvent[] = [];
  for (const entry of input) {
    if (!isWebhookEvent(entry)) return null;
    if (!out.includes(entry)) out.push(entry);
  }
  return out;
}
