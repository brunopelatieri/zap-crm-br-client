// POST /area/api/login — J4: telefone + senha.

import { NextResponse } from 'next/server';

import {
  guardWrite,
  portalError,
  cookieOrigin,
  unexpected,
} from '@/lib/contact-portal/http';
import { signIn } from '@/lib/contact-portal/journeys';
import {
  clientIpHash,
  readJsonObject,
  stringField,
} from '@/lib/contact-portal/request';
import { setSessionCookie } from '@/lib/contact-portal/session';

export async function POST(request: Request) {
  const blocked = guardWrite(request);
  if (blocked) return blocked;

  const body = await readJsonObject(request);
  const phone = body ? stringField(body, 'phone', 40) : null;
  const password = body ? stringField(body, 'password', 256) : null;
  if (!phone || password === null) {
    return portalError(
      'invalid_input',
      'Phone and password are required.',
      400
    );
  }

  try {
    const r = await signIn({
      rawPhone: phone,
      password,
      ipHash: clientIpHash(request),
    });
    if (r.status === 'throttled') {
      return portalError(
        'throttled',
        'Too many attempts. Try again later.',
        429
      );
    }
    if (r.status !== 'ok') {
      return portalError(
        'invalid_credentials',
        'Invalid phone or password.',
        401
      );
    }
    const res = NextResponse.json({
      ok: true,
      next: r.accessCount > 1 ? '/area/escolher-conta' : '/area/painel',
    });
    setSessionCookie(res, r.token, cookieOrigin(request));
    return res;
  } catch (err) {
    return unexpected('login', err);
  }
}
