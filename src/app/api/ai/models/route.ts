import { NextResponse } from 'next/server';
import { requireAiFeature } from '@/lib/ai/plan-gate';
import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account';
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit';
import { getOpenRouterModels, searchModels } from '@/lib/ai/openrouter-models';

/**
 * GET /api/ai/models?provider=openrouter&q=  (any member)
 *
 * Proxy for OpenRouter's public model catalog, cached for an hour, used
 * only to SUGGEST a model on the settings screen (SPEC 089 D-2) — the
 * model field stays free text. Fixed upstream host, no redirects, no
 * user-controlled URL.
 */
export async function GET(request: Request) {
  try {
    const { userId, accountId } = await getCurrentAccount();
    // SPEC 089 D-20: ai_enabled em modo estrito (chave ausente = bloqueado).
    await requireAiFeature(accountId);

    const limit = checkRateLimit(`ai-models:${userId}`, RATE_LIMITS.aiModels);
    if (!limit.success) return rateLimitResponse(limit);

    const url = new URL(request.url);
    if (url.searchParams.get('provider') !== 'openrouter') {
      return NextResponse.json(
        { error: 'Only provider "openrouter" has a model catalog' },
        { status: 400 }
      );
    }
    const q = (url.searchParams.get('q') ?? '').slice(0, 100);

    try {
      const models = await getOpenRouterModels();
      return NextResponse.json({ models: searchModels(models, q) });
    } catch (err) {
      console.error('[ai/models GET] catalog unavailable:', err);
      return NextResponse.json(
        { error: 'The model catalog is unavailable right now' },
        { status: 502 }
      );
    }
  } catch (err) {
    return toErrorResponse(err);
  }
}
