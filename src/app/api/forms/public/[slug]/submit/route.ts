// POST /api/forms/public/[slug]/submit — SPEC 085 §4.2 item 7, §7.2.
//
// Do corpo do cliente só `answers`, `resume_token`, `response_id`,
// `turnstile` e o honeypot são lidos; QUALQUER outro campo (pontos, faixa,
// `link_token`, identidade) é ignorado — a pontuação é do servidor (E-5) e
// a identidade ficou fixada no `start`. 10/min por IP.

import { NextResponse } from 'next/server';

import { isUuid } from '@/lib/api/uuid';
import {
  getClientIp,
  guardPublicRequest,
  isSlugShape,
  PublicApiError,
  publicErrorResponse,
  readPublicBody,
  unavailableError,
} from '@/lib/forms/public-api';
import { submitResponse } from '@/lib/forms/public-service';

export async function POST(
  request: Request,
  ctx: { params: Promise<{ slug: string }> }
) {
  const blocked = guardPublicRequest(request, 'formSubmit');
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
    if (typeof body.honeypot === 'string' && body.honeypot.trim() !== '') {
      throw new PublicApiError(400, 'invalid_request', 'Invalid request.');
    }

    const { thankYou } = await submitResponse({
      slug,
      responseId,
      resumeToken: body.resume_token,
      answers: body.answers,
      turnstile: body.turnstile,
      ip: getClientIp(request),
    });
    return NextResponse.json({ ok: true, thank_you: thankYou });
  } catch (err) {
    return publicErrorResponse('submit', err);
  }
}
