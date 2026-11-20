// ============================================================
// Entrada das rotas da conta `/api/forms/**` (SPEC 085 §7.1, F2).
//
// O corpo que o construtor manda é DESCONFIADO: este módulo reconstrói o
// objeto campo a campo (lista de inclusão, como `project-public.ts`),
// corta tamanhos e recusa o que não tem conserto. Duas coisas que NÃO são
// feitas aqui, de propósito:
//
//   - Validade de PUBLICAÇÃO (`validateFormForPublish`): rascunho pode ser
//     incompleto/incoerente (SPEC §4.3 "Salvar (rascunho pode ser
//     inválido)"). Aqui só se garante FORMA e tamanho.
//   - Existência de ids de etiqueta/funil/membro: `apply-band` e
//     `apply-mapping` filtram por `account_id` na hora de aplicar.
//
// O que é segurança e por isso é conferido AQUI: caminho de mídia sempre
// dentro de `account-<conta>/` (a página pública assina esse caminho com
// `service_role`; um caminho de outra conta vazaria o arquivo dela) e
// vídeo só por URL de embed conhecida (E-16).
//
// Puro (sem Supabase, sem `node:`), então testável sem rede.
// ============================================================

import { isUuid } from '@/lib/api/uuid';
import { isAppLocale } from '@/lib/i18n/locales';

import { normalizeVideoEmbedUrl } from './media-url';
import { FORM_TEMPLATE_IDS, type FormTemplateId } from './templates';
import {
  CHOICE_FIELD_TYPES,
  FIELD_TYPES,
  type Band,
  type BandActions,
  type FieldMapping,
  type FieldMedia,
  type FieldOption,
  type FieldType,
  type FieldValidation,
  type FormFieldInput,
  type FormFont,
  type FormLocale,
  type FormRadius,
  type FormScoring,
  type FormSettings,
  type FormTheme,
  type MappingTarget,
  type PointsRange,
  type PortalVisibility,
  type ResponseSource,
  type ShowIf,
} from './types';

// Reexportado: o teste e as rotas importam daqui desde a F2.
export { normalizeVideoEmbedUrl };

export type ParseResult<T> =
  { ok: true; value: T } | { ok: false; error: string };

const fail = <T>(error: string): ParseResult<T> => ({ ok: false, error });
const ok = <T>(value: T): ParseResult<T> => ({ ok: true, value });

export const MAX_FIELDS = 100;
export const MAX_OPTIONS = 100;
export const MAX_BANDS = 20;
export const FORM_NAME_MAX = 120;

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** String cortada em `max`; qualquer outra coisa vira `undefined`. */
function str(v: unknown, max: number): string | undefined {
  return typeof v === 'string' ? v.slice(0, max) : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function bool(v: unknown): boolean | undefined {
  return typeof v === 'boolean' ? v : undefined;
}

function strList(v: unknown, maxItems: number, maxLen: number): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((x): x is string => typeof x === 'string' && x.length > 0)
    .slice(0, maxItems)
    .map((x) => x.slice(0, maxLen));
}

// ------------------------------------------------------------
// Mídia
// ------------------------------------------------------------

export interface InputScope {
  accountId: string;
}

function mediaPathPattern(accountId: string): RegExp {
  // `account-<conta>/<form_id>/<uuid>.<ext>` (buildFormMediaPath).
  return new RegExp(
    `^account-${accountId.toLowerCase()}/[0-9a-f-]{36}/[0-9a-f-]{36}\\.[a-z0-9]{1,8}$`
  );
}

export function isOwnedMediaPath(path: string, accountId: string): boolean {
  return mediaPathPattern(accountId).test(path);
}

function parseMedia(
  v: unknown,
  scope: InputScope,
  where: string
): ParseResult<FieldMedia | null> {
  if (v === null || v === undefined) return ok(null);
  if (!isRecord(v)) return fail(`${where}: media must be an object`);
  if (v.kind === 'image') {
    const path = str(v.path, 300);
    if (!path || !isOwnedMediaPath(path, scope.accountId)) {
      return fail(`${where}: invalid media path`);
    }
    return ok({ kind: 'image', path });
  }
  if (v.kind === 'video') {
    const url =
      typeof v.url === 'string' ? normalizeVideoEmbedUrl(v.url) : null;
    if (!url) return fail(`${where}: invalid video URL`);
    return ok({ kind: 'video', url });
  }
  return fail(`${where}: unknown media kind`);
}

// ------------------------------------------------------------
// Tema, configurações, faixas
// ------------------------------------------------------------

const FONTS: readonly FormFont[] = ['system', 'serif', 'rounded', 'mono'];
const RADII: readonly FormRadius[] = ['rounded', 'square'];
const COLOR_NAMES = ['primary', 'background', 'text', 'button'] as const;

export function parseTheme(
  raw: unknown,
  scope: InputScope
): ParseResult<FormTheme> {
  if (!isRecord(raw)) return fail('theme must be an object');
  const out: FormTheme = {};

  if (raw.logo_path !== undefined && raw.logo_path !== null) {
    const p = str(raw.logo_path, 300);
    if (!p || !isOwnedMediaPath(p, scope.accountId)) {
      return fail('theme.logo_path: invalid media path');
    }
    out.logo_path = p;
  } else if (raw.logo_path === null) {
    out.logo_path = null;
  }

  if (isRecord(raw.colors)) {
    out.colors = {};
    for (const name of COLOR_NAMES) {
      // Hex é conferido na publicação (`theme_color_invalid`); aqui só o tamanho.
      const c = str(raw.colors[name], 32);
      if (c !== undefined) out.colors[name] = c;
    }
  }
  if (FONTS.includes(raw.font as FormFont)) out.font = raw.font as FormFont;
  if (RADII.includes(raw.radius as FormRadius))
    out.radius = raw.radius as FormRadius;

  if (isRecord(raw.welcome)) {
    const w = raw.welcome;
    const welcome: NonNullable<FormTheme['welcome']> = {};
    const title = str(w.title, 200);
    const description = str(w.description, 1000);
    const button = str(w.button_label, 60);
    if (title !== undefined) welcome.title = title;
    if (description !== undefined) welcome.description = description;
    if (button !== undefined) welcome.button_label = button;
    const media = parseMedia(w.media, scope, 'theme.welcome');
    if (!media.ok) return media;
    welcome.media = media.value;
    out.welcome = welcome;
  }

  if (isRecord(raw.thank_you)) {
    const t = raw.thank_you;
    const thank: NonNullable<FormTheme['thank_you']> = {};
    const title = str(t.title, 200);
    const body = str(t.body, 2000);
    const wa = bool(t.whatsapp_cta);
    const waText = str(t.whatsapp_text, 500);
    if (title !== undefined) thank.title = title;
    if (body !== undefined) thank.body = body;
    if (wa !== undefined) thank.whatsapp_cta = wa;
    if (waText !== undefined) thank.whatsapp_text = waText;
    if (t.redirect_url === null) thank.redirect_url = null;
    else {
      const r = str(t.redirect_url, 2000);
      if (r !== undefined) thank.redirect_url = r === '' ? null : r;
    }
    out.thank_you = thank;
  }
  return ok(out);
}

export function parseSettings(raw: unknown): ParseResult<FormSettings> {
  if (!isRecord(raw)) return fail('settings must be an object');
  const out: FormSettings = {};
  const flags = [
    'accept_generic_link',
    'confirm_phone_with_token',
    'require_phone_proof',
    'allow_multiple_responses',
    'turnstile',
    'robots_noindex',
  ] as const;
  for (const f of flags) {
    const b = bool(raw[f]);
    if (b !== undefined) out[f] = b;
  }
  const ttl = num(raw.token_ttl_days);
  if (ttl !== undefined) out.token_ttl_days = ttl;
  if (Array.isArray(raw.embed_origins)) {
    out.embed_origins = strList(raw.embed_origins, 50, 200);
  }
  return ok(out);
}

function parseBandActions(raw: unknown): BandActions {
  const out: BandActions = {};
  if (!isRecord(raw)) return out;
  out.tag_ids = strList(raw.tag_ids, 50, 40);
  out.notify_user_ids = strList(raw.notify_user_ids, 50, 40);
  if (isRecord(raw.deal)) {
    const d = raw.deal;
    const pipeline = str(d.pipeline_id, 40);
    const stage = str(d.stage_id, 40);
    if (pipeline && stage) {
      const deal: NonNullable<BandActions['deal']> = {
        pipeline_id: pipeline,
        stage_id: stage,
      };
      const tpl = str(d.title_template, 200);
      if (tpl) deal.title_template = tpl;
      if (isRecord(d.assign)) {
        const mode =
          d.assign.mode === 'round_robin' ? 'round_robin' : 'specific';
        const user = str(d.assign.user_id, 40);
        deal.assign = { mode, user_id: user ?? null };
      }
      out.deal = deal;
    } else {
      out.deal = null;
    }
  }
  return out;
}

export function parseScoring(raw: unknown): ParseResult<FormScoring> {
  if (!isRecord(raw)) return fail('scoring must be an object');
  const bandsRaw = raw.bands;
  if (bandsRaw === undefined) return ok({});
  if (!Array.isArray(bandsRaw)) return fail('scoring.bands must be an array');
  if (bandsRaw.length > MAX_BANDS) return fail('too many bands');
  const bands: Band[] = [];
  for (const b of bandsRaw) {
    if (!isRecord(b)) return fail('scoring.bands: invalid band');
    const key = str(b.key, 40);
    const label = str(b.label, 60);
    const min = num(b.min);
    if (!key || label === undefined || min === undefined) {
      return fail('scoring.bands: key, label and min are required');
    }
    const max = b.max === null || b.max === undefined ? null : num(b.max);
    if (max === undefined) return fail('scoring.bands: invalid max');
    bands.push({
      key,
      label,
      min,
      max,
      actions: parseBandActions(b.actions),
    });
  }
  return ok({ bands });
}

// ------------------------------------------------------------
// Criação
// ------------------------------------------------------------

export interface CreateFormBody {
  template: FormTemplateId;
  locale: FormLocale;
  name: string | null;
}

export function parseCreateBody(raw: unknown): ParseResult<CreateFormBody> {
  if (!isRecord(raw)) return fail('Invalid JSON');
  const template = (raw.template ?? 'blank') as FormTemplateId;
  if (!FORM_TEMPLATE_IDS.includes(template)) return fail('Unknown template');
  const locale = raw.locale ?? 'pt-BR';
  if (typeof locale !== 'string' || !isAppLocale(locale))
    return fail('Unsupported locale');
  let name: string | null = null;
  if (raw.name !== undefined && raw.name !== null) {
    if (typeof raw.name !== 'string') return fail('name must be a string');
    name = raw.name.trim().slice(0, FORM_NAME_MAX) || null;
  }
  return ok({ template, locale, name });
}

// ------------------------------------------------------------
// PUT /api/forms/[id] — rascunho
// ------------------------------------------------------------

export interface FormPatch {
  name?: string;
  slug?: string;
  locale?: FormLocale;
  description?: string | null;
  theme?: FormTheme;
  settings?: FormSettings;
  scoring?: FormScoring;
  portal_visibility?: PortalVisibility;
  ai_offerable?: boolean;
  ai_offer_hint?: string | null;
}

const PORTAL_VISIBILITIES: readonly PortalVisibility[] = [
  'none',
  'fill',
  'responses',
  'both',
];

export function parseFormPatch(
  raw: unknown,
  scope: InputScope
): ParseResult<FormPatch> {
  if (!isRecord(raw)) return fail('Invalid JSON');
  const out: FormPatch = {};

  if (raw.name !== undefined) {
    if (typeof raw.name !== 'string' || !raw.name.trim())
      return fail('name cannot be empty');
    out.name = raw.name.trim().slice(0, FORM_NAME_MAX);
  }
  if (raw.slug !== undefined) {
    // Formato e reservados são conferidos pela publicação e pelo CHECK do
    // banco; aqui só o tipo e o tamanho (o CHECK devolve 23514).
    if (typeof raw.slug !== 'string') return fail('slug must be a string');
    out.slug = raw.slug.trim().toLowerCase().slice(0, 80);
  }
  if (raw.locale !== undefined) {
    if (typeof raw.locale !== 'string' || !isAppLocale(raw.locale))
      return fail('Unsupported locale');
    out.locale = raw.locale;
  }
  if (raw.description !== undefined) {
    if (raw.description !== null && typeof raw.description !== 'string')
      return fail('description must be a string');
    out.description =
      raw.description === null ? null : raw.description.slice(0, 1000) || null;
  }
  if (raw.theme !== undefined) {
    const r = parseTheme(raw.theme, scope);
    if (!r.ok) return r;
    out.theme = r.value;
  }
  if (raw.settings !== undefined) {
    const r = parseSettings(raw.settings);
    if (!r.ok) return r;
    out.settings = r.value;
  }
  if (raw.scoring !== undefined) {
    const r = parseScoring(raw.scoring);
    if (!r.ok) return r;
    out.scoring = r.value;
  }
  if (raw.portal_visibility !== undefined) {
    if (
      !PORTAL_VISIBILITIES.includes(raw.portal_visibility as PortalVisibility)
    )
      return fail('Invalid portal_visibility');
    out.portal_visibility = raw.portal_visibility as PortalVisibility;
  }
  if (raw.ai_offerable !== undefined) {
    if (typeof raw.ai_offerable !== 'boolean')
      return fail('ai_offerable must be a boolean');
    out.ai_offerable = raw.ai_offerable;
  }
  if (raw.ai_offer_hint !== undefined) {
    if (raw.ai_offer_hint !== null && typeof raw.ai_offer_hint !== 'string')
      return fail('ai_offer_hint must be a string');
    out.ai_offer_hint =
      raw.ai_offer_hint === null
        ? null
        : raw.ai_offer_hint.slice(0, 300) || null;
  }
  return ok(out);
}

// ------------------------------------------------------------
// PUT /api/forms/[id]/fields — blocos
// ------------------------------------------------------------

const SHOW_IF_OPS = ['eq', 'neq', 'contains', 'answered'] as const;

function parseOptions(raw: unknown): ParseResult<FieldOption[] | null> {
  if (raw === null || raw === undefined) return ok(null);
  if (!Array.isArray(raw)) return fail('options must be an array');
  if (raw.length > MAX_OPTIONS) return fail('too many options');
  const out: FieldOption[] = [];
  for (const o of raw) {
    if (!isRecord(o)) return fail('invalid option');
    const id = str(o.id, 60);
    const label = str(o.label, 200);
    if (!id || label === undefined) return fail('option id and label required');
    const opt: FieldOption = { id, label };
    const points = num(o.points);
    if (points !== undefined) opt.points = Math.trunc(points);
    if (typeof o.jump_to === 'string' && o.jump_to)
      opt.jump_to = o.jump_to.slice(0, 40);
    else if (o.jump_to === null) opt.jump_to = null;
    out.push(opt);
  }
  return ok(out);
}

function parseValidation(raw: unknown): FieldValidation {
  if (!isRecord(raw)) return {};
  const v: FieldValidation = {};
  for (const k of [
    'min',
    'max',
    'step',
    'max_length',
    'min_choices',
    'max_choices',
    'max_files',
    'scale',
  ] as const) {
    const n = num(raw[k]);
    if (n !== undefined) v[k] = n;
  }
  if (raw.mask === 'none' || raw.mask === 'cpf' || raw.mask === 'cep')
    v.mask = raw.mask;
  if (Array.isArray(raw.accept)) v.accept = strList(raw.accept, 20, 120);
  if (Array.isArray(raw.points_ranges)) {
    const ranges: PointsRange[] = [];
    for (const r of raw.points_ranges.slice(0, 20)) {
      if (!isRecord(r)) continue;
      const points = num(r.points);
      if (points === undefined) continue;
      const min = r.min === null || r.min === undefined ? null : num(r.min);
      const max = r.max === null || r.max === undefined ? null : num(r.max);
      if (min === undefined || max === undefined) continue;
      ranges.push({ min, max, points: Math.trunc(points) });
    }
    v.points_ranges = ranges;
  }
  return v;
}

function parseMapping(raw: unknown): FieldMapping | null {
  if (!isRecord(raw) || typeof raw.target !== 'string') return null;
  const target = raw.target.slice(0, 60) as MappingTarget;
  const m: FieldMapping = { target };
  if (typeof raw.overwrite === 'boolean') m.overwrite = raw.overwrite;
  if (isRecord(raw.tag_by_option)) {
    const map: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw.tag_by_option).slice(
      0,
      MAX_OPTIONS
    )) {
      if (typeof v === 'string' && v) map[k.slice(0, 60)] = v.slice(0, 40);
    }
    m.tag_by_option = map;
  }
  return m;
}

function parseShowIf(raw: unknown): ShowIf | null {
  if (!isRecord(raw)) return null;
  const field_key = str(raw.field_key, 40);
  if (!field_key || !SHOW_IF_OPS.includes(raw.op as ShowIf['op'])) return null;
  const out: ShowIf = { field_key, op: raw.op as ShowIf['op'] };
  const v = raw.value;
  if (typeof v === 'string') out.value = v.slice(0, 200);
  else if (typeof v === 'number' || typeof v === 'boolean') out.value = v;
  else if (v === null) out.value = null;
  return out;
}

/** Um bloco do construtor → o formato da RPC `form_fields_replace`. */
export function parseFieldInput(
  raw: unknown,
  scope: InputScope
): ParseResult<FormFieldInput> {
  if (!isRecord(raw)) return fail('invalid block');
  const type = raw.type as FieldType;
  if (!FIELD_TYPES.includes(type)) return fail('invalid block type');
  const key = str(raw.key, 40);
  if (!key || !/^[a-z0-9_]{1,40}$/.test(key)) return fail('invalid block key');
  const label = str(raw.label, 500);
  if (label === undefined) return fail('block label must be a string');

  let id: string | undefined;
  if (raw.id !== undefined && raw.id !== null && raw.id !== '') {
    if (!isUuid(raw.id)) return fail('invalid block id');
    id = raw.id;
  }

  const options = parseOptions(raw.options);
  if (!options.ok) return options;
  const media = parseMedia(raw.media, scope, `block ${key}`);
  if (!media.ok) return media;

  const isChoice = CHOICE_FIELD_TYPES.includes(type);
  const description = str(raw.description, 1000);
  const field: FormFieldInput = {
    ...(id ? { id } : {}),
    key,
    position: 0, // a RPC usa o índice do array
    type,
    label,
    description: description ? description : null,
    required: raw.required === true,
    is_identity: type === 'phone' && raw.is_identity === true,
    options: isChoice ? options.value : null,
    validation: parseValidation(raw.validation),
    media: media.value,
    mapping: parseMapping(raw.mapping),
    show_if: parseShowIf(raw.show_if),
  };
  return ok(field);
}

export function parseFieldsBody(
  raw: unknown,
  scope: InputScope
): ParseResult<FormFieldInput[]> {
  const list = isRecord(raw) ? raw.fields : null;
  if (!Array.isArray(list)) return fail('fields must be an array');
  if (list.length > MAX_FIELDS) return fail('too many blocks');
  const out: FormFieldInput[] = [];
  for (const item of list) {
    const r = parseFieldInput(item, scope);
    if (!r.ok) return r;
    out.push(r.value);
  }
  out.forEach((f, i) => (f.position = i));
  return ok(out);
}

// ------------------------------------------------------------
// Link com token e mídia
// ------------------------------------------------------------

const LINK_SOURCES: readonly ResponseSource[] = [
  'link',
  'inbox',
  'broadcast',
  'automation',
  'flow',
  'portal',
  'ai',
  'api',
  'embed',
];

export function parseLinkBody(
  raw: unknown
): ParseResult<{ contactId: string; source: ResponseSource }> {
  if (!isRecord(raw)) return fail('Invalid JSON');
  if (!isUuid(raw.contact_id)) return fail('contact_id must be a UUID');
  const source = (raw.source ?? 'inbox') as ResponseSource;
  if (!LINK_SOURCES.includes(source)) return fail('Invalid source');
  return ok({ contactId: raw.contact_id, source });
}

export function parseDuplicateBody(
  raw: unknown
): ParseResult<{ name: string | null }> {
  if (raw === null || raw === undefined) return ok({ name: null });
  if (!isRecord(raw)) return fail('Invalid JSON');
  if (raw.name === undefined || raw.name === null) return ok({ name: null });
  if (typeof raw.name !== 'string') return fail('name must be a string');
  return ok({ name: raw.name.trim().slice(0, FORM_NAME_MAX) || null });
}
