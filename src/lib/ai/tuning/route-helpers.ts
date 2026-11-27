import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { requireAiFeature } from '@/lib/ai/plan-gate';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit';
import { AiError } from '@/lib/ai/types';
import { TuningError } from './types';

// ============================================================
// Common pieces of the `/api/ai/examples/**` and `/api/ai/eval/**` routes
// (SPEC 089 F7). Messages are in English (it is `/api/**`); `code` is
// stable and the screen translates it.
// ============================================================

export const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type TuningGuard =
  | {
      ok: true;
      supabase: SupabaseClient;
      accountId: string;
      userId: string;
    }
  | { ok: false; response: Response };

/**
 * The gate every tuning route starts with: admin+ (the screen holds a slice
 * of customer conversations, masked), `ai_enabled` in the plan, and a per-
 * user rate limit on `bucket`. Throws like `requireRole` on a missing
 * session or role (the route's catch maps it).
 */
export async function tuningGuard(
  bucket: string,
  limit: { limit: number; windowMs: number } = RATE_LIMITS.adminAction
): Promise<TuningGuard> {
  const { supabase, accountId, userId } = await requireRole('admin');
  // SPEC 089 D-20: ai_enabled em modo estrito (chave ausente = bloqueado).
  await requireAiFeature(accountId);
  const rl = checkRateLimit(`${bucket}:${userId}`, limit);
  if (!rl.success) return { ok: false, response: rateLimitResponse(rl) };
  return { ok: true, supabase, accountId, userId };
}

/** Map any error of a tuning route to its JSON response. */
export function tuningErrorResponse(err: unknown): Response {
  if (err instanceof TuningError) {
    return NextResponse.json(
      { error: err.message, code: err.code },
      { status: err.status }
    );
  }
  if (err instanceof AiError) {
    return NextResponse.json(
      { error: err.message, code: err.code },
      { status: err.status }
    );
  }
  return toErrorResponse(err);
}

export async function readJson(
  request: Request
): Promise<Record<string, unknown> | null> {
  const body = await request.json().catch(() => null);
  return body && typeof body === 'object' && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : null;
}

export function badRequest(message: string, code = 'invalid_input') {
  return NextResponse.json({ error: message, code }, { status: 400 });
}
