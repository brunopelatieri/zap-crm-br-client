// PATCH /api/forms/public/[slug]/responses/[id] — autosave por bloco
// (SPEC 085 §4.2 item 5, §7.2). `resume_token` confere; só chaves de blocos
// existentes; cada valor passa pela MESMA validação do envio. 120/min por IP.

import { NextResponse } from 'next/server';

import { isUuid } from '@/lib/api/uuid';
import {
  guardPublicRequest,
  isSlugShape,
  publicErrorResponse,
  readPublicBody,
  unavailableError,
} from '@/lib/forms/public-api';
import { autosaveResponse } from '@/lib/forms/public-service';

export async function PATCH(
  request: Request,
  ctx: { params: Promise<{ slug: string; id: string }> }
) {
  const blocked = guardPublicRequest(request, 'formAutosave');
  if (blocked) return blocked;

  try {
    const { slug, id } = await ctx.params;
    if (!isSlugShape(slug) || !isUuid(id)) throw unavailableError();
    const body = await readPublicBody(request);
    const result = await autosaveResponse({
      slug,
      responseId: id,
      resumeToken: body.resume_token,
      delta: body.answers_delta,
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    return publicErrorResponse('autosave', err);
  }
}
