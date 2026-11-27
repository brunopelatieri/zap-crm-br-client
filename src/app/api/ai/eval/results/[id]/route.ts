import { NextResponse } from 'next/server';
import { setVerdict } from '@/lib/ai/tuning/eval';
import {
  UUID_RE,
  badRequest,
  readJson,
  tuningErrorResponse,
  tuningGuard,
} from '@/lib/ai/tuning/route-helpers';

type Params = { params: Promise<{ id: string }> };

/**
 * PATCH /api/ai/eval/results/[id]  (admin+)   { verdict: 'pass'|'fail'|null }
 *
 * The human judgment of one result (P-3: no LLM judge). `null` clears it.
 */
export async function PATCH(request: Request, { params }: Params) {
  try {
    const g = await tuningGuard('ai-eval-verdict');
    if (!g.ok) return g.response;
    const { id } = await params;
    if (!UUID_RE.test(id)) return badRequest('Invalid id.');
    const body = await readJson(request);
    if (!body || !('verdict' in body))
      return badRequest('verdict is required.');
    const result = await setVerdict(
      g.supabase,
      { accountId: g.accountId, userId: g.userId },
      id,
      body.verdict
    );
    return NextResponse.json({ result });
  } catch (err) {
    return tuningErrorResponse(err);
  }
}
