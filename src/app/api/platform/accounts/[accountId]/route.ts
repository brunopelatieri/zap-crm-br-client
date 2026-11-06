// ============================================================
// GET /api/platform/accounts/[accountId] — SPEC 062 §6, §7.3
//
//   Detalhe de uma conta: cabeçalho, plano/ciclo, uso × quota (mesmo
//   `getAccountPlan` que o cliente usa — §7.3: "a garantia de que o
//   proprietário vê EXATAMENTE a mesma barra que o cliente vê"),
//   membros e histórico recente. `service_role`, atrás de
//   `requirePlatformOwner()`.
// ============================================================

import { NextResponse } from 'next/server';

import { requirePlatformOwner } from '@/lib/platform/owner';
import { loadOwnerSelfRefs } from '@/lib/platform/owner-profile';
import {
  PLAN_EVENTS_LIMIT,
  getAccountAuditEvents,
  getAccountDetail,
} from '@/lib/platform/accounts';
import { isPlatformOwnerEmail } from '@/lib/platform/owner';
import { getAccountPlan } from '@/lib/plans/account-plan';
import { listAccountPayments } from '@/lib/plans/payments';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { createPortalAccountService } from '@/lib/contact-portal/account';

const NOT_FOUND = NextResponse.json({ error: 'Not found' }, { status: 404 });

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ accountId: string }> }
) {
  let ownerUserId: string;
  try {
    const ctx = await requirePlatformOwner();
    ownerUserId = ctx.userId;
  } catch {
    return NOT_FOUND;
  }

  const { accountId } = await params;
  const db = supabaseAdmin();

  // Quais alvos desta tela são o PRÓPRIO proprietário (§4.4). A UI usa
  // isto para desabilitar o switch com o motivo no `title`; as rotas de
  // bloqueio recusam de novo, com 400 — o botão desabilitado é
  // conveniência, não garantia.
  const self = await loadOwnerSelfRefs(db, ownerUserId);

  const [detail, planSnapshot, events, auditEvents, payments, contactPortal] =
    await Promise.all([
      getAccountDetail(db, accountId),
      getAccountPlan(accountId, db).catch((err) => {
        console.error(
          '[GET /api/platform/accounts/[accountId]] getAccountPlan error:',
          err
        );
        return null;
      }),
      db
        .from('account_plan_events')
        .select(
          'id, from_plan_code, to_plan_code, from_status, to_status, actor, reason, created_at'
        )
        .eq('account_id', accountId)
        .order('created_at', { ascending: false })
        .limit(PLAN_EVENTS_LIMIT),
      getAccountAuditEvents(db, accountId),
      // Os pagamentos viajam junto com o detalhe: o card os mostra e decide
      // "Desfazer" contra o MESMO `currentPeriodEnd` lido aqui, sem uma
      // segunda ida ao servidor depois da primeira. Falha vira `null` (o
      // card mostra o erro) — não derruba o resto do detalhe.
      listAccountPayments(db, accountId).catch((err) => {
        console.error(
          '[GET /api/platform/accounts/[accountId]] listAccountPayments error:',
          err
        );
        return null;
      }),
      // SPEC 083 — "ligada/desligada · N contatos com acesso" (PRD 082
      // §5). Falha vira `null`: o card some, o detalhe não cai.
      createPortalAccountService(db)
        .summary(accountId)
        .catch(() => null),
    ]);

  if (!detail) {
    return NextResponse.json({ error: 'Account not found' }, { status: 404 });
  }

  return NextResponse.json({
    account: detail,
    usage: planSnapshot?.usage ?? null,
    quotasEnforced: planSnapshot?.quotasEnforced ?? false,
    events: events.data ?? [],
    // SPEC 078 §9.4 — o que o console fez nesta conta, intercalado com
    // `events` pelo card "Histórico".
    auditEvents,
    // SPEC 078 §4.4 — `null` = a leitura falhou.
    payments,
    // SPEC 083 — `null` = a leitura falhou.
    contactPortal,
    // SPEC 078 §9.3 — membros que SÃO o proprietário da plataforma: o
    // diálogo de edição trava o campo de e-mail deles.
    platformOwnerUserIds: detail.members
      .filter((m) => isPlatformOwnerEmail(m.email))
      .map((m) => m.userId),
    self: {
      isOwnAccount: self.ownerAccountId === accountId,
      ownUserId: self.ownerUserId,
    },
  });
}
