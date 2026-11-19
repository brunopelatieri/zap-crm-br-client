// ============================================================
// Serviço da página e das rotas PÚBLICAS dos formulários (SPEC 085 §4.2,
// §7.2, §8; PRD 084 D-2, D-5, D-7, D-9, R-5, R-6).
//
// É o ÚNICO lugar fora de `plan-gate.ts` e `admin-client.ts` que usa o
// service-role dos formulários (`isolation`/`admin-client.test.ts`): a
// página (`app/(public)/f/**`) e as rotas só chamam funções daqui. O
// service-role é ESCOPADO por slug: toda leitura/escrita começa em
// `form_public_availability(slug)`, que devolve o `form_id` e o
// `account_id` — nunca vêm do cliente — e cada consulta seguinte filtra
// por eles.
//
// Regras que este arquivo segura:
//   - TODA indisponibilidade (inexistente, rascunho, plano, quota, conta
//     bloqueada) é o mesmo `unavailable`: a página e as rotas não dizem
//     qual (PRD D-11, L5);
//   - o payload da página sai SÓ de `toPublicPayload` (E-9);
//   - pontuação e faixa só existem aqui, a partir das respostas VALIDADAS
//     (E-5): o corpo do envio não tem campo de pontos e o que o cliente
//     mandar além de `answers` é ignorado;
//   - a identidade fica fixada no `start` (token > telefone) e é a linha
//     da resposta — não o corpo do envio — que diz quem respondeu;
//   - `resume_token`: opaco por resposta, só o sha256 no banco, descartado
//     ao concluir; comparação em tempo constante;
//   - upload: a rota assina, o navegador envia direto ao Storage, e o
//     envio confere o objeto e o tamanho real antes de gravar.
// ============================================================

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import type { SupabaseClient } from '@supabase/supabase-js';
import { createTranslator } from 'next-intl';

import { resolveAuditUserId } from '@/lib/api/v1/contacts';
import { resolveDefaultChannelId } from '@/lib/channels/default-channel';
import { checkRateLimit, RATE_LIMITS } from '@/lib/rate-limit';

import { supabaseAdmin } from './admin-client';
import { collectMediaPaths } from './account-api';
import { isOwnedMediaPath } from './account-input';
import { recordFormSubmitted } from './activity';
import { applyBandActions } from './apply-band';
import { applyMappings } from './apply-mapping';
import {
  isFormAvailable,
  parseAvailabilityRow,
  type FormAvailability,
} from './availability';
import { resolveIdentity } from './identity';
import { verifyFormLink, type FormLinkClaims } from './link-token';
import { toPublicPayload } from './project-public';
import {
  loadPublicFormMessages,
  resolveFormLocale,
  type PublicFormMessageKey,
} from './public-messages';
import { PublicApiError, unavailableError } from './public-api';
import { parseUploadQuotaRow, uploadQuotaHasRoom } from './quota';
import { computeScore, resolveBand } from './scoring';
import { snapshotAnswers } from './snapshot';
import { turnstileSiteKey, verifyTurnstile } from './turnstile';
import {
  buildUploadPath,
  FORM_MEDIA_BUCKET,
  FORM_UPLOADS_BUCKET,
  fileExtension,
  parseUploadPath,
  validateUploadRequest,
  verifyUploadedObject,
} from './uploads';
import { validateAnswer, validateAnswers } from './validate';
import type {
  Answers,
  AnswerValue,
  AnswersSnapshot,
  FileRef,
  Form,
  FormField,
  IdentityMode,
  PublicFormPayload,
  ResponseSource,
} from './types';

type Db = SupabaseClient;

/** Menos que isso entre o `start` e o envio é script, não pessoa (SPEC §7.2). */
export const MIN_FILL_MS = 3000;
/** URL assinada de imagem do formulário (E-16). */
export const PUBLIC_MEDIA_TTL_SECONDS = 7 * 24 * 60 * 60;
/** Teto de chaves por PATCH de autosave. */
const DELTA_MAX_KEYS = 100;
const UTM_KEYS = [
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
] as const;

// ------------------------------------------------------------
// Token de retomada
// ------------------------------------------------------------

export function generateResumeToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashResumeToken(token: string): Buffer {
  return createHash('sha256').update(token, 'utf8').digest();
}

/** `bytea` como o PostgREST o aceita (`\x…`). */
function toByteaLiteral(buf: Buffer): string {
  return `\\x${buf.toString('hex')}`;
}

/** Compara o hash guardado (`\x…` ou `null`) com o token recebido, em tempo constante. */
export function resumeTokenMatches(stored: unknown, token: unknown): boolean {
  if (typeof stored !== 'string' || typeof token !== 'string' || !token) {
    return false;
  }
  if (token.length > 256) return false;
  const hex = stored.startsWith('\\x') ? stored.slice(2) : stored;
  if (!/^[0-9a-f]{64}$/i.test(hex)) return false;
  const a = Buffer.from(hex, 'hex');
  const b = hashResumeToken(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

// ------------------------------------------------------------
// Leitura: disponibilidade, formulário e blocos
// ------------------------------------------------------------

async function checkAvailability(
  db: Db,
  slug: string,
  genericLink: boolean
): Promise<FormAvailability> {
  const { data, error } = await db.rpc('form_public_availability', {
    p_slug: slug,
    p_generic_link: genericLink,
  });
  if (error) {
    console.error(
      '[forms/public] availability failed:',
      (error as { code?: string }).code ?? 'unknown'
    );
    return parseAvailabilityRow(null);
  }
  return parseAvailabilityRow(Array.isArray(data) ? data[0] : data);
}

const TOKEN_MAX = 1024;

/**
 * Disponibilidade + token do link. A quota de CONTATOS só vale para o link
 * genérico (um contato que já existe segue respondendo, PRD D-10): com
 * token, consulta sem ela primeiro; se o token não for válido para ESTE
 * formulário, consulta de novo como link genérico.
 */
async function resolveAvailability(
  db: Db,
  slug: string,
  token: string | null | undefined
): Promise<{ availability: FormAvailability; claims: FormLinkClaims | null }> {
  const tokenGiven =
    typeof token === 'string' && token.length > 0 && token.length <= TOKEN_MAX;
  let availability = await checkAvailability(db, slug, !tokenGiven);
  let claims: FormLinkClaims | null = null;
  if (tokenGiven && availability.formId) {
    claims = verifyFormLink(token, availability.formId);
  }
  if (tokenGiven && !claims) {
    availability = await checkAvailability(db, slug, true);
  }
  return { availability, claims };
}

async function loadFormAndFields(
  db: Db,
  formId: string,
  accountId: string
): Promise<{ form: Form; fields: FormField[] } | null> {
  const { data: form, error } = await db
    .from('forms')
    .select('*')
    .eq('id', formId)
    .eq('account_id', accountId)
    .maybeSingle();
  if (error || !form) return null;
  const { data: fields, error: fieldsError } = await db
    .from('form_fields')
    .select('*')
    .eq('form_id', formId)
    .eq('account_id', accountId)
    .order('position', { ascending: true });
  if (fieldsError) return null;
  const typed = form as Form;
  if (typed.status !== 'published') return null;
  return { form: typed, fields: (fields ?? []) as FormField[] };
}

async function signPublicMedia(
  db: Db,
  paths: readonly string[]
): Promise<Record<string, string>> {
  if (paths.length === 0) return {};
  try {
    const { data, error } = await db.storage
      .from(FORM_MEDIA_BUCKET)
      .createSignedUrls([...paths], PUBLIC_MEDIA_TTL_SECONDS);
    if (error || !data) return {};
    const out: Record<string, string> = {};
    for (const item of data) {
      if (item.path && item.signedUrl) out[item.path] = item.signedUrl;
    }
    return out;
  } catch {
    return {};
  }
}

async function readUploadQuota(db: Db, accountId: string) {
  const { data, error } = await db.rpc('form_upload_quota_state', {
    p_account_id: accountId,
  });
  if (error) return null;
  return parseUploadQuotaRow(Array.isArray(data) ? data[0] : data);
}

// ------------------------------------------------------------
// Página
// ------------------------------------------------------------

export type PublicPageState =
  | { kind: 'unavailable' }
  | {
      kind: 'available';
      payload: PublicFormPayload;
      messages: Record<PublicFormMessageKey, string>;
      /** `settings.robots_noindex`, ou link com token (nunca indexar). */
      noindex: boolean;
    };

/**
 * O que `/f/[slug]` renderiza. Qualquer exceção é "indisponível" (fail-closed)
 * e a causa fica só no log do servidor.
 */
export async function loadPublicFormPage(
  slug: string,
  token?: string | null
): Promise<PublicPageState> {
  try {
    const db = supabaseAdmin();
    const { availability, claims } = await resolveAvailability(db, slug, token);
    if (!isFormAvailable(availability)) return { kind: 'unavailable' };

    const loaded = await loadFormAndFields(
      db,
      availability.formId,
      availability.accountId
    );
    if (!loaded) return { kind: 'unavailable' };
    const { form, fields } = loaded;

    // Token válido cujo contato sumiu volta a pedir o telefone (D-2).
    let mode: IdentityMode = 'phone';
    if (claims) {
      const { data: contact } = await db
        .from('contacts')
        .select('id')
        .eq('id', claims.contactId)
        .eq('account_id', availability.accountId)
        .maybeSingle();
      if (contact?.id) mode = 'token';
    }
    if (mode === 'phone' && form.settings?.accept_generic_link === false) {
      return { kind: 'unavailable' };
    }

    // O JSON de `theme`/`media` pode ter sido gravado direto pela RLS do
    // admin (PostgREST), sem passar pela validação das rotas: o service-role
    // só assina caminho da PRÓPRIA conta (F6, achado L-1).
    const signedMedia = await signPublicMedia(
      db,
      collectMediaPaths(form, fields).filter((p) =>
        isOwnedMediaPath(p, availability.accountId)
      )
    );
    let uploadsAvailable = true;
    if (fields.some((f) => f.type === 'file_upload')) {
      const state = await readUploadQuota(db, availability.accountId);
      // Sem leitura da quota, o upload fica desligado (fail-closed).
      uploadsAvailable = state
        ? state.limitBytes === null || state.usedBytes < state.limitBytes
        : false;
    }

    const payload = toPublicPayload(form, fields, {
      identity: mode,
      signedMedia,
      turnstileSiteKey: turnstileSiteKey(),
      uploadsAvailable,
    });
    return {
      kind: 'available',
      payload,
      messages: await loadPublicFormMessages(form.locale),
      noindex: form.settings?.robots_noindex === true || mode === 'token',
    };
  } catch (err) {
    console.error(
      '[forms/public] page load failed:',
      err instanceof Error ? err.name : typeof err
    );
    return { kind: 'unavailable' };
  }
}

// ------------------------------------------------------------
// Início da resposta
// ------------------------------------------------------------

export interface StartInput {
  slug: string;
  phone: string | null;
  linkToken: string | null;
  utm: unknown;
  /** `embed` só vale sem token (o token traz a origem dele). */
  embedded: boolean;
  userAgent: string | null;
  ipHash: string | null;
}

export type StartResult =
  | { alreadyAnswered: true }
  | {
      alreadyAnswered: false;
      responseId: string;
      resumeToken: string;
      identityMode: IdentityMode;
    };

export function sanitizeUtm(raw: unknown): Record<string, string> | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out: Record<string, string> = {};
  for (const key of UTM_KEYS) {
    const v = (raw as Record<string, unknown>)[key];
    if (typeof v === 'string' && v.trim()) out[key] = v.trim().slice(0, 200);
  }
  return Object.keys(out).length ? out : null;
}

export async function startResponse(input: StartInput): Promise<StartResult> {
  const db = supabaseAdmin();
  const { availability, claims } = await resolveAvailability(
    db,
    input.slug,
    input.linkToken
  );
  if (!isFormAvailable(availability)) throw unavailableError();

  const loaded = await loadFormAndFields(
    db,
    availability.formId,
    availability.accountId
  );
  if (!loaded) throw unavailableError();
  const { form } = loaded;
  const acceptGeneric = form.settings?.accept_generic_link !== false;
  if (!claims && !acceptGeneric) {
    throw new PublicApiError(
      403,
      'token_required',
      'This form only accepts personal links.'
    );
  }

  let auditUserId: string;
  try {
    auditUserId = await resolveAuditUserId(db, availability.accountId);
  } catch {
    throw new PublicApiError(
      500,
      'unexpected',
      'Something went wrong. Try again.'
    );
  }

  const identity = await resolveIdentity(db, {
    formId: form.id,
    accountId: availability.accountId,
    token: input.linkToken,
    phone: input.phone,
    auditUserId,
  });
  if (!identity.ok) {
    switch (identity.reason) {
      case 'invalid_phone':
        throw new PublicApiError(422, 'invalid_phone', 'Invalid phone number.');
      case 'missing_identity':
      case 'contact_not_found':
        throw new PublicApiError(
          400,
          'identity_required',
          'A phone number is required.'
        );
      case 'contacts_quota':
        throw unavailableError();
      default:
        throw new PublicApiError(
          500,
          'unexpected',
          'Something went wrong. Try again.'
        );
    }
  }
  // O token foi para o ralo (contato apagado) e o formulário só aceita link
  // pessoal: não cai para o telefone.
  if (identity.mode !== 'token' && !acceptGeneric) {
    throw new PublicApiError(
      403,
      'token_required',
      'This form only accepts personal links.'
    );
  }

  if (!identity.created && form.settings?.allow_multiple_responses !== true) {
    const { data: done } = await db
      .from('form_responses')
      .select('id')
      .eq('form_id', form.id)
      .eq('account_id', availability.accountId)
      .eq('contact_id', identity.contactId)
      .eq('status', 'completed')
      .limit(1);
    if (done && done.length > 0) return { alreadyAnswered: true };
  }

  const resumeToken = generateResumeToken();
  const source: ResponseSource =
    identity.mode === 'token'
      ? identity.source
      : input.embedded
        ? 'embed'
        : identity.source;
  const { data: row, error } = await db
    .from('form_responses')
    .insert({
      form_id: form.id,
      account_id: availability.accountId,
      contact_id: identity.contactId,
      status: 'partial',
      identity_mode: identity.mode,
      source,
      form_version: form.version,
      answers: {},
      resume_token_hash: toByteaLiteral(hashResumeToken(resumeToken)),
      utm: sanitizeUtm(input.utm),
      locale: form.locale,
      ip_hash: input.ipHash,
      user_agent: input.userAgent ? input.userAgent.slice(0, 256) : null,
    })
    .select('id')
    .single();
  if (error || !row?.id) {
    console.error(
      '[forms/public] response insert failed:',
      (error as { code?: string } | null)?.code ?? 'unknown'
    );
    throw new PublicApiError(
      500,
      'unexpected',
      'Something went wrong. Try again.'
    );
  }

  return {
    alreadyAnswered: false,
    responseId: row.id as string,
    resumeToken,
    identityMode: identity.mode,
  };
}

// ------------------------------------------------------------
// Resposta parcial já iniciada: autosave, upload, envio
// ------------------------------------------------------------

interface ResponseRow {
  id: string;
  form_id: string;
  account_id: string;
  contact_id: string;
  status: string;
  identity_mode: IdentityMode;
  started_at: string;
  answers: AnswersSnapshot | null;
}

interface Loaded {
  db: Db;
  form: Form;
  fields: FormField[];
  accountId: string;
  response: ResponseRow;
}

const notFound = () =>
  new PublicApiError(404, 'not_found', 'Response not found.');

/**
 * Disponibilidade + formulário + resposta `partial` do slug, com o
 * `resume_token` conferido. Qualquer falha é 404 (não distingue "id errado"
 * de "token errado" de "já concluída").
 */
async function loadPartial(
  slug: string,
  responseId: string,
  resumeToken: unknown
): Promise<Loaded> {
  const db = supabaseAdmin();
  const availability = await checkAvailability(db, slug, false);
  if (!isFormAvailable(availability)) throw unavailableError();
  const loaded = await loadFormAndFields(
    db,
    availability.formId,
    availability.accountId
  );
  if (!loaded) throw unavailableError();

  const { data, error } = await db
    .from('form_responses')
    .select(
      'id, form_id, account_id, contact_id, status, identity_mode, started_at, answers, resume_token_hash'
    )
    .eq('id', responseId)
    .eq('form_id', availability.formId)
    .eq('account_id', availability.accountId)
    .maybeSingle();
  if (error || !data) throw notFound();
  const row = data as ResponseRow & { resume_token_hash: unknown };
  if (row.status !== 'partial') throw notFound();
  if (!resumeTokenMatches(row.resume_token_hash, resumeToken)) throw notFound();

  return {
    db,
    form: loaded.form,
    fields: loaded.fields,
    accountId: availability.accountId,
    response: {
      id: row.id,
      form_id: row.form_id,
      account_id: row.account_id,
      contact_id: row.contact_id,
      status: row.status,
      identity_mode: row.identity_mode,
      started_at: row.started_at,
      answers: row.answers,
    },
  };
}

export interface AutosaveResult {
  saved: string[];
  rejected: { key: string; code: string }[];
}

function isEmptyValue(v: unknown): boolean {
  return (
    v === null ||
    v === undefined ||
    (typeof v === 'string' && v.trim() === '') ||
    (Array.isArray(v) && v.length === 0)
  );
}

/**
 * `PATCH …/responses/[id]`: só chaves de blocos existentes, cada valor
 * validado pela MESMA função do envio. Valor vazio/`null` apaga a chave.
 * Nada de pontos aqui: o instantâneo parcial leva `points: 0`; quem pontua
 * é o envio.
 */
export async function autosaveResponse(input: {
  slug: string;
  responseId: string;
  resumeToken: unknown;
  delta: unknown;
}): Promise<AutosaveResult> {
  if (
    !input.delta ||
    typeof input.delta !== 'object' ||
    Array.isArray(input.delta)
  ) {
    throw new PublicApiError(400, 'invalid_request', 'Invalid request body.');
  }
  const entries = Object.entries(input.delta as Record<string, unknown>);
  if (entries.length > DELTA_MAX_KEYS) {
    throw new PublicApiError(400, 'invalid_request', 'Invalid request body.');
  }

  const { db, fields, accountId, form, response } = await loadPartial(
    input.slug,
    input.responseId,
    input.resumeToken
  );
  const byKey = new Map(fields.map((f) => [f.key, f] as const));
  const scope = { accountId, formId: form.id, responseId: response.id };

  const saved: string[] = [];
  const rejected: AutosaveResult['rejected'] = [];
  const toSet: Answers = {};
  const toDelete: string[] = [];
  for (const [key, raw] of entries) {
    const field = byKey.get(key);
    if (!field || field.type === 'statement') {
      rejected.push({ key, code: 'unknown_field' });
      continue;
    }
    if (isEmptyValue(raw)) {
      toDelete.push(key);
      saved.push(key);
      continue;
    }
    const r = validateAnswer(field, raw as AnswerValue, {
      uploadScope: scope,
    });
    if (r === null) {
      toDelete.push(key);
      saved.push(key);
    } else if ('code' in r) {
      rejected.push({ key, code: r.code });
    } else {
      toSet[key] = r.value;
      saved.push(key);
    }
  }

  const next: AnswersSnapshot = { ...(response.answers ?? {}) };
  for (const key of toDelete) delete next[key];
  Object.assign(next, snapshotAnswers(fields, toSet, {}));

  const { error } = await db
    .from('form_responses')
    .update({ answers: next })
    .eq('id', response.id)
    .eq('account_id', accountId)
    .eq('status', 'partial');
  if (error) {
    console.error(
      '[forms/public] autosave failed:',
      (error as { code?: string }).code ?? 'unknown'
    );
    throw new PublicApiError(
      500,
      'unexpected',
      'Something went wrong. Try again.'
    );
  }
  return { saved, rejected };
}

export interface UploadUrlResult {
  path: string;
  signedUrl: string;
  token: string;
  mime: string;
}

const UPLOAD_REJECT: Record<
  string,
  { status: number; code: string; message: string }
> = {
  invalid_name: {
    status: 400,
    code: 'invalid_file',
    message: 'Invalid file name.',
  },
  file_type_not_allowed: {
    status: 400,
    code: 'file_type_not_allowed',
    message: 'File type not allowed.',
  },
  extension_mismatch: {
    status: 400,
    code: 'file_type_not_allowed',
    message: 'File type not allowed.',
  },
  accept_not_allowed: {
    status: 400,
    code: 'file_type_not_allowed',
    message: 'File type not allowed.',
  },
  file_too_large: {
    status: 413,
    code: 'file_too_large',
    message: 'File too large.',
  },
};

export async function createUploadUrl(input: {
  slug: string;
  responseId: string;
  resumeToken: unknown;
  fieldKey: unknown;
  name: unknown;
  mime: unknown;
  size: unknown;
}): Promise<UploadUrlResult> {
  const { db, fields, accountId, form, response } = await loadPartial(
    input.slug,
    input.responseId,
    input.resumeToken
  );
  const field = fields.find(
    (f) => f.key === input.fieldKey && f.type === 'file_upload'
  );
  if (!field) {
    throw new PublicApiError(400, 'invalid_field', 'Invalid upload field.');
  }

  const check = validateUploadRequest(
    {
      name: typeof input.name === 'string' ? input.name : '',
      mime: typeof input.mime === 'string' ? input.mime : '',
      size: Number(input.size),
    },
    field.validation
  );
  if (!check.ok) {
    const rule = UPLOAD_REJECT[check.reason] ?? UPLOAD_REJECT.invalid_name;
    throw new PublicApiError(
      rule.status,
      rule.code,
      rule.message,
      check.maxBytes ? { max_bytes: check.maxBytes } : {}
    );
  }

  const quota = await readUploadQuota(db, accountId);
  if (!quota || !uploadQuotaHasRoom(quota, check.size)) {
    throw new PublicApiError(
      409,
      'upload_quota',
      'Uploads are not available right now.'
    );
  }

  // Teto por RESPOSTA: o que já foi enviado e ainda não concluído também
  // conta (a quota de bytes só soma no envio). Sem isto, uma resposta
  // parcial e 20 pedidos/min gravariam centenas de MB sem tocar na quota.
  const prefix = `account-${accountId}/${form.id}/${response.id}`;
  const { data: sent, error: listError } = await db.storage
    .from(FORM_UPLOADS_BUCKET)
    .list(prefix, { limit: 100 });
  if (listError) {
    throw new PublicApiError(
      500,
      'unexpected',
      'Something went wrong. Try again.'
    );
  }
  const objects = sent ?? [];
  const slots = fields
    .filter((f) => f.type === 'file_upload')
    .reduce((n, f) => n + (f.validation?.max_files ?? 1), 0);
  const pendingBytes = objects.reduce(
    (n, o) => n + (Number(o.metadata?.size) || 0),
    0
  );
  if (
    objects.length >= Math.max(3, slots * 2) ||
    !uploadQuotaHasRoom(quota, pendingBytes + check.size)
  ) {
    throw new PublicApiError(
      409,
      'upload_quota',
      'Uploads are not available right now.'
    );
  }

  // Teto por CONTA e por hora (F6, M-1): vale para todos os IPs juntos. Por
  // último, logo antes de assinar: pedido recusado por validação, quota ou
  // teto por resposta não gasta o orçamento da conta. Trade-off aceito: quem
  // esgota o orçamento deixa o bloco de arquivo da conta indisponível até a
  // janela virar (melhor que encher o disco que todas as contas dividem).
  const accountBudget = checkRateLimit(
    `formUploadAccount:${accountId}`,
    RATE_LIMITS.formUploadAccount
  );
  if (!accountBudget.success) {
    throw new PublicApiError(
      429,
      'rate_limited',
      'Too many uploads. Try again later.',
      {
        retry_after_seconds: Math.max(
          1,
          Math.ceil((accountBudget.reset - Date.now()) / 1000)
        ),
      }
    );
  }

  const path = buildUploadPath({
    accountId,
    formId: form.id,
    responseId: response.id,
    ext: check.ext,
  });
  // `upsert: false` explícito: o objeto verificado no envio não pode ser
  // trocado depois por um segundo PUT na mesma URL assinada.
  const { data, error } = await db.storage
    .from(FORM_UPLOADS_BUCKET)
    .createSignedUploadUrl(path, { upsert: false });
  if (error || !data?.signedUrl) {
    console.error('[forms/public] signed upload url failed');
    throw new PublicApiError(
      500,
      'unexpected',
      'Something went wrong. Try again.'
    );
  }
  return {
    path,
    signedUrl: data.signedUrl,
    token: data.token,
    mime: check.mime,
  };
}

// ------------------------------------------------------------
// Envio
// ------------------------------------------------------------

export interface ThankYou {
  /** `wa.me/<canal padrão>` só quando o formulário liga o botão. */
  whatsapp_url: string | null;
  redirect_url: string | null;
}

async function buildThankYou(db: Db, form: Form): Promise<ThankYou> {
  const cfg = form.theme?.thank_you ?? {};
  const redirect =
    cfg.redirect_url && /^https:\/\//.test(cfg.redirect_url)
      ? cfg.redirect_url
      : null;
  let whatsapp: string | null = null;
  if (cfg.whatsapp_cta === true) {
    try {
      const channelId = await resolveDefaultChannelId(db, form.account_id);
      const { data } = await db
        .from('channels')
        .select('identifier')
        .eq('id', channelId)
        .eq('account_id', form.account_id)
        .maybeSingle();
      const digits = String(data?.identifier ?? '').replace(/\D/g, '');
      if (digits.length >= 8 && digits.length <= 15) {
        const text = cfg.whatsapp_text?.trim();
        whatsapp = `https://wa.me/${digits}${
          text ? `?text=${encodeURIComponent(text.slice(0, 500))}` : ''
        }`;
      }
    } catch {
      whatsapp = null;
    }
  }
  return { whatsapp_url: whatsapp, redirect_url: redirect };
}

async function notificationText(
  locale: string,
  vars: { contact: string; form: string; band: string | null }
): Promise<{ title: string; body: string }> {
  const resolved = resolveFormLocale(locale);
  const messages = (await import(`../../../messages/${resolved}.json`)).default;
  const t = createTranslator({
    locale: resolved,
    messages,
    namespace: 'Notifications.formResponseReceived',
  }) as unknown as (key: string, values?: Record<string, string>) => string;
  return {
    title: t('title', { form: vars.form }),
    body: vars.band
      ? t('bodyWithBand', {
          contact: vars.contact,
          form: vars.form,
          band: vars.band,
        })
      : t('body', { contact: vars.contact, form: vars.form }),
  };
}

export interface SubmitInput {
  slug: string;
  responseId: string;
  resumeToken: unknown;
  /** Só `answers` é lido do corpo do cliente: qualquer outro campo é ignorado. */
  answers: unknown;
  turnstile: unknown;
  ip: string | null;
  now?: number;
}

export async function submitResponse(
  input: SubmitInput
): Promise<{ thankYou: ThankYou }> {
  if (
    !input.answers ||
    typeof input.answers !== 'object' ||
    Array.isArray(input.answers)
  ) {
    throw new PublicApiError(400, 'invalid_request', 'Invalid request body.');
  }
  const { db, form, fields, accountId, response } = await loadPartial(
    input.slug,
    input.responseId,
    input.resumeToken
  );

  const now = input.now ?? Date.now();
  const startedAt = new Date(response.started_at).getTime();
  if (Number.isFinite(startedAt) && now - startedAt < MIN_FILL_MS) {
    throw new PublicApiError(
      400,
      'too_fast',
      'Submitted too quickly. Try again in a moment.'
    );
  }

  if (form.settings?.allow_multiple_responses !== true) {
    const { data: done } = await db
      .from('form_responses')
      .select('id')
      .eq('form_id', form.id)
      .eq('account_id', accountId)
      .eq('contact_id', response.contact_id)
      .eq('status', 'completed')
      .neq('id', response.id)
      .limit(1);
    if (done && done.length > 0) {
      throw new PublicApiError(
        409,
        'already_answered',
        'This form was already answered.'
      );
    }
  }

  // Contato da resposta (fixado no `start`).
  const { data: contactRow } = await db
    .from('contacts')
    .select('name, phone_normalized')
    .eq('id', response.contact_id)
    .eq('account_id', accountId)
    .maybeSingle();

  const raw = { ...(input.answers as Record<string, unknown>) } as Answers;
  // Em `phone`, o telefone do bloco de identidade é o do `start`: trocar
  // o número entre o início e o envio não troca o contato.
  const identityField = fields.find((f) => f.is_identity);
  if (
    identityField &&
    response.identity_mode === 'phone' &&
    contactRow?.phone_normalized
  ) {
    raw[identityField.key] = contactRow.phone_normalized as string;
  }

  let uploadsAvailable = true;
  if (fields.some((f) => f.type === 'file_upload')) {
    const state = await readUploadQuota(db, accountId);
    uploadsAvailable = state
      ? state.limitBytes === null || state.usedBytes < state.limitBytes
      : false;
  }
  // Quota de upload cheia: o bloco de arquivo vira opcional (PRD D-10).
  const toValidate = uploadsAvailable
    ? fields
    : fields.map((f) =>
        f.type === 'file_upload' ? { ...f, required: false } : f
      );

  const validated = validateAnswers(toValidate, raw, {
    identityMode: response.identity_mode,
    confirmPhoneWithToken: form.settings?.confirm_phone_with_token === true,
    uploadScope: { accountId, formId: form.id, responseId: response.id },
  });
  if (!validated.ok) {
    throw new PublicApiError(
      422,
      'validation_failed',
      'Some answers are invalid.',
      { errors: validated.errors }
    );
  }
  const clean = validated.answers;

  // Turnstile: só com o formulário pedindo E as duas chaves no deploy
  // (sem chave o widget nem aparece). Falha de qualquer tipo recusa. Roda
  // DEPOIS de validar as respostas: o token do Cloudflare é de uso único, e
  // um 422 (e-mail errado) não pode gastá-lo — senão o reenvio corrigido
  // falharia no desafio.
  if (form.settings?.turnstile === true && turnstileSiteKey()) {
    const ok = await verifyTurnstile(input.turnstile, input.ip);
    if (!ok) {
      throw new PublicApiError(
        400,
        'turnstile_failed',
        'Human verification failed.'
      );
    }
  }

  // Arquivos: o objeto existe e tem o tamanho que o visitante declarou.
  let uploadBytes = 0;
  const seen = new Set<string>();
  for (const field of fields) {
    if (field.type !== 'file_upload') continue;
    const refs = clean[field.key];
    if (!Array.isArray(refs)) continue;
    for (const ref of refs as FileRef[]) {
      const ext = parseUploadPath(ref.path)?.ext;
      const sane =
        !seen.has(ref.path) &&
        ext !== undefined &&
        ext === fileExtension(ref.name) &&
        validateUploadRequest(ref, field.validation).ok;
      seen.add(ref.path);
      const verified = sane
        ? await verifyUploadedObject(db.storage, ref.path, ref.size)
        : { ok: false as const };
      if (!verified.ok) {
        throw new PublicApiError(
          422,
          'validation_failed',
          'Some answers are invalid.',
          { errors: [{ key: field.key, code: 'invalidFile' }] }
        );
      }
      uploadBytes += verified.size;
    }
  }
  if (uploadBytes > 0) {
    const state = await readUploadQuota(db, accountId);
    if (!state || !uploadQuotaHasRoom(state, uploadBytes)) {
      throw new PublicApiError(
        409,
        'upload_quota',
        'Uploads are not available right now.'
      );
    }
  }

  // Pontuação e faixa: SÓ aqui, a partir do que foi validado (E-5).
  const { score, breakdown } = computeScore(fields, clean);
  const band = resolveBand(form.scoring?.bands, score);
  const snapshot = snapshotAnswers(fields, clean, breakdown);

  // Fecha a resposta ANTES dos efeitos: `.eq('status','partial')` faz de um
  // envio duplo (clique repetido, reenvio) um 409 em vez de dois contatos
  // mapeados e dois negócios.
  const completedAt = new Date(now).toISOString();
  const { data: done, error } = await db
    .from('form_responses')
    .update({
      status: 'completed',
      answers: snapshot,
      score,
      band_key: band?.key ?? null,
      upload_bytes: uploadBytes,
      form_version: form.version,
      completed_at: completedAt,
      resume_token_hash: null,
    })
    .eq('id', response.id)
    .eq('account_id', accountId)
    .eq('status', 'partial')
    .select('id');
  if (error) {
    console.error(
      '[forms/public] complete failed:',
      (error as { code?: string }).code ?? 'unknown'
    );
    throw new PublicApiError(
      500,
      'unexpected',
      'Something went wrong. Try again.'
    );
  }
  if (!done || done.length === 0) {
    throw new PublicApiError(
      409,
      'already_submitted',
      'This response was already submitted.'
    );
  }

  // A partir daqui a resposta já está gravada: nada lança para o visitante.
  const safely = async (label: string, fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (err) {
      console.error(
        `[forms/public] ${label} failed:`,
        err instanceof Error ? err.name : typeof err
      );
    }
  };

  if (uploadBytes > 0) {
    await safely('upload bytes', async () => {
      await db.rpc('form_upload_bytes_add', {
        p_account_id: accountId,
        p_delta: uploadBytes,
      });
    });
  }

  await safely('mappings', () =>
    applyMappings(db, {
      accountId,
      contactId: response.contact_id,
      fields,
      answers: clean,
    })
  );

  // Releitura: o mapeamento pode ter preenchido o nome.
  const { data: contactNow } = await db
    .from('contacts')
    .select('name, phone_normalized')
    .eq('id', response.contact_id)
    .eq('account_id', accountId)
    .maybeSingle();
  const contactName = (contactNow?.name as string | null) ?? null;
  const contactPhone = (contactNow?.phone_normalized as string | null) ?? null;

  if (band) {
    await safely('band actions', async () => {
      const auditUserId = await resolveAuditUserId(db, accountId);
      const text = await notificationText(form.locale, {
        contact: contactName || contactPhone || '—',
        form: form.name,
        band: band.label,
      });
      const applied = await applyBandActions(db, {
        band,
        accountId,
        contactId: response.contact_id,
        formId: form.id,
        formName: form.name,
        responseId: response.id,
        contactName,
        contactPhone,
        auditUserId,
        notification: text,
      });
      // O painel de respostas mostra o negócio criado (F4).
      if (applied.dealId) {
        await db
          .from('form_responses')
          .update({ deal_id: applied.dealId })
          .eq('id', response.id)
          .eq('account_id', accountId);
      }
    });
  }

  await safely('activity', () =>
    recordFormSubmitted(db, {
      accountId,
      contactId: response.contact_id,
      contactPhone,
      contactName,
      formId: form.id,
      formName: form.name,
      responseId: response.id,
      score,
      bandKey: band?.key ?? null,
    })
  );

  return { thankYou: await buildThankYou(db, form) };
}
