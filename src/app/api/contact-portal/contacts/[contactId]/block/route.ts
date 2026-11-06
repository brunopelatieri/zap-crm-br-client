// ============================================================
// POST /api/contact-portal/contacts/[contactId]/block — SPEC 083
//
//   Bloquear / desbloquear o acesso deste contato nesta conta (PRD 082
//   §6.3): `admin`+. Bloquear derruba as sessões do acesso na hora e vale
//   também antes do primeiro acesso. A senha é da pessoa: bloquear não
//   a apaga (PRD 082 D-7), só fecha a porta desta conta.
// ============================================================

import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { recordActivity } from '@/lib/activity/record';
import {
  createPortalAccountService,
  visibleContact,
} from '@/lib/contact-portal/account';
import { requireContactPortalFeature } from '@/lib/contact-portal/plan-gate';
import { portalDb } from '@/lib/contact-portal/service';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ contactId: string }> }
) {
  try {
    const ctx = await requireRole('admin');
    // Plano sem o item → 403 FEATURE_NOT_IN_PLAN (PRD 082 D-4).
    await requireContactPortalFeature(ctx.accountId);
    const { contactId } = await params;

    const body = (await request.json().catch(() => null)) as {
      blocked?: unknown;
    } | null;
    if (typeof body?.blocked !== 'boolean') {
      return NextResponse.json(
        { error: 'blocked must be a boolean' },
        { status: 400 }
      );
    }
    const blocked = body.blocked;

    const contact = await visibleContact(
      ctx.supabase,
      ctx.accountId,
      contactId
    );
    if (!contact) {
      return NextResponse.json({ error: 'Contact not found' }, { status: 404 });
    }

    const ok = await createPortalAccountService(portalDb()).setBlocked({
      accountId: ctx.accountId,
      contactId,
      blocked,
      userId: ctx.userId,
    });
    if (!ok) {
      return NextResponse.json({ error: 'Contact not found' }, { status: 404 });
    }

    void recordActivity(ctx.supabase, {
      accountId: ctx.accountId,
      resourceType: 'contact',
      action: blocked ? 'contact.portal_blocked' : 'contact.portal_unblocked',
      resourceId: contactId,
      resourceLabel: contact.name,
      contactId,
      actor: { kind: 'user', userId: ctx.userId, role: ctx.role },
    });

    return NextResponse.json({ ok: true, blocked });
  } catch (err) {
    return toErrorResponse(err);
  }
}
