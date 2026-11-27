import { NextResponse } from 'next/server';
import { loadEmbeddingsTarget } from '@/lib/ai/config';
import { searchExamples } from '@/lib/ai/tuning/examples';
import { maskAndLimit } from '@/lib/ai/tuning/mask';
import {
  badRequest,
  readJson,
  tuningErrorResponse,
  tuningGuard,
} from '@/lib/ai/tuning/route-helpers';
import {
  EXAMPLES_MAX_DISTANCE,
  EXAMPLE_CUSTOMER_MAX_CHARS,
} from '@/lib/ai/tuning/types';
import { RATE_LIMITS } from '@/lib/rate-limit';

/**
 * POST /api/ai/examples/search  (admin+)   { query, max_distance? }
 *
 * "Test examples": which approved examples would enter the prompt for this
 * customer message, with their distance. Same search as the agent's
 * (`searchExamples`); no LLM call. Spends one embedding on the account's key.
 */
export async function POST(request: Request) {
  try {
    const g = await tuningGuard('ai-examples-search', RATE_LIMITS.adminAction);
    if (!g.ok) return g.response;
    const body = await readJson(request);
    const raw = typeof body?.query === 'string' ? body.query : '';
    const query = maskAndLimit(raw, EXAMPLE_CUSTOMER_MAX_CHARS);
    if (!query) return badRequest('query is required.');

    let maxDistance = EXAMPLES_MAX_DISTANCE;
    if (body?.max_distance !== undefined) {
      const n = Number(body.max_distance);
      if (!Number.isFinite(n) || n < 0 || n > 2) {
        return badRequest('max_distance must be between 0 and 2.');
      }
      maxDistance = n;
    }

    const { target } = await loadEmbeddingsTarget(g.supabase, g.accountId);
    const result = await searchExamples(
      g.supabase,
      g.accountId,
      { embeddingsTarget: target },
      query,
      { maxDistance }
    );
    return NextResponse.json({
      examples: result.examples,
      none: result.none,
      failed: result.failed,
      max_distance: maxDistance,
      embeddings_available: !!target,
    });
  } catch (err) {
    return tuningErrorResponse(err);
  }
}
