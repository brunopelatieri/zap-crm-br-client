import {
  TOOL_KEYS,
  type ToolKey,
  type ToolSetting,
  type ToolsConfig,
} from './types';

// ============================================================
// `ai_configs.tools_config` (migration 105) → `ToolsConfig`.
//
// Stored as snake_case JSON:
//   { "get_contact_profile": { "enabled": true, "visible_fields": ["email"] } }
// Parsing is fail-closed (D-16): an unknown tool key is dropped, a tool
// without `"enabled": true` is off, and an allow-list entry that does not
// look right is dropped (so an empty list means "nothing allowed").
// ============================================================

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Contact fields the agent may be allowed to SEE (get_contact_profile). */
const VISIBLE_BUILTINS = new Set(['email', 'company', 'phone', 'tags']);
/** Contact fields the agent may be allowed to WRITE (update_contact_fields). */
const WRITABLE_BUILTINS = new Set(['name', 'email', 'company']);

/** Longest allow-list kept (a tenant has at most a few hundred tags/fields). */
const MAX_LIST = 200;

const CUSTOM_PREFIX = 'custom:';

function isCustomFieldRef(v: string): boolean {
  return (
    v.startsWith(CUSTOM_PREFIX) && UUID_RE.test(v.slice(CUSTOM_PREFIX.length))
  );
}

function stringList(raw: unknown, keep: (v: string) => boolean): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const v = item.trim().toLowerCase();
    if (!v || seen.has(v) || !keep(v)) continue;
    seen.add(v);
    out.push(v);
    if (out.length >= MAX_LIST) break;
  }
  return out;
}

const isUuid = (v: string) => UUID_RE.test(v);
const isVisibleField = (v: string) =>
  VISIBLE_BUILTINS.has(v) || isCustomFieldRef(v);
const isWritableField = (v: string) =>
  WRITABLE_BUILTINS.has(v) || isCustomFieldRef(v);

function parseSetting(raw: unknown): ToolSetting | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const setting: ToolSetting = { enabled: r.enabled === true };
  if ('visible_fields' in r)
    setting.visibleFields = stringList(r.visible_fields, isVisibleField);
  if ('pipeline_ids' in r)
    setting.pipelineIds = stringList(r.pipeline_ids, isUuid);
  if ('stage_ids' in r) setting.stageIds = stringList(r.stage_ids, isUuid);
  if ('tag_ids' in r) setting.tagIds = stringList(r.tag_ids, isUuid);
  if ('writable_fields' in r)
    setting.writableFields = stringList(r.writable_fields, isWritableField);
  return setting;
}

export function parseToolsConfig(raw: unknown): ToolsConfig {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const r = raw as Record<string, unknown>;
  const out: ToolsConfig = {};
  for (const key of TOOL_KEYS) {
    const setting = parseSetting(r[key]);
    if (setting) out[key] = setting;
  }
  return out;
}

export function isToolEnabled(
  config: ToolsConfig | undefined,
  key: ToolKey
): boolean {
  return config?.[key]?.enabled === true;
}

/** `custom:<uuid>` entries of a field list, as bare uuids. */
export function customFieldIds(
  fields: readonly string[] | undefined
): string[] {
  return (fields ?? [])
    .filter(isCustomFieldRef)
    .map((f) => f.slice(CUSTOM_PREFIX.length));
}

/**
 * The inverse of `parseToolsConfig`: the snake_case JSON stored in
 * `ai_configs.tools_config` (migration 105). Only what the tool settings
 * know is written, so `serialize → parse` is the identity (tested) and an
 * unknown key sent by a client never reaches the database.
 */
export function serializeToolsConfig(
  config: ToolsConfig
): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  for (const key of TOOL_KEYS) {
    const s = config[key];
    if (!s) continue;
    const row: Record<string, unknown> = { enabled: s.enabled === true };
    if (s.visibleFields) row.visible_fields = [...s.visibleFields];
    if (s.pipelineIds) row.pipeline_ids = [...s.pipelineIds];
    if (s.stageIds) row.stage_ids = [...s.stageIds];
    if (s.tagIds) row.tag_ids = [...s.tagIds];
    if (s.writableFields) row.writable_fields = [...s.writableFields];
    out[key] = row;
  }
  return out;
}

/** The ids a tools config points at, by table (for the account check). */
export function referencedIds(config: ToolsConfig): {
  pipelines: string[];
  stages: string[];
  tags: string[];
  customFields: string[];
} {
  const pipelines = new Set<string>();
  const stages = new Set<string>();
  const tags = new Set<string>();
  const customFields = new Set<string>();
  for (const key of TOOL_KEYS) {
    const s = config[key];
    if (!s) continue;
    for (const id of s.pipelineIds ?? []) pipelines.add(id);
    for (const id of s.stageIds ?? []) stages.add(id);
    for (const id of s.tagIds ?? []) tags.add(id);
    for (const id of customFieldIds(s.visibleFields)) customFields.add(id);
    for (const id of customFieldIds(s.writableFields)) customFields.add(id);
  }
  return {
    pipelines: [...pipelines],
    stages: [...stages],
    tags: [...tags],
    customFields: [...customFields],
  };
}
