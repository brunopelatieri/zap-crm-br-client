/**
 * `bindChannelToPhone` — o canal QRCode é o NÚMERO, não a instância.
 *
 * O cenário real que originou a regra: o mantenedor excluiu a instância
 * pelo CRM e pareou o mesmo WhatsApp de novo. Como cada criação abre um
 * `channels` novo e `conversations.channel_id` é NOT NULL (059), todo o
 * histórico do número ficava preso ao canal velho — conversas invisíveis
 * em vez de apagadas, que é o pior tipo de perda.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: (v: string) => v,
  encrypt: (v: string) => v,
}));

vi.mock('@/lib/evolution/config', () => ({
  readEvolutionConfig: () => null,
}));

interface RecordedOp {
  table: string;
  verb: 'select' | 'insert' | 'update' | 'delete';
  payload?: unknown;
  filters: Array<[string, ...unknown[]]>;
}

type Result = { data?: unknown; error?: unknown; count?: number };

/**
 * Fake com FILA por `tabela.verbo`: `bindChannelToPhone` faz DOIS
 * `channels.select` diferentes (o canal atual, depois o canal do
 * número), e um mapa simples devolveria a mesma linha para os dois.
 */
function makeDb(queues: Record<string, Result[]>) {
  const ops: RecordedOp[] = [];
  const pending = new Map<string, Result[]>(
    Object.entries(queues).map(([k, v]) => [k, [...v]])
  );

  function builder(table: string) {
    const op: RecordedOp = { table, verb: 'select', filters: [] };
    let recorded = false;
    const settle = (): Result => {
      if (!recorded) {
        ops.push(op);
        recorded = true;
      }
      const queue = pending.get(`${table}.${op.verb}`);
      const next = queue?.shift();
      return next ?? { data: null, error: null, count: 0 };
    };

    const chain: Record<string, unknown> = {
      then(resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) {
        return Promise.resolve(settle()).then(resolve, reject);
      },
      update: (payload?: unknown) => {
        op.verb = 'update';
        op.payload = payload;
        return chain;
      },
      delete: () => {
        op.verb = 'delete';
        return chain;
      },
      select: (...args: unknown[]) => {
        op.filters.push(['select', ...args]);
        return chain;
      },
      eq: (...args: unknown[]) => {
        op.filters.push(['eq', ...args]);
        return chain;
      },
      neq: (...args: unknown[]) => {
        op.filters.push(['neq', ...args]);
        return chain;
      },
      order: (...args: unknown[]) => {
        op.filters.push(['order', ...args]);
        return chain;
      },
      limit: (...args: unknown[]) => {
        op.filters.push(['limit', ...args]);
        return chain;
      },
      maybeSingle: () => Promise.resolve(settle()),
      single: () => Promise.resolve(settle()),
    };
    return chain;
  }

  return { client: { from: (t: string) => builder(t) }, ops };
}

let currentDb = makeDb({});
vi.mock('@/lib/supabase/admin', () => ({
  supabaseAdmin: () => currentDb.client,
}));

import { bindChannelToPhone, listEvolutionInstances } from './instances';

const INPUT = {
  accountId: 'acct-1',
  instanceId: 'inst-nova',
  channelId: 'chan-nova',
  phone: '5519991234567',
};

function opsFor(table: string, verb?: RecordedOp['verb']) {
  return currentDb.ops.filter(
    (o) => o.table === table && (verb ? o.verb === verb : true)
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('sem canal anterior para o número', () => {
  beforeEach(() => {
    currentDb = makeDb({
      'channels.select': [
        { data: { name: 'bruno', identifier: null } }, // canal atual
        { data: null }, // nenhum canal anterior com este número
      ],
    });
  });

  it('carimba o identifier e devolve o próprio canal', async () => {
    const result = await bindChannelToPhone(INPUT);

    expect(result).toEqual({ channelId: 'chan-nova', adopted: false });
    const update = opsFor('channels', 'update')[0];
    expect(update.payload).toEqual({ identifier: '5519991234567' });
  });

  it('não reaponta a instância nem apaga canal nenhum', async () => {
    await bindChannelToPhone(INPUT);

    expect(opsFor('evolution_instances', 'update')).toHaveLength(0);
    expect(opsFor('channels', 'delete')).toHaveLength(0);
  });
});

describe('número repareado — canal anterior existe', () => {
  function planWithPrevious(
    conversationCount = 0,
    over: Record<string, Result[]> = {}
  ) {
    return makeDb({
      'channels.select': [
        { data: { name: 'bruno teste 2', identifier: null } },
        { data: { id: 'chan-antiga' } },
      ],
      'conversations.select': [{ count: conversationCount }],
      ...over,
    });
  }

  it('reaponta a instância para o canal que já atendia o número', async () => {
    currentDb = planWithPrevious();

    const result = await bindChannelToPhone(INPUT);

    expect(result).toEqual({ channelId: 'chan-antiga', adopted: true });
    const repoint = opsFor('evolution_instances', 'update')[0];
    expect(repoint.payload).toEqual({ channel_id: 'chan-antiga' });
    expect(repoint.filters).toContainEqual(['eq', 'id', 'inst-nova']);
  });

  it('reativa o canal adotado e leva o rótulo novo junto', async () => {
    currentDb = planWithPrevious();

    await bindChannelToPhone(INPUT);

    const adopted = opsFor('channels', 'update').find((o) =>
      o.filters.some(
        ([verb, col, val]) =>
          verb === 'eq' && col === 'id' && val === 'chan-antiga'
      )
    );
    expect(adopted?.payload).toMatchObject({
      identifier: '5519991234567',
      status: 'connected',
      status_detail: null,
      // O operador acabou de escolher este nome ao recriar a instância.
      name: 'bruno teste 2',
    });
  });

  it('apaga o canal recém-criado, que ficou sem instância e sem conversa', async () => {
    currentDb = planWithPrevious();

    await bindChannelToPhone(INPUT);

    const del = opsFor('channels', 'delete')[0];
    expect(del.filters).toContainEqual(['eq', 'id', 'chan-nova']);
  });

  it('procura o canal anterior escopado por conta, tipo e número', async () => {
    currentDb = planWithPrevious();

    await bindChannelToPhone(INPUT);

    const lookup = opsFor('channels', 'select')[1];
    expect(lookup.filters).toContainEqual(['eq', 'account_id', 'acct-1']);
    expect(lookup.filters).toContainEqual(['eq', 'type', 'whatsapp_qr']);
    expect(lookup.filters).toContainEqual([
      'eq',
      'identifier',
      '5519991234567',
    ]);
    expect(lookup.filters).toContainEqual(['neq', 'id', 'chan-nova']);
  });

  it('ABORTA a adoção se o canal novo já tem conversas — nunca órfã histórico', async () => {
    // Fora do fluxo normal (mensagem só trafega depois do pareamento),
    // mas dois canais separados incomodam; histórico órfão é perda.
    currentDb = planWithPrevious(3);

    const result = await bindChannelToPhone(INPUT);

    expect(result).toEqual({ channelId: 'chan-nova', adopted: false });
    expect(opsFor('evolution_instances', 'update')).toHaveLength(0);
    expect(opsFor('channels', 'delete')).toHaveLength(0);
  });

  it('não apaga o canal novo se o reaponte da instância falhou', async () => {
    currentDb = planWithPrevious(0, {
      'evolution_instances.update': [{ error: { message: 'boom' } }],
    });

    const result = await bindChannelToPhone(INPUT);

    expect(result.adopted).toBe(false);
    expect(opsFor('channels', 'delete')).toHaveLength(0);
  });

  it('cai para disabled quando o canal novo não pode ser apagado', async () => {
    currentDb = planWithPrevious(0, {
      'channels.delete': [{ error: { message: 'fk violation' } }],
    });

    const result = await bindChannelToPhone(INPUT);

    expect(result.adopted).toBe(true);
    const fallback = opsFor('channels', 'update').at(-1);
    expect(fallback?.payload).toMatchObject({ status: 'disabled' });
  });
});

describe('identifier já correto', () => {
  it('não reescreve o identifier à toa', async () => {
    currentDb = makeDb({
      'channels.select': [
        { data: { name: 'bruno', identifier: '5519991234567' } },
        { data: null },
      ],
    });

    await bindChannelToPhone(INPUT);

    expect(opsFor('channels', 'update')).toHaveLength(0);
  });
});

describe('listEvolutionInstances — SPEC 069 §6.7 (F9)', () => {
  /** Fake mínimo com `.rpc()` — a cascata de limites usa a RPC de
   *  conta, o resto da leitura são `.select()` comuns. */
  function makeListDb(opts: {
    instanceRow: Record<string, unknown>;
    channelRow: Record<string, unknown>;
    accountLimits?: Record<string, unknown>;
  }) {
    return {
      rpc: (fn: string) => {
        if (fn === 'account_effective_limits') {
          return Promise.resolve({
            data: opts.accountLimits ?? {},
            error: null,
          });
        }
        return Promise.resolve({ data: null, error: null });
      },
      from: (table: string) => {
        const chain: Record<string, unknown> = {
          select: () => chain,
          eq: () => chain,
          in: () => chain,
          order: () => chain,
          maybeSingle: () => {
            if (table === 'evolution_instances') {
              return Promise.resolve({ data: opts.instanceRow, error: null });
            }
            return Promise.resolve({ data: null, error: null });
          },
          then: (resolve: (v: unknown) => unknown) => {
            if (table === 'evolution_instances') {
              return Promise.resolve({
                data: [opts.instanceRow],
                error: null,
              }).then(resolve);
            }
            if (table === 'channels') {
              return Promise.resolve({
                data: [opts.channelRow],
                error: null,
              }).then(resolve);
            }
            return Promise.resolve({ data: null, error: null }).then(resolve);
          },
        };
        return chain;
      },
    };
  }

  it('traz os switches, o teto de captação e os limites resolvidos com o nível de origem', async () => {
    currentDb = {
      client: makeListDb({
        instanceRow: {
          id: 'inst-1',
          channel_id: 'chan-1',
          connected_phone: '5511900000001',
          connected_jid: '5511900000001@s.whatsapp.net',
          last_qr_at: null,
          created_at: '2026-01-01T00:00:00Z',
          check_enabled: true,
          harvest_enabled: false,
          harvest_max_contacts: null,
          harvested_count: 0,
        },
        channelRow: {
          id: 'chan-1',
          name: 'Comercial',
          status: 'connected',
          status_detail: null,
          is_default: false,
        },
        accountLimits: { evolution_cold_send_per_day: 150 },
      }),
    } as unknown as typeof currentDb;

    const [summary] = await listEvolutionInstances('acct-1');

    expect(summary.checkEnabled).toBe(true);
    expect(summary.harvestEnabled).toBe(false);
    expect(summary.harvestMaxContacts).toBeNull();
    expect(summary.limits.coldSendPerDay).toEqual({
      value: 150,
      level: 'account',
    });
    expect(summary.limits.checkPerDay).toEqual({ value: 300, level: 'code' });
    expect(summary.limits.harvestMaxPerInstance.hardCap).toBe(2000);
  });

  it('canal órfão (apagado fora do fluxo normal) é omitido, não derruba a lista', async () => {
    currentDb = {
      client: makeListDb({
        instanceRow: {
          id: 'inst-1',
          channel_id: 'chan-orfa',
          connected_phone: null,
          connected_jid: null,
          last_qr_at: null,
          created_at: '2026-01-01T00:00:00Z',
          check_enabled: false,
          harvest_enabled: false,
          harvest_max_contacts: null,
          harvested_count: 0,
        },
        channelRow: {
          id: 'chan-outro',
          name: 'x',
          status: 'connected',
          status_detail: null,
          is_default: false,
        },
      }),
    } as unknown as typeof currentDb;

    const result = await listEvolutionInstances('acct-1');
    expect(result).toEqual([]);
  });
});
