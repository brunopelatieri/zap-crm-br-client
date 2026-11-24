// ============================================================
// POST /api/account/meta-relay/test  (SPEC 088 §5.3)
//
// Connectivity test. Uses ONLY the saved URL and key (the body is
// ignored: the server must not probe arbitrary addresses on request),
// works with the relay switched off, never touches the failure
// counters, and answers with `{ ok, status, duration_ms, error }` —
// never the target's response body or headers.
// ============================================================

import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { sendRelayTest } from '@/lib/webhooks/meta-relay';

export async function POST() {
  try {
    const ctx = await requireRole('admin');

    // Per ACCOUNT: every admin of the account shares the budget.
    const limit = checkRateLimit(
      `metaRelayTest:${ctx.accountId}`,
      RATE_LIMITS.metaRelayTest
    );
    if (!limit.success) return rateLimitResponse(limit);

    const result = await sendRelayTest(supabaseAdmin(), ctx.accountId);
    if (!result) {
      return NextResponse.json(
        { error: 'No relay configured' },
        { status: 404 }
      );
    }
    return NextResponse.json({
      ok: result.ok,
      status: result.status,
      duration_ms: result.duration_ms,
      error: result.error,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
