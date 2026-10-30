# Evolution Go Integration Guide — Instance Management, Per-Channel Chat & Inbox Routing

**Purpose:** hand-off reference for an LLM implementing a WhatsApp-via-QRCode integration
(Evolution Go) in a **different system, different codebase, different stack**. It condenses
what was learned by building this feature end-to-end in a production multi-tenant CRM (ZAP CRM
BR — Next.js/Supabase), including facts that were **wrong in Evolution Go's own official
documentation** and only surfaced by probing a live server. Treat every "measured against a
real server" claim below as more trustworthy than any Evolution Go doc you are given, official
or not — the two disagreed repeatedly during this project.

**Scope of this guide — three UI/backend processes:**

1. **Instance management by the account owner** — an admin-level screen where a tenant/account
   creates, connects, monitors and deletes one or more WhatsApp "instances" (unofficial,
   QR-paired numbers), each becoming a communication channel for that tenant.
2. **Chat system scoped per channel instance** — how inbound/outbound messages are normalized,
   routed and persisted per instance, so each instance behaves as an independent channel with
   its own credentials, webhook and state.
3. **Inbox distinction between channels** — how a shared inbox UI tells conversations from
   different channels apart (including a pre-existing official/Cloud API channel, if the target
   system already has one) without merging or confusing them.

This is **not** a copy-paste API reference. For the raw endpoint list (request/response schemas)
pair this with an actual OpenAPI probe of your own target server — endpoint shape drifts between
Evolution Go versions, but the **architectural lessons and gotchas below are stable** and worth
re-verifying against your server before writing the adapter.

---

## 1. Why "probe the real server first" is not optional

The two reference documents available going into this project (an official narrative guide and
a compiled OpenAPI reference) **both** turned out to have material errors, discovered only by
scripting read-only calls against a live instance:

| # | Docs said | Real server said | Why it matters |
|---|-----------|-------------------|-----------------|
| 1 | ~59 endpoints | 91 endpoints | Surface area undersold |
| 2 | Buttons/lists don't exist on this engine | `/send/button`, `/send/list`, `/send/carousel` exist, full schema, even a **Pix payment button** | Endpoint *existing* ≠ WhatsApp *accepting* it — see §2 |
| 3 | No endpoint to edit instance behavior flags | `GET`/`PUT /instance/{id}/advanced-settings` exists | "Edit instance" is a real, useful feature |
| 4 | Standardized error envelope `{success, error:{code,message}, meta}` | Plain string `{"error":"not authorized"}`; 404 is `text/plain`, not JSON | Naive JSON error parsing throws on 404 |
| 5 | Media download path documented one way | Path was different in practice | Don't trust doc path names blindly |

**Actionable takeaway:** before writing any adapter code, script a read-only probe (create →
connect → poll status → fetch QR → send a few message types to a real device → delete) against
the actual target server, and log every raw response shape. Build the adapter from **that**
evidence, not from the vendor's prose docs. Budget a dedicated spike phase for this — it is not
wasted time, it is the only way several of the bugs below get caught before they reach
production silently.

### 1.1 Interactive messages: verify rendering, not just HTTP status

The single most expensive assumption to get wrong: an endpoint returning `200` does **not**
mean the recipient's device rendered anything. In this project, `/send/button` and `/send/list`
both returned `500 {"error":"server returned error 405"}` when tested against a real WhatsApp
account — deterministically, reproduced twice with different payloads. That `405` is not from
the Evolution Go server; it is what **WhatsApp's own servers** returned to the underlying
library (whatsmeow) when it tried to deliver a button-formatted message over an unofficial
(non-Business-API) session. Confirmed on-device: plain text and polls arrived; buttons and lists
never did.

**Conclusion that generalizes beyond this one engine:** any Evolution Go / whatsmeow-based
unofficial WhatsApp connector should be assumed **not** to support Meta's interactive message
types (buttons, lists, carousels) regardless of what the HTTP API accepts, because the
restriction lives at WhatsApp's protocol level, not the wrapper's. **Polls were the one
interactive primitive that worked** — plan your "menu" UX around numbered-text-reply or polls,
not buttons, unless you re-verify against your specific server/account tier. Gate this behind a
capability flag (§4) rather than hard-coding it, so it can flip on later if you get contrary
evidence — but default to `false` and require a real-device test before ever flipping it.

---

## 2. API-quirk cheat sheet (Evolution Go specifically, but the *pattern* generalizes)

These are concrete facts observed against Evolution Go. Even if your target vendor differs,
expect a similar *class* of surprise and design your client defensively the same way.

| Area | What was assumed | What was actually true |
|---|---|---|
| **Auth scope** | One API key works everywhere, or "admin routes use the global key" | Auth scope is **per endpoint**, not per category. Instance list/create/delete use a **global** key; almost everything else (`connect`, `qr`, `status`, `send/*`, `message/*`, `advanced-settings`) needs the **per-instance token**. Using the wrong key gets a `401`, not a helpful error. **Build an explicit route→scope map**; do not infer scope from the URL prefix. |
| **Response envelope** | One consistent shape | **Three different shapes coexist**: `{data, message}`, a bare object, and a bare array — depending on endpoint. A single `unwrap(body) = body.data ?? body` helper, with each call site declaring what shape it expects, avoids brittle "assume `.data` always exists" code. |
| **Error shape** | Structured `{success, error:{code, message}}` | Plain string in a JSON field (`{"error":"not authorized"}`) on some errors, and **plain-text, non-JSON** bodies on 404s. Parse defensively: try `body.error` as a string first, fall back to `body.error.message`, fall back to `body.message`, fall back to a generic `HTTP {status}`; never assume the body parses as the documented shape. |
| **QR field naming** | Documented field name (e.g. `qrCode`) | Actual field was lowercase and differently named across doc versions (`qrcode` observed on one probe, `Qrcode` in another). Read defensively: `data.qrcode ?? data.Qrcode ?? data.qrCode`. The QR value itself arrives **ready to render** — a complete `data:image/png;base64,...` URI, no prefix assembly needed. A second field (often called `code`) is not the raw pairing string but a **complete `wa.me` deep link** — useful for an "open on this phone" affordance alongside the scan option. |
| **QR/status semantics on an already-connected instance** | Error | Calling "get QR" on an instance that's already logged in returns a `400`-class error with a message like *"session already logged in"*. Treat this as a **state signal** ("already paired — close this dialog"), not a failure to surface to the user. |
| **QR endpoint latency** | Instant | Measured **~3 seconds fixed latency** on every call to the QR endpoint, success or error path — not a network blip, an internal wait in the engine. Design implications: don't poll it faster than every ~5s (overlapping calls just queue); show a loading state from the very first click (3s of a frozen dialog reads as broken); **don't use this endpoint to detect pairing success** — subscribe to the connection-state webhook event for that, and use a cheap, fast status-polling endpoint only as a safety net. |
| **Instance creation token** | Auto-generated if omitted | **Required.** Omitting it returns `400`. This is actually convenient: generate the token client-side (e.g. `randomUUID()`), encrypt it before it ever touches your database, send it in the create call — you never have to parse a secret out of a response body. |
| **Identifier drift / device suffix** | JID is a clean phone number | The JID often carries a **device suffix** like `:12` before the `@` domain part (e.g. `<phone>:12@s.whatsapp.net`). Strip `:NN` before using the value for contact matching/dedup, on **both** the phone-style JID and the LID-style identifier — missing this breaks contact deduplication silently. Write a unit test specifically for this. |
| **LID vs phone number** | A `/user/info`-style lookup translates an opaque internal ID (LID) back to a phone number | It does **not** — querying by LID returns null phone/JID fields. The **only** reliable direction is phone → LID (via a "check number" style endpoint), never the reverse. If an inbound message arrives identified **only** by LID and you have no prior phone↔LID mapping for it, the safe behavior is to **discard with a high-visibility log**, never fabricate a synthetic contact. Build the mapping table proactively (phone→LID) whenever you create/update a contact on this channel type, so future LID-only inbounds have something to match against. |
| **Media in webhooks** | A public URL always comes back | Two possible shapes depending on server config: (a) an **already-decrypted base64 blob embedded in the payload** (position matters — verify empirically where it sits in the JSON, it may be a sibling of the raw protocol object, not nested inside it), or (b) a real URL, only when the server has object storage (e.g. MinIO/S3) configured. **A third shape you must actively reject**: a URL pointing at WhatsApp's own encrypted CDN — downloading and re-hosting those bytes "succeeds" (upload works, a player renders) but the content is AES-encrypted and unplayable. Detect and refuse these URLs explicitly with a clear log, don't silently produce a broken media bubble. |
| **Body-size limits of your own hosting** | N/A | If your webhook receiver runs on a platform with a request body cap (e.g. serverless functions with a ~4–5MB limit), base64-inflated media (~33% larger than binary) from a moderately sized video will blow that cap and the webhook call itself will fail — which, combined with limited-retry webhook delivery (see §5), means **silent message loss**. Prefer object-storage-backed media delivery (URL in payload, download server-side) over base64-in-webhook for production; treat base64 as a fallback for low-media-volume tenants only, with an explicit size ceiling and a refusal message rather than a crash. |
| **Payload casing/shape mixing** | One consistent JSON convention | Real payloads mixed **three** conventions in the same object: a Go-struct JSON encoding style for envelope fields (`Info`, `Chat`, `ID` — PascalCase), a protobuf-JSON style for the actual message content (`audioMessage`, `mediaKey`, `URL` — camelCase on some fields, verbatim on others), and separate envelope-level fields (`event`, `state` — plain lowercase). A case-insensitive/shape-tolerant payload reader pays for itself immediately; even so it won't save you from fields living at the **wrong nesting level** (see next row) — that class of bug only surfaces by diffing a real captured payload against your fixture. |
| **Message-ID / base64 field nesting depth** | Where you'd guess | In this project the message ID needed for de-duplication and delivery-receipt matching lived **two levels deeper** than every fixture initially assumed (`data.Info.ID`, not `data.ID` or `data.key.ID`), and inline media base64 was a **sibling** of the protocol object, not a child of it. Getting this wrong doesn't throw — it silently produces empty IDs (→ duplicate messages, because your own echo-suppression can't match anything) or "media unavailable" states, with a 100%-green test suite the whole time, because the fixtures encoded the same wrong assumption as the code. **Fixtures must be verified failing against the old/broken code before being trusted**, and ideally sourced from real captured payloads, not hand-written. |
| **Delivery-receipt race condition** | Receipt always arrives after your send completes | For media sends specifically, upload+relay latency (signing a URL, uploading, waiting on the provider) can exceed the time it takes the recipient's client to deliver a read/delivery receipt for that same message ID. A receipt handler that only checks "do we have this message row yet" **once** will miss it. Retry the receipt-to-message match a few times with short backoff (e.g. immediate, +1s, +2.5s) before giving up. |
| **Event name mismatch between subscribe and receive** | Same vocabulary | A family of events **subscribed to** by one name (e.g. `SEND_MESSAGE`, `READ_RECEIPT`, `CONNECTION`) arrives **tagged differently** in the actual webhook payload's `event` field (e.g. `SendMessage`, `Receipt`, `Connected`/`LoggedOut`/`PairSuccess`, one specific sub-event per connection-state transition rather than one generic name). A `switch` keyed on the subscribed family name will silently match nothing for these and the corresponding feature (operator-sent-from-phone echo, read receipts, live connection status) goes dead **with zero errors and a green test suite**. Enumerate and test against the *received* names, not the *subscribed* names — get this from a real captured payload, never from the subscribe-call documentation. |
| **Connection-status payload doesn't carry the booleans you'd expect** | e.g. `{connected: true, loggedIn: true}` on every connection event | The connection-family webhook event may carry a completely different shape (e.g. `{status: "open", jid}`) than the dedicated status-polling endpoint (which does carry those booleans). Reading absent boolean fields as `false` will mark a freshly-connected instance as **disconnected**. Know which endpoint/event gives you which shape and don't cross-read one for the other. |

---

## 3. Recommended data model

Model this as a **channel abstraction** with a provider-specific extension table, not as a
single flat "whatsapp settings" row — even if today you only support one unofficial-WhatsApp
provider, this shape is what lets a second provider (a second unofficial engine, a different
official API, a different messaging platform entirely) be added later without touching chat,
inbox or automation code.

```
tenant/account
   └── channels                        one row per communication channel the tenant owns
         ├── (type='<official-api>')  → <official_provider>_config   (existing, 1:1)
         └── (type='whatsapp_qr')     → provider_instances            (new, 1:1)
                                            └── provider_instance_secrets  (tokens; service-role/backend-only access)
conversations.channel_id → channels.id
```

Key fields on `channels`: `type`, tenant-chosen `name`/label, connected identifier (phone
number once paired), `status` (`disconnected|connecting|connected|error|disabled`), `is_default`
flag, timestamps. Partial-unique indexes enforce "at most one default channel per tenant" and,
if you have a singleton official channel, "at most one of that type per tenant."

Provider-specific table (`provider_instances`): the vendor's own instance id, the **namespaced**
remote name you registered it under (§4.3), connected phone/JID, proxy config if supported, the
list of webhook events you subscribed to (so you can detect drift if the vendor echoes back a
different accepted set), last-QR timestamp (never store the QR image itself), last error.

**Secrets live in a separate table with no row-level read policy for normal users/roles** — only
your backend/service role reads it. A `SELECT *` from application code or an admin UI should be
structurally incapable of leaking a token.

```sql
-- illustrative, adapt to your own schema conventions
CREATE TABLE provider_instance_secrets (
  instance_id               uuid PRIMARY KEY REFERENCES provider_instances(id) ON DELETE CASCADE,
  instance_token_encrypted  text NOT NULL,   -- encrypted at rest (e.g. AES-256-GCM)
  webhook_secret            text NOT NULL,   -- random, used in the webhook URL path itself
  created_at                timestamptz NOT NULL DEFAULT now()
);
```

**Identity-resolution table**, required from day one if the provider can identify a sender by an
opaque ID (LID-style) instead of a phone number (§2):

```sql
CREATE TABLE contact_identities (
  account_id   uuid NOT NULL,   -- scope by tenant, not global — same external id can mean
  contact_id   uuid NOT NULL,   --   a different person to a different tenant sharing infra
  channel_type text NOT NULL,
  external_id  text NOT NULL,  -- e.g. the opaque LID string
  PRIMARY KEY (account_id, channel_type, external_id)
);
```

**Conversation uniqueness must include the channel**, not just (tenant, contact):
`UNIQUE(account_id, contact_id, channel_id)` instead of `UNIQUE(account_id, contact_id)`. See
§6 for why this is the crux of the inbox-distinction problem, and make `channel_id` **immutable**
after creation (reject the update at the database level) — a conversation silently migrating
channel corrupts any per-channel timers or delivery history it carries.

---

## 4. Core architecture: adapter interface + capability matrix + unified in/out paths

This is the pattern that made adding a second channel type cheap in the source project, and is
worth carrying over regardless of target stack/language.

### 4.1 Capability matrix, not scattered `if`s

Declare, per channel type, a static table of what it can do: `text`, `media.{image,video,audio,
document}`, `location`, `poll`, `interactiveButtons`, `interactiveList`, `templates`,
`reactions`, `replyQuote`, `editMessage`, `deleteForEveryone`, `typingIndicator`, `markRead`,
`deliveryReceipts`, `broadcast` (mass-send allowed?), `sessionWindow24h` (does a
reply-window rule apply, e.g. Meta's 24h policy?), `messagingLimit` (does a vendor-imposed
volume tier apply?). Every UI affordance (which composer buttons show), every validation rule
(can this automation step run on this channel?), and every runtime guard reads from **this one
table**, never a hard-coded per-feature check. A new channel type declares its row and the rest
of the system adapts without code changes elsewhere.

For the QR/unofficial-WhatsApp channel specifically, based on the findings in §1–2:
`interactiveButtons: false`, `interactiveList: false`, `templates: false`, `broadcast: false`
(product policy, not a technical limit — mass-sending from an unofficial number is a ban risk),
`sessionWindow24h: false`, `poll: true`, everything else largely `true`.

### 4.2 Adapter interface

```ts
interface ChannelAdapter {
  readonly type: ChannelType;
  readonly capabilities: ChannelCapabilities;

  sendText(ctx, params): Promise<SendResult>;
  sendMedia(ctx, params): Promise<SendResult>;
  sendLocation?(ctx, params): Promise<SendResult>;
  sendPoll?(ctx, params): Promise<SendResult>;
  sendTemplate?(ctx, params): Promise<SendResult>;   // official-API-only, typically
  sendReaction?(ctx, params): Promise<SendResult>;
  markRead?(ctx, params): Promise<void>;
  setTyping?(ctx, params): Promise<void>;

  /** Translates the provider's raw webhook payload into normalized internal events. */
  normalizeInbound(raw: unknown): NormalizedInbound[];
}
```

`ctx` carries the resolved channel + **already-decrypted** credentials. Credential decryption
happens in exactly **one** place in the whole codebase — never inline in a route handler or a
webhook translator — so a security review has one function to audit, not N.

### 4.3 One ingestion path, one send path

Every inbound webhook, regardless of provider, funnels through a single `ingestInboundMessage()`
pipeline: find-or-create contact → find-or-create conversation (scoped by channel, §3) →
**idempotency check** on (conversation, provider-message-id) before insert → insert message →
update conversation summary fields → advance the reply-window "anchor" timestamp **only if the
channel's capability matrix says a reply-window rule applies** → hand off to
automation/flow/AI-reply engines → dispatch outbound webhook/event notifications. Provider
webhook routes become thin translators: verify authenticity, call `normalizeInbound()`, iterate
`ingestInboundMessage()`.

Every outbound send, regardless of trigger (manual reply, automation, flow, broadcast, AI
auto-reply), funnels through a single `sendViaChannel()`: resolve the target channel (explicit
override → the conversation's own channel → tenant's default channel), validate the message type
against the capability matrix (raise a typed "unsupported by this channel" error rather than
letting the provider reject it with an opaque 4xx/5xx), apply channel-specific rules (e.g.
reply-window enforcement, but **only** where `sessionWindow24h: true`), call the adapter, persist
the outcome once.

**Why this matters enough to call out explicitly:** the single most damaging bug class in the
source project's history was a piece of code that resolved "which channel to send through"
**without looking at the conversation's actual channel** — it silently fell back to a default,
so replies to an unofficial-channel conversation went out through the official channel instead
(wrong number, possibly billed, outside any valid reply window). If your system has more than
one send call site, **audit every one of them** for this exact mistake before shipping; it is
easy to reintroduce piecemeal (composer reply, automation engine, flow engine, AI auto-reply,
and any public API endpoint that sends messages are each a separate call site that can regress
independently).

---

## 5. Process 1 — Instance management by the account owner

### 5.1 Auth model

Two credential tiers, and which one a call needs is **per endpoint**, not inferable from a
pattern (§2). Design your client with an explicit route→scope lookup table from day one:

| Operation class | Typical key |
|---|---|
| List/create/delete instances (account-owner/admin actions) | Deployment-wide "global" key |
| Connect, get QR, pairing code, live status, disconnect/logout, send/receive messages, advanced settings | Per-instance token |

The global key is deployment-wide and must **never** reach the browser — it can enumerate,
create or delete *any* tenant's instances if the vendor's multi-tenancy is only enforced by your
own application layer (commonly true: a self-hosted messaging-engine VPS has no concept of your
tenants, it just has "instances"). Every instance-management call goes through your own
authenticated, tenant-scoped backend route; no client-side component talks to the vendor
directly.

### 5.2 Naming instances for a shared, multi-tenant backend

If the vendor's own instance-name namespace is global across your whole deployment (true for a
self-hosted engine shared by all your tenants), a tenant-chosen label must **never** be sent
raw as the instance name — two tenants both naming an instance "vendas" would collide. Namespace
it server-side, e.g.:

```
<deployment-prefix>_<short-hash-of-tenant-id>_<slugified-label>_<random-suffix>
```

This also gives you a cheap way to audit "which of the vendor's instances are ours" if the VPS
is shared with other deployments.

### 5.3 Lifecycle

```
create      → POST .../instance/create      { name, token, ... }   [global key; token generated by YOU, see §2]
connect     → POST .../instance/connect      { subscribe: [...], webhookUrl }  [instance token]
qr          → GET  .../instance/qr           → renderable QR + deep-link         [instance token]
pair        → POST .../instance/pair         { phone }  → pairing code           [instance token]
status      → GET  .../instance/status       → live connection booleans          [instance token]
disconnect  → POST .../instance/disconnect                                       [instance token]
logout      → DELETE .../instance/logout     (unlinks the paired device)         [instance token]
delete      → DELETE .../instance/delete/{id}                                    [global key]
```

Register the webhook URL and the event subscription list on **connect**, not on create — and
always send the **full intended event list** explicitly. An empty/default subscription on some
engines silently registers only a minimal event set (e.g. just raw message events), and
connection-state, receipt and phone-echo events go dark with no error. Compare the accepted-event
echo (if the connect response includes one) against what you sent, and alert on drift instead of
assuming registration succeeded.

### 5.4 UI flow for the connect dialog

1. Render the QR from the response value directly — expect it may already be a complete
   `data:image/...;base64,...` URI (§2), not a raw string needing prefix assembly.
2. Show a countdown (QR codes expire; ~60s is a reasonable default) with a "generate new QR"
   action.
3. **Do not** poll the QR-fetch endpoint on a short interval — it may have multi-second fixed
   latency (§2), and overlapping calls just queue up pointlessly. Use a cheap, fast
   status-polling endpoint as your safety net, but let the **connection-state webhook event**
   be the primary signal that closes the dialog on success.
4. Offer a **pairing-code** alternative alongside the QR scan (enter phone number → get a short
   code → type it into the paired device) for users accessing the admin UI from the same phone
   they're pairing — they can't scan their own screen.
5. Because the deep-link value returned alongside the QR is often a real `wa.me`-style URL
   (§2), also offer an "open on this phone" button, not just "scan this code" — same underlying
   data, better UX for the single-device case.
6. On success, surface the connected phone/identifier and close.

### 5.5 Ongoing management

- **Status**: connected/connecting/disconnected/error, ideally driven by the connection-state
  webhook event rather than continuous polling (which is both wasteful and, per §2, can lag
  behind reality if you're reading the wrong endpoint's booleans).
- **Edit**: a local label rename never touches the vendor; re-registering webhook/events reuses
  the connect call; behavior flags (always-online, auto-reject calls, read-receipts-on,
  ignore-groups, ignore-status, etc.) map to a vendor "advanced settings" endpoint if one exists
  — confirm in your probe whether it needs the instance token or the global key, these are
  commonly inconsistent with the rest of the instance-scoped routes.
- **Limits**: enforce at (a) a per-tenant configurable override, falling back to (b) a
  deployment-wide default via config/env, and separately (c) a hard deployment-wide total cap
  that protects the shared backend/VPS resource itself regardless of any single tenant's limit.
  A per-tenant limit alone does not protect the shared infrastructure from the sum of all
  tenants.
- **Deletion**: delete on the vendor side and locally, but **preserve the tenant's conversation
  history** — mark it read-only / tag it "channel removed" rather than cascading a delete into
  message history. Losing chat history because an admin disconneted a device is a much worse
  outcome than a slightly stale "disconnected instance" row.
- **Non-dismissible risk disclosure**: if the channel type is an unofficial/ToS-gray-area
  connection (true for QR-based WhatsApp), the management UI should permanently display — not a
  one-time dismissible toast — that the number can be banned without notice, there's no vendor
  SLA, and it shouldn't be a business's primary number. This isn't boilerplate CYA copy; it
  reflects a real, observed operational risk class for this integration.
- **Graceful absence of configuration**: if the vendor integration isn't configured for this
  deployment at all (missing base URL/API key), the admin UI section should appear **disabled
  with setup instructions**, never silently vanish from navigation and never 503 with no
  explanation. A feature that "doesn't fire and gives no error" is the single most-repeated
  failure pattern worth designing against throughout this whole integration.

---

## 6. Process 2 — Chat system scoped per channel instance

### 6.1 Webhook authenticity (assume no signature)

Many self-hosted / unofficial messaging engines do **not** sign webhook deliveries (no HMAC).
Don't assume the payload is trustworthy just because it hit your endpoint. Chain multiple
independent checks, all mandatory, any failure → reject with `401` before doing any processing:

1. A random secret embedded in the **webhook URL path itself** (generated per instance, compared
   timing-safely).
2. The vendor's own instance id in the payload matches the instance you resolved from that
   secret.
3. The instance's own token (as you stored it, decrypted) matches a token field in the payload,
   if the vendor includes one.

### 6.2 Idempotency is load-bearing, not defense-in-depth

If the vendor's webhook delivery has a bounded retry policy (e.g. "N attempts over M seconds,
then drop, no dead-letter queue" — common for self-hosted engines), **duplicate delivery is a
certainty you must design for**, not an edge case. Check `(conversation_id, provider_message_id)`
for an existing row **before** inserting, on every inbound message, regardless of provider.
Respond `200` to the webhook as fast as possible (queue heavier processing asynchronously if your
platform supports it) — a slow `200` can itself be treated as a failure by some engines and
trigger a redundant retry.

Corollary: because there's no dead-letter queue, know your delivery-retry window (e.g. "5
attempts over 30s each = ~2.5 minutes total tolerance") and make sure your webhook route's
uptime — including through your own deploys — comfortably exceeds it, or you lose messages with
no trace.

### 6.3 Event translation layer

Given the event-name mismatch and payload-shape-mixing issues in §2, isolate all "read this
provider's raw JSON regardless of its casing/nesting quirks" logic into one small module,
separate from your business logic. It should be immune to key-casing differences; it will
**not** by itself protect you from fields living at the wrong nesting depth — that class of bug
needs a real captured payload to catch, no amount of generic tolerance helps.

Practical event-handling table (map to your vendor's actual received event names, verified
against real payloads, not the subscribe-call docs):

| Event family | Typical handling |
|---|---|
| Inbound customer message | Ingest as a `customer`-sent message via the pipeline in §4.3 |
| Message sent from the paired device itself (not through your system) | Ingest as an `agent`-sent message with no internal sender id — this is a real feature win over an official-API-only integration: replies sent from the operator's own phone show up in your CRM too. **Suppress the echo** of messages *you* sent through your own send path, by matching the provider's returned message id against what your own send call received — otherwise every outbound message you send doubles up when its own echo event arrives. |
| Delivery/read receipt | Update message delivery status, respecting whatever "don't regress a more-advanced status back to a less-advanced one" ordering your system already has (e.g. don't let a stray "delivered" event overwrite an already-"read" status) |
| Connection state change | Update the channel's live status — this is what lets your instance-management UI (§5) avoid polling |
| QR code refreshed | Update a "last QR issued at" timestamp only — **never persist the QR image itself** |

### 6.4 Identity resolution order

On every inbound message, resolve the sender's canonical contact identity in this order:

1. A phone-number-shaped identifier is present and unambiguous (after stripping any device
   suffix, §2) → use it directly, this is the normal path.
2. Only an opaque provider-specific ID (LID-style) is present → look it up in your
   `contact_identities` table (§3). If it matches a contact you've seen before, use that contact.
3. No match → **discard the message with a high-visibility log**, never create a contact keyed
   by a synthetic/unresolvable identifier. A contact you can't reliably message back is worse
   than a dropped message you can investigate from a log line.

Build the phone→opaque-ID mapping proactively (whenever you create or update a contact on this
channel type, resolve and store the mapping) since the reverse lookup is often unavailable
(§2).

### 6.5 Media handling

- Reject encrypted-CDN URLs outright with a clear log (§2) rather than producing a silently
  broken media bubble.
- Prefer object-storage-backed delivery (vendor uploads to S3/MinIO-compatible storage, gives
  you a URL, you fetch server-side and re-host in your own private bucket) over inline base64
  in the webhook payload, especially if your webhook receiver has a body-size ceiling (§2).
- Derive a sensible file extension from the MIME type when the provider doesn't supply a
  filename (true for voice recordings) — otherwise everything lands as a generic/unplayable
  extension.
- **Normalize MIME type parameters before comparing against an allow-list.** A storage layer
  that compares content-type as an exact string against a list of "bare" types (e.g. `audio/ogg`)
  will reject a real-world value like `audio/ogg; codecs=opus` even though the base type is
  allowed. This is a silent-failure pattern: upload rejected, no error surfaced in the chat UI,
  media simply never appears. Strip parameters before the allow-list check, on both the
  server-side upload path and any browser-side recording path (which may produce its own
  parameterized MIME type, e.g. from a `MediaRecorder`).
- Retry the delivery-receipt-to-message match a few times with short backoff for media sends
  specifically (§2's race condition).

---

## 7. Process 3 — Inbox distinction between channels

### 7.1 Model: one thread per (contact, channel), not a merged timeline

When the same real-world contact can reach the business through more than one channel (e.g. an
official Cloud-API number **and** an unofficial QR-paired number), resist the temptation to
merge everything into one interleaved conversation. **Keep one conversation thread per
(tenant, contact, channel)** instead. Reasons this holds up under scrutiny:

- "Reply" becomes ambiguous in a merged view — which channel does a reply go out on? A
  routing bug here (see §4.3's callout) is the costliest class of bug in this whole feature.
- Channel-specific rules (a reply-window policy that only one channel type has, template
  messages that only exist on an official API, per-channel rate/volume limits) become
  impossible to reason about on a shared timeline — every rule needs an extra "which messages
  in this thread came from which channel" check.
- A merged view reads to the operator as "one relationship," which is true at the *contact*
  level and should stay true (shared tags, shared notes, shared deal/pipeline state, shared
  custom fields, shared history in a contact detail panel) — but is **false** at the
  *conversation-mechanics* level, where each channel genuinely has its own number, its own
  delivery guarantees, and its own capabilities.

The contact remains a single, deduplicated identity (dedupe by phone number, independent of how
many channels reach them). What splits is only the conversation/thread, not the contact,
tags, deal, or custom-field data — those stay shared by construction, with **zero
synchronization logic needed**, because there's nothing to synchronize when it was never
duplicated in the first place.

### 7.2 UI surfaces that need channel-awareness

- **Channel filter** in the inbox list ("All channels" / official channel / each instance by its
  tenant-chosen label), ideally persisted in the URL like any other inbox filter.
- **Per-row and per-thread-header badge** showing which channel a conversation belongs to —
  driven by actual channel metadata (color/icon stored on the channel record), not hard-coded
  per-type styling. **Only show the badge at all when the tenant has more than one channel** —
  repeating "Official WhatsApp" on every row when that's the only channel that exists is pure
  noise.
- **Capability-aware composer**: hide template/interactive-button controls on a channel whose
  capability matrix says it doesn't support them; show channel-specific affordances (e.g. a poll
  button) only where they apply. Never show a button that will error when clicked.
- **No reply-window countdown/banner on channels where it doesn't apply** — showing "session
  expires in 23h" on a channel that has no such policy is a confusing false alarm, not a helpful
  warning.
- **Cross-channel awareness in the contact detail panel**: "Also messaged you via: [other
  channel] (N messages)" with a jump-to-thread link. This single affordance is what makes the
  "one contact, multiple threads" model feel coherent to the operator instead of feeling like
  duplicate contacts — implement this before considering the feature done.
- **Starting a new conversation** with a contact that has no existing thread, when the tenant has
  more than one active channel: prompt for which channel to use. With exactly one channel
  configured, skip the prompt and go straight there.

### 7.3 A concrete failure mode worth designing against up front

In the source project, after conversations first became channel-scoped, two real,
easy-to-reproduce bugs appeared that are worth explicitly testing for in any port of this
design:

1. **A reply-window/session-timer feature that reads channel type from a relation the main
   conversation-list query never actually joins/embeds** — the field silently comes back
   undefined, falls back to a default channel type, and a thread on a channel with no
   reply-window policy displays a countdown that doesn't apply to it. If your ORM/query layer
   lazily omits related-table fields unless explicitly requested, verify the channel-type field
   is actually populated wherever a component reads it, with a test, not just a manual check.
2. **The exact same contact appearing as two identical-looking rows in the inbox list**, because
   they messaged through two channels and — before the badge (§7.2) existed — there was no visual
   distinction. This was initially misdiagnosed as a contact-deduplication bug; it wasn't (the
   underlying data was correct: one contact, two threads). The actual fix was purely
   presentational — add the badge. Don't chase a dedup bug that isn't there; check whether the
   "duplicate" rows differ by channel first.

---

## 8. Security & multi-tenancy checklist

- Deployment-wide/"global" provider credentials never reach client-side code and never leave
  your backend. `NEXT_PUBLIC_`-style env prefixes (or your stack's equivalent "bundled into the
  client bundle" convention) are explicitly forbidden for these.
- Per-instance tokens live in a secrets table with no direct read policy for any application
  role — only your backend/service-role context reads and decrypts them, in one single
  code path.
- Webhook authenticity relies on a compound check (§6.1) specifically because the vendor may not
  sign deliveries at all.
- Every instance-management and messaging route re-resolves the tenant/account id from the
  authenticated session and filters on it explicitly — don't trust a client-supplied tenant id.
  Row-level security (or your stack's equivalent) is a second layer, not a substitute for this.
- Namespaced instance naming (§5.2) prevents tenant-to-tenant collision on a shared vendor
  backend.
- Rate-limit instance-creation and QR-generation endpoints — they're cheap for an attacker to
  hammer and moderately expensive for the vendor backend to serve.
- Never persist, log, or cache a QR code image; short TTL; restrict who in your own UI can even
  view the connect dialog (owner/admin tier, not every role).
- Treat inbound media URLs the same way you'd treat any other user-influenced outbound URL your
  server fetches — reuse your existing SSRF guard if you have one for webhooks, rather than
  writing a second one for this path.

---

## 9. Condensed pitfall list (for quick pre-ship review)

| Symptom | Likely cause |
|---|---|
| A feature "just doesn't fire," no error anywhere | Event-name mismatch between subscribe and receive (§2), or a scheduler/cron dependency never configured at all — always fail loud, never silent |
| Every reply from this channel goes out the wrong number / wrong channel | A send call site resolving channel from a default instead of from the actual conversation (§4.3) |
| Duplicate messages appearing for the same inbound event | Missing idempotency check (§6.2), or an ID field read from the wrong nesting depth so your own echo-suppression can't match it (§2) |
| Media shows a static file icon / "unavailable" despite upload succeeding | MIME type sent with parameters against a bare-string allow-list (§6.5), or an encrypted-CDN URL that was never rejected (§2/§6.5) |
| A newly connected instance shows as "disconnected" in the UI | Reading connection-state-event booleans that don't exist on that event's shape; they live on a different endpoint (§2) |
| Two rows for what should be one contact | Not a dedup bug — check whether they differ by channel and whether a channel badge exists yet (§7.3) |
| A reply-window countdown shows on a channel that shouldn't have one | Channel-type field not actually loaded/joined where the UI reads it (§7.3) |
| Test suite is green but the feature is provably broken on a real device | Hand-written fixtures encoding the same wrong assumption as the code under test — verify fixtures fail against the known-broken version first, and prefer fixtures captured from real payloads (§2) |

---

## 10. Adapting this to a different stack/system

Everything in §3–§4 (channel/instance/secrets schema shape, adapter interface, capability
matrix, unified ingest/send paths) is deliberately framework-agnostic — reimplement the same
shapes in your target ORM/language. The vendor-specific facts in §2 are Evolution Go-specific
but the **pattern of vendor-doc unreliability** is not: budget a probe/spike phase for any
messaging-engine integration before trusting its docs. The UI/UX guidance in §5 and §7 is
product-shape guidance (what the owner-facing instance manager and the shared inbox need to
show) more than implementation guidance, and should translate to any frontend stack directly.

If the target system has **no pre-existing "official channel"** to coexist with (i.e. this QR
channel is the *only* channel), you can simplify: skip the channel-badge-only-when-plural rule
(§7.2) since it'll never apply, but still keep the `channel_id` on conversations from day one —
retrofitting it later, after conversations already exist without it, is a much more invasive
migration than including it up front.
