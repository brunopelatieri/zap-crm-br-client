// POST /api/forms/public/[slug]/phone-proof — SPEC 085 F7.
//
// Gera o código de confirmação do telefone (prova de posse pelo WhatsApp).
// NÃO cria contato nem resposta: só uma linha em `form_phone_proofs`. O
// visitante envia o código, do próprio WhatsApp, ao número da conta; a
// mensagem recebida confirma a prova (`handleInboundPhoneProof`). Sem sessão;
// `Origin` obrigatório; 10/min por IP, além dos tetos no banco por
// telefone, formulário e conta.

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
import { MIN_FILL_MS, requestPhoneProof } from '@/lib/forms/public-service';

export async function POST(
  request: Request,
  ctx: { params: Promise<{ slug: string }> }
) {
  const blocked = guardPublicRequest(request, 'formPhoneProof');
  if (blocked) return blocked;

  try {
    const { slug } = await ctx.params;
    if (!isSlugShape(slug)) throw unavailableError();
    const body = await readPublicBody(request);

    if (typeof body.honeypot === 'string' && body.honeypot.trim() !== '') {
      throw new PublicApiError(400, 'invalid_request', 'Invalid request.');
    }
    const elapsed = Number(body.elapsed_ms);
    if (!Number.isFinite(elapsed) || elapsed < MIN_FILL_MS) {
      throw new PublicApiError(
        400,
        'too_fast',
        'Submitted too quickly. Try again in a moment.'
      );
    }

    const ip = getClientIp(request);
    const result = await requestPhoneProof({
      slug,
      phone: bodyString(body, 'phone', 40),
      turnstile: body.turnstile,
      ip,
      ipHash: hashClientIp(ip),
    });
    return NextResponse.json({
      proof_id: result.proofId,
      proof_secret: result.proofSecret,
      code: result.code,
      whatsapp_number: result.whatsappNumber,
      expires_in_seconds: result.expiresInSeconds,
    });
  } catch (err) {
    return publicErrorResponse('phone-proof', err);
  }
}
