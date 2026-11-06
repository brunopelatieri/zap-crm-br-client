// POST /area/api/request-code — J3/J5: pedir o código pelo WhatsApp.
//
// Responde SEMPRE igual (PRD 082 §6.1): quem é contato e quem não é,
// com ou sem limite estourado. O envio roda em `after()`, depois da
// resposta, e a resposta espera um piso de tempo (`holdUntil`), para o
// tempo não denunciar nada. O link da mensagem usa só a origem
// configurada, nunca o host da requisição (F6, A-2).

import { after, NextResponse } from 'next/server';

import { guardWrite, portalError } from '@/lib/contact-portal/http';
import { requestAccessCode } from '@/lib/contact-portal/journeys';
import { PORTAL_REQUEST_CODE_MIN_MS } from '@/lib/contact-portal/limits';
import {
  clientIpHash,
  configuredSiteOrigin,
  holdUntil,
  readJsonObject,
  stringField,
} from '@/lib/contact-portal/request';

export async function POST(request: Request) {
  const blocked = guardWrite(request);
  if (blocked) return blocked;

  const body = await readJsonObject(request);
  const phone = body ? stringField(body, 'phone', 40) : null;
  if (!body || !phone) {
    return portalError('invalid_input', 'Phone is required.', 400);
  }

  const startedAt = Date.now();
  try {
    const { deliver } = await requestAccessCode({
      rawPhone: phone,
      publicCode: stringField(body, 'publicCode', 16),
      purpose: body.purpose === 'first_access' ? 'first_access' : 'reset',
      ipHash: clientIpHash(request),
      siteOrigin: configuredSiteOrigin(),
    });
    if (deliver) after(deliver);
  } catch (err) {
    // Mesmo com o banco fora, a resposta não muda: nada aqui pode virar
    // oráculo de quem é contato.
    const name = err instanceof Error ? err.name : typeof err;
    console.error(`[contact-portal] request-code failed (${name})`);
  }

  await holdUntil(startedAt, PORTAL_REQUEST_CODE_MIN_MS);
  return NextResponse.json({ ok: true });
}
