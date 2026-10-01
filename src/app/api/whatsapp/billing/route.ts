/**
 * GET /api/whatsapp/billing[?channel_id={uuid}[&refresh=1]]
 *
 * Monitor de status de envio e consumo estimado do WhatsApp Cloud API
 * (SPEC 076 §9.1, §9.2). A rota só orquestra: autenticação, flag, papel e
 * limite de taxa. A regra — TTL, recuo, single-flight, DTO por papel —
 * mora em `lib/whatsapp/billing-server.ts` (RNF-08).
 *
 * Contrato
 *
 *   - Flag `whatsapp_billing_monitor_enabled` desligado → 404 para todo
 *     papel (D-10).
 *   - Sem `channel_id`: resumo de todos os canais Cloud, lido só do banco
 *     (a lista nunca espera a Meta; o que venceu é atualizado em `after()`).
 *   - Com `channel_id`: o painel de UM número. UUID inválido → 400; canal
 *     de outra conta, de outro tipo ou `disabled` → 404.
 *   - `refresh=1` só admin+ (403), 6/min por usuário e 1 leitura forçada
 *     por WABA a cada 60 s → 429 com `retry_after_seconds`.
 *   - Falha da Meta NÃO vira 5xx: 200 com o último retrato, `stale` e
 *     `error`. 500 só para erro interno não tratado.
 *
 * Mensagens de erro em inglês (`/api/**` é para integração; a UI traduz).
 */

import { NextResponse } from 'next/server';

import {
  ForbiddenError,
  requireRole,
  toErrorResponse,
} from '@/lib/auth/account';
import { canEditSettings } from '@/lib/auth/roles';
import {
  RATE_LIMITS,
  checkRateLimit,
  type RateLimitResult,
} from '@/lib/rate-limit';
import { supabaseAdmin } from '@/lib/supabase/admin';
import {
  isBillingMonitorEnabled,
  loadBillingSummary,
  loadChannelBilling,
} from '@/lib/whatsapp/billing-server';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function tooManyRefreshes(retryAfterSeconds: number): NextResponse {
  return NextResponse.json(
    {
      error: 'Too many refresh requests',
      retry_after_seconds: retryAfterSeconds,
    },
    { status: 429, headers: { 'Retry-After': String(retryAfterSeconds) } }
  );
}

function retryAfterFromLimit(limit: RateLimitResult): number {
  return Math.max(1, Math.ceil((limit.reset - Date.now()) / 1000));
}

export async function GET(request: Request) {
  try {
    // `viewer` também abre a aba (em leitura): o piso é a associação à
    // conta. O que é só de admin+ (consumo, `refresh`) o DTO e o `if`
    // abaixo decidem.
    const { supabase, userId, accountId, role } = await requireRole('viewer');

    const admin = supabaseAdmin();
    if (!(await isBillingMonitorEnabled(admin))) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }

    const params = new URL(request.url).searchParams;
    // `?channel_id=` vazio é ausência (mesmo cuidado de config/route.ts).
    const channelId = params.get('channel_id')?.trim() || null;

    if (!channelId) {
      const summary = await loadBillingSummary(supabase, accountId, {
        role,
        admin,
      });
      return NextResponse.json(summary, { status: 200 });
    }

    if (!UUID_RE.test(channelId)) {
      return NextResponse.json(
        { error: 'channel_id must be a valid UUID' },
        { status: 400 }
      );
    }

    const force = params.get('refresh') === '1';
    if (force) {
      // O papel antes do limite: um agente recusado não gasta o balde
      // de ninguém.
      if (!canEditSettings(role)) {
        throw new ForbiddenError(
          "This action requires the 'admin' role or higher"
        );
      }
      const limit = checkRateLimit(
        `billing-refresh:${userId}`,
        RATE_LIMITS.billingRefresh
      );
      if (!limit.success) {
        return tooManyRefreshes(retryAfterFromLimit(limit));
      }
    }

    const result = await loadChannelBilling(supabase, accountId, channelId, {
      force,
      role,
      admin,
    });

    if (result.status === 'not_found') {
      return NextResponse.json({ error: 'Channel not found' }, { status: 404 });
    }
    if (result.status === 'throttled') {
      return tooManyRefreshes(result.retryAfterSeconds);
    }
    return NextResponse.json(result.dto, { status: 200 });
  } catch (err) {
    return toErrorResponse(err);
  }
}
