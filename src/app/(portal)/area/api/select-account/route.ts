// POST /area/api/select-account — escolher a conta entre as que a sessão abriu.

import { NextResponse } from 'next/server';

import { getPortalSession } from '@/lib/contact-portal/current';
import { guardWrite, portalError, unexpected } from '@/lib/contact-portal/http';
import { readJsonObject, stringField } from '@/lib/contact-portal/request';
import { portalService } from '@/lib/contact-portal/service';

export async function POST(request: Request) {
  const blocked = guardWrite(request);
  if (blocked) return blocked;

  try {
    const session = await getPortalSession();
    if (!session) return portalError('no_session', 'Not signed in.', 401);

    const body = await readJsonObject(request);
    const contactId = body ? stringField(body, 'contactId', 64) : null;
    if (!contactId) {
      return portalError('invalid_input', 'contactId is required.', 400);
    }

    const ok = await portalService().selectAccount(session, contactId);
    if (!ok) return portalError('not_found', 'Account not available.', 404);
    return NextResponse.json({ ok: true, next: '/area/painel' });
  } catch (err) {
    return unexpected('select-account', err);
  }
}
