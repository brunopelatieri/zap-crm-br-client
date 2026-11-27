import { createHash } from 'node:crypto';
import { resolveAuditUserId } from '@/lib/api/v1/contacts';
import { createDeal } from '@/lib/pipelines/deals';
import { asObject, readString } from './input';
import {
  findByName,
  guardWrite,
  normName,
  oneRow,
  simulated,
  type Named,
} from './write-support';
import type { AgentTool, ParseResult, ToolContext, ToolResult } from './types';

// ============================================================
// Deal writes (SPEC 089 F5): create_deal, move_deal_stage.
//
// Funnels and stages come from the admin's allow-lists (`pipeline_ids`,
// `stage_ids`, both fail-closed: an empty list allows nothing). The model
// names a funnel and a stage; they are resolved among the rows of THIS
// account that the admin listed (`pipelines` by `account_id`,
// `pipeline_stages` by their funnel, since they have no account column).
// The deal is always the contact's of this conversation.
// ============================================================

const MAX_VALUE = 1_000_000_000;
const MAX_NAMES_IN_DETAIL = 20;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface StageRow extends Named {
  position: number;
}

async function loadPipelines(
  ctx: ToolContext,
  ids: string[]
): Promise<{ ok: true; rows: Named[] } | { ok: false; error: string }> {
  if (ids.length === 0) return { ok: true, rows: [] };
  const { data, error } = await ctx.db
    .from('pipelines')
    .select('id, name')
    .eq('account_id', ctx.accountId)
    .in('id', ids);
  if (error) return { ok: false, error: 'lookup_failed' };
  return { ok: true, rows: (data ?? []) as Named[] };
}

/** Allowed stages of ONE funnel (already checked to be the account's). */
async function loadStages(
  ctx: ToolContext,
  pipelineId: string,
  stageIds: string[]
): Promise<{ ok: true; rows: StageRow[] } | { ok: false; error: string }> {
  if (stageIds.length === 0) return { ok: true, rows: [] };
  const { data, error } = await ctx.db
    .from('pipeline_stages')
    .select('id, name, position')
    .eq('pipeline_id', pipelineId)
    .in('id', stageIds)
    .order('position');
  if (error) return { ok: false, error: 'lookup_failed' };
  const rows = ((data ?? []) as StageRow[]).sort(
    (a, b) => (a.position ?? 0) - (b.position ?? 0)
  );
  return { ok: true, rows };
}

const names = (rows: readonly Named[]) =>
  rows.slice(0, MAX_NAMES_IN_DETAIL).map((r) => r.name);

async function contactExists(ctx: ToolContext): Promise<boolean> {
  if (!ctx.contactId) return false;
  const { data, error } = await ctx.db
    .from('contacts')
    .select('id')
    .eq('id', ctx.contactId)
    .eq('account_id', ctx.accountId)
    .maybeSingle();
  return !error && !!data;
}

// ------------------------------------------------------------
// create_deal
// ------------------------------------------------------------

interface CreateDealInput {
  title: string;
  pipeline: string;
  stage?: string;
  value?: number;
}

function parseCreateDeal(input: unknown): ParseResult<CreateDealInput> {
  const parsed = asObject(input);
  if (!parsed.ok) return parsed;
  const obj = parsed.value;
  const title = readString(obj, 'title', { required: true, max: 200 });
  if (!title.ok) return title;
  const pipeline = readString(obj, 'pipeline', { required: true, max: 100 });
  if (!pipeline.ok) return pipeline;
  const stage = readString(obj, 'stage', { max: 100 });
  if (!stage.ok) return stage;
  const out: CreateDealInput = {
    title: title.value as string,
    pipeline: pipeline.value as string,
  };
  if (stage.value) out.stage = stage.value;
  if (obj.value !== undefined && obj.value !== null) {
    if (
      typeof obj.value !== 'number' ||
      !Number.isFinite(obj.value) ||
      obj.value < 0 ||
      obj.value > MAX_VALUE
    ) {
      return { ok: false, error: 'invalid_value' };
    }
    out.value = obj.value;
  }
  return { ok: true, value: out };
}

async function createDealHandler(
  ctx: ToolContext,
  input: CreateDealInput
): Promise<ToolResult> {
  const blocked = guardWrite(ctx);
  if (blocked) return blocked;

  const cfg = ctx.toolsConfig.create_deal;
  const pipelineIds = cfg?.pipelineIds ?? [];
  const stageIds = cfg?.stageIds ?? [];

  const pipelines = await loadPipelines(ctx, pipelineIds);
  if (!pipelines.ok) return pipelines;
  const pHit = findByName(pipelines.rows, input.pipeline);
  if (!pHit.found) {
    return {
      ok: false,
      error: 'pipeline_not_allowed',
      detail: { allowed_pipelines: names(pipelines.rows) },
    };
  }
  const pipeline = pHit.found;

  const stages = await loadStages(ctx, pipeline.id, stageIds);
  if (!stages.ok) return stages;
  // No stage named = the first allowed stage of the funnel.
  const stage = input.stage
    ? findByName(stages.rows, input.stage).found
    : (stages.rows[0] ?? null);
  if (!stage) {
    return {
      ok: false,
      error: 'stage_not_allowed',
      detail: { allowed_stages: names(stages.rows) },
    };
  }

  const title = input.title;
  if (ctx.dryRun) {
    return simulated('create_deal', input, {
      would_create: {
        title,
        pipeline: pipeline.name,
        stage: stage.name,
        value: input.value ?? 0,
      },
    });
  }

  if (!(await contactExists(ctx)))
    return { ok: false, error: 'contact_not_found' };
  const contactId = ctx.contactId as string;

  try {
    // An open deal with the same title in this funnel is not created twice
    // (a repeated call, or a model that retries).
    const { data: open, error: openErr } = await ctx.db
      .from('deals')
      .select('id, title')
      .eq('account_id', ctx.accountId)
      .eq('contact_id', contactId)
      .eq('pipeline_id', pipeline.id)
      .eq('status', 'open')
      .limit(50);
    if (openErr) return { ok: false, error: 'lookup_failed' };
    const dup = ((open ?? []) as { id: string; title: string }[]).find(
      (d) => normName(d.title) === normName(title)
    );
    if (dup) {
      return {
        ok: false,
        error: 'duplicate_deal',
        detail: { deal_id: dup.id },
      };
    }

    const { data: account } = await ctx.db
      .from('accounts')
      .select('default_currency')
      .eq('id', ctx.accountId)
      .maybeSingle();
    const currency =
      (account as { default_currency?: string } | null)?.default_currency ??
      'BRL';
    const userId = await resolveAuditUserId(ctx.db, ctx.accountId);

    const base = {
      userId,
      accountId: ctx.accountId,
      pipelineId: pipeline.id,
      stageId: stage.id,
      contactId,
      title,
      value: input.value,
      currency,
    };
    // The look-up above does not stop two turns running at the same time
    // (a burst of messages) from both creating the deal: the unique index of
    // migration 110 does. A database without the column yet (110 not
    // applied) still gets the deal, guarded only by the look-up.
    let deal: Awaited<ReturnType<typeof createDeal>>;
    try {
      deal = await createDeal(ctx.db, {
        ...base,
        aiDedupeKey: dealDedupeKey(contactId, pipeline.id, title),
      });
    } catch (err) {
      const code = (err as { code?: string } | null)?.code;
      if (code === '23505') return { ok: false, error: 'duplicate_deal' };
      if (code !== '42703' && code !== 'PGRST204') throw err;
      deal = await createDeal(ctx.db, base);
    }
    return {
      ok: true,
      data: {
        status: 'ok',
        deal_id: deal.id,
        pipeline: pipeline.name,
        stage: stage.name,
      },
      activity: {
        action: 'ai.tool_deal_created',
        // No free text in the label: the title is typed from the
        // conversation and this line outlives the contact. Neutral label;
        // only the length of the title goes in the metadata.
        metadata: {
          pipeline: pipeline.name,
          stage: stage.name,
          title_length: title.length,
        },
      },
    };
  } catch (err) {
    // A CHECK / NOT NULL violation puts the failing row in `details`:
    // log only the code and the message.
    const e = err as { code?: string; message?: string } | null;
    console.error('[ai tools] create_deal failed:', e?.code, e?.message);
    return { ok: false, error: 'update_failed' };
  }
}

/**
 * `deals.ai_dedupe_key` of a deal the agent creates: contact, funnel and a
 * hash of the normalized title (the same comparison as the look-up above).
 * At most 138 characters; no title text in it.
 */
export function dealDedupeKey(
  contactId: string,
  pipelineId: string,
  title: string
): string {
  const digest = createHash('sha256').update(normName(title)).digest('hex');
  return `${contactId}:${pipelineId}:${digest}`;
}

export const createDealTool: AgentTool<CreateDealInput> = {
  key: 'create_deal',
  description:
    'Create a deal (sales opportunity) for the customer in this conversation, in a funnel and stage given by name. Only funnels and stages the business allows are accepted (without a stage, the first allowed one is used).',
  inputSchema: {
    type: 'object',
    properties: {
      title: { type: 'string', maxLength: 200 },
      pipeline: { type: 'string', description: 'Funnel name.', maxLength: 100 },
      stage: {
        type: 'string',
        description: 'Stage name (default: the first allowed stage).',
        maxLength: 100,
      },
      value: { type: 'number', minimum: 0 },
    },
    required: ['title', 'pipeline'],
    additionalProperties: false,
  },
  risk: 'write',
  parse: parseCreateDeal,
  handler: createDealHandler,
};

// ------------------------------------------------------------
// move_deal_stage
// ------------------------------------------------------------

interface MoveDealInput {
  deal_id: string;
  stage: string;
}

function parseMoveDeal(input: unknown): ParseResult<MoveDealInput> {
  const parsed = asObject(input);
  if (!parsed.ok) return parsed;
  const obj = parsed.value;
  // The deal id comes from the model: the handler re-checks that the deal
  // is THIS contact's, in THIS account and in an allowed funnel.
  const dealId = readString(obj, 'deal_id', { required: true, max: 36 });
  if (!dealId.ok) return dealId;
  if (!UUID_RE.test(dealId.value as string))
    return { ok: false, error: 'invalid_deal_id' };
  const stage = readString(obj, 'stage', { required: true, max: 100 });
  if (!stage.ok) return stage;
  return {
    ok: true,
    value: { deal_id: dealId.value as string, stage: stage.value as string },
  };
}

interface DealRow {
  id: string;
  title: string;
  pipeline_id: string;
  stage_id: string;
  status: string | null;
}

async function moveDealHandler(
  ctx: ToolContext,
  input: MoveDealInput
): Promise<ToolResult> {
  const blocked = guardWrite(ctx);
  if (blocked) return blocked;

  const cfg = ctx.toolsConfig.move_deal_stage;
  const pipelineIds = cfg?.pipelineIds ?? [];
  const stageIds = cfg?.stageIds ?? [];
  if (pipelineIds.length === 0 || stageIds.length === 0) {
    return { ok: false, error: 'pipeline_not_allowed' };
  }

  // The playground has no contact: nothing to look the deal up against.
  if (ctx.dryRun && !ctx.contactId) {
    return simulated('move_deal_stage', input, {
      note_deal: 'The deal is not looked up in the playground (no contact).',
    });
  }
  if (!ctx.contactId) return { ok: false, error: 'no_contact' };

  const { data: dealData, error: dealErr } = await ctx.db
    .from('deals')
    .select('id, title, pipeline_id, stage_id, status')
    .eq('id', input.deal_id)
    .eq('account_id', ctx.accountId)
    .eq('contact_id', ctx.contactId)
    .maybeSingle();
  if (dealErr) return { ok: false, error: 'lookup_failed' };
  const deal = dealData as DealRow | null;
  if (!deal) return { ok: false, error: 'deal_not_found' };
  // Re-checked: a client that ignored the filters must not widen the scope.
  if (deal.id !== input.deal_id) return { ok: false, error: 'deal_not_found' };
  if (!pipelineIds.includes(deal.pipeline_id.toLowerCase())) {
    return { ok: false, error: 'deal_not_allowed' };
  }
  if (deal.status !== 'open') return { ok: false, error: 'deal_not_open' };

  const stages = await loadStages(ctx, deal.pipeline_id, stageIds);
  if (!stages.ok) return stages;
  const current = stages.rows.find((s) => s.id === deal.stage_id);
  // Moving a deal OUT of a stage the admin did not allow (say "Won") is as
  // much a write as moving one in.
  if (!current) return { ok: false, error: 'deal_stage_not_allowed' };
  const target = findByName(stages.rows, input.stage).found;
  if (!target) {
    return {
      ok: false,
      error: 'stage_not_allowed',
      detail: { allowed_stages: names(stages.rows) },
    };
  }
  if (target.id === current.id) {
    return {
      ok: true,
      data: { status: 'ok', unchanged: true, stage: target.name },
    };
  }

  if (ctx.dryRun) {
    return simulated('move_deal_stage', input, {
      would_move: { from: current.name, to: target.name },
    });
  }

  const { data, error } = await ctx.db
    .from('deals')
    .update({ stage_id: target.id, updated_at: new Date().toISOString() })
    .eq('id', deal.id)
    .eq('account_id', ctx.accountId)
    .eq('contact_id', ctx.contactId)
    .eq('pipeline_id', deal.pipeline_id)
    // Re-checked in the statement itself: a person who closed or moved the
    // deal between our read and this write wins.
    .eq('stage_id', current.id)
    .eq('status', 'open')
    .select('id');
  if (error || !oneRow(data)) {
    if (error)
      console.error('[ai tools] move_deal_stage failed:', error.message);
    return { ok: false, error: 'update_failed' };
  }
  return {
    ok: true,
    data: { status: 'ok', from: current.name, to: target.name },
    activity: {
      action: 'ai.tool_deal_moved',
      // No free text in the label (the title can hold a name or an address
      // and this line outlives the contact).
      metadata: { from: current.name, to: target.name },
    },
  };
}

export const moveDealStageTool: AgentTool<MoveDealInput> = {
  key: 'move_deal_stage',
  description:
    "Move one of this customer's deals (id from list_contact_deals) to another stage of its funnel, by stage name. Only deals and stages the business allows are accepted.",
  inputSchema: {
    type: 'object',
    properties: {
      deal_id: {
        type: 'string',
        description: 'Deal id returned by list_contact_deals.',
      },
      stage: {
        type: 'string',
        description: 'Target stage name.',
        maxLength: 100,
      },
    },
    required: ['deal_id', 'stage'],
    additionalProperties: false,
  },
  risk: 'write',
  parse: parseMoveDeal,
  handler: moveDealHandler,
};
