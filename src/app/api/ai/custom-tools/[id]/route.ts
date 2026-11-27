import { NextResponse } from 'next/server';
import { requireAiFeature } from '@/lib/ai/plan-gate';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import {
  defaultCustomToolsDeps,
  deleteCustomTool,
  updateCustomTool,
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
 * PATCH  /api/ai/custom-tools/[id]  (admin+)  → { tool }
 * DELETE /api/ai/custom-tools/[id]  (admin+)  → { id }
 *
 * Only fields sent change. `headers` replaces the whole set by name; a
 * `value` left out keeps the stored one. Turning a tool on is `is_active`.
 * Deleting a tool is allowed even when the plan no longer has `ai_enabled`
 * (cleanup), like the knowledge base.
 */
export async function PATCH(request: Request, { params }: Params) {
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
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return NextResponse.json(
        { error: 'A JSON object is required' },
        { status: 400 }
      );
    }
    const result = await updateCustomTool(
      await defaultCustomToolsDeps(),
      accountId,
      id,
      body
    );
    if (!result.ok) {
      return NextResponse.json(
        { error: result.error, code: result.code },
        { status: result.status }
      );
    }
    return NextResponse.json({ tool: result.value });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function DELETE(_request: Request, { params }: Params) {
  try {
    const { accountId, userId } = await requireRole('admin');
    const limit = checkRateLimit(
      `ai-custom-tools:${userId}`,
      RATE_LIMITS.adminAction
    );
    if (!limit.success) return rateLimitResponse(limit);

    const { id } = await params;
    if (!UUID_RE.test(id)) {
      return NextResponse.json({ error: 'Tool not found.' }, { status: 404 });
    }
    const deps = await defaultCustomToolsDeps();
    const result = await deleteCustomTool(deps.db, accountId, id);
    if (!result.ok) {
      return NextResponse.json(
        { error: result.error, code: result.code },
        { status: result.status }
      );
    }
    return NextResponse.json(result.value);
  } catch (err) {
    return toErrorResponse(err);
  }
}
