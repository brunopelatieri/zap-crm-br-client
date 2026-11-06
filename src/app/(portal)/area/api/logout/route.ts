// POST /area/api/logout — sair (desta sessão ou de todos os aparelhos).
// O cookie sai mesmo se o banco falhar: a pessoa pediu para sair.

import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';

import { cookieOrigin, guardWrite } from '@/lib/contact-portal/http';
import { signOut } from '@/lib/contact-portal/journeys';
import { readJsonObject } from '@/lib/contact-portal/request';
import {
  clearSessionCookie,
  readSessionToken,
} from '@/lib/contact-portal/session';

export async function POST(request: Request) {
  const blocked = guardWrite(request);
  if (blocked) return blocked;

  const body = await readJsonObject(request);
  try {
    await signOut(readSessionToken(await cookies()), body?.everywhere === true);
  } catch (err) {
    const name = err instanceof Error ? err.name : typeof err;
    console.error(`[contact-portal] logout failed (${name})`);
  }

  const res = NextResponse.json({ ok: true, next: '/area' });
  clearSessionCookie(res, cookieOrigin(request));
  return res;
}
