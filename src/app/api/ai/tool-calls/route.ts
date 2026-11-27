import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

/**
 * GET /api/ai/tool-calls?limit=&before=  (admin+)
 *
 * The audit history of the agent's tool calls (SPEC 089 F5,
 * `ai_tool_calls`, migration 106), newest first. The RLS policy lets admin+
 * read their OWN account's rows; the explicit filter is the second line.
 * `input` and `output_summary` were stored with personal data masked.
 * `before` is the `created_at` of the last row of the previous page.
 *
 * Stays open when the plan lacks `ai_enabled` (like the usage history): it
 * is the record of what already happened.
 */
export async function GET(request: Request) {
  try {
    const { supabase, accountId } = await requireRole('admin');
    const url = new URL(request.url);
    const rawLimit = Number(url.searchParams.get('limit'));
    const limit =
      Number.isInteger(rawLimit) && rawLimit > 0
        ? Math.min(rawLimit, MAX_LIMIT)
        : DEFAULT_LIMIT;
    const before = url.searchParams.get('before');
    if (before && Number.isNaN(Date.parse(before))) {
      return NextResponse.json(
        { error: 'before must be an ISO date' },
        { status: 400 }
      );
    }

    let query = supabase
      .from('ai_tool_calls')
      .select(
        'id, conversation_id, mode, tool, risk, input, output_summary, status, error_code, duration_ms, created_at'
      )
      .eq('account_id', accountId)
      .order('created_at', { ascending: false })
      .limit(limit + 1);
    if (before) query = query.lt('created_at', before);

    const { data, error } = await query;
    if (error) {
      // Migration 106 not applied yet: the tab says so instead of failing.
      const code = (error as { code?: string }).code;
      // 42P01: Postgres; PGRST205: PostgREST (table not in its schema cache).
      if (code === '42P01' || code === 'PGRST205') {
        return NextResponse.json({
          calls: [],
          has_more: false,
          migration_pending: true,
        });
      }
      throw error;
    }
    const rows = data ?? [];
    return NextResponse.json({
      calls: rows.slice(0, limit),
      has_more: rows.length > limit,
      migration_pending: false,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
