import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * SPEC 065 — escopo de canal e execução por conversa nos fluxos
 * (D-6, D-7, itens C1/C2/C3 do inventário).
 *
 * Mock próprio: o de `engine.test.ts` monta um grafo completo para
 * exercitar o avanço de nós, e o que se testa aqui é anterior a isso —
 * QUAL fluxo entra e QUAL execução ativa é encontrada. O grafo fica
 * vazio de propósito: basta saber que linha foi inserida em `flow_runs`.
 */
const h = vi.hoisted(() => ({
  state: {
    flows: [] as Record<string, unknown>[],
    runs: [] as Record<string, unknown>[],
    /** Payloads inseridos em `flow_runs` — qual fluxo realmente começou. */
    runInserts: [] as Record<string, unknown>[],
    /** Filtros de cada consulta a `flow_runs`, para assertar a chave. */
    runQueries: [] as [string, string, unknown][][],
  },
}));

vi.mock('./admin-client', () => {
  const { state } = h;

  function applyFilters(
    rows: Record<string, unknown>[],
    filters: [string, string, unknown][]
  ) {
    let out = rows.slice();
    for (const [op, k, v] of filters) {
      if (op === 'eq') out = out.filter((r) => r[k] === v);
      else if (op === 'is')
        out = out.filter((r) => (v === null ? r[k] == null : r[k] === v));
      else if (op === 'or') {
        const wanted = String(k).match(/channel_id\.eq\.([^,)]+)/)?.[1];
        out = out.filter(
          (r) => r.channel_id == null || r.channel_id === wanted
        );
      }
    }
    return out;
  }

  function resolve(ops: {
    table: string;
    type: string;
    payload?: unknown;
    filters: [string, string, unknown][];
    single: boolean;
    ascBy: string | null;
  }) {
    const { table, type, filters } = ops;
    if (table === 'accounts')
      return { data: { blocked_at: null }, error: null };

    if (table === 'flows') {
      let rows = applyFilters(state.flows, filters);
      if (ops.ascBy) {
        rows = rows
          .slice()
          .sort((a, b) =>
            String(a[ops.ascBy as string]).localeCompare(
              String(b[ops.ascBy as string])
            )
          );
      }
      return { data: ops.single ? (rows[0] ?? null) : rows, error: null };
    }

    if (table === 'flow_runs') {
      if (type === 'insert') {
        const p = ops.payload as Record<string, unknown>;
        state.runInserts.push(p);
        return {
          data: { ...p, id: `run-${state.runInserts.length}` },
          error: null,
        };
      }
      if (type === 'update') return { data: [], error: null };
      state.runQueries.push(filters);
      const rows = applyFilters(state.runs, filters);
      return { data: ops.single ? (rows[0] ?? null) : rows, error: null };
    }

    // Grafo vazio + nenhum evento: o avanço termina sozinho, e nada
    // deste teste depende dele.
    if (table === 'flow_nodes') return { data: [], error: null };
    if (table === 'flow_run_events') return { data: [], error: null, count: 0 };
    return { data: null, error: null };
  }

  function builder(table: string) {
    const ops = {
      table,
      type: 'select',
      payload: undefined as unknown,
      filters: [] as [string, string, unknown][],
      single: false,
      ascBy: null as string | null,
    };
    const b: Record<string, unknown> = {
      select: () => b,
      insert: (p: unknown) => ((ops.type = 'insert'), (ops.payload = p), b),
      update: (p: unknown) => ((ops.type = 'update'), (ops.payload = p), b),
      delete: () => ((ops.type = 'delete'), b),
      eq: (k: string, v: unknown) => (ops.filters.push(['eq', k, v]), b),
      in: (k: string, v: unknown) => (ops.filters.push(['in', k, v]), b),
      is: (k: string, v: unknown) => (ops.filters.push(['is', k, v]), b),
      or: (expr: string) => (ops.filters.push(['or', expr, null]), b),
      filter: (k: string, _op: string, v: unknown) => (
        ops.filters.push(['filter', k, v]),
        b
      ),
      order: (col: string, opt?: { ascending?: boolean }) => {
        if (opt?.ascending !== false) ops.ascBy = col;
        return b;
      },
      limit: () => b,
      single: () => ((ops.single = true), Promise.resolve(resolve(ops))),
      maybeSingle: () => ((ops.single = true), Promise.resolve(resolve(ops))),
      then: (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) =>
        Promise.resolve(resolve(ops)).then(onF, onR),
    };
    return b;
  }

  return {
    supabaseAdmin: () => ({
      from: (t: string) => builder(t),
      rpc: () => Promise.resolve({ error: null }),
    }),
  };
});

import { dispatchInboundToFlows } from './engine';

const ACCOUNT = 'acct-1';

function flow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'flow-1',
    account_id: ACCOUNT,
    user_id: 'user-1',
    name: 'menu',
    description: null,
    status: 'active',
    trigger_type: 'keyword',
    trigger_config: { keywords: ['menu'], match: 'exact' },
    entry_node_id: 'n1',
    fallback_policy: {},
    execution_count: 0,
    last_executed_at: null,
    channel_id: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...over,
  };
}

function run(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'run-existente',
    flow_id: 'flow-1',
    account_id: ACCOUNT,
    user_id: 'user-1',
    contact_id: 'contact-1',
    conversation_id: 'conv-a',
    status: 'active',
    current_node_key: 'n1',
    started_at: '2026-08-01T00:00:00Z',
    ...over,
  };
}

function inbound(over: Record<string, unknown> = {}) {
  return {
    accountId: ACCOUNT,
    userId: 'user-1',
    contactId: 'contact-1',
    conversationId: 'conv-a',
    channelId: 'ch-a',
    message: {
      kind: 'text' as const,
      text: 'menu',
      meta_message_id: 'wamid.1',
    },
    isFirstInboundMessage: false,
    ...over,
  };
}

beforeEach(() => {
  h.state.flows = [];
  h.state.runs = [];
  h.state.runInserts = [];
  h.state.runQueries = [];
});

// ------------------------------------------------------------
// D-6 — escopo de canal do gatilho
// ------------------------------------------------------------

describe('findEntryFlow — escopo de canal (SPEC 065 D-6)', () => {
  it('fluxo escopado no canal B não responde a uma mensagem que chegou no A', async () => {
    h.state.flows = [flow({ id: 'so-do-b', channel_id: 'ch-b' })];

    const result = await dispatchInboundToFlows(inbound({ channelId: 'ch-a' }));

    expect(result.consumed).toBe(false);
    expect(result.outcome).toBe('no_match');
    expect(h.state.runInserts).toHaveLength(0);
  });

  // D-6: "o escopado ganha do genérico". Um fluxo criado para o número
  // de Suporte não pode perder para o menu geral só por ter sido criado
  // depois — a ordem de `created_at` decidiria isso por acidente.
  it('com a mesma palavra-chave, o escopado ganha do genérico mesmo sendo mais novo', async () => {
    h.state.flows = [
      flow({
        id: 'generico',
        channel_id: null,
        created_at: '2026-01-01T00:00:00Z',
      }),
      flow({
        id: 'do-canal-a',
        channel_id: 'ch-a',
        created_at: '2026-08-01T00:00:00Z',
      }),
    ];

    await dispatchInboundToFlows(inbound({ channelId: 'ch-a' }));

    expect(h.state.runInserts).toHaveLength(1);
    expect(h.state.runInserts[0].flow_id).toBe('do-canal-a');
  });

  it('sem fluxo escopado, o genérico continua atendendo', async () => {
    h.state.flows = [flow({ id: 'generico', channel_id: null })];

    await dispatchInboundToFlows(inbound({ channelId: 'ch-a' }));

    expect(h.state.runInserts[0]?.flow_id).toBe('generico');
  });

  // Entre dois escopados no mesmo canal, o desempate continua sendo o
  // mais antigo — o critério que já valia antes desta SPEC.
  it('entre dois escopados no mesmo canal, vence o mais antigo', async () => {
    h.state.flows = [
      flow({
        id: 'novo',
        channel_id: 'ch-a',
        created_at: '2026-08-01T00:00:00Z',
      }),
      flow({
        id: 'antigo',
        channel_id: 'ch-a',
        created_at: '2026-01-01T00:00:00Z',
      }),
    ];

    await dispatchInboundToFlows(inbound({ channelId: 'ch-a' }));

    expect(h.state.runInserts[0]?.flow_id).toBe('antigo');
  });
});

// ------------------------------------------------------------
// D-7 — execução ativa por CONVERSA, não por contato
// ------------------------------------------------------------

describe('execução ativa por conversa (SPEC 065 D-7)', () => {
  // O C2 do inventário, e ele falha em SILÊNCIO: hoje
  // `idx_one_active_run_per_contact` deixa o mesmo contato ter UMA
  // execução ativa em toda a conta. O cliente escreve no segundo número,
  // o motor acha a execução do primeiro e trata a mensagem como resposta
  // dela — ou o INSERT colide com 23505 e vira
  // `duplicate_inbound_ignored`. Nos dois casos, o fluxo do segundo
  // número simplesmente não responde.
  it('o mesmo contato mantém execução ativa em CADA conversa, em paralelo', async () => {
    h.state.flows = [flow({ id: 'menu-b', channel_id: 'ch-b' })];
    // Já existe execução ativa do contato — mas na conversa A.
    h.state.runs = [run({ id: 'run-a', conversation_id: 'conv-a' })];

    await dispatchInboundToFlows(
      inbound({ conversationId: 'conv-b', channelId: 'ch-b' })
    );

    // A execução da conversa A não pode ser confundida com a de B.
    expect(h.state.runInserts).toHaveLength(1);
    expect(h.state.runInserts[0].conversation_id).toBe('conv-b');
    expect(h.state.runInserts[0].flow_id).toBe('menu-b');
  });

  it('a execução ativa é procurada pela CONVERSA, não pelo contato', async () => {
    h.state.runs = [run({ id: 'run-a', conversation_id: 'conv-a' })];

    await dispatchInboundToFlows(inbound({ conversationId: 'conv-b' }));

    const chain = h.state.runQueries[0] ?? [];
    const eqs = chain.filter((f) => f[0] === 'eq').map((f) => [f[1], f[2]]);
    expect(eqs).toContainEqual(['conversation_id', 'conv-b']);
    expect(eqs.map((e) => e[0])).not.toContain('contact_id');
  });

  it('a mensagem na MESMA conversa continua avançando a execução existente', async () => {
    h.state.runs = [run({ id: 'run-a', conversation_id: 'conv-a' })];

    const result = await dispatchInboundToFlows(
      inbound({ conversationId: 'conv-a' })
    );

    // Nenhuma execução nova: a de `conv-a` foi encontrada e assumiu.
    expect(h.state.runInserts).toHaveLength(0);
    expect(result.consumed).toBe(true);
  });
});
