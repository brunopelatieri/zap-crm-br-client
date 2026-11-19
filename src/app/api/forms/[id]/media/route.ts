// ============================================================
// POST/GET /api/forms/[id]/media — SPEC 085 §7.1 / E-16 (admin+)
//
//   POST  `{ name, mime, size }` → URL ASSINADA de upload no bucket privado
//         `form-media` (o arquivo não passa pelo Node). Valida imagem
//         (MIME + extensão + 5 MB) ANTES de assinar. Quem assina é o client
//         de sessão: a policy de INSERT do bucket (097) só abre para `admin`
//         da conta, no prefixo `account-<uuid>/`.
//   GET   `?path=…` → URL assinada de LEITURA (1 h) de um caminho que já
//         subiu — a prévia do construtor mostra a imagem sem recarregar o
//         formulário. Só caminhos desta conta e deste formulário.
//
// A rota de leitura é uma adição desta fase (a SPEC lista só o POST): sem
// ela, a imagem recém-enviada só apareceria depois de recarregar.
// ============================================================

import { NextResponse } from 'next/server';

import { toErrorResponse } from '@/lib/auth/account';
import {
  isUuidParam,
  jsonError,
  loadForm,
  requireFormsRole,
  signMediaPaths,
} from '@/lib/forms/account-api';
import {
  buildFormMediaPath,
  FORM_MEDIA_BUCKET,
  validateMediaRequest,
} from '@/lib/forms/uploads';

type Ctx = { params: Promise<{ id: string }> };

export async function POST(request: Request, { params }: Ctx) {
  try {
    const ctx = await requireFormsRole('admin');
    const { id } = await params;
    if (!isUuidParam(id)) return jsonError('Not found', 404);

    const body = (await request.json().catch(() => null)) as {
      name?: unknown;
      mime?: unknown;
      size?: unknown;
    } | null;
    if (!body || typeof body !== 'object')
      return jsonError('Invalid JSON', 400);

    const form = await loadForm(ctx.supabase, ctx.accountId, id);
    if (!form) return jsonError('Not found', 404);

    const check = validateMediaRequest({
      name: String(body.name ?? ''),
      mime: String(body.mime ?? ''),
      size: Number(body.size),
    });
    if (!check.ok) {
      return jsonError('INVALID_FILE', 400, {
        reason: check.reason,
        ...(check.maxBytes ? { max_bytes: check.maxBytes } : {}),
      });
    }

    const path = buildFormMediaPath({
      accountId: ctx.accountId,
      formId: form.id,
      ext: check.ext,
    });
    const { data, error } = await ctx.supabase.storage
      .from(FORM_MEDIA_BUCKET)
      .createSignedUploadUrl(path);
    if (error || !data) {
      console.error('[forms] media signed upload failed:', error?.message);
      return jsonError('Could not create the upload URL', 500);
    }

    return NextResponse.json({
      path,
      token: data.token,
      signed_url: data.signedUrl,
      mime: check.mime,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function GET(request: Request, { params }: Ctx) {
  try {
    const ctx = await requireFormsRole('admin');
    const { id } = await params;
    if (!isUuidParam(id)) return jsonError('Not found', 404);

    const path = new URL(request.url).searchParams.get('path') ?? '';
    const prefix = `account-${ctx.accountId}/${id}/`;
    if (!path.startsWith(prefix) || path.includes('..')) {
      return jsonError('Not found', 404);
    }
    const form = await loadForm(ctx.supabase, ctx.accountId, id);
    if (!form) return jsonError('Not found', 404);

    const urls = await signMediaPaths(ctx.supabase, [path]);
    if (!urls[path]) return jsonError('Not found', 404);
    return NextResponse.json({ path, url: urls[path] });
  } catch (err) {
    return toErrorResponse(err);
  }
}
