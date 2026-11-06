// POST /area/api/change-password — troca a senha dos acessos desta
// sessão (os que bateram no login) e encerra as outras sessões deles.

import { NextResponse } from 'next/server';

import { getPortalSession } from '@/lib/contact-portal/current';
import { guardWrite, portalError, unexpected } from '@/lib/contact-portal/http';
import { changePortalPassword } from '@/lib/contact-portal/journeys';
import {
  clientIpHash,
  readJsonObject,
  stringField,
} from '@/lib/contact-portal/request';

const ERRORS = {
  invalid_current: [400, 'Current password is incorrect.'],
  weak_password: [400, 'Password does not meet the requirements.'],
  password_mismatch: [400, 'Passwords do not match.'],
  throttled: [429, 'Too many attempts. Try again later.'],
  no_session: [401, 'Not signed in.'],
} as const;

export async function POST(request: Request) {
  const blocked = guardWrite(request);
  if (blocked) return blocked;

  try {
    const session = await getPortalSession();
    if (!session) return portalError('no_session', 'Not signed in.', 401);

    const body = await readJsonObject(request);
    const current = body ? stringField(body, 'current', 256) : null;
    const next = body ? stringField(body, 'next', 256) : null;
    const confirm = body ? stringField(body, 'confirmNext', 256) : null;
    if (current === null || next === null || confirm === null) {
      return portalError('invalid_input', 'Missing fields.', 400);
    }

    const r = await changePortalPassword(session, {
      current,
      next,
      confirmNext: confirm,
      ipHash: clientIpHash(request),
    });
    if (r.status !== 'ok') {
      const [status, message] = ERRORS[r.status];
      return portalError(r.status, message, status);
    }
    return NextResponse.json({ ok: true, changed: r.changed ?? 0 });
  } catch (err) {
    return unexpected('change-password', err);
  }
}
