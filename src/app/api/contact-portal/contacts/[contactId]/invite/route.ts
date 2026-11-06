// ============================================================
// POST /api/contact-portal/contacts/[contactId]/invite — SPEC 083, J1
//
//   "Enviar acesso" na ficha do contato (PRD 082 §6.3): `agent`+. Emite o
//   código de convite e entrega pelo canal da conta na hora, para a
//   ficha dizer se saiu ou por que não saiu. Convite respeita o
//   opt-out (SPEC 083 §6) — quem recusa é o banco (`portal_invite`).
// ============================================================

import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { recordActivity } from '@/lib/activity/record';
import {
  inviteContactToPortal,
  visibleContact,
} from '@/lib/contact-portal/account';
import { requireContactPortalFeature } from '@/lib/contact-portal/plan-gate';
import { configuredSiteOrigin } from '@/lib/contact-portal/request';
import { portalDb } from '@/lib/contact-portal/service';

/** Recusa esperada → 409 (a ficha mostra o motivo); limite → 429. */
const STATUS_OF: Record<string, number> = {
  throttled: 429,
  not_found: 404,
};

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ contactId: string }> }
) {
  try {
    const ctx = await requireRole('agent');
    // Plano sem o item → 403 FEATURE_NOT_IN_PLAN (PRD 082 D-4).
    await requireContactPortalFeature(ctx.accountId);
    const { contactId } = await params;

    const contact = await visibleContact(
      ctx.supabase,
      ctx.accountId,
      contactId
    );
    if (!contact) {
      return NextResponse.json(
        { error: 'Contact not found', code: 'not_found' },
        { status: 404 }
      );
    }

    const result = await inviteContactToPortal({
      db: portalDb(),
      accountId: ctx.accountId,
      accountName: ctx.account.name,
      contactId,
      userId: ctx.userId,
      // Só a origem configurada: o link leva o código (F6, A-2).
      siteOrigin: configuredSiteOrigin(),
    });

    if (!result.ok) {
      return NextResponse.json(
        { error: 'Access invite not sent', code: result.reason },
        { status: STATUS_OF[result.reason] ?? 409 }
      );
    }

    void recordActivity(ctx.supabase, {
      accountId: ctx.accountId,
      resourceType: 'contact',
      action: 'contact.portal_invited',
      resourceId: contactId,
      resourceLabel: contact.name,
      contactId,
      actor: { kind: 'user', userId: ctx.userId, role: ctx.role },
      metadata: { via: result.via },
    });

    return NextResponse.json({ ok: true, via: result.via });
  } catch (err) {
    return toErrorResponse(err);
  }
}
