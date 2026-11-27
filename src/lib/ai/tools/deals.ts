import { asObject } from './input';
import type { AgentTool } from './types';

// list_contact_deals (read): deals of the contact OF THIS CONVERSATION, in
// the funnels the admin allowed (`pipeline_ids`, fail-closed: empty = none).
// No input: contact and account come from the context.

const MAX_DEALS = 20;

interface DealRow {
  id: string;
  title: string;
  value: number | string | null;
  currency: string | null;
  status: string | null;
  expected_close_date: string | null;
  pipeline_id: string;
  pipelines: { name: string } | { name: string }[] | null;
  pipeline_stages: { name: string } | { name: string }[] | null;
}

function nameOf(
  rel: { name: string } | { name: string }[] | null
): string | null {
  if (!rel) return null;
  const one = Array.isArray(rel) ? rel[0] : rel;
  return one?.name ?? null;
}

export const listContactDealsTool: AgentTool<Record<string, never>> = {
  key: 'list_contact_deals',
  description:
    'List the deals (sales opportunities) of the customer in this conversation, with the funnel and stage of each one. Takes no arguments.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  risk: 'read',
  parse(input) {
    const obj = asObject(input);
    if (!obj.ok) return obj;
    return { ok: true, value: {} };
  },
  async handler(ctx) {
    if (!ctx.contactId) return { ok: false, error: 'no_contact' };
    const allowed = ctx.toolsConfig.list_contact_deals?.pipelineIds ?? [];
    if (allowed.length === 0) return { ok: true, data: { deals: [] } };

    const { data, error } = await ctx.db
      .from('deals')
      .select(
        'id, title, value, currency, status, expected_close_date, pipeline_id, pipelines(name), pipeline_stages(name)'
      )
      .eq('account_id', ctx.accountId)
      .eq('contact_id', ctx.contactId)
      .in('pipeline_id', allowed)
      .order('created_at', { ascending: false })
      .limit(MAX_DEALS);
    if (error) return { ok: false, error: 'lookup_failed' };

    const allowedSet = new Set(allowed);
    const deals = ((data ?? []) as DealRow[])
      // Belt and braces: the query already filters, the result is re-checked.
      .filter((d) => allowedSet.has(d.pipeline_id))
      .map((d) => ({
        id: d.id,
        title: d.title,
        value: d.value === null ? null : Number(d.value),
        currency: d.currency,
        status: d.status,
        expected_close_date: d.expected_close_date,
        pipeline: nameOf(d.pipelines),
        stage: nameOf(d.pipeline_stages),
      }));
    return { ok: true, data: { deals } };
  },
};
