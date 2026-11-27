import { NextResponse } from 'next/server';
import { requireAiFeature } from '@/lib/ai/plan-gate';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit';
import { loadAiConfig } from '@/lib/ai/config';
import { buildConversationContext } from '@/lib/ai/context';
import { composeAgentTurn } from '@/lib/ai/compose';
import { documentIdsOf, toolUsageOf, turnSources } from '@/lib/ai/sources';
import { generateReply } from '@/lib/ai/generate';
import { logAiUsage } from '@/lib/ai/usage';
import { registerDraft } from '@/lib/ai/tuning/capture';
import { supabaseAdmin } from '@/lib/ai/admin-client';
import { AiError, partialOf } from '@/lib/ai/types';

/**
 * POST /api/ai/draft  (agent+)
 *
 * Body: { conversation_id }
 * Returns: { draft, draft_id? } — a suggested reply for the agent to edit +
 * send. `draft_id` links the draft to the message that is sent (the composer
 * sends it back as `ai_draft_id`), so an edit becomes a candidate example
 * (SPEC 089 F7).
 *
 * Uses the account's configured provider/key (BYO). Read-only: it never
 * sends or stores anything, just hands text back to the composer.
 */
export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('agent');
    // SPEC 089 D-20: ai_enabled em modo estrito (chave ausente = bloqueado).
    await requireAiFeature(accountId);

    const userLimit = checkRateLimit(`ai-draft:${userId}`, RATE_LIMITS.aiDraft);
    if (!userLimit.success) return rateLimitResponse(userLimit);
    // Also cap the whole team's draws on the shared BYO provider key.
    const accountLimit = checkRateLimit(
      `ai-draft-acct:${accountId}`,
      RATE_LIMITS.aiDraftAccount
    );
    if (!accountLimit.success) return rateLimitResponse(accountLimit);

    const body = await request.json().catch(() => null);
    const conversationId =
      body && typeof body.conversation_id === 'string'
        ? body.conversation_id
        : '';
    if (!conversationId) {
      return NextResponse.json(
        { error: 'conversation_id is required' },
        { status: 400 }
      );
    }

    // RLS scopes the SSR client to the caller's account, so a missing
    // row means "not yours / not found" either way.
    const { data: conversation, error: convErr } = await supabase
      .from('conversations')
      .select('id')
      .eq('id', conversationId)
      .maybeSingle();
    if (convErr) {
      console.error('[ai/draft] conversation lookup error:', convErr);
      return NextResponse.json(
        { error: 'Failed to load conversation' },
        { status: 500 }
      );
    }
    if (!conversation) {
      return NextResponse.json(
        { error: 'Conversation not found' },
        { status: 404 }
      );
    }

    const config = await loadAiConfig(supabase, accountId).catch((err) => {
      // Decrypt failure — surface distinctly from "not configured".
      console.error('[ai/draft] loadAiConfig error:', err);
      throw new AiError('Stored API key could not be decrypted.', {
        code: 'key_decrypt_failed',
        status: 400,
      });
    });
    if (!config) {
      return NextResponse.json(
        {
          error:
            'AI assistant is not set up. Enable it in Settings → AI Assistant.',
          code: 'ai_not_configured',
        },
        { status: 400 }
      );
    }

    const messages = await buildConversationContext(supabase, conversationId);
    // Nothing to draft from — a brand-new thread with no customer text
    // would otherwise produce a nonsensical reply-to-nothing.
    if (messages.length === 0) {
      return NextResponse.json(
        {
          error: 'No messages to draft from yet.',
          code: 'no_messages',
        },
        { status: 400 }
      );
    }

    // Knowledge (best-effort), channel and system prompt in one place.
    const turn = await composeAgentTurn({
      db: supabase,
      accountId,
      config,
      mode: 'draft',
      messages,
      conversationId,
    });

    // D-18: the draft only ever gets read tools (compose.ts narrows them).
    let result: Awaited<ReturnType<typeof generateReply>>;
    try {
      result = await generateReply({
        config,
        systemPrompt: turn.systemPrompt,
        messages: turn.messages,
        tools: turn.tools,
        toolContext: turn.toolContext,
        fallbackSystemPrompt: turn.fallbackSystemPrompt,
      });
    } catch (genErr) {
      // A tool turn that fails midway has already spent tokens: record them
      // (best effort, like the success path) before the error is answered.
      const partial = partialOf(genErr);
      if (partial) {
        try {
          void logAiUsage(supabaseAdmin(), {
            accountId,
            conversationId,
            mode: 'draft',
            provider: config.provider,
            model: config.model,
            usage: partial.usage,
            steps: partial.steps,
            toolCalls: partial.toolCalls.length,
          });
        } catch (logErr) {
          console.error('[ai/draft] partial usage log skipped:', logErr);
        }
      }
      throw genErr;
    }
    const { text, usage } = result;

    // Record spend on the account's BYO key. Best-effort + via the
    // service role (the log has no `authenticated` INSERT policy). This
    // must not fail or delay the draft the agent is waiting on, so:
    //  - the whole thing is wrapped (constructing the admin client throws
    //    if the service-role key is unset — that must not 500 the draft);
    //  - it's fire-and-forget (`void`), not awaited, so the response
    //    isn't held for a DB round-trip.
    try {
      void logAiUsage(supabaseAdmin(), {
        accountId,
        conversationId,
        mode: 'draft',
        provider: config.provider,
        model: config.model,
        usage,
        knowledgeDocumentIds: documentIdsOf(
          turnSources(turn.sources, result.toolSources)
        ),
        ...toolUsageOf(result),
      });
    } catch (logErr) {
      console.error('[ai/draft] usage log skipped:', logErr);
    }

    // A tool turn can end without text (4 steps used): nothing to suggest.
    if (!text) {
      return NextResponse.json(
        {
          error: 'The assistant could not produce a draft.',
          code: 'empty_response',
        },
        { status: 502 }
      );
    }

    // SPEC 089 F7: remember the (masked) draft so the send can tell whether
    // the attendant edited it. Best-effort: without the id the draft is still
    // served, it just cannot be linked to the message that goes out.
    let draftId: string | null = null;
    try {
      draftId = await registerDraft(supabaseAdmin(), {
        accountId,
        conversationId,
        userId,
        messages,
        draftText: text,
      });
    } catch (regErr) {
      console.error('[ai/draft] draft register skipped:', regErr);
    }

    return NextResponse.json({
      draft: text,
      ...(draftId ? { draft_id: draftId } : {}),
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
