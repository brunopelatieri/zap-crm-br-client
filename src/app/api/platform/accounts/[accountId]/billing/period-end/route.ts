// ============================================================
// PUT /api/platform/accounts/[accountId]/billing/period-end — SPEC 078 §3, §8
//
//   Altera a data de vencimento do plano (e, opcionalmente, o ciclo).
//   Corpo: { date: 'YYYY-MM-DD', billingCycle?: 'monthly'|'yearly',
//   reason?: string }. Toda a regra e os efeitos (auditoria, atividade
//   do cliente, webhook) moram em `changePlanPeriodEnd`.
// ============================================================

import { isUuid } from '@/lib/api/uuid';
import { changePlanPeriodEnd } from '@/lib/platform/billing-console';
import { notFoundResponse, toResponse } from '@/lib/platform/console-result';
import { requirePlatformOwner } from '@/lib/platform/owner';
import { supabaseAdmin } from '@/lib/supabase/admin';

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ accountId: string }> }
) {
  let ownerEmail: string;
  try {
    ownerEmail = (await requirePlatformOwner()).email;
  } catch {
    return notFoundResponse();
  }

  const { accountId } = await params;
  if (!isUuid(accountId)) return notFoundResponse();

  const body = (await request.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;

  return toResponse(
    await changePlanPeriodEnd(supabaseAdmin(), { accountId, ownerEmail, body })
  );
}
