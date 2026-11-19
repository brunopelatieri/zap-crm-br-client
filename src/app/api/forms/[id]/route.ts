// ============================================================
// GET/PUT/DELETE /api/forms/[id] — SPEC 085 §7.1 (admin+)
//
//   GET     formulário + blocos + URLs assinadas da mídia (prévia).
//   PUT     salva o RASCUNHO (nome, slug, tema, configurações, faixas…) sem
//           validar publicação — exceto num formulário JÁ PUBLICADO, onde
//           salvar algo que `validateFormForPublish` recusa derrubaria a
//           página ao vivo: aí a mesma validação do publish vale (422).
//   DELETE  só sem respostas e fora do ar (`FORM_HAS_RESPONSES` / `INVALID_STATE`):
//           a FK `form_responses.form_id` é CASCADE, então apagar com uma
//           resposta chegando no meio apagaria o lead junto.
// ============================================================

import { NextResponse } from 'next/server';

import { toErrorResponse } from '@/lib/auth/account';
import { recordFormActivity } from '@/lib/forms/activity';
import {
  collectMediaPaths,
  dbErrorResponse,
  isTurnstileConfigured,
  isUuidParam,
  jsonError,
  loadFields,
  loadForm,
  requireFormsRole,
  signMediaPaths,
} from '@/lib/forms/account-api';
import { parseFormPatch } from '@/lib/forms/account-input';
import { isFormLinkConfigured } from '@/lib/forms/link-token';
import { isValidSlug, isReservedSlug, SLUG_PATTERN } from '@/lib/forms/slug';
import { validateFormForPublish } from '@/lib/forms/validate';
import type { Form } from '@/lib/forms/types';

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: Ctx) {
  try {
    const ctx = await requireFormsRole('admin');
    const { id } = await params;
    if (!isUuidParam(id)) return jsonError('Not found', 404);

    const form = await loadForm(ctx.supabase, ctx.accountId, id);
    if (!form) return jsonError('Not found', 404);
    const fields = await loadFields(ctx.supabase, form.id);
    const mediaUrls = await signMediaPaths(
      ctx.supabase,
      collectMediaPaths(form, fields)
    );

    return NextResponse.json({
      form,
      fields,
      media_urls: mediaUrls,
      capabilities: {
        link_token: isFormLinkConfigured(),
        turnstile: isTurnstileConfigured(),
      },
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function PUT(request: Request, { params }: Ctx) {
  try {
    const ctx = await requireFormsRole('admin');
    const { id } = await params;
    if (!isUuidParam(id)) return jsonError('Not found', 404);

    const parsed = parseFormPatch(await request.json().catch(() => null), {
      accountId: ctx.accountId,
    });
    if (!parsed.ok) return jsonError(parsed.error, 400);
    const patch = parsed.value;
    if (Object.keys(patch).length === 0) {
      return jsonError('Nothing to update', 400);
    }

    const form = await loadForm(ctx.supabase, ctx.accountId, id);
    if (!form) return jsonError('Not found', 404);
    if (form.status === 'archived') return jsonError('INVALID_STATE', 409);

    if (
      patch.slug !== undefined &&
      patch.slug !== form.slug &&
      !isValidSlug(patch.slug)
    ) {
      const code =
        SLUG_PATTERN.test(patch.slug) && isReservedSlug(patch.slug)
          ? 'slug_reserved'
          : 'slug_invalid';
      return jsonError('INVALID_FORM', 422, { issues: [{ code }] });
    }

    if (form.status === 'published') {
      const merged = { ...form, ...patch } as Form;
      const fields = await loadFields(ctx.supabase, form.id);
      const issues = validateFormForPublish(merged, fields);
      if (issues.length > 0) return jsonError('INVALID_FORM', 422, { issues });
    }

    const { data, error } = await ctx.supabase
      .from('forms')
      .update(patch)
      .eq('id', id)
      .eq('account_id', ctx.accountId)
      .select('*')
      .maybeSingle();
    if (error) return dbErrorResponse(error, 'update');
    if (!data) return jsonError('Not found', 404);

    return NextResponse.json({ form: data });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function DELETE(_request: Request, { params }: Ctx) {
  try {
    const ctx = await requireFormsRole('admin');
    const { id } = await params;
    if (!isUuidParam(id)) return jsonError('Not found', 404);

    const form = await loadForm(ctx.supabase, ctx.accountId, id);
    if (!form) return jsonError('Not found', 404);
    if (form.status === 'published') return jsonError('INVALID_STATE', 409);

    const { count, error: countErr } = await ctx.supabase
      .from('form_responses')
      .select('id', { count: 'exact', head: true })
      .eq('form_id', id);
    if (countErr) return dbErrorResponse(countErr, 'count responses');
    if ((count ?? 0) > 0) {
      return jsonError('FORM_HAS_RESPONSES', 409, { count });
    }

    const { error } = await ctx.supabase
      .from('forms')
      .delete()
      .eq('id', id)
      .eq('account_id', ctx.accountId);
    if (error) return dbErrorResponse(error, 'delete');

    void recordFormActivity(ctx.supabase, {
      accountId: ctx.accountId,
      action: 'form.deleted',
      form: { id: form.id, name: form.name },
      actor: { kind: 'user', userId: ctx.userId, role: ctx.role },
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
