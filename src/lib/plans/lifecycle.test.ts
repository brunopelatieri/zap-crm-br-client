import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

vi.mock('@/lib/webhooks/deliver', () => ({
  dispatchWebhookEvent: vi.fn().mockResolvedValue(undefined),
}));
// Achado de code review: os 4 pontos de emissão para a outbox do
// proprietário (SPEC 063) não tinham NENHUMA asserção — um refactor que
// renomeasse um campo dentro de `data.plan` (ex.: `periodEnd`) quebraria
// a chave de dedupe em silêncio, sem nenhum teste para pegar. Mockado
// (não a tabela `system_notifications` real) porque o que importa aqui
// é o CONTRATO com `emitSystemEvent` (tipo + campos de `data.plan`), não
// o mecanismo de outbox em si — esse já tem seu próprio teste em
// `emit.test.ts`/`dedupe.test.ts`.
vi.mock('@/lib/notifications/emit', () => ({
  emitSystemEvent: vi.fn().mockResolvedValue(undefined),
}));

import { dispatchWebhookEvent } from '@/lib/webhooks/deliver';
import { emitSystemEvent } from '@/lib/notifications/emit';
import { runPlanLifecycle } from './lifecycle';

const SETTINGS = { default_plan_code: 'unlimited', grace_days: 7 };
const DEFAULT_PLAN = {
  id: 'plan-unlimited',
  code: 'unlimited',
  billing_period: 'none',
  price_cents: 0,
};

interface Options {
  accountPlanRows: Record<string, unknown>[];
  /**
   * `dedupeKey`s que a leitura EM BLOCO de `platform_audit_log` (achado
   * de code review — uma consulta para todas as contas da corrida, não
   * uma por conta) já devolveria como existentes.
   */
  existingDedupeKeys?: string[];
  /**
   * `false` simula o `UPDATE ... WHERE current_period_end = <lido>`
   * (SPEC 078 §3.3) não casando linha nenhuma — alguém moveu o
   * vencimento depois da leitura do lote.
   */
  updateAffectsRows?: boolean;
}

/**
 * Mock por tabela — cada `.from(table)` devolve uma cadeia própria,
 * porque `account_plans` precisa responder `select` (a lista) e
 * `update` (por conta) de formas diferentes na MESMA corrida.
 */
function makeDb({
  accountPlanRows,
  existingDedupeKeys = [],
  updateAffectsRows = true,
}: Options) {
  const updates: { table: string; payload: Record<string, unknown> }[] = [];
  /** Filtros `.eq(coluna, valor)` de cada UPDATE em `account_plans`. */
  const updateFilters: [string, unknown][][] = [];
  const inserts: { table: string; payload: Record<string, unknown> }[] = [];
  /** Toda tabela tocada, na ordem — usado para provar que
   *  `platform_audit_log` é lida em BLOCO (uma vez), não uma vez por
   *  conta dentro do laço. */
  const fromCalls: string[] = [];

  function chain(result: unknown) {
    const c: Record<string, unknown> = {
      select: () => c,
      eq: () => c,
      in: () => c,
      not: () => c,
      order: () => c,
      range: () => c,
      gte: () => c,
      limit: () => c,
      maybeSingle: () => Promise.resolve(result),
      then: (resolve: (v: unknown) => unknown) =>
        Promise.resolve(result).then(resolve),
    };
    return c;
  }

  const client = {
    from(table: string) {
      fromCalls.push(table);
      if (table === 'platform_settings') {
        return chain({ data: SETTINGS, error: null });
      }
      if (table === 'plans') {
        return chain({ data: DEFAULT_PLAN, error: null });
      }
      if (table === 'account_plans') {
        return {
          select: () => chain({ data: accountPlanRows, error: null }),
          update: (payload: Record<string, unknown>) => {
            updates.push({ table, payload });
            const filters: [string, unknown][] = [];
            updateFilters.push(filters);
            const c = {
              eq: (column: string, value: unknown) => {
                filters.push([column, value]);
                return c;
              },
              select: () =>
                Promise.resolve({
                  data: updateAffectsRows ? [{ account_id: 'x' }] : [],
                  error: null,
                }),
            };
            return c;
          },
        };
      }
      if (table === 'account_plan_events') {
        return {
          insert: (payload: Record<string, unknown>) => {
            inserts.push({ table, payload });
            return Promise.resolve({ data: null, error: null });
          },
        };
      }
      if (table === 'platform_audit_log') {
        return {
          // `loadExistingNotices` lê `payload` de TODAS as linhas de uma
          // vez (`.in('account_id', ids)`), não uma consulta filtrada
          // por `dedupeKey` por chamada — o mock devolve a lista inteira
          // e o próprio código monta o `Set` a partir dela.
          select: () =>
            chain({
              data: existingDedupeKeys.map((dedupeKey) => ({
                payload: { dedupeKey },
              })),
              error: null,
            }),
          insert: (payload: Record<string, unknown>) => {
            inserts.push({ table, payload });
            return Promise.resolve({ data: null, error: null });
          },
        };
      }
      throw new Error(`tabela inesperada no mock: ${table}`);
    },
  };

  return {
    client: client as unknown as SupabaseClient,
    updates,
    updateFilters,
    inserts,
    fromCalls,
  };
}

const NOW = new Date('2026-08-27T12:00:00.000Z');

describe('runPlanLifecycle', () => {
  it('sem contas com vencimento: nada acontece, zero erro', async () => {
    const { client } = makeDb({ accountPlanRows: [] });
    const result = await runPlanLifecycle(NOW, client);
    expect(result).toEqual({
      accountsScanned: 0,
      expiringNotices: 0,
      expired: 0,
      canceledApplied: 0,
      graceEnded: 0,
      errors: 0,
    });
  });

  it('vencendo em 7 dias: emite aviso sem mudar status', async () => {
    const { client, updates, inserts } = makeDb({
      accountPlanRows: [
        {
          account_id: 'acct-1',
          plan_id: 'plan-pro',
          status: 'active',
          billing_cycle: 'monthly',
          current_period_end: '2026-09-03T12:00:00.000Z', // +7 dias
          cancel_at_period_end: false,
          grace_until: null,
          limit_overrides: {},
          plans: { code: 'professional' },
        },
      ],
    });
    const result = await runPlanLifecycle(NOW, client);
    expect(result.expiringNotices).toBe(1);
    expect(updates).toEqual([]); // nada mudou em account_plans
    expect(
      inserts.some(
        (i) =>
          i.table === 'platform_audit_log' &&
          i.payload.action === 'plan.lifecycle_notice'
      )
    ).toBe(true);
    expect(dispatchWebhookEvent).toHaveBeenCalledWith(
      client,
      'acct-1',
      'plan.expiring',
      expect.objectContaining({ daysUntil: 7 })
    );
    expect(emitSystemEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'plan.expiring',
        accountId: 'acct-1',
        data: {
          plan: {
            periodEnd: '2026-09-03T12:00:00.000Z',
            daysUntil: 7,
          },
        },
      }),
      client,
      NOW
    );
  });

  // Achado de code review: a dedupe consultava `platform_audit_log` uma
  // vez POR CONTA dentro do laço — o mesmo padrão de N+1 que
  // `sweep.ts`/`platform/accounts.ts` evitam em outro lugar do
  // repositório. Com N contas vencendo no mesmo dia, a leitura precisa
  // continuar sendo UMA só, batida em bloco antes do laço.
  it('lê platform_audit_log UMA VEZ para N contas, não uma vez por conta', async () => {
    const row = (accountId: string) => ({
      account_id: accountId,
      plan_id: 'plan-pro',
      status: 'active',
      billing_cycle: 'monthly',
      current_period_end: '2026-09-03T12:00:00.000Z', // +7 dias
      cancel_at_period_end: false,
      grace_until: null,
      limit_overrides: {},
      plans: { code: 'professional' },
    });
    const { client, fromCalls } = makeDb({
      accountPlanRows: [row('acct-1'), row('acct-2'), row('acct-3')],
    });
    const result = await runPlanLifecycle(NOW, client);

    expect(result.expiringNotices).toBe(3);
    // 1 leitura em bloco + 3 inserts (um aviso novo por conta) = 4
    // chamadas a `platform_audit_log` no total, nunca 3 leituras + 3
    // inserts (o padrão antigo, uma consulta por conta).
    const auditLogCalls = fromCalls.filter((t) => t === 'platform_audit_log');
    expect(auditLogCalls).toHaveLength(4);
  });

  it('vencendo, mas já avisado (dedupe): não emite de novo', async () => {
    const { client, inserts } = makeDb({
      accountPlanRows: [
        {
          account_id: 'acct-1',
          plan_id: 'plan-pro',
          status: 'active',
          billing_cycle: 'monthly',
          current_period_end: '2026-09-03T12:00:00.000Z',
          cancel_at_period_end: false,
          grace_until: null,
          limit_overrides: {},
          plans: { code: 'professional' },
        },
      ],
      existingDedupeKeys: ['plan.expiring:acct-1:2026-09-03T12:00:00.000Z:7'],
    });
    const result = await runPlanLifecycle(NOW, client);
    expect(result.expiringNotices).toBe(0);
    expect(inserts.some((i) => i.table === 'platform_audit_log')).toBe(false);
    expect(emitSystemEvent).not.toHaveBeenCalled();
  });

  it('vencido sem cancelamento agendado: vira past_due com carência, evento de status', async () => {
    const { client, updates, inserts } = makeDb({
      accountPlanRows: [
        {
          account_id: 'acct-1',
          plan_id: 'plan-pro',
          status: 'active',
          billing_cycle: 'monthly',
          current_period_end: '2026-08-20T12:00:00.000Z', // já passou
          cancel_at_period_end: false,
          grace_until: null,
          limit_overrides: { contacts: 100 },
          plans: { code: 'professional' },
        },
      ],
    });
    const result = await runPlanLifecycle(NOW, client);
    expect(result.expired).toBe(1);

    const update = updates[0].payload;
    expect(update.status).toBe('past_due');
    expect(update.grace_until).toBe('2026-08-27T12:00:00.000Z'); // +7 dias

    const event = inserts.find(
      (i) => i.table === 'account_plan_events'
    )?.payload;
    expect(event).toMatchObject({
      from_status: 'active',
      to_status: 'past_due',
      overrides_after: { contacts: 100 },
    });
    // Achado de code review: `to_plan_code` é NOT NULL no schema (067)
    // — o plano não muda aqui, mas a linha precisa de um valor. `null`
    // cru fazia o INSERT falhar por violação de constraint (silencioso,
    // já que o erro nunca era lido) toda vez que uma conta vencia sem
    // cancelamento agendado — o caminho mais comum de vencimento.
    expect(event).toMatchObject({
      from_plan_code: 'professional',
      to_plan_code: 'professional',
    });
    expect(dispatchWebhookEvent).toHaveBeenCalledWith(
      client,
      'acct-1',
      'plan.expired',
      expect.objectContaining({ graceUntil: '2026-08-27T12:00:00.000Z' })
    );
    expect(emitSystemEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'plan.expired',
        accountId: 'acct-1',
        data: {
          plan: {
            periodEnd: '2026-08-20T12:00:00.000Z',
            graceUntil: '2026-08-27T12:00:00.000Z',
          },
        },
      }),
      client,
      NOW
    );
  });

  it('vencido com cancelamento agendado: desce para o plano padrão, current_period_end null', async () => {
    const { client, updates, inserts } = makeDb({
      accountPlanRows: [
        {
          account_id: 'acct-1',
          plan_id: 'plan-pro',
          status: 'active',
          billing_cycle: 'monthly',
          current_period_end: '2026-08-20T12:00:00.000Z',
          cancel_at_period_end: true,
          grace_until: null,
          limit_overrides: { contacts: 100 },
          plans: { code: 'professional' },
        },
      ],
    });
    const result = await runPlanLifecycle(NOW, client);
    expect(result.canceledApplied).toBe(1);

    const update = updates[0].payload;
    expect(update.plan_id).toBe('plan-unlimited');
    expect(update.status).toBe('active');
    expect(update.cancel_at_period_end).toBe(false);
    expect(update.current_period_end).toBe(null); // unlimited: billing_period 'none'

    const event = inserts.find(
      (i) => i.table === 'account_plan_events'
    )?.payload;
    expect(event).toMatchObject({
      from_plan_code: 'professional',
      to_plan_code: 'unlimited',
      from_status: 'active',
      to_status: 'active',
    });
    expect(dispatchWebhookEvent).toHaveBeenCalledWith(
      client,
      'acct-1',
      'plan.canceled_applied',
      expect.objectContaining({ toPlanCode: 'unlimited' })
    );
    expect(emitSystemEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'plan.canceled_applied',
        accountId: 'acct-1',
        data: {
          plan: {
            fromPlanCode: 'professional',
            toPlanCode: 'unlimited',
            periodEnd: '2026-08-20T12:00:00.000Z',
          },
        },
      }),
      client,
      NOW
    );
  });

  // SPEC 078 §3.3 — concorrência otimista: o UPDATE só vale se o
  // vencimento ainda é o que o lote leu.
  it('o UPDATE de past_due filtra por current_period_end lido', async () => {
    const { client, updateFilters } = makeDb({
      accountPlanRows: [
        {
          account_id: 'acct-1',
          plan_id: 'plan-pro',
          status: 'active',
          billing_cycle: 'monthly',
          current_period_end: '2026-08-20T12:00:00.000Z',
          cancel_at_period_end: false,
          grace_until: null,
          limit_overrides: {},
          plans: { code: 'professional' },
        },
      ],
    });
    await runPlanLifecycle(NOW, client);
    expect(updateFilters[0]).toEqual([
      ['account_id', 'acct-1'],
      ['current_period_end', '2026-08-20T12:00:00.000Z'],
      ['status', 'active'],
    ]);
  });

  it('vencimento movido depois da leitura (UPDATE com zero linhas): não marca past_due, não emite evento', async () => {
    const { client, inserts } = makeDb({
      updateAffectsRows: false,
      accountPlanRows: [
        {
          account_id: 'acct-1',
          plan_id: 'plan-pro',
          status: 'active',
          billing_cycle: 'monthly',
          current_period_end: '2026-08-20T12:00:00.000Z',
          cancel_at_period_end: false,
          grace_until: null,
          limit_overrides: {},
          plans: { code: 'professional' },
        },
      ],
    });
    const result = await runPlanLifecycle(NOW, client);
    expect(result.expired).toBe(0);
    expect(result.errors).toBe(0);
    expect(inserts.some((i) => i.table === 'account_plan_events')).toBe(false);
    expect(dispatchWebhookEvent).not.toHaveBeenCalled();
    expect(emitSystemEvent).not.toHaveBeenCalled();
  });

  it('cancelamento agendado com vencimento movido (zero linhas): não faz downgrade, não emite evento', async () => {
    const { client, updateFilters, inserts } = makeDb({
      updateAffectsRows: false,
      accountPlanRows: [
        {
          account_id: 'acct-1',
          plan_id: 'plan-pro',
          status: 'active',
          billing_cycle: 'monthly',
          current_period_end: '2026-08-20T12:00:00.000Z',
          cancel_at_period_end: true,
          grace_until: null,
          limit_overrides: {},
          plans: { code: 'professional' },
        },
      ],
    });
    const result = await runPlanLifecycle(NOW, client);
    expect(result.canceledApplied).toBe(0);
    expect(result.errors).toBe(0);
    expect(updateFilters[0]).toContainEqual([
      'current_period_end',
      '2026-08-20T12:00:00.000Z',
    ]);
    expect(updateFilters[0]).toContainEqual(['status', 'active']);
    expect(inserts.some((i) => i.table === 'account_plan_events')).toBe(false);
    expect(dispatchWebhookEvent).not.toHaveBeenCalled();
    expect(emitSystemEvent).not.toHaveBeenCalled();
  });

  it('já past_due (não active/trialing) não reprocessa o ramo de vencido de novo', async () => {
    const { client, updates } = makeDb({
      accountPlanRows: [
        {
          account_id: 'acct-1',
          plan_id: 'plan-pro',
          status: 'past_due', // já transicionou numa corrida anterior
          billing_cycle: 'monthly',
          current_period_end: '2026-08-20T12:00:00.000Z',
          cancel_at_period_end: false,
          grace_until: '2026-08-30T12:00:00.000Z', // carência ainda não acabou
          limit_overrides: {},
          plans: { code: 'professional' },
        },
      ],
    });
    const result = await runPlanLifecycle(NOW, client);
    expect(result.expired).toBe(0);
    expect(result.graceEnded).toBe(0);
    expect(updates).toEqual([]);
  });

  it('carência encerrada: avisa, NÃO muda status (D-7)', async () => {
    const { client, updates, inserts } = makeDb({
      accountPlanRows: [
        {
          account_id: 'acct-1',
          plan_id: 'plan-pro',
          status: 'past_due',
          billing_cycle: 'monthly',
          current_period_end: '2026-08-20T12:00:00.000Z',
          cancel_at_period_end: false,
          grace_until: '2026-08-25T12:00:00.000Z', // já passou
          limit_overrides: {},
          plans: { code: 'professional' },
        },
      ],
    });
    const result = await runPlanLifecycle(NOW, client);
    expect(result.graceEnded).toBe(1);
    expect(updates).toEqual([]); // D-7: nada bloqueia
    expect(dispatchWebhookEvent).toHaveBeenCalledWith(
      client,
      'acct-1',
      'plan.grace_ended',
      expect.objectContaining({ graceUntil: '2026-08-25T12:00:00.000Z' })
    );
    expect(emitSystemEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'plan.grace_ended',
        accountId: 'acct-1',
        data: { plan: { graceUntil: '2026-08-25T12:00:00.000Z' } },
      }),
      client,
      NOW
    );
    // O registro de dedupe é o que impede a próxima corrida de avisar
    // de novo — sem ele, `platform_audit_log` nunca ganha o
    // `dedupeKey` e o aviso repetiria a cada 5 minutos para sempre.
    expect(
      inserts.some(
        (i) =>
          i.table === 'platform_audit_log' &&
          i.payload.action === 'plan.lifecycle_notice' &&
          (i.payload.payload as Record<string, unknown>)?.dedupeKey ===
            'plan.grace_ended:acct-1:2026-08-25T12:00:00.000Z'
      )
    ).toBe(true);
  });

  it('conta suspensa manualmente pelo operador: lifecycle não mexe', async () => {
    const { client, updates } = makeDb({
      accountPlanRows: [
        {
          account_id: 'acct-1',
          plan_id: 'plan-pro',
          status: 'suspended',
          billing_cycle: 'monthly',
          current_period_end: '2026-08-20T12:00:00.000Z',
          cancel_at_period_end: false,
          grace_until: null,
          limit_overrides: {},
          plans: { code: 'professional' },
        },
      ],
    });
    const result = await runPlanLifecycle(NOW, client);
    expect(result.expired).toBe(0);
    expect(result.expiringNotices).toBe(0);
    expect(updates).toEqual([]);
  });
});
