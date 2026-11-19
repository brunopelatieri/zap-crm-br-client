// ============================================================
// GET/POST /api/forms/[id]/link — SPEC 085 §7.1 (agent+)
//
//   GET   link genérico (`/f/<slug>`), snippet de embed e `tokenAvailable`
//         (há `FORM_LINK_SECRET` utilizável no deploy?). O QR code é gerado
//         no NAVEGADOR (E-15) — nenhum serviço externo recebe a URL, e a
//         rota não devolve a imagem.
//   POST  `{ contact_id, source }` → link com TOKEN para aquele contato
//         (PRD 084 D-2/D-3). Sem `FORM_LINK_SECRET`: 503
//         `FORM_LINK_SECRET_MISSING`; a UI avisa e o link genérico segue
//         valendo. Só formulário publicado; contato conferido pela RLS.
//
// A origem do link é `NEXT_PUBLIC_SITE_URL`, depois os cabeçalhos do proxy
// (`resolveRequestOrigin`) — nunca o host cru da requisição.
// ============================================================

import { NextResponse } from 'next/server';

import { toErrorResponse } from '@/lib/auth/account';
import {
  isUuidParam,
  jsonError,
  loadForm,
  requireFormsRole,
} from '@/lib/forms/account-api';
import { parseLinkBody } from '@/lib/forms/account-input';
import { buildEmbedSnippet } from '@/lib/forms/embed';
import {
  formPublicUrl,
  isFormLinkConfigured,
  signFormLink,
  verifyFormLink,
} from '@/lib/forms/link-token';
import { resolveRequestOrigin } from '@/lib/http/request-origin';

type Ctx = { params: Promise<{ id: string }> };

function originOf(request: Request): string {
  return resolveRequestOrigin(request, new URL(request.url).origin);
}

export async function GET(request: Request, { params }: Ctx) {
  try {
    const ctx = await requireFormsRole('agent');
    const { id } = await params;
    if (!isUuidParam(id)) return jsonError('Not found', 404);

    const form = await loadForm(ctx.supabase, ctx.accountId, id);
    if (!form) return jsonError('Not found', 404);

    const url = formPublicUrl(form.slug, originOf(request));
    return NextResponse.json({
      url,
      slug: form.slug,
      status: form.status,
      tokenAvailable: isFormLinkConfigured(),
      embed: buildEmbedSnippet(url, form.slug, form.name),
      embedOrigins: form.settings?.embed_origins ?? [],
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(request: Request, { params }: Ctx) {
  try {
    const ctx = await requireFormsRole('agent');
    const { id } = await params;
    if (!isUuidParam(id)) return jsonError('Not found', 404);

    const parsed = parseLinkBody(await request.json().catch(() => null));
    if (!parsed.ok) return jsonError(parsed.error, 400);
    const { contactId, source } = parsed.value;

    const form = await loadForm(ctx.supabase, ctx.accountId, id);
    if (!form) return jsonError('Not found', 404);
    if (form.status !== 'published') return jsonError('INVALID_STATE', 409);

    // Contato da própria conta (RLS da sessão + filtro explícito).
    const { data: contact, error: contactErr } = await ctx.supabase
      .from('contacts')
      .select('id')
      .eq('id', contactId)
      .eq('account_id', ctx.accountId)
      .maybeSingle();
    if (contactErr) {
      console.error('[forms] link contact lookup failed:', contactErr.code);
      return jsonError('Internal server error', 500);
    }
    if (!contact) return jsonError('Contact not found', 404);

    const token = signFormLink({
      formId: form.id,
      contactId,
      source,
      ttlDays: form.settings?.token_ttl_days,
    });
    if (!token) return jsonError('FORM_LINK_SECRET_MISSING', 503);

    const claims = verifyFormLink(token, form.id);
    return NextResponse.json({
      url: formPublicUrl(form.slug, originOf(request), token),
      expires_at: claims?.expiresAt.toISOString() ?? null,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
