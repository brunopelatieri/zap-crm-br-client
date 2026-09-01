import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * SPEC 065 — escopo de canal no motor de automações (D-4, D-5, B2, B3).
 *
 * Mock próprio, e não o de `engine.test.ts`: aquele devolve UMA linha de
 * `conversations` para todo caminho de leitura, e o que se testa aqui é
 * justamente a diferença entre "a conversa daquele canal", "a conversa
 * mais recente" e "nenhuma conversa".
 */
const h = vi.hoisted(() => ({
  state: {
    /** Linhas de `automations` que o banco tem para a conta. */
    automations: [] as Record<string, unknown>[],
    /** Linhas de `conversations` do contato. */
    conversations: [] as Record<string, unknown>[],
    /** `automation_id` de cada log criado — quem realmente executou. */
    executed: [] as string[],
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
        // Só a forma que o motor usa: `channel_id.is.null,channel_id.eq.<id>`.
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
    descBy: string | null;
    nullsFirst: boolean;
  }) {
    const { table, type, filters } = ops;
    if (table === 'accounts')
      return { data: { blocked_at: null }, error: null };
    if (table === 'contacts') return { data: { id: 'contact-1' }, error: null };
    if (table === 'automations') {
      return { data: applyFilters(state.automations, filters), error: null };
    }
    if (table === 'conversations') {
      let rows = applyFilters(state.conversations, filters);
      if (ops.descBy) {
        const col = ops.descBy;
        const rank = (r: Record<string, unknown>) =>
          r[col] == null ? (ops.nullsFirst ? 1 : -1) : 0;
        rows = rows.slice().sort((a, b) => {
          const byNull = rank(b) - rank(a);
          if (byNull !== 0) return byNull;
          return String(b[col] ?? '').localeCompare(String(a[col] ?? ''));
        });
      }
      return { data: ops.single ? (rows[0] ?? null) : rows, error: null };
    }
    if (table === 'automation_logs') {
      if (type === 'insert') {
        const p = ops.payload as { automation_id?: string };
        if (p?.automation_id) state.executed.push(p.automation_id);
        return { data: { id: 'log-1' }, error: null };
      }
      return { data: null, error: null };
    }
    if (table === 'automation_steps') return { data: [], error: null };
    return { data: null, error: null };
  }

  function builder(table: string) {
    const ops = {
      table,
      type: 'select',
      payload: undefined as unknown,
      filters: [] as [string, string, unknown][],
      single: false,
      descBy: null as string | null,
      nullsFirst: true,
    };
    const b: Record<string, unknown> = {
      select: () => b,
      insert: (p: unknown) => ((ops.type = 'insert'), (ops.payload = p), b),
      update: (p: unknown) => ((ops.type = 'update'), (ops.payload = p), b),
      eq: (k: string, v: unknown) => (ops.filters.push(['eq', k, v]), b),
      is: (k: string, v: unknown) => (ops.filters.push(['is', k, v]), b),
      or: (expr: string) => (ops.filters.push(['or', expr, null]), b),
      order: (
        col: string,
        opt?: { ascending?: boolean; nullsFirst?: boolean }
      ) => {
        if (opt?.ascending === false) {
          ops.descBy = col;
          // Espelha o Postgres: `ORDER BY x DESC` é NULLS FIRST por
          // padrão. Sem isto o mock ordena NULL por último e concorda
          // com a suposição de quem escreve o teste, em vez de com o
          // banco.
          ops.nullsFirst = opt?.nullsFirst ?? true;
        }
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

vi.mock('@/lib/whatsapp/resolve-conversation', () => ({
  findOrCreateConversation: vi.fn(async () => 'conv-nova'),
}));

import {
  runAutomationsForTrigger,
  resolveConversationForAutomation,
} from './engine';
import { findOrCreateConversation } from '@/lib/whatsapp/resolve-conversation';
import type { Automation } from '@/types';

const ACCOUNT = 'acct-1';

function automation(over: Partial<Automation> = {}): Record<string, unknown> {
  return {
    id: 'auto-1',
    account_id: ACCOUNT,
    user_id: 'user-1',
    name: 'A',
    trigger_type: 'new_message_received',
    trigger_config: {},
    is_active: true,
    execution_count: 0,
    channel_id: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...over,
  } as unknown as Record<string, unknown>;
}

beforeEach(() => {
  h.state.automations = [];
  h.state.conversations = [];
  h.state.executed = [];
  vi.mocked(findOrCreateConversation).mockClear();
});

// ------------------------------------------------------------
// D-4 — escopo do gatilho
// ------------------------------------------------------------

describe('runAutomationsForTrigger — escopo de canal (SPEC 065 D-4)', () => {
  it('evento no canal A roda as sem canal E as escopadas em A, nunca as de B', async () => {
    h.state.automations = [
      automation({ id: 'sem-canal', channel_id: null }),
      automation({ id: 'de-a', channel_id: 'ch-a' }),
      automation({ id: 'de-b', channel_id: 'ch-b' }),
    ];

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: 'new_message_received',
      contactId: 'contact-1',
      channelId: 'ch-a',
      context: { message_text: 'oi', conversation_id: 'conv-a' },
    });

    expect(h.state.executed.sort()).toEqual(['de-a', 'sem-canal']);
  });

  // O POST manual de `/api/automations/engine` não sabe o canal. Rodar
  // TODAS ali faria uma automação escopada ao número de Suporte disparar
  // para um evento que não veio de canal nenhum — o oposto de escopar.
  it('despacho sem canal roda SÓ as sem canal — nunca "todas"', async () => {
    h.state.automations = [
      automation({ id: 'sem-canal', channel_id: null }),
      automation({ id: 'de-a', channel_id: 'ch-a' }),
    ];

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: 'new_message_received',
      contactId: 'contact-1',
      context: { message_text: 'oi', conversation_id: 'conv-a' },
    });

    expect(h.state.executed).toEqual(['sem-canal']);
  });
});

// ------------------------------------------------------------
// B2 / B3 / D-5 — resolução da conversa
// ------------------------------------------------------------

describe('resolveConversationId — canal da automação (SPEC 065 D-5)', () => {
  it('com canal, usa a conversa DAQUELE canal', async () => {
    h.state.conversations = [
      {
        id: 'conv-b',
        account_id: ACCOUNT,
        contact_id: 'contact-1',
        channel_id: 'ch-b',
        last_message_at: '2026-08-31T10:00:00Z',
      },
      {
        id: 'conv-a',
        account_id: ACCOUNT,
        contact_id: 'contact-1',
        channel_id: 'ch-a',
        last_message_at: '2026-08-01T10:00:00Z',
      },
    ];

    const id = await resolveConversationForAutomation({
      accountId: ACCOUNT,
      contactId: 'contact-1',
      resourceChannelId: 'ch-a',
      ownerUserId: 'user-1',
    });

    expect(id).toBe('conv-a');
    expect(findOrCreateConversation).not.toHaveBeenCalled();
  });

  // B3: hoje "Baseado em horário" e "Contato criado" morrem em
  // `no conversation for contact` porque o motor não sabe por qual
  // número abrir. Com o canal escolhido, sabe.
  it('com canal e SEM conversa, abre a conversa naquele canal (D-5)', async () => {
    h.state.conversations = [];

    const id = await resolveConversationForAutomation({
      accountId: ACCOUNT,
      contactId: 'contact-1',
      resourceChannelId: 'ch-a',
      ownerUserId: 'user-1',
    });

    expect(id).toBe('conv-nova');
    expect(findOrCreateConversation).toHaveBeenCalledWith(
      expect.anything(),
      ACCOUNT,
      'contact-1',
      'ch-a',
      'user-1'
    );
  });

  // B2: desde a migração 059 o índice único é
  // (account_id, contact_id, channel_id) — um contato que fala com dois
  // números tem DUAS conversas, e o `.maybeSingle()` de hoje estoura
  // "multiple rows", que o motor registra como passo falho com o motivo
  // errado ("conversation lookup failed").
  it('sem canal e com DUAS conversas, escolhe a mais recente em vez de errar', async () => {
    h.state.conversations = [
      {
        id: 'conv-velha',
        account_id: ACCOUNT,
        contact_id: 'contact-1',
        channel_id: 'ch-a',
        last_message_at: '2026-08-01T10:00:00Z',
      },
      {
        id: 'conv-recente',
        account_id: ACCOUNT,
        contact_id: 'contact-1',
        channel_id: 'ch-b',
        last_message_at: '2026-08-31T10:00:00Z',
      },
    ];

    const id = await resolveConversationForAutomation({
      accountId: ACCOUNT,
      contactId: 'contact-1',
      resourceChannelId: null,
      ownerUserId: 'user-1',
    });

    expect(id).toBe('conv-recente');
    expect(findOrCreateConversation).not.toHaveBeenCalled();
  });

  // D-5, segunda metade: SEM canal escolhido o comportamento NÃO muda.
  // Abrir conversa no canal padrão "porque sim" é o comportamento
  // implícito que esta SPEC existe para eliminar — e, num contato frio,
  // significaria iniciar diálogo por um número que ninguém escolheu.
  it('sem canal e sem conversa, continua falhando — nunca abre no padrão', async () => {
    h.state.conversations = [];

    await expect(
      resolveConversationForAutomation({
        accountId: ACCOUNT,
        contactId: 'contact-1',
        resourceChannelId: null,
        ownerUserId: 'user-1',
      })
    ).rejects.toThrow('no conversation for contact');
    expect(findOrCreateConversation).not.toHaveBeenCalled();
  });
});

// ------------------------------------------------------------
// Achado de code review — NULL em ORDER BY DESC
// ------------------------------------------------------------

describe('resolveConversationForAutomation — conversa sem mensagens', () => {
  // `ORDER BY x DESC` no Postgres é NULLS FIRST por padrão. Uma conversa
  // recém-aberta (transferência, envio frio, ou a própria que o D-5
  // acabou de criar) nasce com `last_message_at` NULL — e sem
  // `nullsFirst: false` ela ganharia da conversa VIVA do contato, que é
  // a mensagem saindo pelo número errado que esta SPEC existe para
  // impedir.
  it('ignora a conversa vazia e escolhe a que tem mensagem de verdade', async () => {
    h.state.conversations = [
      {
        id: 'conv-vazia',
        account_id: ACCOUNT,
        contact_id: 'contact-1',
        channel_id: 'ch-b',
        last_message_at: null,
      },
      {
        id: 'conv-viva',
        account_id: ACCOUNT,
        contact_id: 'contact-1',
        channel_id: 'ch-a',
        last_message_at: '2026-08-31T10:00:00Z',
      },
    ];

    const id = await resolveConversationForAutomation({
      accountId: ACCOUNT,
      contactId: 'contact-1',
      resourceChannelId: null,
      ownerUserId: 'user-1',
    });

    expect(id).toBe('conv-viva');
  });

  // Só conversas vazias: não há "mais recente" a escolher, mas também
  // não pode falhar — a conversa existe.
  it('com só conversas vazias, ainda devolve uma em vez de falhar', async () => {
    h.state.conversations = [
      {
        id: 'conv-vazia',
        account_id: ACCOUNT,
        contact_id: 'contact-1',
        channel_id: 'ch-a',
        last_message_at: null,
      },
    ];

    await expect(
      resolveConversationForAutomation({
        accountId: ACCOUNT,
        contactId: 'contact-1',
        resourceChannelId: null,
        ownerUserId: 'user-1',
      })
    ).resolves.toBe('conv-vazia');
  });
});
