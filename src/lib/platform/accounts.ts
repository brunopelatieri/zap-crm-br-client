/**
 * Leitura de contas para o console (SPEC 062 §5.2, §7.2, §7.3).
 *
 * Server-only, `service_role` — o console lê ALÉM da própria conta por
 * definição (§1). NUNCA use isto atrás de RLS: `listAccounts`/
 * `getAccountDetail` recebem `db` já resolvido como `supabaseAdmin()`
 * pelo chamador (rota `/api/platform/**`, já atrás de
 * `requirePlatformOwner()`).
 *
 * `listAccounts`: uma ida ao banco por BLOCO de contas (paginado em
 * 25), nunca uma consulta por conta dentro de um laço (§7.2) — a
 * consulta principal traz `account_plans` com `accounts`/`plans`
 * embutidos (FK estável desde a 067; embeds evitados em outros
 * módulos deste repo só quando a FK é recente o bastante para o cache
 * de schema do PostgREST não ter assentado ainda — não é o caso aqui).
 * Duas idas EXTRA, também em bloco (não por conta): contagem de
 * membros e uso de contatos para as 25 contas da página.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

import type { AccountPlanStatus } from '@/lib/plans/types';

export interface AccountListFilters {
  /** Busca por nome da conta (ILIKE). */
  q?: string;
  planCode?: string;
  status?: AccountPlanStatus;
  blocked?: boolean;
  /** Vence dentro de N dias, ainda não vencida (borda inclusiva, igual a `summary.ts`). */
  expiringInDays?: number;
  expired?: boolean;
  /**
   * Simplificação desta fase: overage é calculado só sobre a quota
   * `contacts` (a única persistida em `account_usage_counters`) e,
   * quando ativo, o filtro NÃO usa a paginação do banco — busca um
   * bloco maior (capado) e pagina em memória. Poucas contas ficam em
   * overage na prática; um filtro exato por todas as quotas exigiria
   * uma function no banco, fora do escopo desta fase (F4).
   */
  overage?: boolean;
  /** 1-based. */
  page?: number;
  pageSize?: number;
}

export interface AccountListItem {
  accountId: string;
  accountName: string;
  blockedAt: string | null;
  planCode: string;
  planName: string;
  billingCycle: 'monthly' | 'yearly';
  status: AccountPlanStatus;
  currentPeriodEnd: string | null;
  membersCount: number;
  contactsUsed: number;
  contactsLimit: number | null;
}

export interface AccountListResult {
  items: AccountListItem[];
  total: number;
  page: number;
  pageSize: number;
}

const DEFAULT_PAGE_SIZE = 25;
/** Teto do modo "overage" (ver `AccountListFilters.overage`). */
const OVERAGE_SCAN_CAP = 500;

interface AccountPlanEmbedRow {
  account_id: string;
  status: AccountPlanStatus;
  current_period_end: string | null;
  billing_cycle: 'monthly' | 'yearly';
  accounts: { id: string; name: string; blocked_at: string | null } | null;
  plans: { code: string; name: string; limits: Record<string, number> } | null;
}

async function fetchMembersCounts(
  db: SupabaseClient,
  accountIds: string[]
): Promise<Map<string, number>> {
  if (accountIds.length === 0) return new Map();
  const { data } = await db
    .from('profiles')
    .select('account_id')
    .in('account_id', accountIds);
  const counts = new Map<string, number>();
  for (const row of data ?? []) {
    const id = row.account_id as string;
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return counts;
}

async function fetchContactsUsage(
  db: SupabaseClient,
  accountIds: string[]
): Promise<Map<string, number>> {
  if (accountIds.length === 0) return new Map();
  const { data } = await db
    .from('account_usage_counters')
    .select('account_id, value')
    .eq('metric', 'contacts')
    .in('account_id', accountIds);
  return new Map(
    (data ?? []).map((r) => [r.account_id as string, r.value as number])
  );
}

function toListItem(
  row: AccountPlanEmbedRow,
  membersCount: number,
  contactsUsed: number
): AccountListItem {
  return {
    accountId: row.account_id,
    accountName: row.accounts?.name ?? '',
    blockedAt: row.accounts?.blocked_at ?? null,
    planCode: row.plans?.code ?? '',
    planName: row.plans?.name ?? '',
    billingCycle: row.billing_cycle,
    status: row.status,
    currentPeriodEnd: row.current_period_end,
    membersCount,
    contactsUsed,
    contactsLimit:
      typeof row.plans?.limits?.contacts === 'number'
        ? row.plans.limits.contacts
        : null,
  };
}

export async function listAccounts(
  db: SupabaseClient,
  filters: AccountListFilters
): Promise<AccountListResult> {
  const page = Math.max(1, filters.page ?? 1);
  const pageSize = filters.pageSize ?? DEFAULT_PAGE_SIZE;
  const now = new Date();

  let query = db
    .from('account_plans')
    .select(
      'account_id, status, current_period_end, billing_cycle, accounts:account_id!inner (id, name, blocked_at), plans:plan_id!inner (code, name, limits)',
      { count: 'exact' }
    );

  if (filters.status) query = query.eq('status', filters.status);
  if (filters.blocked === true) {
    query = query.not('accounts.blocked_at', 'is', null);
  } else if (filters.blocked === false) {
    query = query.is('accounts.blocked_at', null);
  }
  if (filters.planCode) query = query.eq('plans.code', filters.planCode);
  if (filters.q) query = query.ilike('accounts.name', `%${filters.q}%`);
  if (filters.expired) {
    query = query.lt('current_period_end', now.toISOString());
  } else if (filters.expiringInDays !== undefined) {
    const windowEnd = new Date(
      now.getTime() + filters.expiringInDays * 24 * 60 * 60 * 1000
    );
    query = query
      .gte('current_period_end', now.toISOString())
      .lte('current_period_end', windowEnd.toISOString());
  }

  query = query.order('created_at', { ascending: false });

  const usingOverageScan = filters.overage === true;
  if (usingOverageScan) {
    query = query.range(0, OVERAGE_SCAN_CAP - 1);
  } else {
    const from = (page - 1) * pageSize;
    query = query.range(from, from + pageSize - 1);
  }

  const { data, error, count } = await query;
  if (error) {
    throw new Error(
      `[listAccounts] account_plans fetch error: ${error.message}`
    );
  }

  const rows = (data ?? []) as unknown as AccountPlanEmbedRow[];
  const accountIds = rows.map((r) => r.account_id);
  const [membersCounts, contactsUsage] = await Promise.all([
    fetchMembersCounts(db, accountIds),
    fetchContactsUsage(db, accountIds),
  ]);

  let items = rows.map((row) =>
    toListItem(
      row,
      membersCounts.get(row.account_id) ?? 0,
      contactsUsage.get(row.account_id) ?? 0
    )
  );

  if (usingOverageScan) {
    items = items.filter(
      (item) =>
        item.contactsLimit !== null && item.contactsUsed > item.contactsLimit
    );
    const total = items.length;
    const from = (page - 1) * pageSize;
    items = items.slice(from, from + pageSize);
    return { items, total, page, pageSize };
  }

  return { items, total: count ?? items.length, page, pageSize };
}

// ------------------------------------------------------------
// Detalhe de uma conta (§7.3)
// ------------------------------------------------------------

export interface AccountMember {
  userId: string;
  fullName: string | null;
  email: string;
  role: 'owner' | 'admin' | 'agent' | 'viewer';
  blockedAt: string | null;
}

export interface AccountDetail {
  accountId: string;
  accountName: string;
  createdAt: string;
  blockedAt: string | null;
  blockedReason: string | null;
  planCode: string;
  planName: string;
  status: AccountPlanStatus;
  billingCycle: 'monthly' | 'yearly';
  startedAt: string;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  graceUntil: string | null;
  members: AccountMember[];
}

export async function getAccountDetail(
  db: SupabaseClient,
  accountId: string
): Promise<AccountDetail | null> {
  const [{ data: accountRow }, { data: planRow }, { data: memberRows }] =
    await Promise.all([
      db
        .from('accounts')
        .select('id, name, created_at, blocked_at, blocked_reason')
        .eq('id', accountId)
        .maybeSingle(),
      db
        .from('account_plans')
        .select(
          'status, billing_cycle, started_at, current_period_end, cancel_at_period_end, grace_until, plans:plan_id (code, name)'
        )
        .eq('account_id', accountId)
        .maybeSingle(),
      db
        .from('profiles')
        .select('user_id, full_name, email, account_role, blocked_at')
        .eq('account_id', accountId)
        .order('account_role', { ascending: false }),
    ]);

  if (!accountRow || !planRow) return null;

  const plan = planRow.plans as unknown as {
    code: string;
    name: string;
  } | null;

  return {
    accountId: accountRow.id,
    accountName: accountRow.name,
    createdAt: accountRow.created_at,
    blockedAt: accountRow.blocked_at,
    blockedReason: accountRow.blocked_reason,
    planCode: plan?.code ?? '',
    planName: plan?.name ?? '',
    status: planRow.status,
    billingCycle: planRow.billing_cycle,
    startedAt: planRow.started_at,
    currentPeriodEnd: planRow.current_period_end,
    cancelAtPeriodEnd: planRow.cancel_at_period_end,
    graceUntil: planRow.grace_until,
    members: (memberRows ?? []).map((m) => ({
      userId: m.user_id as string,
      fullName: m.full_name as string | null,
      email: m.email as string,
      role: m.account_role as AccountMember['role'],
      blockedAt: m.blocked_at as string | null,
    })),
  };
}
