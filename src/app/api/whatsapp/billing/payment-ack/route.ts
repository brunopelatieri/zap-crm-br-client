/**
 * POST /api/whatsapp/billing/payment-ack
 *
 * "Já regularizei" (SPEC 076 §6.3, §9.3): limpa MANUALMENTE o estado de
 * pagamento pendente do WABA do canal. Só owner/admin. Um 131042
 * posterior abre um episódio novo.
 *
 * Corpo: `{ "channel_id": "<uuid>" }`.
 * Resposta: `200 { cleared: true, cleared_at }`, ou
 * `200 { cleared: false }` quando não havia pendência (clique duplo, ou
 * a limpeza automática chegou antes).
 *
 * Flag desligado → 404 para todo papel. Mensagens em inglês.
 *
 * Pendência (Q-7): registrar a ação em `account_activity_log` (SPEC 075)
 * exige ação nova no catálogo fechado `ACTIVITY_CATALOG` e as chaves de
 * texto do feed (i18n) — escopo da F5, não desta rota.
 */

import { NextResponse } from 'next/server';

import {
  ForbiddenError,
  requireRole,
  toErrorResponse,
} from '@/lib/auth/account';
import { isUuid } from '@/lib/api/uuid';
import { canEditSettings } from '@/lib/auth/roles';
import {
  RATE_LIMITS,
  checkRateLimit,
  rateLimitResponse,
} from '@/lib/rate-limit';
import { supabaseAdmin } from '@/lib/supabase/admin';
import {
  acknowledgePayment,
  isBillingMonitorEnabled,
} from '@/lib/whatsapp/billing-server';

export async function POST(request: Request) {
  try {
    const { supabase, userId, accountId, role } = await requireRole('viewer');

    const admin = supabaseAdmin();
    if (!(await isBillingMonitorEnabled(admin))) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }

    if (!canEditSettings(role)) {
      throw new ForbiddenError(
        "This action requires the 'admin' role or higher"
      );
    }

    const limit = checkRateLimit(
      `billing-ack:${userId}`,
      RATE_LIMITS.adminAction
    );
    if (!limit.success) return rateLimitResponse(limit);

    let channelId: unknown;
    try {
      channelId = ((await request.json()) as { channel_id?: unknown })
        ?.channel_id;
    } catch {
      channelId = undefined;
    }
    if (typeof channelId !== 'string' || !isUuid(channelId.trim())) {
      return NextResponse.json(
        { error: 'channel_id must be a valid UUID' },
        { status: 400 }
      );
    }

    const result = await acknowledgePayment(
      supabase,
      accountId,
      channelId.trim(),
      { userId, admin }
    );

    if (result.status === 'not_found') {
      return NextResponse.json({ error: 'Channel not found' }, { status: 404 });
    }
    if (!result.cleared) {
      return NextResponse.json({ cleared: false }, { status: 200 });
    }
    return NextResponse.json(
      { cleared: true, cleared_at: result.clearedAt },
      { status: 200 }
    );
  } catch (err) {
    return toErrorResponse(err);
  }
}
