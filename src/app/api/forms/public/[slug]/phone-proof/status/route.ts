// POST /api/forms/public/[slug]/phone-proof/status — SPEC 085 F7.
//
// A página consulta a cada poucos segundos se a mensagem com o código já
// chegou. POST (e não GET) para o segredo não ir na URL. Id errado, segredo
// errado e prova já usada voltam o mesmo `not_found`. 60/min por IP.

import { NextResponse } from 'next/server';

import { isUuid } from '@/lib/api/uuid';
import {
  guardPublicRequest,
  isSlugShape,
  publicErrorResponse,
  readPublicBody,
  unavailableError,
} from '@/lib/forms/public-api';
import { phoneProofStatus } from '@/lib/forms/public-service';

export async function POST(
  request: Request,
  ctx: { params: Promise<{ slug: string }> }
) {
  const blocked = guardPublicRequest(request, 'formPhoneProofStatus');
  if (blocked) return blocked;

  try {
    const { slug } = await ctx.params;
    const body = await readPublicBody(request);
    const proofId = body.proof_id;
    if (!isSlugShape(slug) || typeof proofId !== 'string' || !isUuid(proofId)) {
      throw unavailableError();
    }
    const status = await phoneProofStatus({
      slug,
      proofId,
      proofSecret: body.proof_secret,
    });
    return NextResponse.json({ status });
  } catch (err) {
    return publicErrorResponse('phone-proof-status', err);
  }
}
