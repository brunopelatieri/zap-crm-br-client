// ============================================================
// GET /api/account/activity — SPEC 075 F5
//
//   Lê `account_activity_log` (SPEC 075) com os cinco filtros da
//   página `/activity` e do widget "Atividade recente". Segue o molde
//   de `/api/account/webhook-logs` (SPEC 055): cliente de SESSÃO (RLS
//   ligada — a policy `account_activity_log_select` (084) é a
//   AUTORIDADE; o guarda de papel aqui é a segunda tranca, não a
//   primeira), mensagens de erro em INGLÊS (padrão de `/api/**`).
//
//   Guarda de papel (D-5): `admin`. Isto é intencionalmente MAIS
//   estrito que a RLS — a RLS já deixa um `agent` ler as PRÓPRIAS
//   linhas (para o widget do dashboard, que não passa por esta rota),
//   mas a PÁGINA `/activity` é só para quem pode ver a conta inteira.
//   Um `agent` chamando esta rota direto recebe 403 mesmo que a RLS
//   deixasse ele ver algo — defesa em profundidade, mesma postura de
//   `webhook-logs`.
// ============================================================

import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { queryActivity, type ActivityFilters } from '@/lib/activity/query';
import {
  ACTIVITY_CATALOG,
  type ActivityResourceType,
} from '@/lib/activity/types';

const VALID_RESOURCE_TYPES = new Set<string>(Object.keys(ACTIVITY_CATALOG));

function parseCsvParam(value: string | null): string[] | undefined {
  if (!value) return undefined;
  const parts = value
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
  return parts.length > 0 ? parts : undefined;
}

export async function GET(request: Request) {
  try {
    const ctx = await requireRole('admin');

    const url = new URL(request.url);
    const resourceTypesRaw = parseCsvParam(
      url.searchParams.get('resource_type')
    );
    if (resourceTypesRaw?.some((t) => !VALID_RESOURCE_TYPES.has(t))) {
      return NextResponse.json(
        { error: 'resource_type contains an unknown value' },
        { status: 400 }
      );
    }

    const filters: ActivityFilters = {
      from: url.searchParams.get('from'),
      to: url.searchParams.get('to'),
      timeZone: url.searchParams.get('time_zone') ?? undefined,
      actorUserId: url.searchParams.get('actor_user_id'),
      resourceTypes: resourceTypesRaw as ActivityResourceType[] | undefined,
      channelIds: parseCsvParam(url.searchParams.get('channel_id')),
      search: url.searchParams.get('search') ?? undefined,
      cursor: url.searchParams.get('cursor'),
      limit: Number(url.searchParams.get('limit')) || undefined,
    };

    const result = await queryActivity(ctx.supabase, ctx.accountId, filters);

    if ('error' in result) {
      const status = 400;
      const message =
        result.error === 'invalid_time_zone'
          ? "'time_zone' is not a valid IANA time zone"
          : `'${result.field}' is not a valid date`;
      return NextResponse.json(
        { error: message, code: result.error },
        { status }
      );
    }

    return NextResponse.json({
      items: result.items,
      next_cursor: result.nextCursor,
      hidden_by_channel_filter: result.hiddenByChannelFilter,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
