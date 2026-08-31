import { describe, expect, it, vi } from 'vitest';

import { hydrateBroadcastReply } from './hydrate-reply';
import { createSupabaseMock, opArgs } from '../audience/supabase-mock';

const ACCOUNT = 'acct-1';
const CONVERSATION = 'conv-1';
const CONTACT = 'contact-1';
const BROADCAST = 'broadcast-1';
const RECIPIENT = 'recipient-1';

const SENT_AT = '2026-08-20T12:00:00.000Z';
const WAMID = 'wamid.XXXX';

function baseParams() {
  return {
    conversationId: CONVERSATION,
    accountId: ACCOUNT,
    contactId: CONTACT,
    broadcastId: BROADCAST,
    recipientId: RECIPIENT,
  };
}

describe('hydrateBroadcastReply', () => {
  it('insere o template com created_at = sent_at e broadcast_id setado', async () => {
    const inserted: Record<string, unknown>[] = [];

    const mock = createSupabaseMock((table, ops) => {
      if (table === 'broadcast_recipients') {
        return { data: { sent_at: SENT_AT, whatsapp_message_id: WAMID } };
      }
      if (table === 'messages') {
        const insertArgs = opArgs(ops, 'insert');
        if (insertArgs) {
          inserted.push(insertArgs[0] as Record<string, unknown>);
          return { data: null };
        }
        // Checagem de replay (R-8): nenhuma mensagem com este wamid ainda.
        return { data: null };
      }
      if (table === 'broadcasts') {
        return {
          data: {
            template_name: 'promo',
            template_language: 'pt_BR',
            template_variables: {},
          },
        };
      }
      if (table === 'contacts') {
        return {
          data: { id: CONTACT, name: 'Alice', phone: '+5511999990001' },
        };
      }
      if (table === 'message_templates') {
        return {
          data: [
            {
              body_text: 'Olá {{1}}, promoção especial!',
              header_type: null,
              header_content: null,
              footer_text: 'Responda SAIR para descadastrar',
              buttons: null,
              waba_id: null,
            },
          ],
        };
      }
      return undefined;
    });

    await hydrateBroadcastReply(mock.db, baseParams());

    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({
      conversation_id: CONVERSATION,
      sender_type: 'agent',
      content_type: 'template',
      template_name: 'promo',
      message_id: WAMID,
      status: 'sent',
      created_at: SENT_AT,
      broadcast_id: BROADCAST,
    });
    expect((inserted[0].template_preview as { body: string }).body).toContain(
      'promoção especial'
    );
  });

  it('sem sent_at ainda não hidrata (R-11 — corrida com o fan-out)', async () => {
    const mock = createSupabaseMock((table) => {
      if (table === 'broadcast_recipients') {
        // Fan-out ainda não carimbou esta linha.
        return { data: { sent_at: null, whatsapp_message_id: null } };
      }
      return undefined;
    });

    await hydrateBroadcastReply(mock.db, baseParams());

    expect(mock.callsFor('messages')).toHaveLength(0);
  });

  it('não duplica a bolha em replay do webhook (R-8)', async () => {
    const mock = createSupabaseMock((table, ops) => {
      if (table === 'broadcast_recipients') {
        return { data: { sent_at: SENT_AT, whatsapp_message_id: WAMID } };
      }
      if (table === 'messages') {
        // Já existe uma mensagem com este message_id nesta conversa.
        if (!opArgs(ops, 'insert')) return { data: { id: 'msg-already' } };
        return { data: null };
      }
      return undefined;
    });

    await hydrateBroadcastReply(mock.db, baseParams());

    expect(mock.callsFor('messages').some((c) => opArgs(c.ops, 'insert'))).toBe(
      false
    );
  });

  it('sem a linha local do template, cai para texto simples — nunca bolha vazia (R-6)', async () => {
    const inserted: Record<string, unknown>[] = [];
    const mock = createSupabaseMock((table, ops) => {
      if (table === 'broadcast_recipients') {
        return { data: { sent_at: SENT_AT, whatsapp_message_id: WAMID } };
      }
      if (table === 'messages') {
        const insertArgs = opArgs(ops, 'insert');
        if (insertArgs) {
          inserted.push(insertArgs[0] as Record<string, unknown>);
          return { data: null };
        }
        return { data: null };
      }
      if (table === 'broadcasts') {
        return {
          data: {
            template_name: 'removido-da-meta',
            template_language: 'pt_BR',
            template_variables: {},
          },
        };
      }
      if (table === 'contacts') {
        return {
          data: { id: CONTACT, name: 'Alice', phone: '+5511999990001' },
        };
      }
      if (table === 'message_templates') {
        // Template não sincronizado localmente.
        return { data: null };
      }
      return undefined;
    });

    await hydrateBroadcastReply(mock.db, baseParams());

    expect(inserted).toHaveLength(1);
    expect(inserted[0].content_type).toBe('text');
    expect(inserted[0].template_preview).toBeNull();
    expect(inserted[0].content_text).toBe('removido-da-meta');
  });

  // SPEC 064 D-2 — a conta tem o MESMO nome+idioma de template em dois
  // WABAs (um por número oficial). A consulta antiga
  // (`.eq('name',...).eq('language',...).maybeSingle()`) ignorava por
  // completo qual canal originou o broadcast e podia hidratar a bolha
  // com o header/botões do WABA errado. Agora `broadcasts.channel_id`
  // (D-3) resolve o WABA e `findTemplateRowForWaba` escolhe a linha certa.
  it('hidrata com a linha do WABA do canal que efetivamente disparou (dois WABAs, mesmo nome+idioma)', async () => {
    const inserted: Record<string, unknown>[] = [];
    const CHANNEL_B = 'channel-b';

    const mock = createSupabaseMock((table, ops) => {
      if (table === 'broadcast_recipients') {
        return { data: { sent_at: SENT_AT, whatsapp_message_id: WAMID } };
      }
      if (table === 'messages') {
        const insertArgs = opArgs(ops, 'insert');
        if (insertArgs) {
          inserted.push(insertArgs[0] as Record<string, unknown>);
          return { data: null };
        }
        return { data: null };
      }
      if (table === 'broadcasts') {
        return {
          data: {
            template_name: 'promo',
            template_language: 'pt_BR',
            template_variables: {},
            channel_id: CHANNEL_B,
          },
        };
      }
      if (table === 'contacts') {
        return {
          data: { id: CONTACT, name: 'Alice', phone: '+5511999990001' },
        };
      }
      if (table === 'whatsapp_config') {
        return { data: { waba_id: 'waba-b' } };
      }
      if (table === 'message_templates') {
        return {
          data: [
            {
              id: 't-a',
              waba_id: 'waba-a',
              body_text: 'Corpo do WABA A',
              header_type: null,
              header_content: null,
              footer_text: null,
              buttons: null,
            },
            {
              id: 't-b',
              waba_id: 'waba-b',
              body_text: 'Corpo do WABA B',
              header_type: null,
              header_content: null,
              footer_text: null,
              buttons: null,
            },
          ],
        };
      }
      return undefined;
    });

    await hydrateBroadcastReply(mock.db, baseParams());

    expect(inserted).toHaveLength(1);
    expect((inserted[0].template_preview as { body: string }).body).toBe(
      'Corpo do WABA B'
    );
  });

  // Achado de code review: a leitura do `waba_id` (via
  // `resolveWabaIdForChannel`) ignorava `error` e degradava uma falha
  // transitória para o mesmo `null` de "canal genuinamente sem WABA" —
  // sem log, as duas causas eram indistinguíveis. Agora o helper loga.
  it('loga (mas não lança) quando a leitura de waba_id falha — degrada para linha legada', async () => {
    const inserted: Record<string, unknown>[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const mock = createSupabaseMock((table, ops) => {
      if (table === 'broadcast_recipients') {
        return { data: { sent_at: SENT_AT, whatsapp_message_id: WAMID } };
      }
      if (table === 'messages') {
        const insertArgs = opArgs(ops, 'insert');
        if (insertArgs) {
          inserted.push(insertArgs[0] as Record<string, unknown>);
          return { data: null };
        }
        return { data: null };
      }
      if (table === 'broadcasts') {
        return {
          data: {
            template_name: 'promo',
            template_language: 'pt_BR',
            template_variables: {},
            channel_id: 'channel-b',
          },
        };
      }
      if (table === 'contacts') {
        return {
          data: { id: CONTACT, name: 'Alice', phone: '+5511999990001' },
        };
      }
      if (table === 'whatsapp_config') {
        // Falha transitória de leitura — não "canal sem config".
        return { data: null, error: { message: 'connection reset' } };
      }
      if (table === 'message_templates') {
        return {
          data: [
            {
              id: 't-legacy',
              waba_id: null,
              body_text: 'Corpo legado',
              header_type: null,
              header_content: null,
              footer_text: null,
              buttons: null,
            },
          ],
        };
      }
      return undefined;
    });

    await hydrateBroadcastReply(mock.db, baseParams());

    expect(spy).toHaveBeenCalled();
    expect(inserted).toHaveLength(1);
    // Best-effort: mesmo sem saber o WABA, ainda hidrata com a linha
    // legada disponível em vez de deixar a bolha sem template nenhum.
    expect((inserted[0].template_preview as { body: string }).body).toBe(
      'Corpo legado'
    );
    spy.mockRestore();
  });

  it('best-effort: um erro não propaga para quem chamou', async () => {
    const mock = createSupabaseMock(() => {
      throw new Error('boom');
    });

    await expect(
      hydrateBroadcastReply(mock.db, baseParams())
    ).resolves.toBeUndefined();
  });
});
