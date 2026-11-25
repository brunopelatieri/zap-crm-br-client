import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { findStatusMessages, findStatusRecipient } from './status-scope';

function makeDb(answer: { data?: unknown; error?: unknown }) {
  const result = Promise.resolve({
    data: answer.data ?? null,
    error: answer.error ?? null,
  });
  const calls: unknown[][] = [];
  const chain = {
    select: (...a: unknown[]) => {
      calls.push(['select', ...a]);
      return chain;
    },
    eq: (...a: unknown[]) => {
      calls.push(['eq', ...a]);
      return chain;
    },
    maybeSingle: () => result,
    then: (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) =>
      result.then(onF, onR),
  };
  return {
    db: { from: () => chain } as unknown as SupabaseClient,
    calls,
  };
}

const message = (id: string, accountId: string) => ({
  id,
  conversation_id: `conv-${id}`,
  conversations: {
    account_id: accountId,
    channel_id: 'chan-1',
    channels: { type: 'whatsapp_cloud' },
  },
});

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('findStatusMessages', () => {
  it('separa as linhas da conta das linhas de outra conta', async () => {
    const { db, calls } = makeDb({
      data: [message('m1', 'acct-1'), message('m2', 'acct-2')],
    });
    expect(await findStatusMessages(db, 'wamid.1', 'acct-1')).toEqual({
      own: [
        {
          id: 'm1',
          conversationId: 'conv-m1',
          accountId: 'acct-1',
          channelId: 'chan-1',
          channelType: 'whatsapp_cloud',
        },
      ],
      foreign: true,
      failed: false,
    });
    // A conta vem da conversa (`channel_id` da mensagem é nulo no histórico).
    expect(calls[0]![1]).toContain('conversations!inner(account_id');
    expect(calls).toContainEqual(['eq', 'message_id', 'wamid.1']);
  });

  it('aceita o embed em lista e falha fechado sem conversa', async () => {
    const asList = {
      ...message('m1', 'acct-1'),
      conversations: [
        { account_id: 'acct-1', channel_id: null, channels: [{ type: 'x' }] },
      ],
    };
    const orphan = { ...message('m2', 'acct-1'), conversations: null };
    const { db } = makeDb({ data: [asList, orphan] });
    const r = await findStatusMessages(db, 'wamid.1', 'acct-1');
    expect(r.own.map((m) => [m.id, m.channelId, m.channelType])).toEqual([
      ['m1', null, 'x'],
    ]);
    expect(r.foreign).toBe(true);
  });

  it('sem conta (change sem número): todas as linhas, cada uma com a sua conta', async () => {
    const { db } = makeDb({
      data: [message('m1', 'acct-1'), message('m2', 'acct-2')],
    });
    const r = await findStatusMessages(db, 'wamid.1', null);
    expect(r.own.map((m) => m.accountId)).toEqual(['acct-1', 'acct-2']);
    expect(r.foreign).toBe(false);
  });

  it('erro de leitura: failed, sem linha nenhuma', async () => {
    const { db } = makeDb({ error: { message: 'timeout' } });
    expect(await findStatusMessages(db, 'wamid.1', 'acct-1')).toEqual({
      own: [],
      foreign: false,
      failed: true,
    });
  });
});

describe('findStatusRecipient', () => {
  const row = {
    id: 'rec-1',
    status: 'sent',
    contact_id: 'contact-1',
    broadcasts: { account_id: 'acct-1' },
    contacts: { account_id: 'acct-1' },
  };

  it('disparo da conta: devolve o destinatário com o contato', async () => {
    const { db, calls } = makeDb({ data: row });
    expect(await findStatusRecipient(db, 'wamid.1', 'acct-1')).toEqual({
      own: { id: 'rec-1', status: 'sent', contactId: 'contact-1' },
      foreign: false,
      failed: false,
    });
    expect(calls).toContainEqual(['eq', 'whatsapp_message_id', 'wamid.1']);
  });

  it.each([
    ['de outra conta', { ...row, broadcasts: { account_id: 'acct-2' } }],
    ['sem disparo no embed', { ...row, broadcasts: null }],
  ])('disparo %s: foreign', async (_label, data) => {
    const { db } = makeDb({ data });
    expect(await findStatusRecipient(db, 'wamid.1', 'acct-1')).toEqual({
      own: null,
      foreign: true,
      failed: false,
    });
  });

  it.each([
    ['de outra conta', { account_id: 'acct-2' }],
    ['apagado', null],
  ])('contato %s: o destinatário vem sem contato', async (_label, contacts) => {
    const { db } = makeDb({ data: { ...row, contacts } });
    const r = await findStatusRecipient(db, 'wamid.1', 'acct-1');
    expect(r.own).toEqual({ id: 'rec-1', status: 'sent', contactId: null });
  });

  it('sem conta (change sem número): vale o disparo, seja de quem for', async () => {
    const { db } = makeDb({ data: row });
    expect((await findStatusRecipient(db, 'wamid.1', null)).own?.id).toBe(
      'rec-1'
    );
  });

  it('inexistente e erro de leitura', async () => {
    const none = { own: null, foreign: false };
    expect(
      await findStatusRecipient(makeDb({}).db, 'wamid.1', 'acct-1')
    ).toEqual({ ...none, failed: false });
    expect(
      await findStatusRecipient(
        makeDb({ error: { message: 'x' } }).db,
        'wamid.1',
        'acct-1'
      )
    ).toEqual({ ...none, failed: true });
  });
});
