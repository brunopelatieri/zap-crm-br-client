import { NextResponse } from 'next/server';
import { requireAiFeature } from '@/lib/ai/plan-gate';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit';
import { promptChanged, recordPromptVersion } from '@/lib/ai/prompt-versions';

/**
 * POST /api/ai/prompt-versions/:id/restore  (admin+)
 *
 * Make an older version the live `system_prompt`. History stays
 * append-only: the restore itself is recorded as a new version, noted
 * with the id it came from. Needs an existing AI config (the prompt lives
 * on `ai_configs`).
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { supabase, accountId, userId } = await requireRole('admin');
    // SPEC 089 D-20: ai_enabled em modo estrito (chave ausente = bloqueado).
    await requireAiFeature(accountId);
    const limit = checkRateLimit(
      `ai-prompt-restore:${userId}`,
      RATE_LIMITS.adminAction
    );
    if (!limit.success) return rateLimitResponse(limit);

    const { id } = await params;

    const { data: version, error: vErr } = await supabase
      .from('ai_prompt_versions')
      .select('id, system_prompt')
      .eq('id', id)
      .eq('account_id', accountId)
      .maybeSingle();
    if (vErr) {
      console.error('[ai/prompt-versions restore] lookup error:', vErr);
      return NextResponse.json(
        { error: 'Failed to load the version' },
        { status: 500 }
      );
    }
    if (!version) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }

    const { data: config } = await supabase
      .from('ai_configs')
      .select('system_prompt')
      .eq('account_id', accountId)
      .maybeSingle();
    if (!config) {
      return NextResponse.json(
        { error: 'AI is not configured yet', code: 'ai_not_configured' },
        { status: 400 }
      );
    }

    const restored = version.system_prompt.trim() || null;
    if (!promptChanged(config.system_prompt, restored)) {
      return NextResponse.json({ success: true, changed: false });
    }

    const { error: upErr } = await supabase
      .from('ai_configs')
      .update({ system_prompt: restored })
      .eq('account_id', accountId);
    if (upErr) {
      console.error('[ai/prompt-versions restore] update error:', upErr);
      return NextResponse.json(
        { error: 'Failed to restore the prompt' },
        { status: 500 }
      );
    }
    await recordPromptVersion(supabase, {
      accountId,
      systemPrompt: restored,
      note: `restore:${version.id}`,
      source: 'panel',
      createdBy: userId,
    });
    return NextResponse.json({ success: true, changed: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
