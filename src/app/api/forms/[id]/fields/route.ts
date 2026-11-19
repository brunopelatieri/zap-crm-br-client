// ============================================================
// PUT /api/forms/[id]/fields — SPEC 085 §7.1 (admin+)
//
// Substitui a lista de blocos numa transação (RPC `form_fields_replace`,
// 097 §9b), mantendo os ids que vierem. Rascunho aceita bloco incompleto;
// formulário PUBLICADO não: a lista nova passa por `validateFormForPublish`
// (422 `INVALID_FORM`) para o link ao vivo nunca ficar quebrado.
// ============================================================

import { NextResponse } from 'next/server';

import { toErrorResponse } from '@/lib/auth/account';
import {
  dbErrorResponse,
  isUuidParam,
  jsonError,
  loadForm,
  replaceFields,
  requireFormsRole,
} from '@/lib/forms/account-api';
import { parseFieldsBody } from '@/lib/forms/account-input';
import { validateFormForPublish } from '@/lib/forms/validate';

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await requireFormsRole('admin');
    const { id } = await params;
    if (!isUuidParam(id)) return jsonError('Not found', 404);

    const parsed = parseFieldsBody(await request.json().catch(() => null), {
      accountId: ctx.accountId,
    });
    if (!parsed.ok) return jsonError(parsed.error, 400);

    const form = await loadForm(ctx.supabase, ctx.accountId, id);
    if (!form) return jsonError('Not found', 404);
    if (form.status === 'archived') return jsonError('INVALID_STATE', 409);

    if (form.status === 'published') {
      const issues = validateFormForPublish(form, parsed.value);
      if (issues.length > 0) return jsonError('INVALID_FORM', 422, { issues });
    }

    let fields;
    try {
      fields = await replaceFields(ctx.supabase, id, parsed.value);
    } catch (err) {
      return dbErrorResponse(err, 'replace fields');
    }
    const fresh = await loadForm(ctx.supabase, ctx.accountId, id);
    return NextResponse.json({ fields, version: fresh?.version ?? null });
  } catch (err) {
    return toErrorResponse(err);
  }
}
