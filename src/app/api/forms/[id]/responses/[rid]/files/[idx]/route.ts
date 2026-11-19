// ============================================================
// GET /api/forms/[id]/responses/[rid]/files/[idx] — SPEC 085 §7.1 (viewer+)
//
// Redireciona (302) para uma URL assinada de 10 minutos com
// `Content-Disposition: attachment` (`download`): o arquivo é do
// visitante e NUNCA abre inline na origem do app. A assinatura usa o
// client de SESSÃO — a policy de leitura do bucket (097) exige membro da
// conta; nenhum service_role aqui.
// ============================================================

import { NextResponse } from 'next/server';

import { toErrorResponse } from '@/lib/auth/account';
import {
  isUuidParam,
  jsonError,
  requireFormsRole,
} from '@/lib/forms/account-api';
import {
  fileBelongsToResponse,
  listResponseFiles,
} from '@/lib/forms/response-display';
import { FORM_UPLOADS_BUCKET } from '@/lib/forms/uploads';
import type { AnswersSnapshot } from '@/lib/forms/types';

const FILE_URL_TTL_SECONDS = 10 * 60;

type Ctx = { params: Promise<{ id: string; rid: string; idx: string }> };

export async function GET(_request: Request, { params }: Ctx) {
  try {
    const ctx = await requireFormsRole('viewer');
    const { id, rid, idx } = await params;
    if (!isUuidParam(id) || !isUuidParam(rid) || !/^\d{1,4}$/.test(idx)) {
      return jsonError('Not found', 404);
    }

    const { data, error } = await ctx.supabase
      .from('form_responses')
      .select('id, answers')
      .eq('id', rid)
      .eq('form_id', id)
      .eq('account_id', ctx.accountId)
      .maybeSingle();
    if (error) {
      console.error('[forms] response file lookup failed:', error.code);
      return jsonError('Internal server error', 500);
    }
    if (!data) return jsonError('Not found', 404);

    const files = listResponseFiles(data.answers as AnswersSnapshot);
    const item = files[Number(idx)];
    if (
      !item ||
      !fileBelongsToResponse(item.file.path, ctx.accountId, id, rid)
    ) {
      return jsonError('Not found', 404);
    }

    const { data: signed, error: signError } = await ctx.supabase.storage
      .from(FORM_UPLOADS_BUCKET)
      .createSignedUrl(item.file.path, FILE_URL_TTL_SECONDS, {
        download: item.file.name || true,
      });
    if (signError || !signed?.signedUrl) {
      return jsonError('Not found', 404);
    }

    const res = NextResponse.redirect(signed.signedUrl, 302);
    // A URL assinada é um segredo de 10 minutos: nada de cache nem Referer.
    res.headers.set('Cache-Control', 'private, no-store');
    res.headers.set('Referrer-Policy', 'no-referrer');
    return res;
  } catch (err) {
    return toErrorResponse(err);
  }
}
