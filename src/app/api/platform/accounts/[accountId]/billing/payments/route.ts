// ============================================================
// GET/POST /api/platform/accounts/[accountId]/billing/payments — SPEC 078 §4, §8
//
//   GET  → os 20 últimos pagamentos da conta (card "Pagamentos").
//   POST → registra um pagamento manual. Corpo: { paymentRef, paidAt:
//          'YYYY-MM-DD', periods, method, amountCents?, note? }.
//
//   `paymentRef` é obrigatório: quem gera o `console:<uuid>` é o
//   diálogo, ao abrir (§4.2). Já aplicado → 200 `already_applied`.
// ============================================================

import { isUuid } from '@/lib/api/uuid';
import {
  listPayments,
  recordManualPayment,
} from '@/lib/platform/billing-console';
import { notFoundResponse, toResponse } from '@/lib/platform/console-result';
import { requirePlatformOwner } from '@/lib/platform/owner';
import { supabaseAdmin } from '@/lib/supabase/admin';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ accountId: string }> }
) {
  try {
    await requirePlatformOwner();
  } catch {
    return notFoundResponse();
  }

  const { accountId } = await params;
  if (!isUuid(accountId)) return notFoundResponse();

  return toResponse(await listPayments(supabaseAdmin(), accountId));
}

export async function POST(
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
    await recordManualPayment(supabaseAdmin(), { accountId, ownerEmail, body })
  );
}
