// POST /api/forms/public/[slug]/start — SPEC 085 §4.2 item 4, §7.2.
//
// Cria a resposta `partial` DEPOIS da identidade (PRD D-7): o telefone
// respondido (ou o token do link) vira contato, e o visitante recebe o
// `response_id` e o `resume_token` das chamadas seguintes. Sem sessão;
// `Origin` obrigatório; 30/min por IP.

import { NextResponse } from 'next/server';

import { hashClientIp } from '@/lib/forms/link-token';
import {
  bodyString,
  getClientIp,
  guardPublicRequest,
  isSlugShape,
  PublicApiError,
  publicErrorResponse,
  readPublicBody,
  unavailableError,
} from '@/lib/forms/public-api';
import { MIN_FILL_MS, startResponse } from '@/lib/forms/public-service';

export async function POST(
  request: Request,
  ctx: { params: Promise<{ slug: string }> }
) {
  const blocked = guardPublicRequest(request, 'formStart');
  if (blocked) return blocked;

  try {
    const { slug } = await ctx.params;
    if (!isSlugShape(slug)) throw unavailableError();
    const body = await readPublicBody(request);

    // Honeypot: o campo escondido do formulário só um robô preenche.
    if (typeof body.honeypot === 'string' && body.honeypot.trim() !== '') {
      throw new PublicApiError(400, 'invalid_request', 'Invalid request.');
    }
    // Tempo desde que a página abriu, medido pelo navegador (relativo, para
    // não depender de o relógio dele bater com o do servidor).
    const elapsed = Number(body.elapsed_ms);
    if (!Number.isFinite(elapsed) || elapsed < MIN_FILL_MS) {
      throw new PublicApiError(
        400,
        'too_fast',
        'Submitted too quickly. Try again in a moment.'
      );
    }

    const result = await startResponse({
      slug,
      phone: bodyString(body, 'phone', 40),
      proofId: bodyString(body, 'proof_id', 64),
      proofSecret: bodyString(body, 'proof_secret', 256),
      linkToken: bodyString(body, 'link_token', 1024),
      utm: body.utm,
      embedded: body.embedded === true,
      userAgent: request.headers.get('user-agent'),
      ipHash: hashClientIp(getClientIp(request)),
    });

    if (result.alreadyAnswered) {
      return NextResponse.json({ already_answered: true });
    }
    return NextResponse.json({
      response_id: result.responseId,
      resume_token: result.resumeToken,
      identity_mode: result.identityMode,
    });
  } catch (err) {
    return publicErrorResponse('start', err);
  }
}
