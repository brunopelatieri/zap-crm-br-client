// ============================================================
// GET /api/platform/summary — SPEC 062 §6, §7.1
//
//   Números da visão geral do console: contas ativas, bloqueadas,
//   vencendo em 7 dias, vencidas, solicitações abertas e contas em
//   overage. É também a rota que `<RequirePlatformOwner>` usa no
//   cliente para o segundo gate (§7) — qualquer chamador não
//   autorizado recebe 404, nunca 401/403/503 (§2.4): a existência do
//   console não pode ser inferida pelo código de status.
//
//   `service_role`: o console lê ALÉM da própria conta por definição
//   (§1) — nunca RLS com `is_platform_owner()`.
//
// Simplificação desta fase (F3): "contas em overage" considera só a
// quota `contacts`, a única persistida em `account_usage_counters`
// hoje (067). As demais quotas (membros, canais) são computadas ao
// vivo por conta em `getAccountPlan` — refazer isso para TODAS as
// contas nesta rota seria uma consulta por conta, exatamente o que
// §7.2 proíbe. O detalhe por conta (F4) usa os números reais.
// ============================================================

import { NextResponse } from 'next/server';

import { requirePlatformOwner } from '@/lib/platform/owner';
import {
  computePlatformSummary,
  type AccountSummaryRow,
} from '@/lib/platform/summary';
import type { AccountPlanStatus } from '@/lib/plans/types';
import { supabaseAdmin } from '@/lib/supabase/admin';

const NOT_FOUND = NextResponse.json({ error: 'Not found' }, { status: 404 });

export async function GET() {
  try {
    await requirePlatformOwner();
  } catch {
    return NOT_FOUND;
  }

  const db = supabaseAdmin();

  const [
    { data: rows, error: rowsErr },
    { count: pendingCount },
    { data: settingsRow },
  ] = await Promise.all([
    db
      .from('account_plans')
      .select(
        'account_id, status, current_period_end, accounts:account_id (blocked_at), plans:plan_id (limits)'
      ),
    db
      .from('plan_change_requests')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'pending'),
    db.from('platform_settings').select('quotas_enforced').maybeSingle(),
  ]);

  if (rowsErr) {
    console.error(
      '[GET /api/platform/summary] account_plans fetch error:',
      rowsErr
    );
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }

  const quotasEnforced = settingsRow?.quotas_enforced ?? false;
  const accountIds = (rows ?? []).map((r) => r.account_id);

  const { data: counters } = await db
    .from('account_usage_counters')
    .select('account_id, value')
    .eq('metric', 'contacts')
    .in(
      'account_id',
      // `in()` com array vazio gera SQL inválido em algumas versões do
      // client — placeholder inofensivo (nenhuma conta real usa este
      // uuid) quando não há contas.
      accountIds.length > 0
        ? accountIds
        : ['00000000-0000-0000-0000-000000000000']
    );

  const usedByAccount = new Map<string, number>(
    (counters ?? []).map((c) => [c.account_id as string, c.value as number])
  );

  const summaryRows: AccountSummaryRow[] = (rows ?? []).map((row) => {
    const account = row.accounts as unknown as {
      blocked_at: string | null;
    } | null;
    const plan = row.plans as unknown as {
      limits: Record<string, number>;
    } | null;
    const contactsLimit = plan?.limits?.contacts;
    const used = usedByAccount.get(row.account_id as string) ?? 0;
    const isOverage =
      quotasEnforced &&
      typeof contactsLimit === 'number' &&
      used > contactsLimit;

    return {
      accountId: row.account_id as string,
      blockedAt: account?.blocked_at ?? null,
      status: row.status as AccountPlanStatus,
      currentPeriodEnd: row.current_period_end as string | null,
      isOverage,
    };
  });

  const summary = computePlatformSummary(
    summaryRows,
    pendingCount ?? 0,
    new Date()
  );

  return NextResponse.json({ quotasEnforced, summary });
}
