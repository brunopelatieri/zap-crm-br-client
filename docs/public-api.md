# Public API (`/api/v1`)

The public API lets you drive your wacrm instance from your own
scripts and automations — send messages, manage contacts, launch
broadcasts — without going through the dashboard UI.

> **Status:** stable. Authentication, scopes, rate limiting, the
> messages / contacts / conversations / broadcasts endpoints, the
> inbound [ingest webhook](#post-apiv1ingestcontact) (SPEC 055), and
> outbound event [webhooks](#webhooks) all ship now. `GET /api/v1/me`'s
> `plan` block also carries the subscription cycle and the
> `account_blocked` error code (SPEC 062, console do proprietário) — see
> [Response envelope](#response-envelope) and [`GET /api/v1/me`](#get-apiv1me).

> **This document is the source of truth for the API contract.** It is
> meant to be read by three audiences: external integrators, an LLM
> working on this codebase, and whoever maintains the `openapi.json`
> consumed by the separate Scalar-based API-reference project — every
> request/response shape, status code, and error code below should be
> precise enough to transcribe directly into an OpenAPI schema. If you
> change a route's behavior, update this file in the same change.
>
> The generated spec lives at [`public/openapi.json`](../public/openapi.json)
> (served at `/openapi.json` once deployed) — point the Scalar project's
> `<script data-url="…">` or config at that URL. It validates clean under
> `npx @redocly/cli lint` and Scalar's own `@scalar/openapi-parser`; run
> both after regenerating it.
>
> **There is also a pt-BR mirror:**
> [`public/openapi.pt-BR.json`](../public/openapi.pt-BR.json) (served at
> `/openapi.pt-BR.json`) — same paths, operations, schemas, and property
> names (the wire contract doesn't translate), with every human-facing
> `summary`/`description`/tag description translated. **Any change to
> `/api/v1/**` — a new endpoint, a changed field, a removed one — updates
> `docs/public-api.md`, `public/openapi.json`, AND
> `public/openapi.pt-BR.json` in the same change.** This is a standing
> rule, restated in `AGENTS.md`, not a one-off for this section.
>
> Related but separate interface: an **MCP server**
> (`mcp-server/`, see [docs/mcp.md](./mcp.md)) lets AI assistants drive
> the CRM directly. It is not part of `/api/v1` (different protocol,
> not REST) and is out of scope for this document and for the
> `openapi.json` it feeds.

## Authentication

Every request authenticates with an **API key**, sent as a bearer
token:

```
Authorization: Bearer wacrm_live_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

Keys are **account-scoped**: a key acts on exactly one account, the
one it was created in. There is no cross-account access.

### Creating a key

In the dashboard: **Settings → API keys → New API key**. Only
**admins and owners** can create keys.

1. Give the key a name (after the integration that will use it).
2. Grant the **scopes** it needs — nothing more (see below).
3. Copy the key. **The full key is shown exactly once.** wacrm
   stores only a SHA-256 hash, so it can never be shown again. If you
   lose it, revoke it and create a new one.

### Revoking a key

**Settings → API keys → Revoke.** Revocation is effective on the
key's next request. Revoked keys stay in the list as an audit trail.

## Scopes

A key can do only what its scopes allow — independent of who created
it. Grant the minimum.

| Scope                | Allows                                |
| -------------------- | ------------------------------------- |
| `messages:send`      | Send WhatsApp messages                |
| `messages:read`      | Read messages and delivery status     |
| `contacts:read`      | List and read contacts                |
| `contacts:write`     | Create and update contacts            |
| `conversations:read` | List and read conversations           |
| `broadcasts:send`    | Launch broadcast campaigns            |
| `webhooks:manage`    | Register and manage outbound webhooks |
| `ingest:write`       | Create contacts from an inbound webhook (`POST /api/v1/ingest/contact`) |

A key with **no scopes** still authenticates and can call
`GET /api/v1/me` — useful for verifying a key works.

### Scope is the _account_, never a single agent

> **An API key sees every conversation and every message in the
> account — including threads assigned to other agents.** It is not
> equivalent to an agent user. Treat it as an administrator credential.

This deserves spelling out because the app itself behaves differently.
Inside the dashboard, an agent sees only the conversations assigned to
them plus the unassigned queue — that isolation is enforced per row by
Postgres RLS, which keys off the signed-in user (`auth.uid()`).

The public API authenticates with an **API key**, not a user session.
There is no signed-in user for RLS to reason about, so these endpoints
run with a service-role client scoped explicitly to your `account_id`.
Tenancy still holds — a key never reaches another account's data — but
per-agent assignment plays no part in what it returns.

Practical consequences:

- `GET /api/v1/conversations` lists the account's conversations,
  assigned or not.
- `GET /api/v1/conversations/{id}/messages` returns the full thread
  regardless of who owns it.
- `POST /api/v1/messages` can write into any conversation in the
  account.

So: handing a key to a third-party integrator gives them the whole
account's conversation history. If you need a narrower blast radius,
use scopes (`conversations:read` alone can't send, for instance) and
issue one key per integration so you can revoke it in isolation.

Per-agent key scoping is not implemented. If you need it, say so — it
would mean a new scope column on `api_keys` and a rework of these
handlers.

## Language of error messages

All `/api/**` responses (including this public API and internal app
routes) return **English** error strings by design. Integrations,
scripts, and logs consume a stable language; the dashboard UI maps
status codes / known error shapes to translated copy via `next-intl`
when showing failures to end users. Do not localize API payloads.

## Response envelope

Every response uses one of two shapes:

```jsonc
// success
{ "data": { /* ... */ } }

// failure
{ "error": { "code": "forbidden", "message": "This API key is missing the 'messages:send' scope" } }
```

Branch on `error.code` (stable); `error.message` is for humans and
may be reworded.

| Status | `code`         | Meaning                                               |
| ------ | -------------- | ----------------------------------------------------- |
| 401    | `unauthorized` | Missing / malformed / unknown / revoked / expired key |
| 403    | `forbidden`    | Valid key, but missing the required scope             |
| 429    | `rate_limited` | Per-key rate limit exceeded                           |
| 400    | `bad_request`  | Malformed input                                       |
| 404    | `not_found`    | No such resource                                      |
| 403    | `quota_exceeded` | Account plan quota reached (SPEC 059) — see below   |
| 403    | `account_blocked` | The account was blocked by the operator (SPEC 062) — see below |
| 500    | `internal`     | Server error                                          |

**`quota_exceeded`** only appears when the deployment has plan quotas
turned on (most self-hosted forks don't — see
[`docs/spec-059-motor-de-quotas.md`](./spec-059-motor-de-quotas.md)
D-1). `POST /api/v1/contacts` and `POST /api/v1/ingest/contact` are the
two endpoints that can return it, when the account's `contacts` quota
is already at its limit — check `usage` on `GET /api/v1/me` before a
bulk import to avoid it.

**`account_blocked`** can be returned by **any** endpoint, and it is the
one failure where the key itself is fine: it has not been revoked, it
has not expired, and its scopes are correct — the platform operator
blocked the account it belongs to. Distinguishing it from `forbidden`
matters precisely because an integration receiving `forbidden` will go
and check its scopes, and find nothing wrong with them.

Retrying will not help; the account has to be unblocked by whoever runs
the server. Messages *received* on the blocked account's WhatsApp
number keep arriving and nothing is deleted — only outbound action and
API access stop.

## Rate limits

Requests are limited **per key**: **120 requests per minute**. On a
`429`, these headers tell you when to retry:

- `Retry-After` — seconds until the window resets
- `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`

> The limiter is in-memory and **per process**. A single-instance
> deploy (the common case for a self-hosted fork) is fine as-is. If
> you scale to multiple instances, swap the limiter for a shared
> store (Redis/Upstash) — see the note at the top of
> `src/lib/rate-limit.ts`. The limit is otherwise unenforced across
> instances.

## Endpoints

### `GET /api/v1/me`

Returns the account a key is bound to and the scopes it carries.
Requires only a valid key (no scope). Use it to verify a key works
and to discover its scopes.

```bash
curl https://your-crm.example.com/api/v1/me \
  -H "Authorization: Bearer wacrm_live_xxx"
```

```json
{
  "data": {
    "account": { "id": "…", "name": "Acme Inc" },
    "key": { "id": "…", "scopes": ["messages:send"] },
    "plan": {
      "code": "professional",
      "name": "Profissional",
      "status": "active",
      "billingCycle": "monthly",
      "startedAt": "2026-08-01T00:00:00Z",
      "currentPeriodEnd": "2026-09-01T00:00:00Z",
      "cancelAtPeriodEnd": false
    },
    "usage": [
      { "key": "contacts", "used": 1847, "limit": 10000 },
      { "key": "channels_whatsapp_qr", "used": 1, "limit": 2 }
    ],
    "channels": [
      {
        "id": "…",
        "name": "Main Number",
        "type": "whatsapp_cloud",
        "status": "connected",
        "phone": "+14155550100"
      }
    ]
  }
}
```

`plan` and `usage` (SPEC 059) reflect the deployment's plan quotas.
`plan.billingCycle`, `startedAt`, `currentPeriodEnd` and
`cancelAtPeriodEnd` (SPEC 062) describe the subscription cycle — an
integration that provisions resources based on the plan should check
`currentPeriodEnd` before assuming access continues. `currentPeriodEnd`
is `null` when the plan doesn't expire (a free or custom plan);
`cancelAtPeriodEnd: true` means access is scheduled to drop to the
deployment's default plan at that date, but hasn't yet.
`usage` is an **empty array** when the deployment doesn't have quotas
turned on (D-1) — every `limit` is effectively unlimited, so there's
nothing meaningful to report. When quotas are on, `limit: null` on a
given entry still means that specific quota is unlimited for this
account's plan.

`channels` (SPEC 064) lists the account's active WhatsApp numbers —
useful for picking a `channel_id` to pass to `POST /api/v1/messages`
or `POST /api/v1/broadcasts` on an account with more than one official
number. **Only present when the key has `messages:send` or
`broadcasts:send`** — it includes phone numbers, so a key scoped only
to e.g. `contacts:read` doesn't get the field at all (not an empty
array). `phone` is `null` when the number hasn't been confirmed with
Meta yet — use the channel's `name` in the meantime.

### `POST /api/v1/messages`

Send a WhatsApp message to a phone number. Scope: `messages:send`. You
pass an **E.164 number**, not an internal id — the endpoint
finds-or-creates the contact + conversation, then sends.

```bash
curl -X POST https://your-crm.example.com/api/v1/messages \
  -H "Authorization: Bearer wacrm_live_xxx" \
  -H "Content-Type: application/json" \
  -d '{ "to": "+14155550123", "type": "text", "text": "Hi 👋" }'
```

`type` is `text` (default), `template`, `interactive`, or a media kind
(`image` / `video` / `document` / `audio`). Media needs `media_url` (and
optional `filename`); `text` doubles as the caption. `template` needs a
`template` object:

```jsonc
{
  "to": "+14155550123",
  "type": "template",
  "template": {
    "name": "order_update",
    "language": "en_US",
    "params": ["A123"], // positional body vars, or a structured object
  },
  "reply_to_message_id": "<uuid>", // optional; must be in the same conversation
  "channel_id": "<uuid>", // optional; picks which of the account's channels to send from
}
```

`channel_id` (SPEC 049 §5.4) is optional — omit it and the message goes out
on the account's default channel, same as before this field existed. Pass
it to target a specific channel (e.g. a QR code instance instead of
WhatsApp Oficial). `400 bad_request` if the id doesn't belong to this
account (never `404`, which would confirm the id exists) or if the channel
isn't `connected`; the message includes the channel's status. If the
message type isn't supported on the resolved channel (e.g. a template on a
QR instance), the request fails with `400 unsupported_by_channel`.

#### Interactive messages (`type: "interactive"`)

Reply buttons or a tap-to-expand list. `interactive_payload` is required and
is one of two shapes, keyed by `kind`:

```jsonc
// reply buttons — 1 to 3
{
  "to": "+14155550123",
  "type": "interactive",
  "interactive_payload": {
    "kind": "buttons",
    "body": "How can we help?",       // required, ≤ 1024 chars
    "header": "Support",              // optional, ≤ 60 chars
    "footer": "Reply within minutes", // optional, ≤ 60 chars
    "buttons": [
      { "id": "track_order", "title": "Track order" }, // title ≤ 20 chars
      { "id": "talk_to_human", "title": "Talk to a human" }
    ]
  }
}

// list — 1 to 10 rows total, across up to 10 sections
{
  "to": "+14155550123",
  "type": "interactive",
  "interactive_payload": {
    "kind": "list",
    "body": "Pick a topic",
    "button_label": "Choose",          // required, ≤ 20 chars
    "sections": [
      {
        "title": "Billing",            // optional section header
        "rows": [
          { "id": "invoice", "title": "Get an invoice", "description": "PDF, sent by email" } // title ≤ 24, description ≤ 72 chars
        ]
      }
    ]
  }
}
```

Button ids and list row ids must be non-empty and unique within the
payload — they're echoed back in the inbound webhook/message when the
recipient taps one, so the automation reading that reply can branch on
`id`. A malformed payload (missing body, too many buttons/rows, a field
over its length limit, a duplicate id) is rejected with `400 bad_request`
before any Meta call is made.

Response (201):

```json
{
  "data": {
    "message_id": "…",
    "whatsapp_message_id": "wamid.…",
    "conversation_id": "…",
    "contact_id": "…",
    "contact_created": true
  }
}
```

Domain error codes beyond the table above:

| Code | Status | Meaning |
| --- | --- | --- |
| `whatsapp_not_configured` | 400 | The resolved channel has no working WhatsApp connection |
| `meta_error` | 502 | The request reached Meta and it rejected the send |
| `template_malformed` | 500 | The stored template shape can't be built into a send |
| `unsupported_by_channel` | 400 | The message type isn't supported on the resolved channel (e.g. a template on a QR instance) |
| `cold_send_limit` | 429 | Rate-limited re-engagement outside the messaging window — see below |
| `quota_exceeded` | 403 | Sending to a brand-new phone number would create a contact past the account's plan quota (SPEC 059) — only reachable when the deployment has plan quotas turned on |

**`cold_send_limit` (WhatsApp QRCode channels only).** WhatsApp Oficial
(Cloud API) tracks Meta's 24h customer-service window and falls back to
templates outside it, same as the dashboard. A **WhatsApp QRCode**
channel (Evolution) has no such window, so outbound-to-a-cold-contact is
throttled instead (SPEC 049 §6.2, D-1): a per-instance daily cap (lower
while the instance is still "warming up"), an hourly cap, and a minimum
interval between cold sends. Calling `/api/v1/messages` against a QR
channel outside these limits returns `429 cold_send_limit` with a
`Retry-After` header — **this path always blocks** the call. This is
stricter than the inbox: a human agent sending the same cold message from
the dashboard is only warned, never blocked, because stalling an agent
mid-conversation is worse than the marginal risk of one manual send; an
API caller that got a silent `200` would just keep sending.

### `GET /api/v1/contacts`

List contacts, newest first. Scope: `contacts:read`. Paginated (see
[Pagination](#pagination)). Optional filters: `?search=` (matches name
or phone) and `?tag=<tagId>`.

```json
{
  "data": [
    {
      "id": "…",
      "phone": "+14155550123",
      "name": "Jane Doe",
      "email": null,
      "company": "Acme",
      "avatar_url": null,
      "tags": [{ "id": "…", "name": "vip", "color": "#3b82f6" }],
      "created_at": "…",
      "updated_at": "…"
    }
  ],
  "meta": { "next_cursor": "…" }
}
```

### `POST /api/v1/contacts`

Create a contact. Scope: `contacts:write`. `phone` (E.164) is required;
`name`, `email`, `company`, and `tags` (an array of tag names, created
if missing) are optional. **Find-or-create by phone:** an existing
match returns `200` with the existing contact; a new contact returns
`201`. The response body is the serialized contact (same shape as the
list rows above).

On a deployment with plan quotas turned on (SPEC 059), creating a
contact past the account's `contacts` limit fails with
`403 quota_exceeded` instead of `201` — nothing is written. Finding an
existing contact by phone never hits the quota, since it doesn't
create anything.

### `GET` / `PATCH /api/v1/contacts/{id}`

Read or update one contact. Scopes: `contacts:read` / `contacts:write`.
`PATCH` updates only the fields you send (`name`, `email`, `company`);
pass `tags` (an array of tag names) to replace the contact's tags. A
contact in another account returns `404`.

### `GET /api/v1/conversations`

List conversations, newest first. Scope: `conversations:read`.
Paginated. Optional filters: `?status=` (`open` / `pending` / `closed`),
`?contact_id=`, and `?channel_id=` (SPEC 049 §5.4 — which of the
account's channels the conversation belongs to). Each conversation
embeds its contact + tags and includes `channel_id` in the response.

### `GET /api/v1/conversations/{id}`

Read one conversation. Scope: `conversations:read`. `404` if it belongs
to another account.

### `GET /api/v1/conversations/{id}/messages`

List a conversation's messages, newest first. Scope: `messages:read`.
Paginated. Each message includes its `direction` (`inbound` /
`outbound`), `status` (delivery state), `whatsapp_message_id`,
`content_*`, `is_favorite` (read-only — see the retention note below),
and `deleted_at` / `deletion_scope` / `deletion_actor` (read-only — see
the deletion note below). The conversation is verified to belong to
your account first (`404` otherwise).

**Message history can be pruned.** Accounts may configure a message
retention policy (per channel type) that periodically removes older
messages — a message an agent marked as a favorite is never removed by
that policy, which is what `is_favorite` reflects. An integration that
pages through this endpoint expecting an immutable, ever-growing
history should account for the total count going down between polls
instead of treating that as a bug on your end.

**A message can be marked as deleted.** An agent can delete a message
they sent (or the contact can delete one of their own from their
phone); the row stays in the history for the record instead of
disappearing. `deleted_at` is `null` unless that happened; when set,
`deletion_scope` says what the outcome was on the channel
(`revoked` — actually removed from the contact's device, WhatsApp
QRCode channel only; `not_supported` — the official Meta channel has no
delete-for-everyone endpoint, so only marked here; `revoke_failed` —
the QRCode channel's delete request was rejected) and `deletion_actor`
says who deleted it (`agent` or `contact`). There is no `DELETE`
endpoint on this API — deleting a message is only available from the
inbox UI. An admin can additionally purge a message from the system
entirely (not just mark it); a purged message stops appearing here at
all, the same as if it never existed.

### `POST /api/v1/broadcasts`

Launch a template broadcast to a list of recipients. Scope:
`broadcasts:send`. The broadcast + its recipient rows are persisted
immediately and the sends fan out in the background, so the call
returns fast — poll `GET /api/v1/broadcasts/{id}` for progress.

```bash
curl -X POST https://your-crm.example.com/api/v1/broadcasts \
  -H "Authorization: Bearer wacrm_live_xxx" \
  -H "Content-Type: application/json" \
  -d '{
        "name": "July promo",
        "template_name": "promo_july",
        "template_language": "en_US",
        "channel_id": "…",
        "recipients": [
          { "to": "+14155550123", "params": ["Jane"] },
          { "to": "+14155550124" }
        ]
      }'
```

Recipients are capped at **1000 per request** — split larger sends.
Invalid phone numbers are dropped and counted as `rejected`.

`channel_id` (SPEC 064, optional) picks which official number sends
this broadcast — see `channels` on [`GET /api/v1/me`](#get-apiv1me).
Omit it to use the account's default Cloud number; either way, the
number is resolved and **recorded** on the broadcast immediately, and
never changes later even if the account's default number changes
afterward.

**Template and channel must belong to the same WhatsApp Business
Account.** `template_name` is validated against the WABA of the
resolved `channel_id` (SPEC 065 D-3) *before* any recipient row is
created — Meta scopes templates per WABA, so a template approved on
one number doesn't exist on another. A mismatch fails the whole
request with `400 template_waba_mismatch` (nothing is created): pick a
template that belongs to the chosen channel's WABA, or send through
the number that has it.

The fan-out itself runs in the background after the response is sent, with
a soft 60-second budget — comfortable for a typical batch, but a request
near the 1000-recipient cap can exceed it. That's a best-effort bound, not
a guarantee: there is no durable retry queue yet (tracked in
[Roadmap](#roadmap)), so recipients still `pending` when the budget runs
out stay `pending` — `GET /api/v1/broadcasts/{id}` will show a count that
stalls short of `total_recipients` rather than resuming on its own. For
anything close to the cap, prefer splitting into a few smaller requests
over one call at the limit. Response (202):

```json
{
  "data": {
    "broadcast_id": "…",
    "channel_id": "…",
    "status": "sending",
    "total_recipients": 2,
    "accepted": 2,
    "rejected": 0
  }
}
```

### `GET /api/v1/broadcasts/{id}`

Broadcast status + counts. Scope: `broadcasts:send`. `status` moves
`sending` → `sent`; `delivered_count` / `read_count` keep climbing as
Meta delivery webhooks arrive. `404` for another account's broadcast.

```json
{
  "data": {
    "id": "…",
    "name": "July promo",
    "template_name": "promo_july",
    "template_language": "en_US",
    "channel_id": "…",
    "status": "sending",
    "total_recipients": 2,
    "sent_count": 1,
    "delivered_count": 1,
    "read_count": 0,
    "replied_count": 0,
    "failed_count": 0,
    "created_at": "…",
    "updated_at": "…"
  }
}
```

`status` is one of `scheduled` / `sending` / `sent` / `failed` —
`scheduled` only applies to a campaign created from the dashboard with a
future send time; every broadcast created through this endpoint starts
`sending` immediately (there is no scheduling parameter here).

`channel_id` is `null` on a broadcast created before multi-number
support (SPEC 064) shipped — it predates the column and was never
attributed to a specific number.

## Inbound webhook (ingest)

This is the **inverse** of the [outbound event webhooks](#webhooks)
below: instead of wacrm calling *you*, a third party (n8n, a landing
page, an e-commerce platform) calls **wacrm** to create a contact and
optionally launch a template — without going through the dashboard UI
or the CSV importer. If you're looking for wacrm notifying you about
events in your account, that's [Webhooks](#webhooks), a different
endpoint under a different scope.

### `POST /api/v1/ingest/contact`

Scope: `ingest:write`. Validates and normalizes the phone number,
creates or matches the contact (dedup by phone, same as
`POST /api/v1/contacts`), writes tags/notes/custom fields, and —
when `template_id` is present and approved — sends a template. Every
accepted request also feeds a **funnel**: a `broadcasts` row scoped to
`webhook_id`, reused across every request that carries the same id
(see [Funnel semantics](#funnel-semantics) below).

```bash
curl -X POST https://your-crm.example.com/api/v1/ingest/contact \
  -H "Authorization: Bearer wacrm_live_xxx" \
  -H "Content-Type: application/json" \
  -d '{
        "webhook_id": "1234567890123456",
        "webhook_name": "Landing page — Black Friday",
        "phone": "(19) 9 9924-9658",
        "name": "Maria Souza",
        "email": "maria@empresa.com.br",
        "company": "Empresa LTDA",
        "tags": "Cliente VIP, lead quente",
        "notes": {
          "nota_1": "Veio do formulário da LP de Black Friday",
          "nota_2": "Pediu contato à tarde"
        },
        "custom_fields": [
          { "field": "origem", "value": "landing_page_bf" }
        ],
        "template_id": "3f2b8c10-2a44-4a7e-9c1e-77c3b2a1d5e0",
        "template_params": ["Maria"]
      }'
```

| Field              | Type                   | Required | Rule                                                                                          |
| ------------------ | ---------------------- | -------- | ----------------------------------------------------------------------------------------------- |
| `webhook_id`       | string (or number)     | yes      | Digits only, **minimum 16** — identifies the funnel. Not a credential; the API key is.          |
| `webhook_name`     | string                 | yes      | Non-empty after trim; truncated (not rejected) past 120 characters — it's a display label.       |
| `phone`            | string (or number)     | yes      | **Strict Brazilian validation** (DDD against the Anatel list, mobile/landline shape) — see below. |
| `name`             | string                 | no       | Falls back to the normalized phone if omitted (same as `POST /api/v1/contacts`).                 |
| `email`            | string                 | no       | Stored as sent, no format check.                                                                 |
| `company`          | string                 | no       | Stored as sent.                                                                                  |
| `tags`             | string (CSV) or array  | no       | **Additive** — never removes a tag the contact already has. Creates a tag that doesn't exist.    |
| `notes`            | object or string array | no       | Object keys sorted by their **numeric suffix** (`nota_2` before `nota_10`), not alphabetically. Always appends — never dedupes. |
| `custom_fields`    | array of `{field,value}` | no     | `field` matched case-insensitively against an existing custom field name. No match → that one entry is skipped (never fails the request). |
| `template_id`      | string (uuid)          | no       | A `message_templates.id` **in this account**, with Meta status `APPROVED`.                       |
| `template_params`  | array                  | no       | Positional body variables (`{{1}}`, `{{2}}`…) for the template. Non-string entries are coerced to string, never dropped (dropping would shift every later placeholder). |
| `channel_id`       | string (uuid)          | no       | Which of the account's official numbers sends the template (SPEC 065 D-9) — see `channels` on [`GET /api/v1/me`](#get-apiv1me). `400 channel_not_in_account` if the id doesn't belong to this account (never `404`, which would confirm the id exists). |

`channel_id` only matters when `template_id` is also present — it
picks which Cloud number sends. Omit it and the channel is **derived**
from the template's WABA: if exactly one of the account's Cloud
channels sends through that WABA, the template goes out on it;
otherwise (zero or more than one match) the send falls back to the
account's default Cloud channel, same as before this field existed.
Either way, `assertTemplateChannelCompatible` has the final say — a
template sent through a channel of the wrong WABA never reaches Meta;
it fails with `template_waba_mismatch` in `warnings[]` (see the
[response envelope](#response-envelope-an-asymmetry-on-purpose) below —
this is a post-contact-creation failure, so the request still returns
`202`, not `400`).

**Phone validation is stricter here than everywhere else in the public
API.** `POST /api/v1/contacts` and `PATCH /api/v1/contacts/{id}`
normalize a phone but do **not** enforce Brazilian DDD/mobile-shape
rules (kept loose on purpose, to not break existing integrations —
see `docs/spec-050-padronizacao-telefone-br.md` §4 D-5). This endpoint
is new, so it has no existing integration to break: an invalid DDD or
malformed mobile number is rejected with `invalid_phone` rather than
silently stored.

Response (**202** — accepted; the template send, if any, runs in the
background and is never awaited by this response):

```json
{
  "data": {
    "contact_id": "b630a43f-…",
    "contact_created": true,
    "funnel": { "broadcast_id": "9c1e…", "webhook_id": "1234567890123456" },
    "tags": { "linked": 1, "created": 1 },
    "notes": { "inserted": 2 },
    "custom_fields": { "matched": 1, "skipped": [] },
    "send": { "attempted": true, "template_id": "3f2b8c10-…" },
    "warnings": []
  }
}
```

`funnel` is `null` when the funnel row itself couldn't be
created/updated (a rare infra failure) — the contact is still created
in that case; see [Response envelope](#response-envelope) below for
why that's still a `202`, not a `5xx`.

Response (**400** — rejected; nothing was created):

```json
{ "error": { "code": "invalid_phone", "message": "Phone number failed Brazilian validation: invalid_ddd" } }
```

| `code`                   | Meaning                                                                    |
| ------------------------ | ----------------------------------------------------------------------------- |
| `invalid_webhook_id`     | Missing, non-numeric, or fewer than 16 digits                               |
| `invalid_webhook_name`   | Missing or empty after trim                                                 |
| `invalid_phone`          | Failed the strict BR validation above; `message` carries the specific reason |
| `bad_request`            | Request body isn't a JSON object                                            |
| `channel_not_in_account` | `channel_id` doesn't belong to this account (SPEC 065)                      |
| `quota_exceeded` (**403**, not 400) | Account's `contacts` plan quota is already at its limit (SPEC 059) — nothing was created |

#### Response envelope: an asymmetry on purpose

Failure **before** the contact is created is a `400` — nothing was
written, so it's safe for the caller to fix the payload and retry.
Failure **after** the contact exists (an unapproved template, a
channel that can't broadcast, a Meta rejection, a transient DB error
writing a tag/note/custom-field) is **always `202`**, never a `4xx`
or `5xx` — retrying a request whose contact was already created would
otherwise risk the caller reprocessing and duplicating notes (notes
are never deduplicated by design). Whatever went wrong shows up in
`warnings[]` in the same response *and* as a row in the account's
webhook log (**Settings → Log de webhook** in the dashboard — not
exposed over the API). A request rejected for a missing/invalid API
key (`401`/`403`/`429`) is the one exception that logs nothing at
all: without a valid key there's no account to attach a log row to.

#### Funnel semantics

Every accepted request writes into a `broadcasts` row scoped by
`(account_id, webhook_id)` — the **same** `webhook_id` across many
requests reuses the **same** row (found via `webhook_id`, not created
fresh each time), so this behaves like a long-lived campaign that
accumulates over weeks or months, not one row per contact. Two
consequences worth knowing:

- The funnel's `total_recipients` counts **send attempts**, not
  distinct people — the same contact reached again in a later request
  counts again. `ingested_count` (dashboard-only, not in this
  response) separately counts every accepted request, with or without
  a send.
- The funnel's `status` is `streaming` — it never reaches `sent` or
  `failed` the way a dashboard campaign does, because it's an ongoing
  stream, not a bounded batch. Progress (`sent_count`,
  `delivered_count`, `read_count`, `replied_count`, `failed_count`) is
  visible on the dashboard under **Disparos → Funis de webhook**, not
  through `GET /api/v1/broadcasts/{id}` — that endpoint requires the
  `broadcasts:send` scope and works the same for a funnel row as for
  a normal campaign if you already have the id.

## Pagination

Every list endpoint pages the same way. Request a page size with
`?limit=` (default 50, max 100) and read the next page with the opaque
`meta.next_cursor` from the previous response:

```
GET /api/v1/contacts?limit=50
→ { "data": [ … ], "meta": { "next_cursor": "eyJ…" } }

GET /api/v1/contacts?limit=50&cursor=eyJ…
→ { "data": [ … ], "meta": { "next_cursor": null } }   // last page
```

Cursors are keyset-based (stable under concurrent inserts). Pass the
cursor back verbatim — don't parse it. `next_cursor: null` means the
last page.

## Webhooks

Rather than polling, register an endpoint and wacrm will POST to it when
things happen in your account. **Migration required:** apply
`supabase/migrations/028_webhook_endpoints.sql`.

### Events

| Event                    | Fires when                                 |
| ------------------------ | ------------------------------------------ |
| `message.received`       | An inbound message arrives from a contact  |
| `message.status_updated` | A message you sent changed delivery status |
| `conversation.created`   | A new conversation is opened for a contact |
| `plan.changed`           | Self-service changed the account's plan or billing cycle (SPEC 062) |
| `plan.expiring`          | The plan's `currentPeriodEnd` is 7 or 1 day(s) out |
| `plan.expired`           | `currentPeriodEnd` passed; the account moved to `past_due` |
| `plan.canceled`          | Self-service scheduled the plan to cancel at period end |
| `plan.cancel_reverted`   | Self-service reverted a scheduled cancellation |
| `plan.canceled_applied`  | A scheduled cancellation took effect at period end |
| `plan.grace_ended`       | The `past_due` grace period ended (access is **not** revoked by this alone — see §4.3 of SPEC 062) |
| `plan.renewed`           | A payment renewed the plan period — recorded by an external billing system (`/api/admin/accounts/{id}/billing/renew`, `data.source = "api"`) or by the platform operator in the console (`data.source = "console"`). Also moves a `trialing` or `past_due` account to `active` |
| `plan.period_changed`    | The platform operator changed the plan due date (and/or billing cycle) by hand in the console. Not a payment — `plan.renewed` does **not** fire |

### Managing endpoints

All under scope `webhooks:manage`.

- `POST /api/v1/webhooks` — register `{ "url": "https://…", "events": ["message.received"] }`. `url` must be `https://`. **The response includes `secret` exactly once** — store it to verify signatures; wacrm keeps only an encrypted copy.
- `GET /api/v1/webhooks` — list your endpoints (never returns the secret).
- `GET /api/v1/webhooks/{id}` — read one.
- `PATCH /api/v1/webhooks/{id}` — update `url`, `events`, or `is_active` (re-enabling clears the failure counter). At least one field is required.
- `DELETE /api/v1/webhooks/{id}` — remove one.

```bash
curl -X POST https://your-crm.example.com/api/v1/webhooks \
  -H "Authorization: Bearer wacrm_live_xxx" \
  -H "Content-Type: application/json" \
  -d '{ "url": "https://example.com/hooks/wacrm", "events": ["message.received"] }'
# → 201 { "data": { "id": "…", "url": "…", "events": [...], "is_active": true, "last_delivery_at": null, "failure_count": 0, "created_at": "…", "secret": "whsec_…" } }
```

`GET /api/v1/webhooks` returns the same shape as an array, without
`secret` (never returned again after creation):

```json
{
  "data": [
    {
      "id": "…",
      "url": "https://example.com/hooks/wacrm",
      "events": ["message.received", "plan.expiring"],
      "is_active": true,
      "last_delivery_at": "2026-08-20T09:00:00.000Z",
      "failure_count": 0,
      "created_at": "2026-07-01T12:00:00.000Z"
    }
  ],
  "meta": { "next_cursor": null }
}
```

The roster is settings-class (an account registers a handful of
endpoints, not thousands) — `meta.next_cursor` is always `null` here,
there is no pagination to walk. `DELETE` responds
`{ "data": { "id": "…", "deleted": true } }`; a foreign or already-deleted
`id` is `404`, not `200 { "deleted": false }`.

### Delivery payload

Every delivery is a POST with this envelope; `id` is a unique per-
delivery uuid you can dedupe on, and `data` varies by `event`:

```json
{
  "id": "8f3c…",
  "event": "message.received",
  "occurred_at": "2026-07-01T12:00:00.000Z",
  "account_id": "…",
  "data": {/* per-event, see below */}
}
```

`data` by event:

```jsonc
// message.received
{ "conversation_id": "…", "contact_id": "…", "whatsapp_message_id": "wamid.…", "content_type": "text", "text": "Hi 👋", "channel_id": "…", "channel_type": "whatsapp_cloud" }
// conversation.created
{ "conversation_id": "…", "contact_id": "…", "channel_id": "…", "channel_type": "whatsapp_cloud" }
// message.status_updated
{ "whatsapp_message_id": "wamid.…", "conversation_id": "…", "status": "delivered", "channel_id": "…", "channel_type": "whatsapp_cloud" }
// plan.changed
{ "fromPlanCode": "essential", "toPlanCode": "professional", "billingCycle": "yearly", "currentPeriodEnd": "2027-08-27T12:00:00.000Z" }
// plan.expiring
{ "periodEnd": "2026-09-03T12:00:00.000Z", "daysUntil": 7 }
// plan.expired
{ "periodEnd": "2026-08-27T12:00:00.000Z", "graceUntil": "2026-09-03T12:00:00.000Z" }
// plan.canceled
{ "planCode": "professional", "currentPeriodEnd": "2026-09-27T12:00:00.000Z" }
// plan.cancel_reverted
{ "planCode": "professional", "currentPeriodEnd": "2026-09-27T12:00:00.000Z" }
// plan.canceled_applied
{ "fromPlanCode": "professional", "toPlanCode": "free" }
// plan.grace_ended
{ "graceUntil": "2026-09-03T12:00:00.000Z" }
// plan.renewed
{ "paymentRef": "fatura-2026-09-1042", "periods": 1, "currentPeriodEnd": "2026-10-01T00:00:00.000Z", "source": "api" }
// plan.period_changed
{ "previousPeriodEnd": "2026-10-01T02:59:59.000Z", "currentPeriodEnd": "2026-12-21T02:59:59.000Z", "billingCycle": "monthly", "status": "active" }
```

`plan.renewed.data.source` (`"api"` | `"console"`) and the whole
`plan.period_changed` event were added by SPEC 078. The field is purely
additive — existing subscribers that ignore it are unaffected. Behavior
change for `/api/admin/accounts/{id}/billing/renew` (SPEC 078 D-8): a
renewal now also moves a `trialing` account to `active` (before, only
`past_due` was reactivated); `suspended` and `canceled` stay as they are,
and a payment never unblocks an account. The request and response
contract of that endpoint is unchanged. `currentPeriodEnd` in
`plan.period_changed` is always the end of a calendar day in
`America/Sao_Paulo` (23:59:59, i.e. the next day in UTC).

The `plan.*` events (SPEC 062) are dispatched through this same
account-scoped mechanism: register an endpoint subscribed to them the
same way as any other event. There is no separate email/SMTP
notification channel yet — that's a planned addition (SPEC 063), not
implemented in this deployment.

`channel_id`/`channel_type` (`"whatsapp_cloud"` or `"whatsapp_qr"`) identify
which of the account's channels the event belongs to — added for accounts
with more than one channel connected (SPEC 049 §5.5). Purely additive:
existing subscribers that don't read these fields are unaffected.
`channel_type` on `message.status_updated` can be `null` if the channel was
since deleted.

Headers: `X-Wacrm-Event`, `X-Wacrm-Webhook-Id`, and `X-Wacrm-Signature`.

### Verifying the signature

`X-Wacrm-Signature: t=<unix_seconds>,v1=<hex>` where `v1 =
HMAC-SHA256(secret, "${t}.${rawBody}")`. Recompute it over the **raw
request body** and compare in constant time; reject if `t` is more than
a few minutes old (replay protection).

```js
const [, t, v1] = header.match(/t=(\d+),v1=([0-9a-f]+)/);
const expected = crypto
  .createHmac('sha256', secret)
  .update(`${t}.${rawBody}`)
  .digest('hex');
const ok = crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(v1));
```

### Delivery semantics

Delivery is **best-effort**: a single attempt per event with a short
timeout, and **redirects are not followed**. `message.status_updated`
covers messages wacrm stores (inbox + API sends), not broadcast-only
sends, and — because providers re-send and re-order status callbacks —
the same status may arrive more than once or out of order; **dedupe on
`id` and don't assume ordering**. Each consecutive failure increments
`failure_count`; after **15 consecutive failures** the endpoint is
auto-disabled (`is_active: false`) — a successful delivery resets the
counter to 0, and disabling only ever happens automatically (re-enabling
is always an explicit `PATCH`, which also resets the counter). Durable
retry-with-backoff (a delivery queue) is a future enhancement; today,
treat missed deliveries as possible and reconcile with the read
endpoints when it matters.

**Target restrictions (SSRF).** The `url` must be `https://` and must
resolve to a public address — requests to `localhost`, private/RFC1918
ranges, link-local (incl. cloud metadata `169.254.169.254`), and similar
internal targets are refused at delivery time.

### Meta webhook relay (raw WhatsApp events)

The events above are wacrm's own, reinterpreted envelope. If you also need
the **original JSON that Meta sends** for your WhatsApp Cloud API numbers
(`pricing`, full `errors`, `context`, `referral`, contact cards — anything
wacrm does not model), turn on the Meta webhook relay (SPEC 088). Meta
allows a single webhook URL per number; the relay lets wacrm keep it and
still forward the same payload to a second system (n8n, BI, another
helpdesk).

**It is configured only in the dashboard** (Settings → API keys, card
"Meta webhook relay", admin or above) and is **not part of `/api/v1`**:
there is no endpoint, scope or `event` value for it, and `openapi.json`
does not describe it. One relay per account, one target URL (`https://`,
public address only — same SSRF rules as above).

**When it fires.** For every Meta webhook POST that passes wacrm's
signature check, if the relay is switched on and the POST carries at least
one change for an **active Cloud API number of your account**. The match
is by `value.metadata.phone_number_id` only. Never relayed:

- events with no number (`message_template_*`, `account_update` and other
  WABA-level events);
- numbers that are not in the account, or whose channel is disabled or
  deleted;
- numbers the POST's signer does not cover: a POST validated by a
  channel's own Meta App Secret only speaks for the numbers whose channel
  stores that same App Secret (a number under a non-default Meta App needs
  its own App Secret saved to be relayed);
- anything that belongs to another account;
- anything while your account is blocked;
- deliveries above 50 per second per account (see **Volume** below).

The QR-code (Evolution) channel is not covered; only Cloud API numbers.

**Request.** `POST <your url>` with `Content-Type: application/json` and
these headers:

| Header                | Value                                                         |
| --------------------- | ------------------------------------------------------------- |
| `X-Wacrm-Event`       | `meta.webhook_raw`                                            |
| `X-Wacrm-Delivery-Id` | a uuid, new on every delivery                                 |
| `X-Wacrm-Signature`   | `t=<unix_seconds>,v1=<hex>`, computed as in the section below |
| `X-Wacrm-Test`        | `true`, only on the dashboard's "Test connection" request     |

There is **no `X-Hub-Signature-256`** and no other Meta header: Meta's
signature is not forwarded. Authenticate the call with
`X-Wacrm-Signature` and the key shown once when you create the relay.

**Body.** The Meta webhook, with no wacrm envelope:

- Normal case: the whole POST, **byte for byte** as Meta sent it.
- If one Meta POST mixes events of several accounts (rare), you receive the
  same object with `entry[]` reduced to your entries and each `changes[]`
  reduced to your changes (other top-level keys and the content of each
  change are untouched; an entry left without changes is dropped).

Either way it is a valid Meta webhook that contains only your data. Tell
your numbers apart by `entry[].changes[].value.metadata.phone_number_id`.
Media arrives as an `id` only (no URL, no bytes): downloading it needs a
Graph API token that the relay does not provide.

**Verifying the signature.** Same scheme as
[Verifying the signature](#verifying-the-signature) above, with the
relay's key as `secret`: `v1 = HMAC-SHA256(secret, "${t}.${rawBody}")`,
over the raw request body. Parse the JSON only after the check.

**Delivery semantics.**

- One attempt per Meta POST, **5-second timeout**, redirects are **not**
  followed (a `3xx` counts as a failure). Any non-`2xx`, timeout or network
  error is a failure.
- A success resets the failure counter; after **15 consecutive failures**
  the relay switches itself off and the dashboard shows when and why.
  Switching it back on is always manual and resets the counter.
- No queue, no retry, **no ordering guarantee**: events that arrive while
  your target is down are lost.
- Meta resends a webhook when it does not get a `200`, so the same event
  may reach you more than once. Dedupe on `messages[].id`, and on
  `statuses[].id` together with `status`.
- **Volume.** Every relayed Meta POST becomes a delivery, up to **50 per
  second per account** (counted per server process); the excess is dropped,
  not retried, and does not count as a failure. A broadcast to thousands of
  contacts produces tens of thousands of `statuses` POSTs (`sent`,
  `delivered`, `read`); size your target for it, or the 15-failure limit
  can trip within seconds.
- The payload carries your contacts' phone numbers, names and message
  text out of wacrm. Treat the target and the key accordingly.
- "Test connection" sends a sample text-message webhook with fake ids
  (`phone_number_id: "0"`, `wamid.TEST`) and `X-Wacrm-Test: true`, signed
  like a real delivery. It works while the relay is off and does not count
  as a failure.

## Roadmap

The public API now covers messaging (including interactive buttons/lists),
contacts, conversations, broadcasts, and outbound webhooks — the full
scope of [#245](https://github.com/ArnasDon/wacrm/issues/245). Known gaps,
not yet scheduled:

- **Durable webhook delivery queue** with retry/backoff. Today delivery is
  one best-effort attempt per event (see [Delivery semantics](#delivery-semantics)).
- **Per-agent API key scoping.** A key is always an account-wide credential
  today (see [Scope is the account, never a single agent](#scope-is-the-account-never-a-single-agent));
  narrowing a key to one agent's assigned conversations would need a new
  `api_keys` column and a rework of the auth/query layer.
- **Distributed rate limiting.** The 120/min budget is enforced in-memory,
  per process (see [Rate limits](#rate-limits)) — correct for a
  single-instance deploy, silently ineffective across multiple instances
  until swapped for a shared store.
- **A sandbox key mode** (`wacrm_test_…`). The `wacrm_live_` prefix leaves
  room for it, but it isn't implemented.
- **Endpoints for deals/pipelines, templates, and flows** — not exposed via
  the public API yet, only through the dashboard.

## Implementation reference (source map)

For whoever is changing this API (human or LLM) or regenerating the
companion `openapi.json` for the Scalar reference site — where each piece
of the contract above actually lives in this repo:

| Concept | File(s) |
| --- | --- |
| Route handlers (`/api/v1/**`) | `src/app/api/v1/**/route.ts` |
| API-key auth → account context (`requireApiKey`) | `src/lib/auth/api-context.ts` |
| Key generation / hashing | `src/lib/api-keys/keys.ts` |
| Key lookup / persistence | `src/lib/api-keys/store.ts` |
| Scope vocabulary (`ApiScope`) | `src/lib/api-keys/scopes.ts` |
| Response envelope, `ApiError` | `src/lib/api/v1/respond.ts` |
| Cursor pagination | `src/lib/api/v1/pagination.ts` |
| Contacts / conversations query helpers | `src/lib/api/v1/contacts.ts`, `src/lib/api/v1/conversations.ts` |
| Rate limiting (`RATE_LIMITS.publicApi` + every other bucket in the app) | `src/lib/rate-limit.ts` |
| Interactive message payload + validation | `src/lib/whatsapp/interactive.ts`, limits in `src/lib/whatsapp/meta-api.ts` (`INTERACTIVE_LIMITS`) |
| `plan`/`usage` block on `GET /api/v1/me` (SPEC 059/062) | `src/lib/plans/account-plan.ts` (`getAccountPlan`), `src/lib/plans/types.ts` |
| `account_blocked` enforcement (checked before every `/api/v1/**` route runs) | `src/lib/auth/api-context.ts` (`requireApiKey`), `src/lib/platform/blocked.ts` |
| Cold-send throttling (`cold_send_limit`) | `src/lib/channels/cold-send-limit.ts`, `src/lib/channels/cold-send-wiring.ts`, wired in `src/lib/whatsapp/send-message.ts` |
| Channel capabilities (`sessionWindow24h` etc.) | `src/lib/channels/capabilities.ts`, `src/lib/channels/types.ts` |
| Webhook event vocabulary | `src/lib/webhooks/events.ts` |
| Webhook HMAC signing | `src/lib/webhooks/sign.ts` |
| Webhook delivery + failure counter | `src/lib/webhooks/deliver.ts` |
| Webhook SSRF guard | `src/lib/webhooks/ssrf.ts` |
| Dashboard-only Meta webhook relay (not `/api/v1`, SPEC 088)                  | `src/lib/webhooks/meta-relay.ts`, `meta-relay-config.ts`, hook in `src/app/api/whatsapp/webhook/route.ts`, routes `src/app/api/account/meta-relay/**`, UI `src/components/settings/meta-relay-settings.tsx`, schema `supabase/migrations/101_meta_webhook_relay.sql` |
| `api_keys` schema | `supabase/migrations/026_api_keys.sql` |
| `webhook_endpoints` schema | `supabase/migrations/028_webhook_endpoints.sql` |
| Inbound ingest webhook route | `src/app/api/v1/ingest/contact/route.ts` |
| Ingest validation, notes/custom-fields/funnel writes, log | `src/lib/ingest/*.ts` (SPEC 055) |
| Template-approval guard used by ingest sends | `src/lib/whatsapp/template-approval.ts` |
| `webhook_ingest_logs` schema + funnel columns on `broadcasts` | `supabase/migrations/065_inbound_contact_webhook.sql` |
| Dashboard-only failure log for the ingest webhook (not `/api/v1`) | `src/app/api/account/webhook-logs/route.ts`, UI at `src/components/settings/webhook-log-settings.tsx` |
| Dashboard-only key management (cookie-auth, **not** `/api/v1`) | `src/app/api/account/api-keys/route.ts`, `src/app/api/account/api-keys/[id]/route.ts`, UI at `src/components/settings/api-keys-settings.tsx` |
| Tests exercising the above | `*.test.ts` co-located next to each file listed |

Notes worth knowing before touching this area:

- **Key management is dashboard-only, on purpose.** `POST/GET/PATCH/DELETE
  /api/account/api-keys[/{id}]` authenticate via the Supabase cookie
  session (admin+), not a bearer key — there's no `/api/v1` endpoint to
  create or revoke a key. Webhook *endpoints*, by contrast, are managed
  through `/api/v1/webhooks` itself, since a self-service integrator needs
  to register its own callback without dashboard access.
- **Every route is thin** — auth, then delegate to a `src/lib/**` function
  that's independently unit-tested. There is no HTTP-level integration test
  suite for the routes themselves; correctness is proven at the lib layer
  per this project's convention (see `AGENTS.md`).
- **All `/api/**` error text is English by design** (see
  [Language of error messages](#language-of-error-messages)) — never
  translate payloads, even though the dashboard UI is pt-BR/en.
