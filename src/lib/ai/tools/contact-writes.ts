import { assignTag, unassignTag } from '@/lib/tags';
import { customFieldIds } from './config';
import {
  asObject,
  readString,
  readStringArray,
  stripControl,
  type Obj,
} from './input';
import {
  findByName,
  guardWrite,
  oneRow,
  simulated,
  type Named,
} from './write-support';
import type {
  AgentTool,
  ParseResult,
  ToolContext,
  ToolKey,
  ToolResult,
} from './types';

// ============================================================
// Contact writes (SPEC 089 F5): update_contact_fields, add_contact_tags,
// remove_contact_tags. All three act on `ctx.contactId` only (read from the
// conversation row by `buildToolContext`), filter by `ctx.accountId`, and
// stay inside the admin's allow-list (`writable_fields`, `tag_ids`), which
// is fail-closed: an empty list allows nothing.
// ============================================================

const MAX_TAGS = 10;
const MAX_CUSTOM = 20;
const MAX_NAMES_IN_DETAIL = 20;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ------------------------------------------------------------
// Tags
// ------------------------------------------------------------

const TAG_LIST = {
  type: 'array',
  items: { type: 'string', maxLength: 40 },
  minItems: 1,
  maxItems: MAX_TAGS,
};

function parseTags(input: unknown): ParseResult<{ tags: string[] }> {
  const obj = asObject(input);
  if (!obj.ok) return obj;
  const tags = readStringArray(obj.value, 'tags', {
    required: true,
    maxItems: MAX_TAGS,
    maxLength: 40,
  });
  if (!tags.ok) return tags;
  return { ok: true, value: { tags: tags.value as string[] } };
}

async function loadAllowedTags(
  ctx: ToolContext,
  key: ToolKey
): Promise<{ ok: true; tags: Named[] } | { ok: false; error: string }> {
  const ids = ctx.toolsConfig[key]?.tagIds ?? [];
  if (ids.length === 0) return { ok: true, tags: [] };
  const { data, error } = await ctx.db
    .from('tags')
    .select('id, name')
    .eq('account_id', ctx.accountId)
    .in('id', ids);
  if (error) return { ok: false, error: 'lookup_failed' };
  return {
    ok: true,
    tags: ((data ?? []) as Named[]).filter((t) => typeof t.name === 'string'),
  };
}

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

async function changeTags(
  ctx: ToolContext,
  key: 'add_contact_tags' | 'remove_contact_tags',
  input: { tags: string[] }
): Promise<ToolResult> {
  const blocked = guardWrite(ctx);
  if (blocked) return blocked;

  const loaded = await loadAllowedTags(ctx, key);
  if (!loaded.ok) return loaded;

  const resolved: Named[] = [];
  const refused: string[] = [];
  for (const wanted of input.tags) {
    const hit = findByName(loaded.tags, wanted);
    if (hit.found) {
      if (!resolved.some((r) => r.id === hit.found.id))
        resolved.push(hit.found);
    } else {
      refused.push(wanted);
    }
  }
  if (resolved.length === 0) {
    return {
      ok: false,
      error: 'tag_not_allowed',
      detail: {
        allowed_tags: loaded.tags
          .slice(0, MAX_NAMES_IN_DETAIL)
          .map((t) => t.name),
      },
    };
  }
  const names = resolved.map((t) => t.name);

  if (ctx.dryRun) {
    return simulated(key, input, { would_apply: names, refused });
  }

  if (!(await contactExists(ctx)))
    return { ok: false, error: 'contact_not_found' };
  try {
    for (const tag of resolved) {
      if (key === 'add_contact_tags') {
        await assignTag(ctx.db, ctx.contactId as string, tag.id);
      } else {
        await unassignTag(ctx.db, ctx.contactId as string, tag.id);
      }
    }
  } catch (err) {
    console.error(`[ai tools] ${key} failed:`, err);
    return { ok: false, error: 'update_failed' };
  }
  return {
    ok: true,
    data: {
      status: 'ok',
      applied: names,
      ...(refused.length ? { refused } : {}),
    },
    activity: {
      action:
        key === 'add_contact_tags'
          ? 'ai.tool_tags_added'
          : 'ai.tool_tags_removed',
      label: names.join(', '),
      metadata: { tags: names },
    },
  };
}

export const addContactTagsTool: AgentTool<{ tags: string[] }> = {
  key: 'add_contact_tags',
  description:
    'Add tags (by name) to the customer in this conversation. Only tags the business allows are applied; others are refused.',
  inputSchema: {
    type: 'object',
    properties: { tags: TAG_LIST },
    required: ['tags'],
    additionalProperties: false,
  },
  risk: 'write',
  parse: parseTags,
  handler: (ctx, input) => changeTags(ctx, 'add_contact_tags', input),
};

export const removeContactTagsTool: AgentTool<{ tags: string[] }> = {
  key: 'remove_contact_tags',
  description:
    'Remove tags (by name) from the customer in this conversation. Only tags the business allows are removed; others are refused.',
  inputSchema: {
    type: 'object',
    properties: { tags: TAG_LIST },
    required: ['tags'],
    additionalProperties: false,
  },
  risk: 'write',
  parse: parseTags,
  handler: (ctx, input) => changeTags(ctx, 'remove_contact_tags', input),
};

// ------------------------------------------------------------
// Fields
// ------------------------------------------------------------

interface UpdateFieldsInput {
  name?: string;
  email?: string;
  company?: string;
  custom_fields?: Record<string, string>;
}

function parseUpdateFields(input: unknown): ParseResult<UpdateFieldsInput> {
  const parsed = asObject(input);
  if (!parsed.ok) return parsed;
  const obj: Obj = parsed.value;
  const out: UpdateFieldsInput = {};
  for (const [key, max] of [
    ['name', 200],
    ['email', 254],
    ['company', 200],
  ] as const) {
    const v = readString(obj, key, { max });
    if (!v.ok) return v;
    if (v.value) out[key] = v.value;
  }
  const rawCustom = obj.custom_fields;
  if (rawCustom !== undefined && rawCustom !== null) {
    if (typeof rawCustom !== 'object' || Array.isArray(rawCustom)) {
      return { ok: false, error: 'invalid_custom_fields' };
    }
    const entries = Object.entries(rawCustom as Obj);
    if (entries.length > MAX_CUSTOM)
      return { ok: false, error: 'too_many_custom_fields' };
    const custom: Record<string, string> = {};
    for (const [name, value] of entries) {
      const cleanName = stripControl(name).trim();
      if (
        typeof value !== 'string' ||
        value.length > 500 ||
        !cleanName ||
        cleanName.length > 100
      ) {
        return { ok: false, error: 'invalid_custom_fields' };
      }
      custom[cleanName] = stripControl(value).trim();
    }
    if (entries.length > 0) out.custom_fields = custom;
  }
  if (Object.keys(out).length === 0) return { ok: false, error: 'no_fields' };
  return { ok: true, value: out };
}

interface FieldRefusal {
  field: string;
  reason: 'field_not_allowed' | 'ambiguous_field' | 'invalid_value';
}

async function updateFields(
  ctx: ToolContext,
  input: UpdateFieldsInput
): Promise<ToolResult> {
  const blocked = guardWrite(ctx);
  if (blocked) return blocked;

  const writable = new Set(
    ctx.toolsConfig.update_contact_fields?.writableFields ?? []
  );
  const refused: FieldRefusal[] = [];
  const patch: Record<string, string> = {};

  for (const key of ['name', 'email', 'company'] as const) {
    const value = input[key];
    if (value === undefined) continue;
    if (!writable.has(key)) {
      refused.push({ field: key, reason: 'field_not_allowed' });
    } else if (key === 'email' && !EMAIL_RE.test(value)) {
      refused.push({ field: key, reason: 'invalid_value' });
    } else {
      patch[key] = value;
    }
  }

  // Custom fields: by NAME, resolved among the fields of this account that
  // the admin listed (`custom:<uuid>`). Two allowed fields with the same
  // name are ambiguous and never written at random.
  const customRows: { id: string; value: string; name: string }[] = [];
  if (input.custom_fields) {
    const allowedIds = customFieldIds([...writable]);
    let fields: Named[] = [];
    if (allowedIds.length > 0) {
      const { data, error } = await ctx.db
        .from('custom_fields')
        .select('id, field_name')
        .eq('account_id', ctx.accountId)
        .in('id', allowedIds);
      if (error) return { ok: false, error: 'lookup_failed' };
      fields = ((data ?? []) as { id: string; field_name: string }[]).map(
        (f) => ({
          id: f.id,
          name: f.field_name,
        })
      );
    }
    for (const [name, value] of Object.entries(input.custom_fields)) {
      const hit = findByName(fields, name);
      if (hit.found) {
        if (!customRows.some((r) => r.id === hit.found.id)) {
          customRows.push({ id: hit.found.id, value, name: hit.found.name });
        }
      } else {
        refused.push({
          field: name,
          reason: hit.ambiguous ? 'ambiguous_field' : 'field_not_allowed',
        });
      }
    }
  }

  const updated = [...Object.keys(patch), ...customRows.map((r) => r.name)];
  if (updated.length === 0) {
    return { ok: false, error: 'field_not_allowed', detail: { refused } };
  }

  if (ctx.dryRun) {
    return simulated('update_contact_fields', input, {
      would_update: updated,
      refused,
    });
  }

  if (!(await contactExists(ctx)))
    return { ok: false, error: 'contact_not_found' };
  const contactId = ctx.contactId as string;

  // The contact row and the custom values are two statements. If the
  // second fails after the first landed, the call reports what DID land
  // (status `partial`) instead of an error that would invite a repeat.
  let patchDone = false;
  if (Object.keys(patch).length > 0) {
    const { data, error } = await ctx.db
      .from('contacts')
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq('id', contactId)
      .eq('account_id', ctx.accountId)
      .select('id');
    if (error || !oneRow(data)) {
      if (error)
        console.error(
          '[ai tools] update_contact_fields failed:',
          error.message
        );
      return { ok: false, error: 'update_failed' };
    }
    patchDone = true;
  }
  let customFailed = false;
  if (customRows.length > 0) {
    // Upsert by (contact, field): never the panel's delete-then-insert,
    // which would wipe the fields this call does not mention.
    const { error } = await ctx.db.from('contact_custom_values').upsert(
      customRows.map((r) => ({
        contact_id: contactId,
        custom_field_id: r.id,
        value: r.value,
      })),
      { onConflict: 'contact_id,custom_field_id' }
    );
    if (error) {
      console.error(
        '[ai tools] update_contact_fields (custom) failed:',
        error.message
      );
      if (!patchDone) return { ok: false, error: 'update_failed' };
      customFailed = true;
    }
  }

  const landed = customFailed ? Object.keys(patch) : updated;
  return {
    ok: true,
    data: {
      status: customFailed ? 'partial' : 'ok',
      updated: landed,
      ...(customFailed ? { failed: customRows.map((r) => r.name) } : {}),
      ...(refused.length ? { refused } : {}),
    },
    activity: {
      action: 'ai.tool_contact_updated',
      label: landed.join(', '),
      metadata: { fields: landed },
    },
  };
}

export const updateContactFieldsTool: AgentTool<UpdateFieldsInput> = {
  key: 'update_contact_fields',
  description:
    'Update fields of the customer in this conversation: name, e-mail, company, or custom fields by their name. Only the fields the business allows are written; others are refused.',
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', maxLength: 200 },
      email: { type: 'string', maxLength: 254 },
      company: { type: 'string', maxLength: 200 },
      custom_fields: {
        type: 'object',
        description: 'Custom field name → new value.',
        additionalProperties: { type: 'string', maxLength: 500 },
      },
    },
    additionalProperties: false,
  },
  risk: 'write',
  parse: parseUpdateFields,
  handler: updateFields,
};
