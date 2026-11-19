// ============================================================
// Validação (SPEC 085 §6 `validate.ts`; critério 8 do §12.1).
//
// Duas funções, dois momentos:
//   - `validateFormForPublish(form, fields)` — roda no cliente E no
//     servidor ao publicar. Rascunho pode ser inválido; publicado, não.
//   - `validateAnswers(fields, answers, opts)` — roda no servidor no
//     `submit` (e no cliente, por bloco, para a validação inline). Só os
//     blocos VISÍVEIS contam; valor de bloco escondido é descartado
//     (§4.2 item 3); chave desconhecida some.
//
// Mensagens: códigos estáveis (a UI traduz, `Forms.*` na F2 /
// `PublicForm.*` na F3). Puro, importável do cliente.
// ============================================================

import { EMAIL_RE } from '@/lib/auth/email';
import { normalizeContactPhone } from '@/lib/phone/br';

import { pruneHiddenAnswers, resolveVisibleFields, sortFields } from './logic';
import { isReservedSlug, SLUG_PATTERN } from './slug';
import { FORM_UPLOAD_ALLOWED, uploadPathBelongsTo } from './uploads';
import {
  CHOICE_FIELD_TYPES,
  FIELD_TYPES,
  INPUT_FIELD_TYPES,
  isCssHexColor,
  type AnswerValue,
  type Answers,
  type Band,
  type FieldType,
  type FileRef,
  type Form,
  type FormField,
  type FormFieldInput,
  type IdentityMode,
  type MappingTarget,
} from './types';

// ------------------------------------------------------------
// Publicação
// ------------------------------------------------------------

export type FormIssueCode =
  | 'name_required'
  | 'slug_invalid'
  | 'slug_reserved'
  | 'locale_invalid'
  | 'no_fields'
  | 'no_input_fields'
  | 'identity_required'
  | 'identity_not_phone'
  | 'identity_duplicate'
  | 'identity_not_first_input'
  | 'identity_has_show_if'
  | 'key_invalid'
  | 'key_duplicate'
  | 'type_invalid'
  | 'label_required'
  | 'options_required'
  | 'options_too_few'
  | 'option_id_invalid'
  | 'option_id_duplicate'
  | 'option_label_required'
  | 'yes_no_options_invalid'
  | 'show_if_unknown_field'
  | 'show_if_forward_ref'
  | 'show_if_self_ref'
  | 'show_if_op_invalid'
  | 'jump_to_unknown_field'
  | 'jump_to_not_allowed'
  | 'jump_to_backward'
  | 'jump_to_self'
  | 'number_range_invalid'
  | 'step_invalid'
  | 'max_length_invalid'
  | 'choices_range_invalid'
  | 'rating_scale_invalid'
  | 'max_files_invalid'
  | 'accept_not_allowed'
  | 'points_range_invalid'
  | 'consent_must_be_required'
  | 'mapping_target_invalid'
  | 'mapping_tag_option_unknown'
  | 'band_key_duplicate'
  | 'band_range_invalid'
  | 'band_overlap'
  | 'band_gap'
  | 'band_no_zero'
  | 'band_open_end_missing'
  | 'redirect_url_not_https'
  | 'theme_color_invalid'
  | 'embed_origin_invalid'
  | 'embed_origins_too_many'
  | 'token_ttl_invalid';

export interface FormIssue {
  code: FormIssueCode;
  /** `key` do bloco (ou da faixa, ou ausente para o formulário). */
  field?: string;
  detail?: string;
}

type PublishForm = Pick<
  Form,
  'name' | 'slug' | 'locale' | 'settings' | 'scoring' | 'theme'
>;
type PublishField = FormFieldInput | FormField;

const KEY_PATTERN = /^[a-z0-9_]{1,40}$/;
const OPTION_ID_PATTERN = /^[A-Za-z0-9_-]{1,60}$/;
const SUPPORTED_FORM_LOCALES: readonly string[] = ['pt-BR', 'en'];
export const EMBED_ORIGINS_MAX = 10;
export const RATING_SCALE_MIN = 3;
export const RATING_SCALE_MAX = 10;
export const MAX_FILES_MAX = 5;

/** Para que alvo cada tipo pode ser mapeado (SPEC §4.1, última coluna). */
export const MAPPING_TARGETS_BY_TYPE: Readonly<
  Record<
    FieldType,
    readonly (
      | 'contact.name'
      | 'contact.email'
      | 'contact.company'
      | 'contact.opt_in'
      | 'custom'
      | 'tag'
    )[]
  >
> = {
  short_text: ['contact.name', 'contact.company', 'custom'],
  long_text: ['custom'],
  email: ['contact.email', 'custom'],
  phone: ['custom'],
  number: ['custom'],
  date: ['custom'],
  single_select: ['custom', 'tag'],
  multi_select: ['tag'],
  dropdown: ['custom', 'tag'],
  yes_no: ['custom', 'tag'],
  rating: ['custom'],
  file_upload: [],
  statement: [],
  consent: ['contact.opt_in'],
};

function mappingTargetKind(target: MappingTarget): string {
  return target.startsWith('custom:') ? 'custom' : target;
}

function isHttpsOrigin(value: string): boolean {
  try {
    const u = new URL(value);
    return (
      u.protocol === 'https:' &&
      u.pathname === '/' &&
      !u.search &&
      !u.hash &&
      !value.endsWith('/') &&
      !u.username &&
      !u.password
    );
  } catch {
    return false;
  }
}

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

function isNonNegInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0;
}

/**
 * Tudo que precisa ser verdade para o formulário ir ao ar. Devolve TODOS
 * os problemas (o construtor lista); vazio = pode publicar.
 */
export function validateFormForPublish(
  form: PublishForm,
  fields: readonly PublishField[]
): FormIssue[] {
  const issues: FormIssue[] = [];
  const push = (code: FormIssueCode, field?: string, detail?: string) =>
    issues.push(field ? { code, field, detail } : { code, detail });

  // Formulário -------------------------------------------------
  if (!form.name || !form.name.trim()) push('name_required');
  if (!SLUG_PATTERN.test(form.slug ?? '')) push('slug_invalid');
  else if (isReservedSlug(form.slug)) push('slug_reserved');
  if (!SUPPORTED_FORM_LOCALES.includes(form.locale)) push('locale_invalid');

  const settings = form.settings ?? {};
  const acceptGeneric = settings.accept_generic_link !== false;
  if (
    settings.token_ttl_days !== undefined &&
    settings.token_ttl_days !== null &&
    !(
      Number.isInteger(settings.token_ttl_days) &&
      settings.token_ttl_days >= 1 &&
      settings.token_ttl_days <= 365
    )
  ) {
    push('token_ttl_invalid');
  }
  const origins = settings.embed_origins ?? [];
  if (origins.length > EMBED_ORIGINS_MAX) push('embed_origins_too_many');
  for (const o of origins) {
    if (!isHttpsOrigin(o)) push('embed_origin_invalid', undefined, o);
  }
  const redirect = form.theme?.thank_you?.redirect_url;
  if (redirect && !isHttpsUrl(redirect)) push('redirect_url_not_https');
  for (const [name, color] of Object.entries(form.theme?.colors ?? {})) {
    if (color !== undefined && color !== null && !isCssHexColor(color)) {
      push('theme_color_invalid', undefined, name);
    }
  }

  // Blocos -----------------------------------------------------
  const ordered = sortFields(fields);
  if (ordered.length === 0) push('no_fields');
  const inputFields = ordered.filter((f) => INPUT_FIELD_TYPES.includes(f.type));
  if (ordered.length > 0 && inputFields.length === 0) push('no_input_fields');

  const seenKeys = new Set<string>();
  const indexByKey = new Map<string, number>();
  ordered.forEach((f, i) => {
    if (!indexByKey.has(f.key)) indexByKey.set(f.key, i);
  });

  const identities = ordered.filter((f) => f.is_identity);
  if (identities.length > 1) push('identity_duplicate');
  if (acceptGeneric && identities.length === 0) push('identity_required');
  for (const id of identities) {
    if (id.type !== 'phone') push('identity_not_phone', id.key);
    if (id.show_if) push('identity_has_show_if', id.key);
  }
  if (identities.length === 1) {
    const id = identities[0];
    // O bloco de identidade é o primeiro COM ENTRADA (§4.2 item 4):
    // antes dele nada é gravado, então nada pode vir antes que precise
    // de resposta.
    if (inputFields[0] && inputFields[0].key !== id.key) {
      push('identity_not_first_input', id.key);
    }
  }

  ordered.forEach((f, i) => {
    const k = f.key;
    if (!KEY_PATTERN.test(k)) push('key_invalid', k);
    if (seenKeys.has(k)) push('key_duplicate', k);
    seenKeys.add(k);

    if (!FIELD_TYPES.includes(f.type)) {
      push('type_invalid', k, String(f.type));
      return;
    }
    if (!f.label || !f.label.trim()) push('label_required', k);

    const v = f.validation ?? {};

    // Opções
    if (CHOICE_FIELD_TYPES.includes(f.type)) {
      const options = f.options ?? [];
      if (f.type === 'yes_no') {
        const ids = options.map((o) => o.id).sort();
        const okIds =
          options.length === 0 ||
          (ids.length === 2 && ids[0] === 'no' && ids[1] === 'yes');
        if (!okIds) push('yes_no_options_invalid', k);
      } else if (options.length === 0) {
        push('options_required', k);
      } else if (options.length < 2) {
        push('options_too_few', k);
      }
      const seenIds = new Set<string>();
      for (const o of options) {
        if (!OPTION_ID_PATTERN.test(o.id)) push('option_id_invalid', k, o.id);
        if (seenIds.has(o.id)) push('option_id_duplicate', k, o.id);
        seenIds.add(o.id);
        if (f.type !== 'yes_no' && (!o.label || !o.label.trim())) {
          push('option_label_required', k, o.id);
        }
        if (o.jump_to) {
          if (f.type === 'multi_select') {
            // Múltipla não pula (duas opções apontariam para dois lugares).
            push('jump_to_not_allowed', k, o.jump_to);
          } else if (o.jump_to === k) {
            push('jump_to_self', k, o.jump_to);
          } else if (!indexByKey.has(o.jump_to)) {
            push('jump_to_unknown_field', k, o.jump_to);
          } else if ((indexByKey.get(o.jump_to) as number) <= i) {
            // Só para frente: é o que torna ciclo impossível (PRD D-6).
            push('jump_to_backward', k, o.jump_to);
          }
        }
      }
    }

    // show_if
    if (f.show_if) {
      const ref = f.show_if.field_key;
      if (!['eq', 'neq', 'contains', 'answered'].includes(f.show_if.op)) {
        push('show_if_op_invalid', k);
      }
      if (ref === k) push('show_if_self_ref', k);
      else if (!indexByKey.has(ref)) push('show_if_unknown_field', k, ref);
      else if ((indexByKey.get(ref) as number) > i)
        push('show_if_forward_ref', k, ref);
    }

    // Validação por tipo
    if (f.type === 'number') {
      if (v.min !== undefined && v.max !== undefined && v.min > v.max) {
        push('number_range_invalid', k);
      }
      if (v.step !== undefined && !(Number.isFinite(v.step) && v.step > 0)) {
        push('step_invalid', k);
      }
    }
    if (
      (f.type === 'short_text' || f.type === 'long_text') &&
      v.max_length !== undefined
    ) {
      if (!(Number.isInteger(v.max_length) && v.max_length >= 1)) {
        push('max_length_invalid', k);
      }
    }
    if (f.type === 'multi_select') {
      const min = v.min_choices ?? 0;
      const max = v.max_choices ?? f.options?.length ?? 0;
      if (
        !isNonNegInt(min) ||
        !isNonNegInt(max) ||
        min > max ||
        max > (f.options?.length ?? 0)
      ) {
        push('choices_range_invalid', k);
      }
    }
    if (f.type === 'rating') {
      const scale = v.scale ?? 5;
      if (!(
        Number.isInteger(scale) &&
        scale >= RATING_SCALE_MIN &&
        scale <= RATING_SCALE_MAX
      )) {
        push('rating_scale_invalid', k);
      }
    }
    if (f.type === 'file_upload') {
      const maxFiles = v.max_files ?? 1;
      if (!(
        Number.isInteger(maxFiles) &&
        maxFiles >= 1 &&
        maxFiles <= MAX_FILES_MAX
      )) {
        push('max_files_invalid', k);
      }
      for (const mime of v.accept ?? []) {
        if (!FORM_UPLOAD_ALLOWED[mime]) push('accept_not_allowed', k, mime);
      }
    }
    if (f.type === 'number' || f.type === 'rating') {
      for (const r of v.points_ranges ?? []) {
        const okMin =
          r.min === null || r.min === undefined || Number.isFinite(r.min);
        const okMax =
          r.max === null || r.max === undefined || Number.isFinite(r.max);
        const ordered =
          r.min === null ||
          r.min === undefined ||
          r.max === null ||
          r.max === undefined ||
          r.min <= r.max;
        if (!okMin || !okMax || !ordered || !Number.isFinite(r.points)) {
          push('points_range_invalid', k);
          break;
        }
      }
    }
    if (f.type === 'consent' && !f.required)
      push('consent_must_be_required', k);

    // Mapeamento
    if (f.mapping) {
      const allowed = MAPPING_TARGETS_BY_TYPE[f.type];
      const kind = mappingTargetKind(f.mapping.target);
      if (!allowed.includes(kind as (typeof allowed)[number])) {
        push('mapping_target_invalid', k, f.mapping.target);
      } else if (
        kind === 'custom' &&
        !/^custom:[0-9a-fA-F-]{36}$/.test(f.mapping.target)
      ) {
        push('mapping_target_invalid', k, f.mapping.target);
      }
      if (kind === 'tag') {
        const ids = new Set((f.options ?? []).map((o) => o.id));
        for (const optionId of Object.keys(f.mapping.tag_by_option ?? {})) {
          if (!ids.has(optionId))
            push('mapping_tag_option_unknown', k, optionId);
        }
      }
    }
  });

  // Faixas -----------------------------------------------------
  issues.push(...validateBands(form.scoring?.bands ?? []));

  return issues;
}

/**
 * Faixas: chaves únicas, `min ≤ max`, sem sobreposição e cobrindo o
 * domínio (começam em 0, sem buraco, a última aberta). Nenhuma faixa é
 * válido (formulário sem classificação).
 */
export function validateBands(bands: readonly Band[]): FormIssue[] {
  const issues: FormIssue[] = [];
  if (bands.length === 0) return issues;

  const seen = new Set<string>();
  for (const b of bands) {
    if (seen.has(b.key))
      issues.push({ code: 'band_key_duplicate', field: b.key });
    seen.add(b.key);
    const badMin = !Number.isInteger(b.min) || b.min < 0;
    const badMax =
      b.max !== null &&
      b.max !== undefined &&
      (!Number.isInteger(b.max) || b.max < b.min);
    if (badMin || badMax)
      issues.push({ code: 'band_range_invalid', field: b.key });
  }
  if (issues.length) return issues;

  const ordered = [...bands].sort((a, b) => a.min - b.min);
  if (ordered[0].min !== 0)
    issues.push({ code: 'band_no_zero', field: ordered[0].key });
  for (let i = 1; i < ordered.length; i++) {
    const prev = ordered[i - 1];
    const cur = ordered[i];
    if (prev.max === null || prev.max === undefined) {
      issues.push({ code: 'band_overlap', field: cur.key });
    } else if (cur.min <= prev.max) {
      issues.push({ code: 'band_overlap', field: cur.key });
    } else if (cur.min !== prev.max + 1) {
      issues.push({ code: 'band_gap', field: cur.key });
    }
  }
  const last = ordered[ordered.length - 1];
  if (last.max !== null && last.max !== undefined) {
    issues.push({ code: 'band_open_end_missing', field: last.key });
  }
  return issues;
}

// ------------------------------------------------------------
// Respostas
// ------------------------------------------------------------

export type AnswerErrorCode =
  | 'required'
  | 'invalidType'
  | 'invalidEmail'
  | 'invalidPhone'
  | 'invalidNumber'
  | 'invalidDate'
  | 'invalidOption'
  | 'minChoices'
  | 'maxChoices'
  | 'maxLength'
  | 'minValue'
  | 'maxValue'
  | 'tooManyFiles'
  | 'invalidFile'
  | 'consentRequired';

export interface AnswerError {
  key: string;
  code: AnswerErrorCode;
}

export interface ValidateAnswersOptions {
  identityMode: IdentityMode | 'preview';
  /** `settings.confirm_phone_with_token` (padrão falso). */
  confirmPhoneWithToken?: boolean;
  /** Só para teste do telefone; em produção vem de `isBrDeployment()`. */
  brMode?: boolean;
  /**
   * Pasta da resposta no bucket `form-uploads`. Todo `FileRef.path` tem de
   * estar DENTRO dela (E-16): caminho de outra conta/formulário/resposta
   * é `invalidFile`. `null` (prévia, ou resposta ainda sem id) recusa
   * qualquer arquivo. Obrigatório de propósito — a rota não pode esquecer.
   */
  uploadScope: UploadScope | null;
}

export interface UploadScope {
  accountId: string;
  formId: string;
  responseId: string;
}

export type ValidateAnswersResult =
  { ok: true; answers: Answers } | { ok: false; errors: AnswerError[] };

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
export const SHORT_TEXT_MAX = 500;
export const LONG_TEXT_MAX = 5000;

function isValidIsoDate(s: string): boolean {
  const m = DATE_PATTERN.exec(s);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return (
    dt.getUTCFullYear() === y &&
    dt.getUTCMonth() === mo - 1 &&
    dt.getUTCDate() === d
  );
}

function isFileRef(v: unknown): v is FileRef {
  if (!v || typeof v !== 'object') return false;
  const f = v as Record<string, unknown>;
  return (
    typeof f.path === 'string' &&
    f.path.length > 0 &&
    typeof f.name === 'string' &&
    typeof f.mime === 'string' &&
    typeof f.size === 'number' &&
    Number.isInteger(f.size) &&
    f.size > 0
  );
}

/** Valida UM bloco; `null` = ok. Exportado para a validação inline do cliente. */
export function validateAnswer(
  field: Pick<
    FormField,
    'key' | 'type' | 'required' | 'options' | 'validation'
  >,
  raw: AnswerValue | undefined,
  opts?: {
    brMode?: boolean;
    /** Ausente = validação inline do cliente (sem checar a pasta). */
    uploadScope?: UploadScope | null;
  }
): { code: AnswerErrorCode } | { ok: true; value: AnswerValue } | null {
  const v = field.validation ?? {};
  const empty =
    raw === undefined ||
    raw === null ||
    (typeof raw === 'string' && raw.trim() === '') ||
    (Array.isArray(raw) && raw.length === 0);

  if (empty) {
    if (field.type === 'consent')
      return field.required ? { code: 'consentRequired' } : null;
    return field.required ? { code: 'required' } : null;
  }

  switch (field.type) {
    case 'short_text':
    case 'long_text': {
      if (typeof raw !== 'string') return { code: 'invalidType' };
      const value = raw.trim();
      const cap =
        v.max_length ??
        (field.type === 'short_text' ? SHORT_TEXT_MAX : LONG_TEXT_MAX);
      if (value.length > cap) return { code: 'maxLength' };
      return { ok: true, value };
    }
    case 'email': {
      if (typeof raw !== 'string') return { code: 'invalidType' };
      const value = raw.trim().toLowerCase();
      if (value.length > 254 || !EMAIL_RE.test(value))
        return { code: 'invalidEmail' };
      return { ok: true, value };
    }
    case 'phone': {
      if (typeof raw !== 'string') return { code: 'invalidType' };
      const r = normalizeContactPhone(
        raw,
        opts?.brMode !== undefined ? { brMode: opts.brMode } : undefined
      );
      if (!r.ok) return { code: 'invalidPhone' };
      return { ok: true, value: r.phone };
    }
    case 'number': {
      const n = typeof raw === 'string' ? Number(raw.replace(',', '.')) : raw;
      if (typeof n !== 'number' || !Number.isFinite(n))
        return { code: 'invalidNumber' };
      if (v.min !== undefined && n < v.min) return { code: 'minValue' };
      if (v.max !== undefined && n > v.max) return { code: 'maxValue' };
      return { ok: true, value: n };
    }
    case 'date': {
      if (typeof raw !== 'string' || !isValidIsoDate(raw.trim()))
        return { code: 'invalidDate' };
      return { ok: true, value: raw.trim() };
    }
    case 'single_select':
    case 'dropdown': {
      if (typeof raw !== 'string') return { code: 'invalidType' };
      if (!field.options?.some((o) => o.id === raw))
        return { code: 'invalidOption' };
      return { ok: true, value: raw };
    }
    case 'multi_select': {
      if (!Array.isArray(raw) || raw.some((x) => typeof x !== 'string')) {
        return { code: 'invalidType' };
      }
      const ids = Array.from(new Set(raw as string[]));
      if (ids.some((id) => !field.options?.some((o) => o.id === id))) {
        return { code: 'invalidOption' };
      }
      if (v.min_choices !== undefined && ids.length < v.min_choices)
        return { code: 'minChoices' };
      if (v.max_choices !== undefined && ids.length > v.max_choices)
        return { code: 'maxChoices' };
      return { ok: true, value: ids };
    }
    case 'yes_no': {
      if (typeof raw === 'boolean') return { ok: true, value: raw };
      if (raw === 'yes' || raw === 'no')
        return { ok: true, value: raw === 'yes' };
      return { code: 'invalidType' };
    }
    case 'rating': {
      const scale = v.scale ?? 5;
      const n = typeof raw === 'string' ? Number(raw) : raw;
      if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > scale) {
        return { code: 'invalidNumber' };
      }
      return { ok: true, value: n };
    }
    case 'file_upload': {
      if (!Array.isArray(raw) || !(raw as unknown[]).every(isFileRef))
        return { code: 'invalidFile' };
      const maxFiles = v.max_files ?? 1;
      if (raw.length > maxFiles) return { code: 'tooManyFiles' };
      if (opts && 'uploadScope' in opts) {
        const scope = opts.uploadScope;
        const inScope =
          !!scope &&
          (raw as FileRef[]).every((f) => uploadPathBelongsTo(f.path, scope));
        if (!inScope) return { code: 'invalidFile' };
      }
      // Só os quatro campos: o resto do objeto que o navegador mandou (lixo,
      // JSON arbitrário) não entra no instantâneo nem na exportação.
      return {
        ok: true,
        value: (raw as FileRef[]).map((f) => ({
          path: f.path,
          name: f.name,
          mime: f.mime,
          size: f.size,
        })),
      };
    }
    case 'consent': {
      if (raw !== true) return { code: 'consentRequired' };
      return { ok: true, value: true };
    }
    case 'statement':
      // Não tem valor; o que vier é descartado.
      return null;
    default:
      return { code: 'invalidType' };
  }
}

/**
 * Valida as respostas inteiras no servidor (§4.2 item 7). Devolve as
 * respostas LIMPAS (só blocos visíveis, valores normalizados — telefone
 * só dígitos, e-mail minúsculo, número como `number`) ou a lista de
 * erros por bloco. Em `token` sem `confirmPhoneWithToken`, o bloco de
 * identidade é pulado (PRD D-2).
 */
export function validateAnswers(
  fields: readonly FormField[],
  rawAnswers: Answers,
  opts: ValidateAnswersOptions
): ValidateAnswersResult {
  const skipIdentity =
    opts.identityMode === 'token' && !opts.confirmPhoneWithToken;
  const considered = skipIdentity
    ? fields.filter((f) => !f.is_identity)
    : fields;

  const pruned = pruneHiddenAnswers(considered, rawAnswers);
  const errors: AnswerError[] = [];
  const clean: Answers = {};

  // Visibilidade é decidida pelas respostas CRUAS (o que o visitante viu);
  // a validação roda só sobre os visíveis — inclusive os sem resposta
  // (para o `required` pegar).
  const visible = resolveVisibleFields(considered, rawAnswers);
  for (const field of visible) {
    if (field.type === 'statement') continue;
    const result = validateAnswer(field, pruned[field.key], {
      brMode: opts.brMode,
      uploadScope: opts.uploadScope,
    });
    if (result === null) continue;
    if ('code' in result) {
      errors.push({ key: field.key, code: result.code });
      continue;
    }
    clean[field.key] = result.value;
  }

  return errors.length ? { ok: false, errors } : { ok: true, answers: clean };
}
