import { NextResponse } from 'next/server';
import { requireAiFeature } from '@/lib/ai/plan-gate';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit';
import { loadAiConfig } from '@/lib/ai/config';
import { callProvider } from '@/lib/ai/generate';
import { AiError } from '@/lib/ai/types';

/**
 * POST /api/ai/tools/test  (admin+)
 *
 * "Test tools" (SPEC 089 §5.3 rule 5): does the configured model accept
 * tool calls at all? One tiny request offers a harmless probe tool and
 * reports whether the model called it. It runs nothing in the CRM and
 * touches no customer data; it spends a few tokens of the account's own
 * key, hence admin-only and rate limited. The simulated run of the real
 * tools (what they WOULD do) is the Playground.
 *
 *   { status: 'supported' }    the model called the probe tool
 *   { status: 'no_call' }      the request was accepted but the model did
 *                              not call it (inconclusive; try the Playground)
 *   { status: 'unsupported' }  the provider refused tools for this model
 */
export async function POST() {
  try {
    const { supabase, accountId, userId } = await requireRole('admin');
    await requireAiFeature(accountId);
    const limit = checkRateLimit(
      `ai-tools-test:${userId}`,
      RATE_LIMITS.adminAction
    );
    if (!limit.success) return rateLimitResponse(limit);

    const config = await loadAiConfig(supabase, accountId, {
      requireActive: false,
    }).catch((err) => {
      console.error('[ai/tools/test] loadAiConfig error:', err);
      throw new AiError('Stored API key could not be decrypted.', {
        code: 'key_decrypt_failed',
        status: 400,
      });
    });
    if (!config) {
      return NextResponse.json(
        {
          error: 'No agent configured yet. Add your provider key in Setup.',
          code: 'ai_not_configured',
        },
        { status: 400 }
      );
    }

    try {
      const res = await callProvider(config, {
        systemPrompt:
          'You are a connectivity probe. Call the ping tool exactly once, with no arguments. Do not write any other text.',
        messages: [{ role: 'user', content: 'ping' }],
        tools: [
          {
            name: 'ping',
            description: 'Returns pong. Takes no arguments.',
            parameters: {
              type: 'object',
              properties: {},
              additionalProperties: false,
            },
          },
        ],
        timeoutMs: 20_000,
      });
      const called = (res.toolCalls ?? []).some((c) => c.name === 'ping');
      return NextResponse.json({
        status: called ? 'supported' : 'no_call',
        provider: config.provider,
        model: config.model,
      });
    } catch (err) {
      if (err instanceof AiError && err.code === 'tools_unsupported') {
        return NextResponse.json({
          status: 'unsupported',
          provider: config.provider,
          model: config.model,
        });
      }
      throw err;
    }
  } catch (err) {
    if (err instanceof AiError) {
      return NextResponse.json(
        { error: err.message, code: err.code },
        { status: err.status }
      );
    }
    return toErrorResponse(err);
  }
}
