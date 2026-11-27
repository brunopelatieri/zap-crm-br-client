import { NextResponse } from 'next/server';
import { requireAiFeature } from '@/lib/ai/plan-gate';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import {
  defaultCustomToolsDeps,
  simulateCustomTool,
} from '@/lib/ai/tools/custom-tools';
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit';

type Params = { params: Promise<{ id: string }> };

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * POST /api/ai/custom-tools/[id]/test  (admin+)  { arguments }
 *   → { simulation: { tool, would_call: { method, url, arguments }, risk, header_names, called: false } }
 *
 * A SIMULATION: the arguments are checked against the tool's schema and the
 * call is described (method, the URL without its query string, the
 * arguments). It never makes the request and never reads the headers, so it
 * cannot be used to probe an address.
 */
export async function POST(request: Request, { params }: Params) {
  try {
    const { accountId, userId } = await requireRole('admin');
    await requireAiFeature(accountId);
    const limit = checkRateLimit(
      `ai-custom-tools:${userId}`,
      RATE_LIMITS.adminAction
    );
    if (!limit.success) return rateLimitResponse(limit);

    const { id } = await params;
    if (!UUID_RE.test(id)) {
      return NextResponse.json({ error: 'Tool not found.' }, { status: 404 });
    }
    const body = await request.json().catch(() => null);
    const args =
      body && typeof body === 'object' && !Array.isArray(body)
        ? (body as { arguments?: unknown }).arguments
        : undefined;
    const deps = await defaultCustomToolsDeps();
    const result = await simulateCustomTool(deps.db, accountId, id, args ?? {});
    if (!result.ok) {
      return NextResponse.json(
        { error: result.error, code: result.code },
        { status: result.status }
      );
    }
    return NextResponse.json({ simulation: result.value });
  } catch (err) {
    return toErrorResponse(err);
  }
}
