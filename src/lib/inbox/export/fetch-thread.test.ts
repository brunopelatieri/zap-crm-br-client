import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  CONVERSATION_EXPORT_BATCH,
  CONVERSATION_EXPORT_MAX_MESSAGES,
  fetchThreadForExport,
} from './fetch-thread';

interface Op {
  name: string;
  args: unknown[];
}

interface QueryResult {
  data: unknown;
  error: { message: string } | null;
  count?: number;
}

type TableHandler = (ops: Op[]) => QueryResult;

/** Builder encadeável e "then-ável" que grava as operações recebidas —
 *  é por elas que os testes provam o `.gte()/.lte()` do período e o
 *  desempate por `id` da ordenação. */
function makeSupabase(
  handlers: Record<string, TableHandler>,
  recorded: { table: string; ops: Op[] }[] = []
): SupabaseClient {
  const chainable = ['select', 'eq', 'in', 'gte', 'lte', 'order', 'limit'];

  return {
    from(table: string) {
      const ops: Op[] = [];
      recorded.push({ table, ops });

      const handler =
        handlers[table] ??
        (() => {
          throw new Error(`consulta inesperada em "${table}"`);
        });

      const builder: Record<string, unknown> = {};
      for (const name of chainable) {
        builder[name] = (...args: unknown[]) => {
          ops.push({ name, args });
          return builder;
        };
      }
      builder.range = (...args: unknown[]) => {
        ops.push({ name: 'range', args });
        return Promise.resolve(handler(ops));
      };
      builder.maybeSingle = () => {
        ops.push({ name: 'maybeSingle', args: [] });
        return Promise.resolve(handler(ops));
      };
      builder.then = (
        resolve: (v: QueryResult) => unknown,
        reject?: (e: unknown) => unknown
      ) => Promise.resolve(handler(ops)).then(resolve, reject);

      return builder;
    },
  } as unknown as SupabaseClient;
}

const conversationRow = {
  id: 'conv-1',
  user_id: 'u1',
  account_id: 'acc-1',
  contact_id: 'contact-1',
  status: 'open',
  unread_count: 0,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
  channel_id: 'channel-a',
  contact: { id: 'contact-1', phone: '5511999999999', name: 'Maria' },
  channel: { id: 'channel-a', name: 'Oficial', type: 'whatsapp_cloud' },
};

function message(overrides: Record<string, unknown> = {}) {
  return {
    id: 'm1',
    conversation_id: 'conv-1',
    sender_type: 'customer',
    content_type: 'text',
    status: 'delivered',
    created_at: '2026-08-12T10:00:00.000Z',
    ...overrides,
  };
}

function hasOp(ops: Op[], name: string): boolean {
  return ops.some((op) => op.name === name);
}

describe('fetchThreadForExport — 404 genérico', () => {
  it('conversa inexistente (ou de outra conta) devolve null', async () => {
    const supabase = makeSupabase({
      conversations: () => ({ data: null, error: null }),
    });

    const result = await fetchThreadForExport(supabase, {
      conversationId: 'conv-1',
    });
    expect(result).toBeNull();
  });

  it('conversa sem contato visível devolve null, sem seguir para as mensagens', async () => {
    const supabase = makeSupabase({
      conversations: () => ({
        data: { ...conversationRow, contact: null },
        error: null,
      }),
      messages: () => {
        throw new Error('não deveria consultar mensagens');
      },
    });

    expect(
      await fetchThreadForExport(supabase, { conversationId: 'conv-1' })
    ).toBeNull();
  });

  it('propaga erro de consulta da conversa', async () => {
    const supabase = makeSupabase({
      conversations: () => ({ data: null, error: { message: 'boom' } }),
    });

    await expect(
      fetchThreadForExport(supabase, { conversationId: 'conv-1' })
    ).rejects.toThrow('boom');
  });
});

describe('fetchThreadForExport — teto de mensagens', () => {
  it('acima do teto devolve truncated com o total, sem baixar as mensagens', async () => {
    let pageQueries = 0;
    const supabase = makeSupabase({
      conversations: () => ({ data: conversationRow, error: null }),
      messages: (ops) => {
        if (hasOp(ops, 'range')) {
          pageQueries++;
          return { data: [], error: null };
        }
        return {
          data: null,
          error: null,
          count: CONVERSATION_EXPORT_MAX_MESSAGES + 1,
        };
      },
    });

    const result = await fetchThreadForExport(supabase, {
      conversationId: 'conv-1',
    });

    expect(result?.truncated).toBe(true);
    expect(result?.total).toBe(CONVERSATION_EXPORT_MAX_MESSAGES + 1);
    expect(result?.messages).toEqual([]);
    expect(pageQueries).toBe(0);
  });
});

describe('fetchThreadForExport — coleta', () => {
  it('pagina as mensagens até o lote vir incompleto', async () => {
    const page0 = Array.from({ length: CONVERSATION_EXPORT_BATCH }, (_, i) =>
      message({ id: `m${i}` })
    );
    const page1 = Array.from({ length: 250 }, (_, i) =>
      message({ id: `m${CONVERSATION_EXPORT_BATCH + i}` })
    );
    const ranges: unknown[][] = [];

    const supabase = makeSupabase({
      conversations: () => ({ data: conversationRow, error: null }),
      messages: (ops) => {
        const range = ops.find((op) => op.name === 'range');
        if (!range) {
          return {
            data: null,
            error: null,
            count: CONVERSATION_EXPORT_BATCH + 250,
          };
        }
        ranges.push(range.args);
        return {
          data: range.args[0] === 0 ? page0 : page1,
          error: null,
        };
      },
      message_reactions: () => ({ data: [], error: null }),
    });

    const result = await fetchThreadForExport(supabase, {
      conversationId: 'conv-1',
    });

    expect(ranges).toEqual([
      [0, CONVERSATION_EXPORT_BATCH - 1],
      [CONVERSATION_EXPORT_BATCH, CONVERSATION_EXPORT_BATCH * 2 - 1],
    ]);
    expect(result?.messages).toHaveLength(CONVERSATION_EXPORT_BATCH + 250);
    expect(result?.truncated).toBe(false);
  });

  it('ordena por created_at e desempata por id — o PDF precisa ser reproduzível', async () => {
    const recorded: { table: string; ops: Op[] }[] = [];
    const supabase = makeSupabase(
      {
        conversations: () => ({ data: conversationRow, error: null }),
        messages: (ops) =>
          hasOp(ops, 'range')
            ? { data: [message()], error: null }
            : { data: null, error: null, count: 1 },
        message_reactions: () => ({ data: [], error: null }),
      },
      recorded
    );

    await fetchThreadForExport(supabase, { conversationId: 'conv-1' });

    const pageQuery = recorded.find(
      (r) => r.table === 'messages' && hasOp(r.ops, 'range')
    );
    const orders = pageQuery!.ops.filter((op) => op.name === 'order');
    expect(orders.map((op) => op.args[0])).toEqual(['created_at', 'id']);
  });

  it('aplica o período como gte/lte na contagem e nas páginas', async () => {
    const recorded: { table: string; ops: Op[] }[] = [];
    const supabase = makeSupabase(
      {
        conversations: () => ({ data: conversationRow, error: null }),
        messages: (ops) =>
          hasOp(ops, 'range')
            ? { data: [], error: null }
            : { data: null, error: null, count: 0 },
        message_reactions: () => ({ data: [], error: null }),
      },
      recorded
    );

    await fetchThreadForExport(supabase, {
      conversationId: 'conv-1',
      from: '2026-08-01T00:00:00.000Z',
      to: '2026-08-31T23:59:59.999Z',
    });

    const messageQueries = recorded.filter((r) => r.table === 'messages');
    expect(messageQueries.length).toBeGreaterThanOrEqual(2);
    for (const query of messageQueries) {
      expect(query.ops.find((op) => op.name === 'gte')?.args).toEqual([
        'created_at',
        '2026-08-01T00:00:00.000Z',
      ]);
      expect(query.ops.find((op) => op.name === 'lte')?.args).toEqual([
        'created_at',
        '2026-08-31T23:59:59.999Z',
      ]);
    }
  });

  it('busca reações por lote de message_id, nunca uma consulta por mensagem', async () => {
    const messages = Array.from({ length: 5 }, (_, i) =>
      message({ id: `m${i}` })
    );
    let reactionQueries = 0;

    const supabase = makeSupabase({
      conversations: () => ({ data: conversationRow, error: null }),
      messages: (ops) =>
        hasOp(ops, 'range')
          ? { data: messages, error: null }
          : { data: null, error: null, count: messages.length },
      message_reactions: () => {
        reactionQueries++;
        return {
          data: [
            {
              id: 'r1',
              message_id: 'm2',
              conversation_id: 'conv-1',
              actor_type: 'customer',
              emoji: '👍',
              created_at: '2026-08-12T10:05:00.000Z',
            },
          ],
          error: null,
        };
      },
    });

    const result = await fetchThreadForExport(supabase, {
      conversationId: 'conv-1',
    });

    expect(reactionQueries).toBe(1);
    expect(result?.reactions).toHaveLength(1);
  });
});

describe('fetchThreadForExport — nomes de agente', () => {
  it('resolve sender_id de agente e actor_id de reação no mesmo mapa', async () => {
    const messages = [
      message({ id: 'm1', sender_type: 'agent', sender_id: 'user-joao' }),
    ];
    const recorded: { table: string; ops: Op[] }[] = [];

    const supabase = makeSupabase(
      {
        conversations: () => ({ data: conversationRow, error: null }),
        messages: (ops) =>
          hasOp(ops, 'range')
            ? { data: messages, error: null }
            : { data: null, error: null, count: 1 },
        message_reactions: () => ({
          data: [
            {
              id: 'r1',
              message_id: 'm1',
              conversation_id: 'conv-1',
              actor_type: 'agent',
              actor_id: 'user-ana',
              emoji: '❤️',
              created_at: '2026-08-12T10:05:00.000Z',
            },
          ],
          error: null,
        }),
        profiles: () => ({
          data: [
            { user_id: 'user-joao', full_name: 'João' },
            { user_id: 'user-ana', full_name: 'Ana' },
          ],
          error: null,
        }),
      },
      recorded
    );

    const result = await fetchThreadForExport(supabase, {
      conversationId: 'conv-1',
    });

    expect(result?.agentNames.get('user-joao')).toBe('João');
    // Regressão: sem o actor_id no lookup, a reação do colega sairia
    // como "agente removido" no documento.
    expect(result?.agentNames.get('user-ana')).toBe('Ana');

    const profileQuery = recorded.find((r) => r.table === 'profiles');
    const inOp = profileQuery!.ops.find((op) => op.name === 'in');
    expect(inOp?.args[1]).toEqual(
      expect.arrayContaining(['user-joao', 'user-ana'])
    );
  });

  it('agente que saiu da conta simplesmente não entra no mapa', async () => {
    const supabase = makeSupabase({
      conversations: () => ({ data: conversationRow, error: null }),
      messages: (ops) =>
        hasOp(ops, 'range')
          ? {
              data: [
                message({
                  id: 'm1',
                  sender_type: 'agent',
                  sender_id: 'user-removido',
                }),
              ],
              error: null,
            }
          : { data: null, error: null, count: 1 },
      message_reactions: () => ({ data: [], error: null }),
      profiles: () => ({ data: [], error: null }),
    });

    const result = await fetchThreadForExport(supabase, {
      conversationId: 'conv-1',
    });

    expect(result?.agentNames.size).toBe(0);
  });

  it('não consulta profiles quando só há mensagem de cliente', async () => {
    const supabase = makeSupabase({
      conversations: () => ({ data: conversationRow, error: null }),
      messages: (ops) =>
        hasOp(ops, 'range')
          ? { data: [message()], error: null }
          : { data: null, error: null, count: 1 },
      message_reactions: () => ({ data: [], error: null }),
      profiles: () => {
        throw new Error('não deveria consultar profiles');
      },
    });

    const result = await fetchThreadForExport(supabase, {
      conversationId: 'conv-1',
    });
    expect(result?.agentNames.size).toBe(0);
  });
});
