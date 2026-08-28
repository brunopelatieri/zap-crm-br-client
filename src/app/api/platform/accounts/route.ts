// ============================================================
// GET /api/platform/accounts — SPEC 062 §6, §7.2
//
//   Lista paginada + filtros (`q`, `plan`, `status`, `blocked`,
//   `expiringInDays`, `expired`, `overage`) — a consulta agregada por
//   trás de `/admin/accounts`. `service_role`, atrás de
//   `requirePlatformOwner()` — 404 para qualquer chamador não
//   autorizado (§2.4), nunca 401/403.
// ============================================================

import { NextResponse } from 'next/server';

import { requirePlatformOwner } from '@/lib/platform/owner';
import { listAccounts } from '@/lib/platform/accounts';
import type { AccountPlanStatus } from '@/lib/plans/types';
import { supabaseAdmin } from '@/lib/supabase/admin';

const NOT_FOUND = NextResponse.json({ error: 'Not found' }, { status: 404 });

const VALID_STATUSES = new Set<AccountPlanStatus>([
  'trialing',
  'active',
  'past_due',
  'suspended',
  'canceled',
]);

export async function GET(request: Request) {
  try {
    await requirePlatformOwner();
  } catch {
    return NOT_FOUND;
  }

  const url = new URL(request.url);
  const params = url.searchParams;

  const status = params.get('status');
  if (status !== null && !VALID_STATUSES.has(status as AccountPlanStatus)) {
    return NextResponse.json({ error: 'Invalid status' }, { status: 400 });
  }

  const page = Number(params.get('page') ?? '1');
  const pageSize = Number(params.get('pageSize') ?? '25');

  try {
    const result = await listAccounts(supabaseAdmin(), {
      q: params.get('q') ?? undefined,
      planCode: params.get('plan') ?? undefined,
      status: (status as AccountPlanStatus) ?? undefined,
      blocked:
        params.get('blocked') === 'true'
          ? true
          : params.get('blocked') === 'false'
            ? false
            : undefined,
      expiringInDays: params.has('expiringInDays')
        ? Number(params.get('expiringInDays'))
        : undefined,
      expired: params.get('expired') === 'true',
      overage: params.get('overage') === 'true',
      page: Number.isFinite(page) && page > 0 ? page : 1,
      pageSize:
        Number.isFinite(pageSize) && pageSize > 0
          ? Math.min(pageSize, 100)
          : 25,
    });
    return NextResponse.json(result);
  } catch (err) {
    console.error('[GET /api/platform/accounts] listAccounts error:', err);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
