import { customFieldIds } from './config';
import { asObject } from './input';
import type { AgentTool } from './types';

// get_contact_profile (read): the contact OF THIS CONVERSATION — never
// another one. No input at all: the contact comes from `ctx.contactId`,
// which `buildToolContext` read from the conversation row.
//
// What is visible is the admin's allow-list (`visible_fields`), fail-closed:
// only the name is always shown. Deals are NOT included (they would bypass
// the funnel allow-list of list_contact_deals). `contact_tags` and
// `contact_custom_values` have no `account_id`, so they are only reached
// through a parent row already filtered by the account.

interface ContactRow {
  id: string;
  name: string | null;
  email: string | null;
  company: string | null;
  phone: string | null;
}

export const getContactProfileTool: AgentTool<Record<string, never>> = {
  key: 'get_contact_profile',
  description:
    'Get the profile of the customer in this conversation (name and the fields the business allows you to see, such as e-mail, company, tags and custom fields). Takes no arguments.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  risk: 'read',
  parse(input) {
    const obj = asObject(input);
    if (!obj.ok) return obj;
    return { ok: true, value: {} };
  },
  async handler(ctx) {
    if (!ctx.contactId) return { ok: false, error: 'no_contact' };
    const visible = new Set(
      ctx.toolsConfig.get_contact_profile?.visibleFields ?? []
    );

    const { data: contact, error } = await ctx.db
      .from('contacts')
      .select('id, name, email, company, phone')
      .eq('id', ctx.contactId)
      .eq('account_id', ctx.accountId)
      .maybeSingle();
    if (error) return { ok: false, error: 'lookup_failed' };
    if (!contact) return { ok: false, error: 'contact_not_found' };
    const row = contact as ContactRow;

    const profile: Record<string, unknown> = { name: row.name ?? null };
    if (visible.has('email')) profile.email = row.email ?? null;
    if (visible.has('company')) profile.company = row.company ?? null;
    if (visible.has('phone')) profile.phone = row.phone ?? null;

    if (visible.has('tags')) {
      const { data: tagRows, error: tagErr } = await ctx.db
        .from('contact_tags')
        .select('tags!inner(name, account_id)')
        .eq('contact_id', row.id)
        .eq('tags.account_id', ctx.accountId);
      if (tagErr) return { ok: false, error: 'lookup_failed' };
      profile.tags = ((tagRows ?? []) as { tags: unknown }[])
        .flatMap((r) => (Array.isArray(r.tags) ? r.tags : [r.tags]))
        .filter(
          (t): t is { name: string; account_id: string } =>
            !!t &&
            typeof (t as { name?: unknown }).name === 'string' &&
            (t as { account_id?: unknown }).account_id === ctx.accountId
        )
        .map((t) => t.name);
    }

    const fieldIds = customFieldIds([...visible]);
    if (fieldIds.length > 0) {
      // Field definitions first, filtered by the account: a field id from
      // another account in the allow-list resolves to nothing.
      const { data: fields, error: fieldErr } = await ctx.db
        .from('custom_fields')
        .select('id, field_name')
        .eq('account_id', ctx.accountId)
        .in('id', fieldIds);
      if (fieldErr) return { ok: false, error: 'lookup_failed' };
      const names = new Map(
        ((fields ?? []) as { id: string; field_name: string }[]).map((f) => [
          f.id,
          f.field_name,
        ])
      );
      const custom: Record<string, string | null> = {};
      if (names.size > 0) {
        const { data: values, error: valErr } = await ctx.db
          .from('contact_custom_values')
          .select('custom_field_id, value')
          .eq('contact_id', row.id)
          .in('custom_field_id', [...names.keys()]);
        if (valErr) return { ok: false, error: 'lookup_failed' };
        for (const v of (values ?? []) as {
          custom_field_id: string;
          value: string | null;
        }[]) {
          const name = names.get(v.custom_field_id);
          if (name) custom[name] = v.value ?? null;
        }
      }
      profile.custom_fields = custom;
    }

    return { ok: true, data: profile };
  },
};
