// ============================================================
// POST /api/contact-portal/contacts/status — SPEC 083
//
//   Estado do acesso de até 100 contatos, para a ficha (PRD 082 §6.3:
//   "sem acesso · convite enviado · ativo · bloqueado" e último login).
//   `viewer`+. Só devolve contatos que a RLS deixa o usuário ver
//   (escopo de contatos da SPEC 042), e diz se a área da conta está
//   elegível — a ficha esconde os botões quando não está.
//
//   Plano sem o item (PRD 082 D-4): 403 `FEATURE_NOT_IN_PLAN`; o cartão
//   da ficha trata esse 403 como "não renderizar", sem toast.
// ============================================================

import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import {
  createPortalAccountService,
  visibleContactIds,
} from '@/lib/contact-portal/account';
import { requireContactPortalFeature } from '@/lib/contact-portal/plan-gate';
import { portalDb } from '@/lib/contact-portal/service';

const MAX_IDS = 100;

export async function POST(request: Request) {
  try {
    const ctx = await requireRole('viewer');
    await requireContactPortalFeature(ctx.accountId);
    const body = (await request.json().catch(() => null)) as {
      contactIds?: unknown;
    } | null;
    const ids = body?.contactIds;
    if (
      !Array.isArray(ids) ||
      ids.length > MAX_IDS ||
      ids.some((id) => typeof id !== 'string')
    ) {
      return NextResponse.json(
        { error: `contactIds must be an array of up to ${MAX_IDS} ids` },
        { status: 400 }
      );
    }

    const visible = await visibleContactIds(
      ctx.supabase,
      ctx.accountId,
      ids as string[]
    );
    const account = createPortalAccountService(portalDb());
    const [statuses, settings] = await Promise.all([
      account.accessStatus(ctx.accountId, visible),
      account.getSettings(ctx.accountId),
    ]);

    return NextResponse.json({
      eligible: settings?.eligible ?? false,
      statuses,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
