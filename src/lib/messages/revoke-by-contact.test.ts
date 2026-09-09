import { describe, expect, it, vi } from 'vitest';
import { markRevokedByContact } from './revoke-by-contact';

const recordActivityMock = vi.fn(async () => undefined);
vi.mock('@/lib/activity/record', () => ({
  recordActivity: (...args: unknown[]) => recordActivityMock(...(args as [])),
}));

type Resp = { data?: unknown; error?: { message: string } | null };

function makeDb(opts: { messagesSelect: Resp; channelsSelect?: Resp }) {
  const updates: Array<{ table: string; row: unknown }> = [];
  const inserts: Array<{ table: string; row: unknown }> = [];

  function chain(table: string) {
    const obj = {
      select: () => obj,
      eq: () => obj,
      is: () => obj,
      in: () => obj,
      insert: (row: unknown) => {
        inserts.push({ table, row });
        return Promise.resolve({ error: null });
      },
      update: (row: unknown) => {
        updates.push({ table, row });
        return obj;
      },
      maybeSingle: async () =>
        table === 'channels'
          ? (opts.channelsSelect ?? { data: null, error: null })
          : { data: null, error: null },
      then: (resolve: (r: Resp) => void) => {
        resolve(
          table === 'messages'
            ? opts.messagesSelect
            : table === 'channels'
              ? (opts.channelsSelect ?? { data: [], error: null })
              : { data: null, error: null }
        );
      },
    };
    return obj;
  }

  return { from: (table: string) => chain(table), updates, inserts };
}

describe('markRevokedByContact', () => {
  it('sem linha correspondente, nao faz nada', async () => {
    const db = makeDb({ messagesSelect: { data: [], error: null } });
    await markRevokedByContact(db as never, 'acct-1', 'wamid.x');
    expect(db.updates).toHaveLength(0);
    expect(db.inserts).toHaveLength(0);
  });

  it('marca deleted_at/deletion_actor=contact e grava o log (action=mark, not_attempted)', async () => {
    const db = makeDb({
      messagesSelect: {
        data: [
          {
            id: 'msg-1',
            conversation_id: 'conv-1',
            channel_id: null,
            content_type: 'text',
            content_text: 'oi, apago isso',
            media_path: null,
            created_at: '2026-09-01T00:00:00.000Z',
            deleted_at: null,
            conversations: {
              account_id: 'acct-1',
              channel_id: 'chan-1',
              contact_id: 'contact-9',
            },
          },
        ],
        error: null,
      },
      channelsSelect: {
        data: [{ id: 'chan-1', type: 'whatsapp_qr' }],
        error: null,
      },
    });

    await markRevokedByContact(db as never, 'acct-1', 'wamid.x');

    expect(db.updates).toHaveLength(1);
    expect(db.updates[0].row).toMatchObject({
      deleted_by: null,
      deletion_scope: 'revoked',
      deletion_actor: 'contact',
    });

    expect(db.inserts).toHaveLength(1);
    expect(db.inserts[0].row).toMatchObject({
      action: 'mark',
      provider_outcome: 'not_attempted',
      actor: 'contact',
      actor_user_id: null,
      channel_type: 'whatsapp_qr',
      content_preview: 'oi, apago isso',
    });

    // SPEC 075 F3 — o único caso do catálogo com actor.kind === 'contact'.
    expect(recordActivityMock).toHaveBeenCalledTimes(1);
    expect(recordActivityMock).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        accountId: 'acct-1',
        resourceType: 'message',
        action: 'message.deleted_by_contact',
        resourceId: 'msg-1',
        actor: { kind: 'contact', contactId: 'contact-9' },
        channelId: 'chan-1',
        channelType: 'whatsapp_qr',
        conversationId: 'conv-1',
        contactId: 'contact-9',
      })
    );
  });

  it('pula linha ja marcada (guarda §9.3.1 — a primeira gravacao vence)', async () => {
    const db = makeDb({
      messagesSelect: {
        data: [
          {
            id: 'msg-1',
            conversation_id: 'conv-1',
            channel_id: null,
            content_type: 'text',
            content_text: 'oi',
            media_path: null,
            created_at: '2026-09-01T00:00:00.000Z',
            deleted_at: '2026-09-01T01:00:00.000Z',
            conversations: { account_id: 'acct-1', channel_id: 'chan-1' },
          },
        ],
        error: null,
      },
    });

    await markRevokedByContact(db as never, 'acct-1', 'wamid.x');

    expect(db.updates).toHaveLength(0);
    expect(db.inserts).toHaveLength(0);
  });
});
