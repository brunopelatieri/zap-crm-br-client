import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { getAccountDetail, listAccounts } from './accounts';

// ------------------------------------------------------------
// getAccountDetail
// ------------------------------------------------------------

function makeDetailDb(rows: {
  account?: Record<string, unknown> | null;
  plan?: Record<string, unknown> | null;
  members?: Record<string, unknown>[];
}) {
  const client = {
    from(table: string) {
      if (table === 'accounts') {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: () =>
                Promise.resolve({ data: rows.account ?? null, error: null }),
            }),
          }),
        };
      }
      if (table === 'account_plans') {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: () =>
                Promise.resolve({ data: rows.plan ?? null, error: null }),
            }),
          }),
        };
      }
      if (table === 'profiles') {
        return {
          select: () => ({
            eq: () => ({
              order: () =>
                Promise.resolve({ data: rows.members ?? [], error: null }),
            }),
          }),
        };
      }
      throw new Error(`tabela inesperada no mock: ${table}`);
    },
  };
  return client as unknown as SupabaseClient;
}

const ACCOUNT_ROW = {
  id: 'acct-1',
  name: 'Acme',
  created_at: '2026-01-01T00:00:00Z',
  blocked_at: null,
  blocked_reason: null,
};

const PLAN_ROW = {
  status: 'active',
  billing_cycle: 'monthly',
  started_at: '2026-01-01T00:00:00Z',
  current_period_end: '2026-09-01T00:00:00Z',
  cancel_at_period_end: false,
  grace_until: null,
  plans: { code: 'professional', name: 'Profissional' },
};

describe('getAccountDetail', () => {
  it('devolve null quando a conta não existe', async () => {
    const db = makeDetailDb({ account: null, plan: PLAN_ROW });
    expect(await getAccountDetail(db, 'acct-1')).toBeNull();
  });

  it('devolve null quando a conta não tem account_plans (invariante da 067 quebrada)', async () => {
    const db = makeDetailDb({ account: ACCOUNT_ROW, plan: null });
    expect(await getAccountDetail(db, 'acct-1')).toBeNull();
  });

  it('monta o detalhe completo, mapeando plano embutido e membros', async () => {
    const db = makeDetailDb({
      account: ACCOUNT_ROW,
      plan: PLAN_ROW,
      members: [
        {
          user_id: 'u1',
          full_name: 'Ana',
          email: 'ana@acme.com',
          account_role: 'owner',
          blocked_at: null,
        },
        {
          user_id: 'u2',
          full_name: null,
          email: 'carlos@acme.com',
          account_role: 'agent',
          blocked_at: '2026-08-01T00:00:00Z',
        },
      ],
    });
    const result = await getAccountDetail(db, 'acct-1');
    expect(result).toEqual({
      accountId: 'acct-1',
      accountName: 'Acme',
      createdAt: '2026-01-01T00:00:00Z',
      blockedAt: null,
      blockedReason: null,
      planCode: 'professional',
      planName: 'Profissional',
      status: 'active',
      billingCycle: 'monthly',
      startedAt: '2026-01-01T00:00:00Z',
      currentPeriodEnd: '2026-09-01T00:00:00Z',
      cancelAtPeriodEnd: false,
      graceUntil: null,
      members: [
        {
          userId: 'u1',
          fullName: 'Ana',
          email: 'ana@acme.com',
          role: 'owner',
          blockedAt: null,
        },
        {
          userId: 'u2',
          fullName: null,
          email: 'carlos@acme.com',
          role: 'agent',
          blockedAt: '2026-08-01T00:00:00Z',
        },
      ],
    });
  });
});

// ------------------------------------------------------------
// listAccounts
// ------------------------------------------------------------

/**
 * Builder encadeável genérico: engole todo método de filtro
 * (`eq`/`not`/`is`/`ilike`/`lt`/`gte`/`lte`/`order`/`range`) e resolve
 * com o resultado fixo quando `await`ado — `listAccounts` reatribui
 * `query` várias vezes conforme os filtros ativos e só dá `await`
 * direto no final, sem chamar um verbo terminal.
 */
function chainable(result: unknown) {
  const c: Record<string, unknown> = {
    eq: () => c,
    not: () => c,
    is: () => c,
    ilike: () => c,
    lt: () => c,
    gte: () => c,
    lte: () => c,
    order: () => c,
    range: () => c,
    then: (
      resolve: (v: unknown) => unknown,
      reject?: (e: unknown) => unknown
    ) => Promise.resolve(result).then(resolve, reject),
  };
  return c;
}

function makeListDb(opts: {
  accountPlanRows: Record<string, unknown>[];
  count?: number;
  memberCountRows?: { account_id: string }[];
  usageRows?: { account_id: string; value: number }[];
}) {
  const client = {
    from(table: string) {
      if (table === 'account_plans') {
        return {
          select: () =>
            chainable({
              data: opts.accountPlanRows,
              error: null,
              count: opts.count ?? opts.accountPlanRows.length,
            }),
        };
      }
      if (table === 'profiles') {
        return {
          select: () => ({
            in: () =>
              Promise.resolve({
                data: opts.memberCountRows ?? [],
                error: null,
              }),
          }),
        };
      }
      if (table === 'account_usage_counters') {
        return {
          select: () => ({
            eq: () => ({
              in: () =>
                Promise.resolve({ data: opts.usageRows ?? [], error: null }),
            }),
          }),
        };
      }
      throw new Error(`tabela inesperada no mock: ${table}`);
    },
  };
  return client as unknown as SupabaseClient;
}

function embedRow(over: Partial<Record<string, unknown>> = {}) {
  return {
    account_id: 'acct-1',
    status: 'active',
    current_period_end: '2026-09-01T00:00:00Z',
    billing_cycle: 'monthly',
    accounts: { id: 'acct-1', name: 'Acme', blocked_at: null },
    plans: {
      code: 'professional',
      name: 'Profissional',
      limits: { contacts: 100 },
    },
    ...over,
  };
}

describe('listAccounts', () => {
  it('mapeia linhas + contagem de membros + uso de contatos em bloco', async () => {
    const db = makeListDb({
      accountPlanRows: [embedRow()],
      count: 1,
      memberCountRows: [{ account_id: 'acct-1' }, { account_id: 'acct-1' }],
      usageRows: [{ account_id: 'acct-1', value: 42 }],
    });
    const result = await listAccounts(db, {});
    expect(result).toEqual({
      items: [
        {
          accountId: 'acct-1',
          accountName: 'Acme',
          blockedAt: null,
          planCode: 'professional',
          planName: 'Profissional',
          billingCycle: 'monthly',
          status: 'active',
          currentPeriodEnd: '2026-09-01T00:00:00Z',
          membersCount: 2,
          contactsUsed: 42,
          contactsLimit: 100,
        },
      ],
      total: 1,
      page: 1,
      pageSize: 25,
    });
  });

  // Achado de code review (ausência de teste): a §7.2 documenta esta
  // simplificação explicitamente como "F4, fora do escopo exato" — só
  // a quota `contacts` entra no filtro `overage`, e a paginação vira
  // EM MEMÓRIA em vez de no banco. Sem teste, uma alteração futura
  // podia trocar `>` por `>=` (incluindo contas exatamente no limite,
  // que não estão em overage) sem que nada acusasse.
  it('overage=true: filtra em memória só por contactsUsed > contactsLimit (SPEC 062 §7.2, simplificação F4)', async () => {
    const db = makeListDb({
      accountPlanRows: [
        embedRow({
          account_id: 'acct-over',
          plans: { code: 'p', name: 'P', limits: { contacts: 10 } },
        }),
        embedRow({
          account_id: 'acct-at-limit',
          plans: { code: 'p', name: 'P', limits: { contacts: 10 } },
        }),
        embedRow({
          account_id: 'acct-unlimited',
          plans: { code: 'p', name: 'P', limits: {} },
        }),
      ],
      memberCountRows: [],
      usageRows: [
        { account_id: 'acct-over', value: 11 },
        { account_id: 'acct-at-limit', value: 10 },
        { account_id: 'acct-unlimited', value: 999 },
      ],
    });
    const result = await listAccounts(db, { overage: true });
    expect(result.items.map((i) => i.accountId)).toEqual(['acct-over']);
    expect(result.total).toBe(1);
  });

  it('overage=true: total é o FILTRADO, não a contagem do bloco bruto lido do banco', async () => {
    // 5 contas no bloco bruto (é o que `count: 'exact'` devolveria),
    // só 3 realmente em overage — se `total` viesse do `count` bruto em
    // vez de `items.length` pós-filtro, este teste pegaria a regressão.
    const rows = Array.from({ length: 5 }, (_, i) =>
      embedRow({
        account_id: `acct-${i}`,
        plans: { code: 'p', name: 'P', limits: { contacts: 10 } },
      })
    );
    const db = makeListDb({
      accountPlanRows: rows,
      count: 5,
      usageRows: rows.map((r, i) => ({
        account_id: r.account_id as string,
        value: i < 3 ? 20 : 5, // só as 3 primeiras estouram o limite de 10
      })),
    });
    const result = await listAccounts(db, { overage: true, pageSize: 2 });
    expect(result.total).toBe(3);
    expect(result.items).toHaveLength(2); // paginado em memória, página 1 de tamanho 2
    expect(result.items.map((i) => i.accountId)).toEqual(['acct-0', 'acct-1']);
  });
});
