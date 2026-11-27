import { NextResponse } from 'next/server';
import { getRun, summarizeResults } from '@/lib/ai/tuning/eval';
import {
  UUID_RE,
  badRequest,
  tuningErrorResponse,
  tuningGuard,
} from '@/lib/ai/tuning/route-helpers';

type Params = { params: Promise<{ id: string }> };

/**
 * GET /api/ai/eval/runs/[id]  (admin+) → { run, results, summary }
 *
 * One run with the result of each case. A run `running` for too long is
 * reported as `error` (its worker was lost).
 */
export async function GET(_request: Request, { params }: Params) {
  try {
    const g = await tuningGuard('ai-eval-runs');
    if (!g.ok) return g.response;
    const { id } = await params;
    if (!UUID_RE.test(id)) return badRequest('Invalid id.');
    const { run, results } = await getRun(g.supabase, g.accountId, id);
    return NextResponse.json({
      run,
      results,
      summary: summarizeResults(results),
    });
  } catch (err) {
    return tuningErrorResponse(err);
  }
}
