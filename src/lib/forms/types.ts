// ============================================================
// Tipos dos formulários de captação (SPEC 085 §4.1, §5.1, §6).
//
// Espelham as tabelas `forms`, `form_fields` e `form_responses` (097) e
// os JSONB que elas guardam. Dois cuidados que valem para todo o módulo:
//
//   1. `FieldType` é uma união FECHADA, igual ao CHECK do banco: um tipo
//      de bloco novo entra aqui, no CHECK e em `validate.ts` juntos.
//   2. `PublicFormPayload` é o ÚNICO formato que chega ao navegador do
//      visitante (E-9). Nada de `account_id`, pontos, faixas, ids de
//      etiqueta/funil ou mapeamentos passa por ele; `project-public.ts`
//      monta e o teste de contrato confere.
//
// Importável do cliente: este arquivo não toca Supabase nem `node:`.
// ============================================================

import type { AppLocale } from '@/lib/i18n/locales';

export const FIELD_TYPES = [
  'short_text',
  'long_text',
  'email',
  'phone',
  'number',
  'date',
  'single_select',
  'multi_select',
  'dropdown',
  'yes_no',
  'rating',
  'file_upload',
  'statement',
  'consent',
] as const;

export type FieldType = (typeof FIELD_TYPES)[number];

/** Blocos que o visitante responde (têm valor em `answers`). */
export const INPUT_FIELD_TYPES: readonly FieldType[] = FIELD_TYPES.filter(
  (t) => t !== 'statement'
);

/** Blocos com `options[]` (escolha). `yes_no` usa as opções fixas `yes`/`no`. */
export const CHOICE_FIELD_TYPES: readonly FieldType[] = [
  'single_select',
  'multi_select',
  'dropdown',
  'yes_no',
];

export const YES_NO_OPTION_IDS = ['yes', 'no'] as const;

export type FormStatus = 'draft' | 'published' | 'archived';
export type FormLocale = AppLocale;
export type ResponseStatus = 'partial' | 'completed' | 'abandoned';
export type IdentityMode = 'phone' | 'token';
export type ResponseSource =
  | 'link'
  | 'inbox'
  | 'broadcast'
  | 'automation'
  | 'flow'
  | 'portal'
  | 'ai'
  | 'api'
  | 'embed';
export type PortalVisibility = 'none' | 'fill' | 'responses' | 'both';

// ------------------------------------------------------------
// Bloco
// ------------------------------------------------------------

export interface FieldOption {
  id: string;
  label: string;
  /** Pontos da opção (PRD D-5). Nunca vai ao payload público. */
  points?: number;
  /** `key` de um bloco POSTERIOR para onde pular ao escolher (PRD D-6). */
  jump_to?: string | null;
}

export type ShowIfOp = 'eq' | 'neq' | 'contains' | 'answered';

/** Uma condição só, sem grafo (PRD D-6). */
export interface ShowIf {
  field_key: string;
  op: ShowIfOp;
  value?: string | number | boolean | null;
}

export type FieldMedia =
  { kind: 'image'; path: string } | { kind: 'video'; url: string };

export type TextMask = 'none' | 'cpf' | 'cep';

/** Faixa de pontos para `number`/`rating` (inclusiva; `null` = aberta). */
export interface PointsRange {
  min: number | null;
  max: number | null;
  points: number;
}

export interface FieldValidation {
  min?: number;
  max?: number;
  step?: number;
  max_length?: number;
  mask?: TextMask;
  min_choices?: number;
  max_choices?: number;
  max_files?: number;
  /** MIME types aceitos (subconjunto da allowlist de `uploads.ts`). */
  accept?: string[];
  /** `rating`: 3..10. */
  scale?: number;
  points_ranges?: PointsRange[];
}

export type MappingTarget =
  | 'contact.name'
  | 'contact.email'
  | 'contact.company'
  | 'contact.opt_in'
  | `custom:${string}`
  | 'tag';

export interface FieldMapping {
  target: MappingTarget;
  /** `false` (padrão) = preenche se vazio (PRD D-4). */
  overwrite?: boolean;
  /** `tag`: `option_id → tag_id`. Etiquetas são aditivas. */
  tag_by_option?: Record<string, string>;
}

export interface FormField {
  id: string;
  form_id: string;
  account_id: string;
  key: string;
  position: number;
  type: FieldType;
  label: string;
  description: string | null;
  required: boolean;
  /** Só em `phone`; no máximo um por formulário (PRD D-2). */
  is_identity: boolean;
  options: FieldOption[] | null;
  validation: FieldValidation;
  media: FieldMedia | null;
  mapping: FieldMapping | null;
  show_if: ShowIf | null;
  created_at: string;
  updated_at: string;
}

/** O que o construtor manda para criar/substituir blocos (sem ids de linha). */
export type FormFieldInput = Omit<
  FormField,
  'id' | 'form_id' | 'account_id' | 'created_at' | 'updated_at'
> & { id?: string };

// ------------------------------------------------------------
// Formulário
// ------------------------------------------------------------

/**
 * Cor de tema: só hex (`#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`). É o que
 * vai parar numa variável CSS da página pública — qualquer outra forma é
 * vetor de injeção de estilo (SPEC 085 §8).
 */
export const CSS_HEX_COLOR_PATTERN =
  /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

export function isCssHexColor(value: unknown): value is string {
  return typeof value === 'string' && CSS_HEX_COLOR_PATTERN.test(value);
}

export interface FormThemeColors {
  primary?: string;
  background?: string;
  text?: string;
  button?: string;
}

export interface FormWelcome {
  title?: string;
  description?: string;
  button_label?: string;
  media?: FieldMedia | null;
}

export interface FormThankYou {
  title?: string;
  body?: string;
  whatsapp_cta?: boolean;
  whatsapp_text?: string;
  /** Só `https://`, após 3 s (SPEC §4.2 item 8). */
  redirect_url?: string | null;
}

export type FormFont = 'system' | 'serif' | 'rounded' | 'mono';
export type FormRadius = 'rounded' | 'square';

export interface FormTheme {
  logo_path?: string | null;
  colors?: FormThemeColors;
  font?: FormFont;
  radius?: FormRadius;
  welcome?: FormWelcome;
  thank_you?: FormThankYou;
}

export interface FormSettings {
  /** `true` (padrão): `/f/<slug>` sem token pede o telefone (PRD D-2). */
  accept_generic_link?: boolean;
  confirm_phone_with_token?: boolean;
  allow_multiple_responses?: boolean;
  /** Padrão 30 (PRD R-4). */
  token_ttl_days?: number;
  turnstile?: boolean;
  /** `https://` + host, sem caminho, no máximo 10 (SPEC §8 item 10). */
  embed_origins?: string[];
  robots_noindex?: boolean;
}

export type AssignMode = 'specific' | 'round_robin';

export interface BandDealAction {
  pipeline_id: string;
  stage_id: string;
  /** Padrão `{{contact.name}} — {{form.name}}`. */
  title_template?: string;
  assign?: { mode: AssignMode; user_id?: string | null };
}

export interface BandActions {
  tag_ids?: string[];
  deal?: BandDealAction | null;
  notify_user_ids?: string[];
}

export interface Band {
  key: string;
  label: string;
  min: number;
  /** `null` = sem teto. */
  max: number | null;
  actions?: BandActions;
}

export interface FormScoring {
  bands?: Band[];
}

export interface Form {
  id: string;
  account_id: string;
  /** Criador; NULL depois que o usuário foi excluído (088). */
  user_id: string | null;
  name: string;
  slug: string;
  status: FormStatus;
  locale: FormLocale;
  description: string | null;
  theme: FormTheme;
  settings: FormSettings;
  scoring: FormScoring;
  portal_visibility: PortalVisibility;
  ai_offerable: boolean;
  ai_offer_hint: string | null;
  version: number;
  published_at: string | null;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

// ------------------------------------------------------------
// Resposta
// ------------------------------------------------------------

export interface FileRef {
  path: string;
  name: string;
  mime: string;
  size: number;
}

/** Valor cru que o navegador manda, por `key` de bloco. */
export type AnswerValue = string | number | boolean | string[] | FileRef[];
export type Answers = Record<string, AnswerValue>;

/** Uma entrada do instantâneo `form_responses.answers` (PRD D-4). */
export interface AnswerSnapshotEntry {
  label: string;
  type: FieldType;
  value: AnswerValue;
  points: number;
  /** Rótulos das opções escolhidas no momento do envio. */
  option_labels?: string[];
}

export type AnswersSnapshot = Record<string, AnswerSnapshotEntry>;

export interface FormResponse {
  id: string;
  form_id: string;
  account_id: string;
  contact_id: string;
  status: ResponseStatus;
  identity_mode: IdentityMode;
  source: ResponseSource;
  form_version: number;
  answers: AnswersSnapshot;
  score: number | null;
  band_key: string | null;
  upload_bytes: number;
  utm: Record<string, string> | null;
  locale: string | null;
  ip_hash: string | null;
  user_agent: string | null;
  started_at: string;
  completed_at: string | null;
  updated_at: string;
}

// ------------------------------------------------------------
// Projeção pública (E-9) — o que o visitante recebe
// ------------------------------------------------------------

export type PublicIdentityMode = 'phone' | 'token' | 'preview';

export interface PublicFieldOption {
  id: string;
  label: string;
  jump_to?: string | null;
}

/** `FieldValidation` sem nada que pontue. */
export type PublicFieldValidation = Omit<FieldValidation, 'points_ranges'>;

export type PublicFieldMedia =
  { kind: 'image'; url: string } | { kind: 'video'; url: string };

export interface PublicField {
  key: string;
  type: FieldType;
  label: string;
  description: string | null;
  required: boolean;
  is_identity: boolean;
  options: PublicFieldOption[] | null;
  validation: PublicFieldValidation;
  media: PublicFieldMedia | null;
  show_if: ShowIf | null;
}

export interface PublicFormPayload {
  slug: string;
  name: string;
  locale: FormLocale;
  description: string | null;
  theme: {
    logo_url: string | null;
    colors: FormThemeColors;
    font: FormFont;
    radius: FormRadius;
    welcome: Omit<FormWelcome, 'media'> & { media: PublicFieldMedia | null };
    thank_you: Omit<FormThankYou, 'redirect_url'> & {
      redirect_url: string | null;
    };
  };
  fields: PublicField[];
  identity: { mode: PublicIdentityMode };
  settings: {
    allow_multiple_responses: boolean;
    confirm_phone_with_token: boolean;
    turnstile_site_key: string | null;
    /**
     * `false` quando a quota de bytes de upload da conta acabou (PRD D-10):
     * só o bloco de arquivo some (o resto do formulário segue).
     */
    uploads_available: boolean;
  };
  /** Blocos com entrada × 10 s (SPEC §4.2 item 2). */
  estimated_seconds: number;
}
