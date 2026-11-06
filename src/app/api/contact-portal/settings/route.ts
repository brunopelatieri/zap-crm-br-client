// ============================================================
// GET/PATCH /api/contact-portal/settings — SPEC 083
//
//   Configurações → Área do contato (PRD 082 §6.3): ligar/desligar, canal
//   que envia os códigos, template de autenticação e palavra-chave.
//   `admin`+ nas duas (é configuração da conta). O banco é alcançado
//   pelas `portal_*` com `service_role`; a autorização é o
//   `requireRole` daqui. Mensagens em inglês (padrão de `/api/**`).
//
//   Plano (SPEC 083 §8.4, PRD 082 D-4): o GET é a ÚNICA rota do grupo
//   que responde 200 sem o item — devolve `featureInPlan: false` para a
//   aba renderizar o aviso "não incluído no seu plano". O PATCH, como as
//   demais, responde 403 `FEATURE_NOT_IN_PLAN`.
// ============================================================

import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import {
  createPortalAccountService,
  parseSettingsPatch,
  type PortalAccountSettings,
} from '@/lib/contact-portal/account';
import {
  hasContactPortalFeature,
  requireContactPortalFeature,
} from '@/lib/contact-portal/plan-gate';
import { PortalServiceError, portalDb } from '@/lib/contact-portal/service';
import { resolveRequestOrigin } from '@/lib/http/request-origin';

function view(request: Request, settings: PortalAccountSettings | null) {
  const origin = resolveRequestOrigin(request, new URL(request.url).origin);
  return {
    featureInPlan: true as const,
    settings,
    portalUrl: settings ? `${origin}/area/c/${settings.publicCode}` : null,
  };
}

export async function GET(request: Request) {
  try {
    const ctx = await requireRole('admin');
    if (!(await hasContactPortalFeature(ctx.accountId))) {
      return NextResponse.json({
        featureInPlan: false,
        settings: null,
        portalUrl: null,
      });
    }
    const settings = await createPortalAccountService(portalDb()).getSettings(
      ctx.accountId
    );
    return NextResponse.json(view(request, settings));
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function PATCH(request: Request) {
  try {
    const ctx = await requireRole('admin');
    await requireContactPortalFeature(ctx.accountId);
    const parsed = parseSettingsPatch(await request.json().catch(() => null));
    if ('error' in parsed) {
      return NextResponse.json({ error: parsed.error }, { status: 400 });
    }

    try {
      const settings = await createPortalAccountService(portalDb()).setSettings(
        ctx.accountId,
        parsed.patch,
        ctx.userId
      );
      return NextResponse.json(view(request, settings));
    } catch (err) {
      // 22023: canal ou template de outra conta (a função confere).
      if (err instanceof PortalServiceError && err.pgCode === '22023') {
        return NextResponse.json(
          { error: 'Channel or template does not belong to this account' },
          { status: 400 }
        );
      }
      throw err;
    }
  } catch (err) {
    return toErrorResponse(err);
  }
}
