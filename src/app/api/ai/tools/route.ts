import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { requireAiFeature } from '@/lib/ai/plan-gate';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit';
import {
  parseToolsConfig,
  referencedIds,
  serializeToolsConfig,
} from '@/lib/ai/tools/config';
import { allTools } from '@/lib/ai/tools/registry';
import { TOOL_KEYS, type ToolsConfig } from '@/lib/ai/tools/types';
import { WRITE_CALLS_PER_CONVERSATION } from '@/lib/ai/defaults';

/** Postgres `undefined_column` naming `tools_config` (migration 105 missing). */
function isMissingColumn(error: unknown): boolean {
  const e = error as { code?: unknown; message?: unknown } | null;
  return (
    e?.code === '42703' &&
    typeof e.message === 'string' &&
    e.message.includes('tools_config')
  );
}

/**
 * Ids of `table` (restricted to the account) among `ids`: the ones that DO
 * exist in this account. `pipeline_stages` has no `account_id`, so its check
 * goes through the account's funnels.
 */
async function idsInAccount(
  db: SupabaseClient,
  accountId: string,
  table: 'pipelines' | 'tags' | 'custom_fields' | 'pipeline_stages',
  ids: string[]
): Promise<Set<string> | null> {
  if (ids.length === 0) return new Set();
  if (table === 'pipeline_stages') {
    const { data: pipes, error: pErr } = await db
      .from('pipelines')
      .select('id')
      .eq('account_id', accountId);
    if (pErr) return null;
    const pipelineIds = ((pipes ?? []) as { id: string }[]).map((p) => p.id);
    if (pipelineIds.length === 0) return new Set();
    const { data, error } = await db
      .from('pipeline_stages')
      .select('id')
      .in('pipeline_id', pipelineIds)
      .in('id', ids);
    if (error) return null;
    return new Set(((data ?? []) as { id: string }[]).map((r) => r.id));
  }
  const { data, error } = await db
    .from(table)
    .select('id')
    .eq('account_id', accountId)
    .in('id', ids);
  if (error) return null;
  return new Set(((data ?? []) as { id: string }[]).map((r) => r.id));
}

/**
 * GET /api/ai/tools  (admin+)
 *   → { catalog, tools_config, configured, write_calls_per_conversation }
 * PUT /api/ai/tools  (admin+)   { tools_config }
 *
 * The per-tool switches and allow-lists of the account (SPEC 089 F5,
 * `ai_configs.tools_config`). Every tool is born OFF; lists are fail-closed.
 * The PUT stores only what `parseToolsConfig` understands and refuses any
 * id (funnel, stage, tag, custom field) that is not a row of THIS account,
 * so a list can never point at another tenant's data.
 */
export async function GET() {
  try {
    const { supabase, accountId } = await requireRole('admin');
    await requireAiFeature(accountId);

    const { data, error } = await supabase
      .from('ai_configs')
      .select('tools_config')
      .eq('account_id', accountId)
      .maybeSingle();
    const migrationPending = !!error && isMissingColumn(error);
    if (error && !migrationPending) throw error;

    return NextResponse.json({
      catalog: allTools().map((t) => ({ key: t.key, risk: t.risk })),
      tools_config: serializeToolsConfig(
        parseToolsConfig(
          (data as { tools_config?: unknown } | null)?.tools_config
        )
      ),
      configured: !!data,
      migration_pending: migrationPending,
      write_calls_per_conversation: WRITE_CALLS_PER_CONVERSATION,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function PUT(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('admin');
    await requireAiFeature(accountId);
    const limit = checkRateLimit(
      `ai-tools-config:${userId}`,
      RATE_LIMITS.adminAction
    );
    if (!limit.success) return rateLimitResponse(limit);

    const body = await request.json().catch(() => null);
    const raw = body?.tools_config;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return NextResponse.json(
        { error: 'tools_config must be an object' },
        { status: 400 }
      );
    }
    // An unknown tool key is a client bug, not something to drop in silence.
    const unknown = Object.keys(raw).filter(
      (k) => !(TOOL_KEYS as readonly string[]).includes(k)
    );
    if (unknown.length > 0) {
      return NextResponse.json(
        { error: 'Unknown tool', code: 'unknown_tool', tools: unknown },
        { status: 400 }
      );
    }

    const config: ToolsConfig = parseToolsConfig(raw);
    const refs = referencedIds(config);
    const checks = await Promise.all([
      idsInAccount(supabase, accountId, 'pipelines', refs.pipelines),
      idsInAccount(supabase, accountId, 'pipeline_stages', refs.stages),
      idsInAccount(supabase, accountId, 'tags', refs.tags),
      idsInAccount(supabase, accountId, 'custom_fields', refs.customFields),
    ]);
    if (checks.some((c) => c === null)) {
      return NextResponse.json(
        { error: 'Could not verify the selected items' },
        { status: 500 }
      );
    }
    const [pipelines, stages, tags, customFields] = checks as Set<string>[];
    const outside = [
      ...refs.pipelines.filter((id) => !pipelines.has(id)),
      ...refs.stages.filter((id) => !stages.has(id)),
      ...refs.tags.filter((id) => !tags.has(id)),
      ...refs.customFields.filter((id) => !customFields.has(id)),
    ];
    if (outside.length > 0) {
      return NextResponse.json(
        {
          error: 'Some selected items do not exist in this account',
          code: 'invalid_reference',
        },
        { status: 400 }
      );
    }

    const stored = serializeToolsConfig(config);
    const { data, error } = await supabase
      .from('ai_configs')
      .update({ tools_config: stored })
      .eq('account_id', accountId)
      .select('id');
    if (error) {
      if (isMissingColumn(error)) {
        return NextResponse.json(
          {
            error: 'The database is missing migration 105/106.',
            code: 'migration_pending',
          },
          { status: 409 }
        );
      }
      throw error;
    }
    // RLS refuses an UPDATE in silence: zero rows is an error, not success.
    if (!data || data.length !== 1) {
      return NextResponse.json(
        {
          error: 'No agent configured yet. Add your provider key in Setup.',
          code: 'ai_not_configured',
        },
        { status: 409 }
      );
    }
    return NextResponse.json({ tools_config: stored });
  } catch (err) {
    return toErrorResponse(err);
  }
}
