// ============================================================
// POST /api/platform/accounts/[accountId]/billing/payments/[paymentId]/reverse
// — SPEC 078 §4.5, §8
//
//   Desfaz o ÚLTIMO pagamento não estornado da conta (a linha é
//   marcada, nunca apagada). Corpo: { reason?: string }. As regras
//   (`payment_not_latest`, `period_changed_since_payment`…) vivem em
//   `reverse_plan_payment`, no banco; aqui viram 409.
// ============================================================

import { isUuid } from '@/lib/api/uuid';
import { reverseManualPayment } from '@/lib/platform/billing-console';
import { notFoundResponse, toResponse } from '@/lib/platform/console-result';
import { requirePlatformOwner } from '@/lib/platform/owner';
import { supabaseAdmin } from '@/lib/supabase/admin';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ accountId: string; paymentId: string }> }
) {
  let ownerEmail: string;
  try {
    ownerEmail = (await requirePlatformOwner()).email;
  } catch {
    return notFoundResponse();
  }

  const { accountId, paymentId } = await params;
  if (!isUuid(accountId) || !isUuid(paymentId)) return notFoundResponse();

  const body = (await request.json().catch(() => null)) as {
    reason?: unknown;
  } | null;

  return toResponse(
    await reverseManualPayment(supabaseAdmin(), {
      accountId,
      paymentId,
      ownerEmail,
      body,
    })
  );
}
