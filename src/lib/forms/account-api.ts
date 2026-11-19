// ============================================================
// Cola das rotas da conta `/api/forms/**` (SPEC 085 §7.1, F2).
//
// Tudo aqui roda com o client de SESSÃO (`ctx.supabase`, RLS): quem decide
// quem pode escrever é a policy (`admin` da conta) e a RPC
// `form_fields_replace` (INVOKER). `supabaseAdmin()` só entra na guarda de
// plano (`plan_feature_strict` é `service_role`).
//
// Código de erro estável + mensagem em inglês (padrão de `/api/**`); a UI
// traduz `FEATURE_NOT_IN_PLAN`, `QUOTA_EXCEEDED`, `FORM_LINK_SECRET_MISSING`,
// `FORM_HAS_RESPONSES`, `INVALID_FORM`, `SLUG_TAKEN`, `INVALID_STATE`.
// ============================================================

import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';

import { isUuid } from '@/lib/api/uuid';
import { requireRole, type AccountContext } from '@/lib/auth/account';
import type { AccountRole } from '@/lib/auth/roles';

import { recordFormActivity, type FormActivityAction } from './activity';
import { requireFormsFeature } from './plan-gate';
import { parseFormsQuotaError } from './quota';
import { suggestSlug } from './slug';
import { FORM_MEDIA_BUCKET } from './uploads';
import { validateFormForPublish } from './validate';
import type { Form, FormField, FormFieldInput, FormStatus } from './types';

type Db = SupabaseClient;

/** `requireRole(min)` e DEPOIS `requireFormsFeature` (SPEC §5.3). */
export async function requireFormsRole(
  min: AccountRole
): Promise<AccountContext> {
  const ctx = await requireRole(min);
  await requireFormsFeature(ctx.accountId);
  return ctx;
}

/** Turnstile só liga com as duas chaves no deploy (SPEC 085 §7.2). */
export function isTurnstileConfigured(): boolean {
  return !!(process.env.TURNSTILE_SITE_KEY && process.env.TURNSTILE_SECRET_KEY);
}

export const jsonError = (
  error: string,
  status: number,
  extra: Record<string, unknown> = {}
) => NextResponse.json({ error, ...extra }, { status });

interface PgLikeError {
  code?: string;
  message?: string;
  details?: string;
}

/**
 * Erro do Postgres/PostgREST → resposta com código estável; `null` quando
 * não é um erro conhecido (o chamador responde 500 sem vazar a mensagem).
 */
export function mapFormsDbError(err: unknown): NextResponse | null {
  if (!err || typeof err !== 'object') return null;
  const e = err as PgLikeError;
  const message = e.message ?? '';

  const quota = parseFormsQuotaError(err);
  if (quota) {
    return jsonError('QUOTA_EXCEEDED', 409, {
      metric: quota.metric,
      used: quota.used,
      limit: quota.limit,
    });
  }
  if (e.code === '23505') {
    if (message.includes('forms_slug_key')) {
      return jsonError('SLUG_TAKEN', 409);
    }
    if (
      message.includes('form_fields_form_key_unique') ||
      message.includes('idx_form_fields_one_identity')
    ) {
      return jsonError('INVALID_FORM', 400, {
        issues: [{ code: 'key_duplicate' }],
      });
    }
  }
  // CHECK (slug, nome, tipo, chave) ou parâmetro inválido da RPC.
  if (e.code === '23514' || e.code === '22023' || e.code === '22P02') {
    return jsonError('INVALID_FORM', 400);
  }
  // `42501`: a RPC/RLS não distingue "não existe" de "não é seu".
  if (e.code === '42501') return jsonError('Not found', 404);
  return null;
}

/** Erro conhecido → resposta; desconhecido → 500 genérico, com log. */
export function dbErrorResponse(err: unknown, where: string): NextResponse {
  const mapped = mapFormsDbError(err);
  if (mapped) return mapped;
  console.error(`[forms] ${where}:`, err);
  return jsonError('Internal server error', 500);
}

// ------------------------------------------------------------
// Leitura
// ------------------------------------------------------------

export async function loadForm(
  db: Db,
  accountId: string,
  id: string
): Promise<Form | null> {
  const { data, error } = await db
    .from('forms')
    .select('*')
    .eq('id', id)
    .eq('account_id', accountId)
    .maybeSingle();
  if (error) throw error;
  return (data as Form | null) ?? null;
}

export async function loadFields(db: Db, formId: string): Promise<FormField[]> {
  const { data, error } = await db
    .from('form_fields')
    .select('*')
    .eq('form_id', formId)
    .order('position', { ascending: true });
  if (error) throw error;
  return (data ?? []) as FormField[];
}

export const isUuidParam = isUuid;

// ------------------------------------------------------------
// Escrita
// ------------------------------------------------------------

/** Substitui os blocos (RPC transacional); mantém os ids que vierem. */
export async function replaceFields(
  db: Db,
  formId: string,
  fields: readonly FormFieldInput[]
): Promise<FormField[]> {
  const { data, error } = await db.rpc('form_fields_replace', {
    p_form_id: formId,
    p_fields: fields,
  });
  if (error) throw error;
  return (data ?? []) as FormField[];
}

/**
 * O que o INSERT leva do formulário (o resto — conta, dono, slug, status,
 * versão, datas — é preenchido por `insertFormWithSlug` ou pelo banco).
 * `Omit` e não `Pick`: o teste de isolamento da área do contato proíbe a
 * palavra entre aspas `portal_…` fora de `lib/contact-portal/`.
 */
export type NewFormRow = Omit<
  Form,
  | 'id'
  | 'account_id'
  | 'user_id'
  | 'slug'
  | 'status'
  | 'version'
  | 'published_at'
  | 'archived_at'
  | 'created_at'
  | 'updated_at'
>;

const SLUG_ATTEMPTS = 6;

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 6);
}

/**
 * Insere o formulário com o slug sugerido do nome. O slug é único no
 * DEPLOYMENT (`UNIQUE` em `forms.slug`) e a sessão só enxerga os da
 * própria conta — então a colisão com OUTRA conta só aparece como `23505`
 * no INSERT. Tenta de novo com sufixo aleatório (e só então desiste).
 */
export async function insertFormWithSlug(
  db: Db,
  ctx: { accountId: string; userId: string },
  row: NewFormRow,
  ownSlugs: Iterable<string> = []
): Promise<Form> {
  const base = suggestSlug(row.name, ownSlugs);
  let lastError: unknown = null;
  for (let attempt = 0; attempt < SLUG_ATTEMPTS; attempt++) {
    const slug =
      attempt === 0
        ? base
        : `${base.slice(0, 55).replace(/-+$/g, '')}-${randomSuffix()}`;
    const { data, error } = await db
      .from('forms')
      .insert({
        ...row,
        slug,
        account_id: ctx.accountId,
        user_id: ctx.userId,
        status: 'draft',
      })
      .select('*')
      .single();
    if (!error && data) return data as Form;
    lastError = error;
    const e = error as PgLikeError | null;
    const slugCollision =
      e?.code === '23505' && (e.message ?? '').includes('forms_slug_key');
    if (!slugCollision) throw error;
  }
  throw lastError;
}

// ------------------------------------------------------------
// Transições de estado (SPEC 085 §4.5)
// ------------------------------------------------------------

export interface TransitionSpec {
  from: readonly FormStatus[];
  patch: Record<string, unknown>;
  action: FormActivityAction;
  /** Roda `validateFormForPublish` no servidor (só o publish). */
  validate?: boolean;
}

/**
 * `draft → published`, `published → draft`, `* → archived`,
 * `archived → draft` (SPEC §4.5). O UPDATE leva `status IN (from)` na
 * própria instrução: duas transições concorrentes não passam as duas.
 * Restaurar passa pela trigger de quota (`QUOTA_EXCEEDED:forms` → 409).
 */
export async function runTransition(
  ctx: AccountContext,
  id: string,
  spec: TransitionSpec
): Promise<NextResponse> {
  if (!isUuidParam(id)) return jsonError('Not found', 404);

  const form = await loadForm(ctx.supabase, ctx.accountId, id);
  if (!form) return jsonError('Not found', 404);
  if (!spec.from.includes(form.status)) return jsonError('INVALID_STATE', 409);

  if (spec.validate) {
    const fields = await loadFields(ctx.supabase, form.id);
    const issues = validateFormForPublish(form, fields);
    if (issues.length > 0) return jsonError('INVALID_FORM', 422, { issues });
  }

  const { data, error } = await ctx.supabase
    .from('forms')
    .update(spec.patch)
    .eq('id', id)
    .eq('account_id', ctx.accountId)
    .in('status', [...spec.from])
    .select('*')
    .maybeSingle();
  if (error) return dbErrorResponse(error, spec.action);
  if (!data) return jsonError('INVALID_STATE', 409);

  void recordFormActivity(ctx.supabase, {
    accountId: ctx.accountId,
    action: spec.action,
    form: { id: form.id, name: form.name },
    actor: { kind: 'user', userId: ctx.userId, role: ctx.role },
  });
  return NextResponse.json({ form: data });
}

// ------------------------------------------------------------
// Mídia assinada (para a prévia do construtor)
// ------------------------------------------------------------

export function collectMediaPaths(
  form: Pick<Form, 'theme'>,
  fields: readonly Pick<FormField, 'media'>[]
): string[] {
  const out = new Set<string>();
  const theme = form.theme ?? {};
  if (theme.logo_path) out.add(theme.logo_path);
  if (theme.welcome?.media?.kind === 'image') out.add(theme.welcome.media.path);
  for (const f of fields) {
    if (f.media?.kind === 'image') out.add(f.media.path);
  }
  return [...out];
}

export const MEDIA_SIGNED_URL_TTL_SECONDS = 60 * 60;

/** `path` → URL assinada de leitura (1 h); falha vira mapa vazio (a prévia só perde a imagem). */
export async function signMediaPaths(
  db: Db,
  paths: readonly string[]
): Promise<Record<string, string>> {
  if (paths.length === 0) return {};
  try {
    const { data, error } = await db.storage
      .from(FORM_MEDIA_BUCKET)
      .createSignedUrls([...paths], MEDIA_SIGNED_URL_TTL_SECONDS);
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
