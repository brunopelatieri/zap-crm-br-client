// ============================================================
// DELETE /api/contact-portal/contacts/[contactId]/sessions — SPEC 083
//
//   "Encerrar sessões do contato" (PRD 082 §6.3): `admin`+. Tira este
//   acesso de toda sessão aberta; a pessoa entra de novo com a senha.
// ============================================================

import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import {
  createPortalAccountService,
  visibleContact,
} from '@/lib/contact-portal/account';
import { requireContactPortalFeature } from '@/lib/contact-portal/plan-gate';
import { portalDb } from '@/lib/contact-portal/service';

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ contactId: string }> }
) {
  try {
    const ctx = await requireRole('admin');
    // Plano sem o item → 403 FEATURE_NOT_IN_PLAN (PRD 082 D-4).
    await requireContactPortalFeature(ctx.accountId);
    const { contactId } = await params;

    const contact = await visibleContact(
      ctx.supabase,
      ctx.accountId,
      contactId
    );
    if (!contact) {
      return NextResponse.json({ error: 'Contact not found' }, { status: 404 });
    }

    const ended = await createPortalAccountService(portalDb()).endSessions(
      ctx.accountId,
      contactId
    );
    return NextResponse.json({ ok: true, ended });
  } catch (err) {
    return toErrorResponse(err);
  }
}
