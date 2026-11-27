import { NextResponse } from 'next/server';
import { createCase, listCases } from '@/lib/ai/tuning/eval';
import {
  badRequest,
  readJson,
  tuningErrorResponse,
  tuningGuard,
} from '@/lib/ai/tuning/route-helpers';
import {
  EVAL_MAX_CASES_PER_ACCOUNT,
  EVAL_MAX_CASES_PER_RUN,
} from '@/lib/ai/tuning/types';

/**
 * GET /api/ai/eval/cases  (admin+)
 *   → { cases, limits: { max_cases, max_cases_per_run } }
 */
export async function GET() {
  try {
    const g = await tuningGuard('ai-eval-cases');
    if (!g.ok) return g.response;
    const cases = await listCases(g.supabase, g.accountId);
    return NextResponse.json({
      cases,
      limits: {
        max_cases: EVAL_MAX_CASES_PER_ACCOUNT,
        max_cases_per_run: EVAL_MAX_CASES_PER_RUN,
      },
    });
  } catch (err) {
    return tuningErrorResponse(err);
  }
}

/**
 * POST /api/ai/eval/cases  (admin+)
 *   { title, conversation: [{ role: 'user'|'assistant', content }],
 *     expect_handoff?: boolean, expected_notes?: string }  → { case }
 *
 * A reference conversation and what the agent should do with it. The text is
 * masked of personal data before it is stored; the conversation must end
 * with a customer message.
 */
export async function POST(request: Request) {
  try {
    const g = await tuningGuard('ai-eval-cases-write');
    if (!g.ok) return g.response;
    const body = await readJson(request);
    if (!body) return badRequest('Invalid JSON body.');
    const created = await createCase(
      g.supabase,
      { accountId: g.accountId, userId: g.userId },
      {
        title: body.title,
        conversation: body.conversation,
        expectHandoff: body.expect_handoff,
        expectedNotes: body.expected_notes,
      }
    );
    return NextResponse.json({ case: created }, { status: 201 });
  } catch (err) {
    return tuningErrorResponse(err);
  }
}
