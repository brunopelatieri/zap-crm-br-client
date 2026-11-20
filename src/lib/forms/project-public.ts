// ============================================================
// Projeção pública (SPEC 085 E-9; PRD 084 D-9, R-5).
//
// O ÚNICO caminho pelo qual um formulário chega ao navegador do
// visitante. É uma lista de inclusão explícita, campo a campo — nunca um
// spread do registro — para que uma coluna nova em `forms` ou um campo
// novo em `validation` não vaze por acidente. O teste de contrato
// serializa um formulário cheio e falha se o JSON contiver `account_id`,
// `points`, `band`, `tag_id`, `pipeline_id`, `stage_id`, `assign`,
// `user_id` ou `notify`.
//
// Mídia: o servidor assina as URLs antes (E-16) e passa o mapa
// `path → url`; caminho sem assinatura sai como `null`, nunca como o
// caminho cru do bucket.
// ============================================================

import { sortFields } from './logic';
import {
  INPUT_FIELD_TYPES,
  isCssHexColor,
  type FieldMedia,
  type FormThemeColors,
  type Form,
  type FormField,
  type PublicField,
  type PublicFieldMedia,
  type PublicFormPayload,
  type PublicIdentityMode,
} from './types';

/** Segundos por bloco com entrada (SPEC §4.2 item 2). */
export const SECONDS_PER_INPUT_FIELD = 10;

export interface ProjectPublicOptions {
  /** `path` do bucket `form-media` → URL assinada. */
  signedMedia?: Record<string, string>;
  identity: PublicIdentityMode;
  /** `TURNSTILE_SITE_KEY` quando o formulário tem Turnstile ligado e o deploy tem a chave. */
  turnstileSiteKey?: string | null;
  /** `false` com a quota de upload cheia (PRD D-10); padrão `true`. */
  uploadsAvailable?: boolean;
}

function projectMedia(
  media: FieldMedia | null | undefined,
  signed: Record<string, string>
): PublicFieldMedia | null {
  if (!media) return null;
  if (media.kind === 'video') {
    return typeof media.url === 'string' && /^https:\/\//.test(media.url)
      ? { kind: 'video', url: media.url }
      : null;
  }
  const url = signed[media.path];
  return url ? { kind: 'image', url } : null;
}

export function projectField(
  field: FormField,
  signed: Record<string, string>
): PublicField {
  const v = field.validation ?? {};
  // Sem `points_ranges`; só o que a tela precisa para validar inline.
  const validation: PublicField['validation'] = {};
  if (v.min !== undefined) validation.min = v.min;
  if (v.max !== undefined) validation.max = v.max;
  if (v.step !== undefined) validation.step = v.step;
  if (v.max_length !== undefined) validation.max_length = v.max_length;
  if (v.mask !== undefined) validation.mask = v.mask;
  if (v.min_choices !== undefined) validation.min_choices = v.min_choices;
  if (v.max_choices !== undefined) validation.max_choices = v.max_choices;
  if (v.max_files !== undefined) validation.max_files = v.max_files;
  if (v.accept !== undefined) validation.accept = [...v.accept];
  if (v.scale !== undefined) validation.scale = v.scale;

  return {
    key: field.key,
    type: field.type,
    label: field.label,
    description: field.description ?? null,
    required: field.required,
    is_identity: field.is_identity,
    // Só id, rótulo e pulo — nunca os pontos.
    options: field.options
      ? field.options.map((o) => ({
          id: o.id,
          label: o.label,
          ...(o.jump_to ? { jump_to: o.jump_to } : {}),
        }))
      : null,
    validation,
    media: projectMedia(field.media, signed),
    show_if: field.show_if
      ? {
          field_key: field.show_if.field_key,
          op: field.show_if.op,
          ...(field.show_if.value !== undefined
            ? { value: field.show_if.value }
            : {}),
        }
      : null,
  };
}

/**
 * `toPublicPayload(form, fields, opts)`: o que a página pública recebe.
 * Em `identity.mode = 'token'` o bloco de identidade continua na lista
 * (o cliente o pula, salvo `confirm_phone_with_token`); o `contact_id`
 * NUNCA vai no payload — o token volta no envio (SPEC §4.2 item 1).
 */
export function toPublicPayload(
  form: Form,
  fields: readonly FormField[],
  opts: ProjectPublicOptions
): PublicFormPayload {
  const signed = opts.signedMedia ?? {};
  const theme = form.theme ?? {};
  const welcome = theme.welcome ?? {};
  const thankYou = theme.thank_you ?? {};
  const settings = form.settings ?? {};

  const ordered = sortFields(fields);
  const publicFields = ordered.map((f) => projectField(f, signed));
  const inputCount = ordered.filter((f) =>
    INPUT_FIELD_TYPES.includes(f.type)
  ).length;

  return {
    slug: form.slug,
    name: form.name,
    locale: form.locale,
    description: form.description ?? null,
    theme: {
      logo_url: theme.logo_path ? (signed[theme.logo_path] ?? null) : null,
      colors: projectColors(theme.colors),
      font: theme.font ?? 'system',
      radius: theme.radius ?? 'rounded',
      welcome: {
        ...(welcome.title !== undefined ? { title: welcome.title } : {}),
        ...(welcome.description !== undefined
          ? { description: welcome.description }
          : {}),
        ...(welcome.button_label !== undefined
          ? { button_label: welcome.button_label }
          : {}),
        media: projectMedia(welcome.media, signed),
      },
      thank_you: {
        ...(thankYou.title !== undefined ? { title: thankYou.title } : {}),
        ...(thankYou.body !== undefined ? { body: thankYou.body } : {}),
        ...(thankYou.whatsapp_cta !== undefined
          ? { whatsapp_cta: thankYou.whatsapp_cta }
          : {}),
        ...(thankYou.whatsapp_text !== undefined
          ? { whatsapp_text: thankYou.whatsapp_text }
          : {}),
        redirect_url:
          thankYou.redirect_url && /^https:\/\//.test(thankYou.redirect_url)
            ? thankYou.redirect_url
            : null,
      },
    },
    fields: publicFields,
    identity: { mode: opts.identity },
    settings: {
      allow_multiple_responses: settings.allow_multiple_responses === true,
      confirm_phone_with_token: settings.confirm_phone_with_token === true,
      phone_proof:
        opts.identity === 'phone' && settings.require_phone_proof === true,
      turnstile_site_key:
        settings.turnstile === true && opts.turnstileSiteKey
          ? opts.turnstileSiteKey
          : null,
      uploads_available: opts.uploadsAvailable !== false,
    },
    estimated_seconds: inputCount * SECONDS_PER_INPUT_FIELD,
  };
}

/** Só cores hex passam (publicação já valida; aqui é a segunda trava). */
function projectColors(colors: FormThemeColors | undefined): FormThemeColors {
  const out: FormThemeColors = {};
  for (const name of ['primary', 'background', 'text', 'button'] as const) {
    const value = colors?.[name];
    if (isCssHexColor(value)) out[name] = value;
  }
  return out;
}

/**
 * Chaves que NUNCA podem aparecer no JSON público (E-9). Exportadas para
 * o teste de contrato e para quem quiser reconferir em runtime.
 */
export const PUBLIC_PAYLOAD_FORBIDDEN_KEYS = [
  'account_id',
  'points',
  'band',
  'tag_id',
  'pipeline_id',
  'stage_id',
  'assign',
  'user_id',
  'notify',
  'mapping',
  'scoring',
  'contact_id',
  'ip_hash',
] as const;

/** Nomes de chave do JSON (não valores) que violam o contrato. */
export function findForbiddenPublicKeys(payload: unknown): string[] {
  const found = new Set<string>();
  const visit = (value: unknown) => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (value && typeof value === 'object') {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        for (const forbidden of PUBLIC_PAYLOAD_FORBIDDEN_KEYS) {
          if (k === forbidden || k.includes(forbidden)) found.add(k);
        }
        visit(v);
      }
    }
  };
  visit(payload);
  return [...found];
}
