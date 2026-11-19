// ============================================================
// POST /api/forms/[id]/duplicate — SPEC 085 §4.3 / §7.1 (admin+)
//
// Copia tema, configurações, faixas e blocos para um formulário NOVO em
// rascunho (slug novo, sem respostas, versão 1). Conta na quota `forms`
// como qualquer criação (`QUOTA_EXCEEDED` → 409). Corpo opcional
// `{ name }`; sem ele, `"<nome> (copy)"` — a UI manda o nome já traduzido.
// ============================================================

import { NextResponse } from 'next/server';

import { toErrorResponse } from '@/lib/auth/account';
import { recordFormActivity } from '@/lib/forms/activity';
import {
  dbErrorResponse,
  insertFormWithSlug,
  isUuidParam,
  jsonError,
  loadFields,
  loadForm,
  replaceFields,
  requireFormsRole,
} from '@/lib/forms/account-api';
import { FORM_NAME_MAX, parseDuplicateBody } from '@/lib/forms/account-input';
import type { FormFieldInput } from '@/lib/forms/types';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await requireFormsRole('admin');
    const { id } = await params;
    if (!isUuidParam(id)) return jsonError('Not found', 404);

    const parsed = parseDuplicateBody(await request.json().catch(() => null));
    if (!parsed.ok) return jsonError(parsed.error, 400);

    const source = await loadForm(ctx.supabase, ctx.accountId, id);
    if (!source) return jsonError('Not found', 404);
    const sourceFields = await loadFields(ctx.supabase, source.id);

    const { data: own } = await ctx.supabase
      .from('forms')
      .select('slug')
      .eq('account_id', ctx.accountId);
    const ownSlugs = (own ?? []).map((r) => r.slug as string);

    const name = (parsed.value.name ?? `${source.name} (copy)`).slice(
      0,
      FORM_NAME_MAX
    );

    let copy;
    try {
      copy = await insertFormWithSlug(
        ctx.supabase,
        { accountId: ctx.accountId, userId: ctx.userId },
        {
          name,
          locale: source.locale,
          description: source.description,
          theme: source.theme,
          settings: source.settings,
          scoring: source.scoring,
          portal_visibility: source.portal_visibility,
          ai_offerable: source.ai_offerable,
          ai_offer_hint: source.ai_offer_hint,
        },
        ownSlugs
      );
    } catch (err) {
      return dbErrorResponse(err, 'duplicate');
    }

    // Sem `id`: a RPC cria linhas novas (o id antigo pertence ao original).
    const copies: FormFieldInput[] = sourceFields.map((f) => ({
      key: f.key,
      position: f.position,
      type: f.type,
      label: f.label,
      description: f.description,
      required: f.required,
      is_identity: f.is_identity,
      options: f.options,
      validation: f.validation,
      media: f.media,
      mapping: f.mapping,
      show_if: f.show_if,
    }));

    let fields;
    try {
      fields = await replaceFields(ctx.supabase, copy.id, copies);
    } catch (err) {
      await ctx.supabase.from('forms').delete().eq('id', copy.id);
      return dbErrorResponse(err, 'duplicate fields');
    }

    void recordFormActivity(ctx.supabase, {
      accountId: ctx.accountId,
      action: 'form.created',
      form: { id: copy.id, name: copy.name },
      actor: { kind: 'user', userId: ctx.userId, role: ctx.role },
      metadata: { duplicated_from: source.id },
    });

    return NextResponse.json({ form: copy, fields }, { status: 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}
