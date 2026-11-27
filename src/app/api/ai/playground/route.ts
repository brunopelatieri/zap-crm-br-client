import { NextResponse } from 'next/server';
import { requireAiFeature } from '@/lib/ai/plan-gate';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit';
import { loadAiConfig } from '@/lib/ai/config';
import { supabaseAdmin } from '@/lib/ai/admin-client';
import { composeAgentTurn } from '@/lib/ai/compose';
import { generateReply } from '@/lib/ai/generate';
import { turnSources } from '@/lib/ai/sources';
import { AiError, type ChatMessage } from '@/lib/ai/types';

// Keep the tested transcript bounded, mirroring the live context window.
const MAX_TURNS = 20;

/**
 * POST /api/ai/playground  (agent+)
 *
 * Test-chat with the account's agent WITHOUT touching WhatsApp. Runs the
 * exact same path the auto-reply bot uses — knowledge-base retrieval +
 * `auto_reply` system prompt + the configured provider — so what you see
 * here is what a real customer would get. Reads the config even when the
 * master switch is off (requireActive:false) so you can try it before
 * going live. Stateless: the client sends the running transcript each turn.
 */
export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('agent');
    // SPEC 089 D-20: ai_enabled em modo estrito (chave ausente = bloqueado).
    await requireAiFeature(accountId);

    const limit = checkRateLimit(
      `ai-playground:${userId}`,
      RATE_LIMITS.aiDraft
    );
    if (!limit.success) return rateLimitResponse(limit);
    // Per account too, like the draft (SPEC 089 F8): every agent of the team
    // can open the playground, and each turn spends up to 4 model calls on
    // the account's own key.
    const accountLimit = checkRateLimit(
      `ai-playground-acct:${accountId}`,
      RATE_LIMITS.aiDraftAccount
    );
    if (!accountLimit.success) return rateLimitResponse(accountLimit);

    const body = await request.json().catch(() => null);
    const rawMessages = Array.isArray(body?.messages) ? body.messages : null;
    if (!rawMessages) {
      return NextResponse.json(
        { error: 'messages is required' },
        { status: 400 }
      );
    }

    const messages: ChatMessage[] = rawMessages
      .filter(
        (m: unknown): m is ChatMessage =>
          !!m &&
          typeof m === 'object' &&
          ((m as ChatMessage).role === 'user' ||
            (m as ChatMessage).role === 'assistant') &&
          typeof (m as ChatMessage).content === 'string' &&
          (m as ChatMessage).content.trim().length > 0
      )
      .slice(-MAX_TURNS);

    if (messages.length === 0) {
      return NextResponse.json(
        { error: 'Send a message to test the agent.' },
        { status: 400 }
      );
    }

    const config = await loadAiConfig(supabaseAdmin(), accountId, {
      requireActive: false,
    }).catch((err) => {
      console.error('[ai/playground] loadAiConfig error:', err);
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

    const turn = await composeAgentTurn({
      db: supabase,
      accountId,
      config,
      mode: 'playground',
      messages,
    });

    // SPEC 089 F4 / D-18: the account's enabled tools; write tools run in
    // simulation (nothing is written), reads run for real. No conversation
    // here, so contact tools answer `no_contact`.
    const result = await generateReply({
      config,
      systemPrompt: turn.systemPrompt,
      messages: turn.messages,
      tools: turn.tools,
      toolContext: turn.toolContext,
      fallbackSystemPrompt: turn.fallbackSystemPrompt,
    });
    // Sources (D-14) and tool calls: what grounded this turn, for the
    // admin only.
    return NextResponse.json({
      reply: result.text,
      handoff: result.handoff,
      sources: turnSources(turn.sources, result.toolSources),
      tool_calls: result.toolCalls ?? [],
      steps: result.steps ?? 1,
      ...(result.handoffRequest
        ? { handoff_request: result.handoffRequest }
        : {}),
      ...(result.toolsDisabled ? { tools_disabled: result.toolsDisabled } : {}),
      ...(result.stopReason === 'step_limit'
        ? { stop_reason: 'step_limit' }
        : {}),
    });
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
