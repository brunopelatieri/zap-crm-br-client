// POST /area/api/complete-code — código + nova senha (primeiro acesso e
// recuperação). Acertou: grava a senha e já abre a sessão.

import { NextResponse } from 'next/server';

import {
  guardWrite,
  portalError,
  cookieOrigin,
  unexpected,
} from '@/lib/contact-portal/http';
import { completeAccessCode } from '@/lib/contact-portal/journeys';
import {
  clientIpHash,
  readJsonObject,
  stringField,
} from '@/lib/contact-portal/request';
import { setSessionCookie } from '@/lib/contact-portal/session';

const ERRORS = {
  invalid_code: [400, 'Invalid or expired code.'],
  weak_password: [400, 'Password does not meet the requirements.'],
  password_mismatch: [400, 'Passwords do not match.'],
  terms_required: [400, 'Terms of use must be accepted.'],
  throttled: [429, 'Too many attempts. Try again later.'],
} as const;

export async function POST(request: Request) {
  const blocked = guardWrite(request);
  if (blocked) return blocked;

  const body = await readJsonObject(request);
  const phone = body ? stringField(body, 'phone', 40) : null;
  const code = body ? stringField(body, 'code', 16) : null;
  const password = body ? stringField(body, 'password', 256) : null;
  const confirm = body ? stringField(body, 'confirmPassword', 256) : null;
  if (!body || !phone || !code || password === null || confirm === null) {
    return portalError('invalid_input', 'Missing fields.', 400);
  }

  try {
    const r = await completeAccessCode({
      rawPhone: phone,
      publicCode: stringField(body, 'publicCode', 16),
      rawCode: code,
      password,
      confirmPassword: confirm,
      termsAccepted: body.termsAccepted === true,
      ipHash: clientIpHash(request),
    });
    if (r.status !== 'ok') {
      const [status, message] = ERRORS[r.status];
      return portalError(r.status, message, status);
    }
    const res = NextResponse.json({ ok: true, next: '/area/painel' });
    setSessionCookie(res, r.token, cookieOrigin(request));
    return res;
  } catch (err) {
    return unexpected('complete-code', err);
  }
}
