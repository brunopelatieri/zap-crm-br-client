import { NextResponse } from 'next/server';
import { requireAiFeature } from '@/lib/ai/plan-gate';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import {
  createCustomTool,
  defaultCustomToolsDeps,
  listCustomTools,
  MAX_CUSTOM_TOOLS,
} from '@/lib/ai/tools/custom-tools';
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit';

/**
 * GET  /api/ai/custom-tools   (admin+)  → { tools, max_tools, migration_pending }
 * POST /api/ai/custom-tools   (admin+)  → 201 { tool }
 *
 * The account's own HTTP tools for the agent (SPEC 089 F6,
 * `ai_custom_tools`, migration 107). The logic lives in
 * `src/lib/ai/tools/custom-tools.ts` (the public API and the MCP of SPEC 090
 * reuse it). The headers are WRITE-ONLY: a request carries them as
 * `[{ name, value }]`, they are stored encrypted, and no response ever has
 * a value: a tool shows `header_names` and `has_headers`.
 */
export async function GET() {
  try {
    const { supabase, accountId } = await requireRole('admin');
    await requireAiFeature(accountId);
    // The RLS client: admin+ read their own rows, and the column grant hides
    // `headers_encrypted` from it by construction.
    const result = await listCustomTools(supabase, accountId);
    if (!result.ok) {
      if (result.code === 'migration_pending') {
        return NextResponse.json({
          tools: [],
          max_tools: MAX_CUSTOM_TOOLS,
          migration_pending: true,
        });
      }
      return NextResponse.json(
        { error: result.error, code: result.code },
        { status: result.status }
      );
    }
    return NextResponse.json({
      tools: result.value,
      max_tools: MAX_CUSTOM_TOOLS,
      migration_pending: false,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(request: Request) {
  try {
    const { accountId, userId } = await requireRole('admin');
    await requireAiFeature(accountId);
    const limit = checkRateLimit(
      `ai-custom-tools:${userId}`,
      RATE_LIMITS.adminAction
    );
    if (!limit.success) return rateLimitResponse(limit);

    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return NextResponse.json(
        { error: 'A JSON object is required' },
        { status: 400 }
      );
    }
    const result = await createCustomTool(
      await defaultCustomToolsDeps(),
      accountId,
      userId,
      body
    );
    if (!result.ok) {
      return NextResponse.json(
        { error: result.error, code: result.code },
        { status: result.status }
      );
    }
    return NextResponse.json({ tool: result.value }, { status: 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}
