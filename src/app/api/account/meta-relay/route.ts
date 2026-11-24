// ============================================================
// /api/account/meta-relay  (SPEC 088 §5.1)
//
//   GET    — the account's relay config (never the key).
//   PUT    — create or update `{ url, is_enabled }`. On CREATION the
//            signing key is generated and returned ONCE.
//   DELETE — remove the config (URL and key).
//
// Dashboard endpoints: cookie session, admin+ (D-8). The table has RLS
// on and no policy, so after the role check the handlers use the admin
// client — and every query is filtered by the SESSION's `accountId`,
// never by anything the caller sends.
// ============================================================

import { NextResponse } from 'next/server';

import { recordActivity } from '@/lib/activity/record';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { normalizeWebhookUrl } from '@/lib/webhooks/endpoints';
import {
  planRelaySaveActivity,
  relayHost,
} from '@/lib/webhooks/meta-relay-activity';
import {
  deleteRelayConfig,
  readRelayConfig,
  saveRelayConfig,
} from '@/lib/webhooks/meta-relay-config';
import { isDeliverableUrl } from '@/lib/webhooks/ssrf';

const MAX_URL_LEN = 2048;

function hasUrlCredentials(url: string): boolean {
  const u = new URL(url);
  return u.username !== '' || u.password !== '';
}

export async function GET() {
  try {
    const ctx = await requireRole('admin');
    const relay = await readRelayConfig(supabaseAdmin(), ctx.accountId);
    return NextResponse.json({ relay });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function PUT(request: Request) {
  try {
    const ctx = await requireRole('admin');

    const limit = checkRateLimit(
      `admin:metaRelaySave:${ctx.userId}`,
      RATE_LIMITS.adminAction
    );
    if (!limit.success) return rateLimitResponse(limit);

    const body = (await request.json().catch(() => null)) as {
      url?: unknown;
      is_enabled?: unknown;
    } | null;

    if (typeof body?.is_enabled !== 'boolean') {
      return NextResponse.json(
        { error: "'is_enabled' must be a boolean" },
        { status: 400 }
      );
    }

    const url = normalizeWebhookUrl(body.url);
    // Node's fetch refuses URLs with embedded credentials, so every delivery
    // would fail and the relay would switch itself off: reject at save time.
    if (!url || url.length > MAX_URL_LEN || hasUrlCredentials(url)) {
      return NextResponse.json(
        { error: "'url' must be a valid https:// URL" },
        { status: 400 }
      );
    }
    // Same SSRF guard as every delivery (it runs again at send time: DNS
    // can change). Failing here makes the error show up when saving.
    if (!(await isDeliverableUrl(url))) {
      return NextResponse.json(
        { error: "'url' must point to a public host" },
        { status: 400 }
      );
    }

    const db = supabaseAdmin();
    const prev = await readRelayConfig(db, ctx.accountId);
    const result = await saveRelayConfig(db, ctx.accountId, {
      url,
      isEnabled: body.is_enabled,
      userId: ctx.userId,
    });

    const label = relayHost(result.relay.url);
    for (const action of planRelaySaveActivity(prev, {
      url: result.relay.url,
      is_enabled: result.relay.is_enabled,
    })) {
      await recordActivity(ctx.supabase, {
        accountId: ctx.accountId,
        resourceType: 'webhook',
        action,
        resourceLabel: label,
        actor: { kind: 'user', userId: ctx.userId, role: ctx.role },
      });
    }

    const created = result.secret !== undefined;
    return NextResponse.json(
      created
        ? // Plaintext key — shown to the admin exactly once.
          { relay: result.relay, secret: result.secret }
        : { relay: result.relay },
      { status: created ? 201 : 200 }
    );
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function DELETE() {
  try {
    const ctx = await requireRole('admin');

    const limit = checkRateLimit(
      `admin:metaRelayDelete:${ctx.userId}`,
      RATE_LIMITS.adminAction
    );
    if (!limit.success) return rateLimitResponse(limit);

    const db = supabaseAdmin();
    // Read before deleting: the host is what the activity row records.
    const prev = await readRelayConfig(db, ctx.accountId);
    const removed = await deleteRelayConfig(db, ctx.accountId);
    if (!removed) {
      return NextResponse.json(
        { error: 'No relay configured' },
        { status: 404 }
      );
    }

    await recordActivity(ctx.supabase, {
      accountId: ctx.accountId,
      resourceType: 'webhook',
      action: 'webhook.relay_removed',
      resourceLabel: prev ? relayHost(prev.url) : null,
      actor: { kind: 'user', userId: ctx.userId, role: ctx.role },
    });

    return NextResponse.json({ removed: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
