// ============================================================
// POST /api/account/meta-relay/secret  (SPEC 088 §5.1)
//
// Generate a new signing key. The previous one stops signing
// immediately; the new plaintext is returned exactly ONCE.
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
import { relayHost } from '@/lib/webhooks/meta-relay-activity';
import {
  readRelayConfig,
  rotateRelaySecret,
} from '@/lib/webhooks/meta-relay-config';

export async function POST() {
  try {
    const ctx = await requireRole('admin');

    const limit = checkRateLimit(
      `admin:metaRelaySecret:${ctx.userId}`,
      RATE_LIMITS.adminAction
    );
    if (!limit.success) return rateLimitResponse(limit);

    const db = supabaseAdmin();
    // Read BEFORE rotating: a failure here must not happen after the old key
    // was already invalidated, or the new one would never reach the admin.
    const current = await readRelayConfig(db, ctx.accountId);
    const secret = await rotateRelaySecret(db, ctx.accountId, ctx.userId);
    if (secret === null) {
      return NextResponse.json(
        { error: 'No relay configured' },
        { status: 404 }
      );
    }

    await recordActivity(ctx.supabase, {
      accountId: ctx.accountId,
      resourceType: 'webhook',
      action: 'webhook.relay_secret_rotated',
      resourceLabel: current ? relayHost(current.url) : null,
      actor: { kind: 'user', userId: ctx.userId, role: ctx.role },
    });

    // Plaintext key — shown to the admin exactly once.
    return NextResponse.json({ secret });
  } catch (err) {
    return toErrorResponse(err);
  }
}
