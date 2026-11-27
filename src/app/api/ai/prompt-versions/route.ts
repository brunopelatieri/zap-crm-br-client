import { NextResponse } from 'next/server';
import { requireAiFeature } from '@/lib/ai/plan-gate';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { PROMPT_VERSIONS_LIMIT } from '@/lib/ai/prompt-versions';

/**
 * GET /api/ai/prompt-versions  (admin+)
 *
 * The account's system-prompt history, newest first (SPEC 089 F1). Every
 * save that changes the prompt appends a version; restoring appends a new
 * one. Admin-only, mirroring the table's SELECT policy.
 */
export async function GET() {
  try {
    const { supabase, accountId } = await requireRole('admin');
    // SPEC 089 D-20: ai_enabled em modo estrito (chave ausente = bloqueado).
    await requireAiFeature(accountId);
    const { data, error } = await supabase
      .from('ai_prompt_versions')
      .select('id, system_prompt, note, source, created_by, created_at')
      .eq('account_id', accountId)
      .order('created_at', { ascending: false })
      .limit(PROMPT_VERSIONS_LIMIT);
    if (error) {
      console.error('[ai/prompt-versions GET] error:', error);
      return NextResponse.json(
        { error: 'Failed to load prompt versions' },
        { status: 500 }
      );
    }
    return NextResponse.json({ versions: data ?? [] });
  } catch (err) {
    return toErrorResponse(err);
  }
}
