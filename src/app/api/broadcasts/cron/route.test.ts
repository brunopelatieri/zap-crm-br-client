import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * SPEC 069 F8 — a varredura de `awaiting_check` (R6, disparo parcial).
 *
 * O foco é a MÁQUINA em contato com o banco: qual consulta define o
 * lote, qual estado a campanha assume depois de cada desfecho, e o que
 * NUNCA pode acontecer (a mesma pessoa em duas fatias, a variante B
 * varrida, a campanha encerrada antes da fila esvaziar).
 *
 * A passada de campanhas `scheduled` que já existia neste cron não é
 * exercitada aqui — o cenário devolve lista vazia para ela.
 */

const afterCallbacks: Array<() => unknown> = [];
vi.mock('next/server', () => ({
  after: (cb: () => unknown) => {
    afterCallbacks.push(cb);
  },
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      body,
      json: async () => body,
    }),
  },
}));

vi.mock('@/lib/platform/blocked', () => ({
  loadBlockedAccountIds: async () => blockedAccounts,
}));

const loadAccountQuota = vi.fn();
vi.mock('@/lib/whatsapp/messaging-limit-server', () => ({
  loadAccountQuota: (...args: unknown[]) => loadAccountQuota(...args),
}));

const planDashboardBroadcast = vi.fn();
const planAbTestBroadcast = vi.fn();
vi.mock('@/lib/whatsapp/broadcast-dispatch', () => ({
  planDashboardBroadcast: (...args: unknown[]) =>
    planDashboardBroadcast(...args),
  planAbTestBroadcast: (...args: unknown[]) => planAbTestBroadcast(...args),
  SEND_BATCH_SIZE: 10,
  SEND_BATCH_DELAY_MS: 1000,
}));

const deliverBroadcast = vi.fn();
vi.mock('@/lib/whatsapp/broadcast-core', async () => {
  const actual = await vi.importActual<
    typeof import('@/lib/whatsapp/broadcast-core')
  >('@/lib/whatsapp/broadcast-core');
  return {
    ...actual,
    deliverBroadcast: (...args: unknown[]) => deliverBroadcast(...args),
  };
});

const logBroadcastAudit = vi.fn();
vi.mock('@/lib/broadcasts/audit', () => ({
  logBroadcastAudit: (...args: unknown[]) => logBroadcastAudit(...args),
}));

let withinWindow = true;
vi.mock('@/lib/broadcasts/send-window', async () => {
  const actual = await vi.importActual<
    typeof import('@/lib/broadcasts/send-window')
  >('@/lib/broadcasts/send-window');
  return { ...actual, isWithinSendWindow: () => withinWindow };
});

// ------------------------------------------------------------
// Cenário: uma campanha em awaiting_check e o estado da fila
// ------------------------------------------------------------

interface QueueItem {
  contactId: string;
  status: 'pending' | 'in_progress' | 'done' | 'failed' | 'expired' | 'skipped';
  checkedAt?: string;
}

interface Scenario {
  awaiting: Array<Record<string, unknown>>;
  queue: QueueItem[];
  /** contact_id -> whatsapp_status */
  contactStatus: Record<string, 'valid' | 'invalid'>;
  /** Linhas de broadcast_recipients já existentes (contact ids). */
  recipients: string[];
  batchLimit: number;
}

let scenario: Scenario;
let blockedAccounts: Set<string>;
const broadcastUpdates: Array<Record<string, unknown>> = [];
/** Filtros da consulta que monta o lote — para asseverar a marca d'água. */
const readyQueryFilters: unknown[][] = [];

function makeAdminDb() {
  return {
    from(table: string) {
      const filters: unknown[][] = [];
      let updatePayload: Record<string, unknown> | undefined;
      let selectArgs: unknown[] = [];

      const chain: Record<string, unknown> = {
        select: (...args: unknown[]) => {
          selectArgs = args;
          return chain;
        },
        eq: (...args: unknown[]) => {
          filters.push(['eq', ...args]);
          return chain;
        },
        is: (...args: unknown[]) => {
          filters.push(['is', ...args]);
          return chain;
        },
        in: (...args: unknown[]) => {
          filters.push(['in', ...args]);
          return chain;
        },
        gte: (...args: unknown[]) => {
          filters.push(['gte', ...args]);
          return chain;
        },
        lte: () => chain,
        neq: () => chain,
        not: () => chain,
        update: (p: Record<string, unknown>) => {
          updatePayload = p;
          return chain;
        },
        order: () => chain,
        limit: () => chain,
        maybeSingle: () => {
          if (table === 'profiles') {
            return Promise.resolve({
              data: { account_role: 'admin' },
              error: null,
            });
          }
          if (updatePayload !== undefined) {
            if (table === 'broadcasts') {
              return Promise.resolve(applyBroadcastUpdate());
            }
            broadcastUpdates.push(updatePayload);
            return Promise.resolve({ data: { id: 'b1' }, error: null });
          }
          return Promise.resolve({ data: null, error: null });
        },
        then: (resolve: (v: unknown) => unknown) =>
          Promise.resolve(settle()).then(resolve),
      };

      function eqValue(key: string): unknown {
        for (const f of filters) {
          if (f[0] === 'eq' && f[1] === key) return f[2];
        }
        return undefined;
      }
      function inValues(key: string): unknown[] | undefined {
        for (const f of filters) {
          if (f[0] === 'in' && f[1] === key) return f[2] as unknown[];
        }
        return undefined;
      }
      function gteValue(key: string): string | undefined {
        for (const f of filters) {
          if (f[0] === 'gte' && f[1] === key) return f[2] as string;
        }
        return undefined;
      }
      const isHeadCount = () =>
        typeof selectArgs[1] === 'object' &&
        (selectArgs[1] as { head?: boolean } | undefined)?.head === true;

      /**
       * `update(...).eq('id', X).eq('status', Y)` sobre `broadcasts`: só
       * aplica (e devolve sucesso) se a linha ainda estiver no status Y
       * — é o que faz o mock exercitar de verdade o claim do R6 (achado
       * de code review: duas invocações sobrepostas não podiam disparar
       * a mesma fatia duas vezes).
       */
      function applyBroadcastUpdate(): {
        data: unknown;
        error: null;
      } {
        if (table !== 'broadcasts' || updatePayload === undefined) {
          return { data: null, error: null };
        }
        const id = eqValue('id');
        const requiredStatus = eqValue('status');
        const row = scenario.awaiting.find(
          (r) => (r as { id?: string }).id === id
        ) as (Record<string, unknown> & { status?: string }) | undefined;

        if (!row) return { data: null, error: null };
        if (requiredStatus !== undefined && row.status !== requiredStatus) {
          return { data: null, error: null };
        }
        Object.assign(row, updatePayload);
        broadcastUpdates.push(updatePayload);
        return { data: { id }, error: null };
      }

      function settle(): {
        data: unknown;
        error: null;
        count?: number | null;
      } {
        if (updatePayload !== undefined) {
          if (table === 'broadcasts') {
            return applyBroadcastUpdate();
          }
          broadcastUpdates.push(updatePayload);
          return { data: null, error: null };
        }

        if (table === 'broadcasts') {
          const status = eqValue('status');
          if (status === 'awaiting_check') {
            return {
              data: scenario.awaiting.filter(
                (r) =>
                  ((r as { status?: string }).status ?? 'awaiting_check') ===
                  'awaiting_check'
              ),
              error: null,
            };
          }
          // A passada de `scheduled` deste cron não é o alvo deste
          // arquivo.
          return { data: [], error: null };
        }

        if (table === 'contact_check_queue') {
          const statuses =
            inValues('status') ??
            (eqValue('status') ? [eqValue('status')] : undefined);
          let matching = scenario.queue.filter(
            (q) => !statuses || statuses.includes(q.status)
          );
          // A marca d'água É a consulta: sem filtrar de verdade por ela
          // aqui, um bug no avanço de `check_resumed_at` no route.ts
          // passaria batido pelos testes (foi exatamente o que
          // aconteceu — achado de code review).
          const gteCheckedAt = gteValue('checked_at');
          if (gteCheckedAt !== undefined) {
            matching = matching.filter(
              (q) => (q.checkedAt ?? '') >= gteCheckedAt
            );
          }
          if (isHeadCount()) {
            return { data: null, error: null, count: matching.length };
          }
          // A consulta do LOTE — registra os filtros para asseverar a
          // marca d'água.
          readyQueryFilters.push(...filters);
          return {
            data: matching.map((q) => ({
              contact_id: q.contactId,
              checked_at: q.checkedAt ?? null,
            })),
            error: null,
          };
        }

        if (table === 'broadcast_recipients') {
          if (isHeadCount()) {
            return {
              data: null,
              error: null,
              count: scenario.recipients.length,
            };
          }
          const asked = (inValues('contact_id') as string[] | undefined) ?? [];
          return {
            data: scenario.recipients
              .filter((id) => asked.includes(id))
              .map((id) => ({ contact_id: id })),
            error: null,
          };
        }

        if (table === 'contacts') {
          const asked = (inValues('contact_id') ??
            inValues('id') ??
            []) as string[];
          return {
            data: asked
              .filter(
                (id) => (scenario.contactStatus[id] ?? 'valid') === 'valid'
              )
              .map((id) => ({ id })),
            error: null,
          };
        }

        return { data: null, error: null };
      }

      return chain;
    },
  };
}

vi.mock('@/lib/supabase/admin', () => ({
  supabaseAdmin: () => makeAdminDb(),
}));

import { GET } from './route';

function makeRequest(secret?: string): Request {
  return new Request('http://localhost/api/broadcasts/cron', {
    headers: secret ? { 'x-cron-secret': secret } : {},
  });
}

function awaitingRow(over: Record<string, unknown> = {}) {
  return {
    id: 'b1',
    account_id: 'acct-1',
    user_id: 'user-1',
    name: 'Campanha CLT',
    template_name: 'promo',
    template_language: 'pt_BR',
    template_variables: {},
    header_media_url: null,
    channel_id: 'chan-cloud',
    channel_source: 'resource',
    scheduled_timezone: 'America/Sao_Paulo',
    window_override: false,
    check_resumed_at: null,
    // Mutável pelo mock de `broadcasts` a cada `update()` — é isso que
    // faz o claim (achado de code review) e a marca d'água virarem
    // estado real entre ciclos, em vez de sempre "suceder".
    status: 'awaiting_check',
    ...over,
  };
}

beforeEach(() => {
  afterCallbacks.length = 0;
  broadcastUpdates.length = 0;
  readyQueryFilters.length = 0;
  blockedAccounts = new Set();
  withinWindow = true;
  planDashboardBroadcast.mockReset();
  deliverBroadcast.mockReset();
  logBroadcastAudit.mockReset();
  loadAccountQuota.mockReset();
  loadAccountQuota.mockResolvedValue({
    configured: true,
    snapshot: { batchLimit: 1000 },
  });
  planDashboardBroadcast.mockImplementation(async () => ({
    broadcastId: 'b1',
    planned: [
      { recipientRowId: 'r1', contactId: 'c1', phone: '55', params: [] },
    ],
    rejected: 0,
    totalRecipients: 1,
    excludedOptedOut: 0,
    excludedInvalidWhatsapp: 0,
  }));
  process.env.AUTOMATION_CRON_SECRET = 'the-secret';
  scenario = {
    awaiting: [],
    queue: [],
    contactStatus: {},
    recipients: [],
    batchLimit: 1000,
  };
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

function lastStatusUpdate(): Record<string, unknown> | undefined {
  return [...broadcastUpdates].reverse().find((u) => 'status' in u);
}

describe('GET /api/broadcasts/cron — contrato de auth', () => {
  it('503 sem AUTOMATION_CRON_SECRET', async () => {
    delete process.env.AUTOMATION_CRON_SECRET;
    const res = await GET(makeRequest('x'));
    expect(res.status).toBe(503);
  });

  it('401 com segredo errado', async () => {
    const res = await GET(makeRequest('wrong'));
    expect(res.status).toBe(401);
  });
});

describe('varredura awaiting_check — (a) dispara a fatia validada', () => {
  beforeEach(() => {
    scenario.awaiting = [awaitingRow()];
    scenario.queue = [
      { contactId: 'c1', status: 'done', checkedAt: '2026-09-03T10:00:00Z' },
      { contactId: 'c2', status: 'pending' },
    ];
  });

  it('planeja com audiência contact_ids e em modo partialAppend', async () => {
    await GET(makeRequest('the-secret'));

    expect(planDashboardBroadcast).toHaveBeenCalledTimes(1);
    const params = planDashboardBroadcast.mock.calls[0][1];
    expect(params.adoptBroadcastId).toBe('b1');
    expect(params.partialAppend).toBe(true);
    expect(params.input.audience).toEqual({
      type: 'contact_ids',
      contactIds: ['c1'],
    });
  });

  it('entrega com finalizeStatus:false — a fatia NÃO encerra a campanha', async () => {
    await GET(makeRequest('the-secret'));
    expect(afterCallbacks).toHaveLength(1);
    await afterCallbacks[0]();

    expect(deliverBroadcast).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ finalizeStatus: false })
    );
  });

  it('com fila ainda pendente, volta a awaiting_check e carimba check_resumed_at', async () => {
    await GET(makeRequest('the-secret'));

    const update = lastStatusUpdate();
    expect(update).toMatchObject({ status: 'awaiting_check' });
    expect(update?.check_resumed_at).toEqual(expect.any(String));
  });

  it('com a fila esvaziada por esta fatia, conclui em sent', async () => {
    scenario.queue = [
      { contactId: 'c1', status: 'done', checkedAt: '2026-09-03T10:00:00Z' },
    ];
    await GET(makeRequest('the-secret'));

    expect(lastStatusUpdate()).toMatchObject({ status: 'sent' });
  });

  it('registra a fatia na trilha marcada como partial_send', async () => {
    await GET(makeRequest('the-secret'));

    expect(logBroadcastAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        event: 'dispatched',
        broadcastId: 'b1',
        details: expect.objectContaining({ partial_send: true }),
      })
    );
  });

  it('a resposta do cron reporta a retomada', async () => {
    const res = await GET(makeRequest('the-secret'));
    const body = await res.json();
    expect(body.partialSend).toMatchObject({ resumed: 1 });
  });
});

describe('varredura awaiting_check — quem entra no lote', () => {
  it('contato JÁ com linha de destinatário nunca entra numa segunda fatia', async () => {
    scenario.awaiting = [awaitingRow()];
    scenario.queue = [
      { contactId: 'c1', status: 'done', checkedAt: '2026-09-03T10:00:00Z' },
      { contactId: 'c2', status: 'done', checkedAt: '2026-09-03T10:05:00Z' },
    ];
    scenario.recipients = ['c1']; // c1 já saiu numa fatia anterior

    await GET(makeRequest('the-secret'));

    const params = planDashboardBroadcast.mock.calls[0][1];
    expect(params.input.audience.contactIds).toEqual(['c2']);
  });

  it('contato checado e INVÁLIDO fica fora do lote (senão a campanha nunca completaria)', async () => {
    scenario.awaiting = [awaitingRow()];
    scenario.queue = [
      { contactId: 'c1', status: 'done', checkedAt: '2026-09-03T10:00:00Z' },
      { contactId: 'c2', status: 'done', checkedAt: '2026-09-03T10:01:00Z' },
    ];
    scenario.contactStatus = { c2: 'invalid' };

    await GET(makeRequest('the-secret'));

    const params = planDashboardBroadcast.mock.calls[0][1];
    expect(params.input.audience.contactIds).toEqual(['c1']);
  });

  it('audiência inteira inválida: completa em sent, sem disparar nada', async () => {
    scenario.awaiting = [awaitingRow()];
    scenario.queue = [
      { contactId: 'c1', status: 'done', checkedAt: '2026-09-03T10:00:00Z' },
    ];
    scenario.contactStatus = { c1: 'invalid' };

    await GET(makeRequest('the-secret'));

    expect(planDashboardBroadcast).not.toHaveBeenCalled();
    expect(lastStatusUpdate()).toMatchObject({ status: 'sent' });
  });

  it("usa check_resumed_at como marca d'água na consulta do lote", async () => {
    scenario.awaiting = [
      awaitingRow({ check_resumed_at: '2026-09-03T09:00:00Z' }),
    ];
    scenario.queue = [
      { contactId: 'c1', status: 'done', checkedAt: '2026-09-03T10:00:00Z' },
    ];

    await GET(makeRequest('the-secret'));

    expect(readyQueryFilters).toContainEqual([
      'gte',
      'checked_at',
      '2026-09-03T09:00:00Z',
    ]);
  });

  it('corta o lote pela cota de 24 h em vez de deixar o planejamento lançar', async () => {
    scenario.awaiting = [awaitingRow()];
    scenario.queue = Array.from({ length: 30 }, (_, i) => ({
      contactId: `c${i}`,
      status: 'done' as const,
      checkedAt: '2026-09-03T10:00:00Z',
    }));
    loadAccountQuota.mockResolvedValue({
      configured: true,
      snapshot: { batchLimit: 10 },
    });

    await GET(makeRequest('the-secret'));

    const params = planDashboardBroadcast.mock.calls[0][1];
    expect(params.input.audience.contactIds).toHaveLength(10);
  });
});

describe('varredura awaiting_check — (b) espera', () => {
  it('nada pronto e fila com itens: não dispara, continua awaiting_check', async () => {
    scenario.awaiting = [awaitingRow()];
    scenario.queue = [{ contactId: 'c1', status: 'pending' }];

    const res = await GET(makeRequest('the-secret'));
    const body = await res.json();

    expect(planDashboardBroadcast).not.toHaveBeenCalled();
    expect(lastStatusUpdate()).toBeUndefined();
    expect(body.partialSend).toMatchObject({ waiting: 1 });
  });

  it('mesmo esperando, atualiza checked_count para a tela mostrar progresso', async () => {
    scenario.awaiting = [awaitingRow()];
    scenario.queue = [
      { contactId: 'c1', status: 'pending' },
      { contactId: 'c2', status: 'done', checkedAt: '2026-09-03T10:00:00Z' },
    ];
    scenario.recipients = ['c2'];

    await GET(makeRequest('the-secret'));

    expect(broadcastUpdates.some((u) => 'checked_count' in u)).toBe(true);
  });
});

describe('varredura awaiting_check — (d) fora da janela de envio (D-11)', () => {
  beforeEach(() => {
    withinWindow = false;
    scenario.awaiting = [awaitingRow()];
    scenario.queue = [
      { contactId: 'c1', status: 'done', checkedAt: '2026-09-03T10:00:00Z' },
      { contactId: 'c2', status: 'pending' },
    ];
  });

  it('adia: não dispara e mantém awaiting_check', async () => {
    const res = await GET(makeRequest('the-secret'));
    const body = await res.json();

    expect(planDashboardBroadcast).not.toHaveBeenCalled();
    expect(lastStatusUpdate()).toBeUndefined();
    expect(body.partialSend).toMatchObject({ postponed: 1 });
  });

  it('o motivo vai para a trilha como blocked_window', async () => {
    await GET(makeRequest('the-secret'));

    expect(logBroadcastAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        event: 'blocked_window',
        details: expect.objectContaining({ partial_send: true }),
      })
    );
  });

  it('window_override dispara mesmo fora da janela', async () => {
    scenario.awaiting = [awaitingRow({ window_override: true })];
    await GET(makeRequest('the-secret'));
    expect(planDashboardBroadcast).toHaveBeenCalledTimes(1);
  });
});

describe('varredura awaiting_check — (§14) campanha que não pode andar', () => {
  it('tudo skipped e nada disparado: cai para failed com motivo', async () => {
    scenario.awaiting = [awaitingRow()];
    scenario.queue = [
      { contactId: 'c1', status: 'skipped' },
      { contactId: 'c2', status: 'skipped' },
    ];

    const res = await GET(makeRequest('the-secret'));
    const body = await res.json();

    expect(lastStatusUpdate()).toMatchObject({ status: 'failed' });
    expect(body.partialSend).toMatchObject({ failed: 1 });
    expect(logBroadcastAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        event: 'failed',
        details: expect.objectContaining({ reason: 'checks_unresolved' }),
      })
    );
  });

  it('mas com algo já disparado, completa em sent — envio parcial é envio', async () => {
    scenario.awaiting = [awaitingRow()];
    scenario.queue = [{ contactId: 'c1', status: 'skipped' }];
    scenario.recipients = ['c9'];

    await GET(makeRequest('the-secret'));

    expect(lastStatusUpdate()).toMatchObject({ status: 'sent' });
  });
});

describe('varredura awaiting_check — travas', () => {
  it('conta bloqueada é pulada por inteiro', async () => {
    blockedAccounts = new Set(['acct-1']);
    scenario.awaiting = [awaitingRow()];
    scenario.queue = [
      { contactId: 'c1', status: 'done', checkedAt: '2026-09-03T10:00:00Z' },
    ];

    await GET(makeRequest('the-secret'));

    expect(planDashboardBroadcast).not.toHaveBeenCalled();
    expect(broadcastUpdates).toHaveLength(0);
  });

  it('cota de 24 h estourada mantém awaiting_check e registra blocked_quota', async () => {
    const { BroadcastError } = await vi.importActual<
      typeof import('@/lib/whatsapp/broadcast-core')
    >('@/lib/whatsapp/broadcast-core');
    scenario.awaiting = [awaitingRow()];
    scenario.queue = [
      { contactId: 'c1', status: 'done', checkedAt: '2026-09-03T10:00:00Z' },
      { contactId: 'c2', status: 'pending' },
    ];
    planDashboardBroadcast.mockRejectedValue(
      new BroadcastError('quota_exceeded', 'over quota', 429)
    );

    const res = await GET(makeRequest('the-secret'));
    const body = await res.json();

    // O claim (achado de code review) passa por `sending` antes de
    // reverter — a campanha TERMINA em `awaiting_check` (mesmo estado
    // de antes), não sem nenhuma escrita de status.
    expect(lastStatusUpdate()).toMatchObject({ status: 'awaiting_check' });
    expect(scenario.awaiting[0].status).toBe('awaiting_check');
    expect(body.partialSend).toMatchObject({ waiting: 1 });
    expect(logBroadcastAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ event: 'blocked_quota' })
    );
  });

  it('erro inesperado no planejamento marca a campanha como failed', async () => {
    scenario.awaiting = [awaitingRow()];
    scenario.queue = [
      { contactId: 'c1', status: 'done', checkedAt: '2026-09-03T10:00:00Z' },
    ];
    planDashboardBroadcast.mockRejectedValue(new Error('boom'));

    const res = await GET(makeRequest('the-secret'));
    const body = await res.json();

    expect(lastStatusUpdate()).toMatchObject({ status: 'failed' });
    expect(body.partialSend).toMatchObject({ failed: 1 });
  });
});

// ============================================================
// O cenário do "pronto quando" da F8, simulado ciclo a ciclo
// ============================================================

describe('drenagem em múltiplos ciclos (30 contatos, cota de 10)', () => {
  it('completa em três fatias e só então vira sent', async () => {
    const all = Array.from({ length: 30 }, (_, i) => `c${i}`);
    scenario.awaiting = [awaitingRow()];
    // Todos já checados e válidos; a cota é que limita cada ciclo.
    scenario.queue = all.map((contactId) => ({
      contactId,
      status: 'done' as const,
      checkedAt: '2026-09-03T10:00:00Z',
    }));
    loadAccountQuota.mockResolvedValue({
      configured: true,
      snapshot: { batchLimit: 10 },
    });

    const slices: string[][] = [];
    planDashboardBroadcast.mockImplementation(
      async (
        _db: unknown,
        params: { input: { audience: { contactIds: string[] } } }
      ) => {
        const ids = params.input.audience.contactIds;
        slices.push(ids);
        // O planejamento cria as linhas de destinatário — é isso que
        // tira estes contatos do lote do próximo ciclo.
        scenario.recipients.push(...ids);
        return {
          broadcastId: 'b1',
          planned: ids.map((id) => ({
            recipientRowId: `r-${id}`,
            contactId: id,
            phone: '55',
            params: [],
          })),
          rejected: 0,
          totalRecipients: ids.length,
          excludedOptedOut: 0,
          excludedInvalidWhatsapp: 0,
        };
      }
    );

    // Ciclo 1 e 2: sobra fila, volta a awaiting_check.
    for (const cycle of [1, 2]) {
      broadcastUpdates.length = 0;
      await GET(makeRequest('the-secret'));
      expect(slices).toHaveLength(cycle);
      expect(slices[cycle - 1]).toHaveLength(10);
      expect(lastStatusUpdate()).toMatchObject({ status: 'awaiting_check' });
    }

    // Ciclo 3: a última fatia esvazia o lote — a campanha encerra.
    broadcastUpdates.length = 0;
    await GET(makeRequest('the-secret'));

    expect(slices).toHaveLength(3);
    expect(lastStatusUpdate()).toMatchObject({ status: 'sent' });

    // Ninguém saiu duas vezes, e os 30 saíram.
    const dispatched = slices.flat();
    expect(new Set(dispatched).size).toBe(30);
    expect(dispatched).toHaveLength(30);
  });
});

describe('drenagem em múltiplos ciclos (30 contatos, cota de CHECAGEM de 10)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('o laço real do R6: a checagem libera 10 por ciclo e a campanha só encerra no terceiro', async () => {
    // Relógio fixo: neste cenário `readyRemaining` chega a 0 em TODO
    // ciclo (10 prontos, cota de envio bem acima disso), então a marca
    // d'água avança de verdade a cada ciclo — o relógio real do
    // ambiente de teste não tem garantia nenhuma de estar depois de
    // 2026-09-03T10:00, então fixamos para o filtro `checked_at >=
    // check_resumed_at` comparar contra os mesmos carimbos que o teste
    // usa.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-03T10:00:00Z'));
    const all = Array.from({ length: 30 }, (_, i) => `c${i}`);
    scenario.awaiting = [awaitingRow()];
    // Todos começam PENDENTES: quem os move para `done` é o cron de
    // checagem, simulado abaixo entre um ciclo e outro.
    scenario.queue = all.map((contactId) => ({
      contactId,
      status: 'pending' as const,
    }));

    const slices: string[][] = [];
    planDashboardBroadcast.mockImplementation(
      async (
        _db: unknown,
        params: { input: { audience: { contactIds: string[] } } }
      ) => {
        const ids = params.input.audience.contactIds;
        slices.push(ids);
        scenario.recipients.push(...ids);
        return {
          broadcastId: 'b1',
          planned: ids.map((id) => ({
            recipientRowId: `r-${id}`,
            contactId: id,
            phone: '55',
            params: [],
          })),
          rejected: 0,
          totalRecipients: ids.length,
          excludedOptedOut: 0,
          excludedInvalidWhatsapp: 0,
        };
      }
    );

    /** O que o cron de CHECAGEM faz entre dois ciclos deste cron. */
    function checkNext(n: number, at: string) {
      scenario.queue
        .filter((q) => q.status === 'pending')
        .slice(0, n)
        .forEach((q) => {
          q.status = 'done';
          q.checkedAt = at;
        });
    }

    // Ciclo 1: 10 checados, 10 saem, 20 continuam na fila.
    checkNext(10, '2026-09-03T10:00:00Z');
    broadcastUpdates.length = 0;
    await GET(makeRequest('the-secret'));
    expect(slices[0]).toHaveLength(10);
    expect(lastStatusUpdate()).toMatchObject({ status: 'awaiting_check' });

    // Ciclo 2: mais 10 — o relógio avança JUNTO com o carimbo, senão a
    // marca d'água que o ciclo 1 gravou (= "now" do ciclo 1) deixaria
    // estes itens, checados "no passado" em relação a ela, invisíveis.
    vi.setSystemTime(new Date('2026-09-03T10:05:00Z'));
    checkNext(10, '2026-09-03T10:05:00Z');
    broadcastUpdates.length = 0;
    await GET(makeRequest('the-secret'));
    expect(slices[1]).toHaveLength(10);
    expect(lastStatusUpdate()).toMatchObject({ status: 'awaiting_check' });

    // Ciclo 3: os últimos 10 — a fila esvazia e a campanha encerra.
    vi.setSystemTime(new Date('2026-09-03T10:10:00Z'));
    checkNext(10, '2026-09-03T10:10:00Z');
    broadcastUpdates.length = 0;
    await GET(makeRequest('the-secret'));
    expect(slices[2]).toHaveLength(10);
    expect(lastStatusUpdate()).toMatchObject({ status: 'sent' });

    const dispatched = slices.flat();
    expect(dispatched).toHaveLength(30);
    expect(new Set(dispatched).size).toBe(30);
  });

  it('um ciclo fora da janela no meio do laço não perde ninguém', async () => {
    scenario.awaiting = [awaitingRow()];
    scenario.queue = [
      { contactId: 'c1', status: 'done', checkedAt: '2026-09-03T10:00:00Z' },
      { contactId: 'c2', status: 'pending' },
    ];

    const slices: string[][] = [];
    planDashboardBroadcast.mockImplementation(
      async (
        _db: unknown,
        params: { input: { audience: { contactIds: string[] } } }
      ) => {
        const ids = params.input.audience.contactIds;
        slices.push(ids);
        scenario.recipients.push(...ids);
        return {
          broadcastId: 'b1',
          planned: [],
          rejected: 0,
          totalRecipients: ids.length,
          excludedOptedOut: 0,
          excludedInvalidWhatsapp: 0,
        };
      }
    );

    // Ciclo fechado: adia sem despachar e sem avançar a marca d'água.
    withinWindow = false;
    await GET(makeRequest('the-secret'));
    expect(slices).toHaveLength(0);

    // Janela reabre: o MESMO contato continua no lote.
    withinWindow = true;
    await GET(makeRequest('the-secret'));
    expect(slices[0]).toEqual(['c1']);
  });
});

// ============================================================
// Achados de code review (fixados nesta rodada) — cobertura direta
// ============================================================

describe("varredura awaiting_check — marca d'água (achado de code review)", () => {
  it('não avança check_resumed_at quando a cota corta o lote, senão os que sobraram somem para sempre', async () => {
    scenario.awaiting = [awaitingRow()];
    scenario.queue = [
      { contactId: 'c1', status: 'done', checkedAt: '2026-09-03T10:00:00Z' },
      { contactId: 'c2', status: 'done', checkedAt: '2026-09-03T10:00:00Z' },
    ];
    loadAccountQuota.mockResolvedValue({
      configured: true,
      snapshot: { batchLimit: 1 },
    });
    // O mock padrão do topo do arquivo devolve sempre `contactId: 'c1'`
    // sem tocar `scenario.recipients` — aqui a exclusão pela existência
    // de `broadcast_recipients` entre ciclos É o que o teste verifica,
    // então o plano precisa refletir de verdade quem foi aceito.
    planDashboardBroadcast.mockImplementation(
      async (
        _db: unknown,
        params: { input: { audience: { contactIds: string[] } } }
      ) => {
        const ids = params.input.audience.contactIds;
        scenario.recipients.push(...ids);
        return {
          broadcastId: 'b1',
          planned: ids.map((id) => ({
            recipientRowId: `r-${id}`,
            contactId: id,
            phone: '55',
            params: [],
          })),
          rejected: 0,
          totalRecipients: ids.length,
          excludedOptedOut: 0,
          excludedInvalidWhatsapp: 0,
        };
      }
    );

    await GET(makeRequest('the-secret'));

    // c1 saiu; c2 ficou pronto mas cortado pela cota. A marca d'água
    // TEM que continuar como estava (null) — um avanço para `now` faria
    // `checked_at >= check_resumed_at` excluir c2 (checado ANTES de
    // `now`) do próximo ciclo para sempre, mesmo válido e nunca
    // disparado.
    expect(scenario.awaiting[0].check_resumed_at).toBeNull();
    expect(lastStatusUpdate()).toMatchObject({ status: 'awaiting_check' });

    // No ciclo seguinte, com a cota liberada, c2 continua visível e sai.
    broadcastUpdates.length = 0;
    loadAccountQuota.mockResolvedValue({
      configured: true,
      snapshot: { batchLimit: 10 },
    });
    await GET(makeRequest('the-secret'));

    const params = planDashboardBroadcast.mock.calls[1][1];
    expect(params.input.audience.contactIds).toEqual(['c2']);
    expect(lastStatusUpdate()).toMatchObject({ status: 'sent' });
  });

  it('avança check_resumed_at para `now` quando o lote pronto coube inteiro (otimização segura)', async () => {
    scenario.awaiting = [awaitingRow()];
    scenario.queue = [
      { contactId: 'c1', status: 'done', checkedAt: '2026-09-03T10:00:00Z' },
      { contactId: 'c2', status: 'pending' },
    ];

    await GET(makeRequest('the-secret'));

    expect(scenario.awaiting[0].check_resumed_at).toEqual(expect.any(String));
    expect(scenario.awaiting[0].check_resumed_at).not.toBeNull();
  });
});

describe('varredura awaiting_check — trava de concorrência (achado de code review)', () => {
  it('duas invocações sobrepostas do cron não despacham a mesma fatia duas vezes', async () => {
    scenario.awaiting = [awaitingRow()];
    scenario.queue = [
      { contactId: 'c1', status: 'done', checkedAt: '2026-09-03T10:00:00Z' },
      { contactId: 'c2', status: 'done', checkedAt: '2026-09-03T10:00:00Z' },
    ];

    // As duas leem o MESMO lote pronto — nenhuma inseriu
    // `broadcast_recipients` ainda quando a outra também lê. Sem o
    // claim, as duas despachariam; com ele, só a que ganhar a corrida
    // pelo `UPDATE ... WHERE status = 'awaiting_check'` chega a
    // planejar o envio.
    await Promise.all([
      GET(makeRequest('the-secret')),
      GET(makeRequest('the-secret')),
    ]);

    expect(planDashboardBroadcast).toHaveBeenCalledTimes(1);
  });
});
