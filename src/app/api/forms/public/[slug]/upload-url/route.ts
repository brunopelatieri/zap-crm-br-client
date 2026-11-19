// POST /api/forms/public/[slug]/upload-url — SPEC 085 §7.2, E-6.
//
// Valida nome, MIME (allowlist dupla), tamanho e quota ANTES de assinar; o
// navegador então envia o arquivo direto ao Storage (não passa pelo Node).
// O envio da resposta confere o objeto e o tamanho real. 20/min por IP.

import { NextResponse } from 'next/server';

import { isUuid } from '@/lib/api/uuid';
import {
  guardPublicRequest,
  isSlugShape,
  publicErrorResponse,
  readPublicBody,
  unavailableError,
} from '@/lib/forms/public-api';
import { createUploadUrl } from '@/lib/forms/public-service';

export async function POST(
  request: Request,
  ctx: { params: Promise<{ slug: string }> }
) {
  const blocked = guardPublicRequest(request, 'formUpload');
  if (blocked) return blocked;

  try {
    const { slug } = await ctx.params;
    const body = await readPublicBody(request);
    const responseId = body.response_id;
    if (
      !isSlugShape(slug) ||
      typeof responseId !== 'string' ||
      !isUuid(responseId)
    ) {
      throw unavailableError();
    }
    const result = await createUploadUrl({
      slug,
      responseId,
      resumeToken: body.resume_token,
      fieldKey: body.field_key,
      name: body.name,
      mime: body.mime,
      size: body.size,
    });
    return NextResponse.json({
      path: result.path,
      signed_url: result.signedUrl,
      token: result.token,
      mime: result.mime,
    });
  } catch (err) {
    return publicErrorResponse('upload-url', err);
  }
}
