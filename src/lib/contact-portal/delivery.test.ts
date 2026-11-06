import type { SupabaseClient } from '@supabase/supabase-js';
import { createTranslator } from 'next-intl';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import en from '../../../messages/en.json';
import ptBR from '../../../messages/pt-BR.json';

const sendAndPersistOutbound = vi.fn();
const resolveDefaultChannelId = vi.fn();
const findOrCreateConversation = vi.fn();

vi.mock('@/lib/channels/send', () => ({
  sendAndPersistOutbound: (...a: unknown[]) => sendAndPersistOutbound(...a),
}));
vi.mock('@/lib/channels/default-channel', () => ({
  resolveDefaultChannelId: (...a: unknown[]) => resolveDefaultChannelId(...a),
}));
vi.mock('@/lib/whatsapp/resolve-conversation', () => ({
  findOrCreateConversation: (...a: unknown[]) => findOrCreateConversation(...a),
}));

import { ColdSendLimitError } from '@/lib/channels/cold-send-wiring';

import {
  PORTAL_CODE_MARKER,
  accessLink,
  chooseDeliveryMode,
  composeCodeText,
  deliverAccessCode,
  loadAuthTemplate,
  looksLikePortalCodeMessage,
} from './delivery';

const HOUR = 3600 * 1000;
const now = new Date('2026-10-30T12:00:00Z');

type Rows = Record<string, Record<string, unknown> | null>;

/** `from(t).select().eq()…maybeSingle()` devolvendo a linha de `rows[t]`. */
function fakeDb(rows: Rows) {
  return {
    from(table: string) {
      const chain = {
        select: () => chain,
        eq: () => chain,
        maybeSingle: async () => ({ data: rows[table] ?? null, error: null }),
      };
      return chain;
    },
  } as unknown as SupabaseClient;
}

const tEn = createTranslator({
  locale: 'en',
  messages: en,
  namespace: 'ContactPortal.whatsapp',
}) as unknown as Parameters<typeof composeCodeText>[0];

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_APP_LOCALE', 'pt-BR');
  sendAndPersistOutbound.mockResolvedValue({ whatsapp_message_id: 'w1' });
});

describe('chooseDeliveryMode', () => {
  it('QRCode: sempre texto livre (não tem janela da Meta)', () => {
    expect(
      chooseDeliveryMode({
        channelType: 'whatsapp_qr',
        lastCustomerMessageAt: null,
        hasAuthTemplate: false,
        now,
      })
    ).toBe('text');
  });

  it('Cloud dentro da janela: texto livre (a J2 sempre cai aqui)', () => {
    expect(
      chooseDeliveryMode({
        channelType: 'whatsapp_cloud',
        lastCustomerMessageAt: new Date(now.getTime() - 2 * HOUR),
        hasAuthTemplate: false,
        now,
      })
    ).toBe('text');
  });

  it('Cloud fora da janela: template; sem template, needs_template', () => {
    const old = new Date(now.getTime() - 30 * HOUR);
    expect(
      chooseDeliveryMode({
        channelType: 'whatsapp_cloud',
        lastCustomerMessageAt: old,
        hasAuthTemplate: true,
        now,
      })
    ).toBe('template');
    expect(
      chooseDeliveryMode({
        channelType: 'whatsapp_cloud',
        lastCustomerMessageAt: null,
        hasAuthTemplate: false,
        now,
      })
    ).toBe('needs_template');
  });
});

describe('accessLink', () => {
  it('código no fragmento (não vai ao servidor nem ao log do proxy)', () => {
    expect(
      accessLink('https://dev.valenranch.com.br/', 'ABCD2345', '012345')
    ).toBe('https://dev.valenranch.com.br/area/c/ABCD2345/codigo#c=012345');
  });

  it('sem origem pública: sem link', () => {
    expect(accessLink(null, 'ABCD2345', '012345')).toBeNull();
    expect(accessLink('  ', 'ABCD2345', '012345')).toBeNull();
  });
});

describe('composeCodeText', () => {
  it('começa pelo marcador, traz código, conta, validade e link', () => {
    const text = composeCodeText(tEn, {
      kind: 'code',
      code: '048213',
      accountName: 'Valen Ranch',
      link: 'https://x/area/c/ABCD2345/codigo#c=048213',
    });
    expect(text.startsWith(`${PORTAL_CODE_MARKER} `)).toBe(true);
    expect(text).toContain('048213');
    expect(text).toContain('Valen Ranch');
    expect(text).toContain('10 minutes');
    expect(text).toContain('https://x/area/c/ABCD2345/codigo#c=048213');
  });

  it('convite anuncia a validade do convite (24 h)', () => {
    const text = composeCodeText(tEn, {
      kind: 'invite',
      code: '048213',
      accountName: 'Valen Ranch',
      link: null,
    });
    expect(text).toContain('24 hours');
    expect(text).not.toContain('Sign in');
  });

  it('as chaves existem nos dois dicionários', () => {
    for (const messages of [en, ptBR]) {
      const ns = (messages as { ContactPortal: { whatsapp: object } })
        .ContactPortal.whatsapp;
      expect(Object.keys(ns).sort()).toEqual([
        'codeMessage',
        'inviteMessage',
        'redactedBody',
        'signInLink',
      ]);
    }
  });
});

describe('eco fromMe', () => {
  it('reconhece a mensagem de código pelo marcador + 6 dígitos', () => {
    expect(
      looksLikePortalCodeMessage(`${PORTAL_CODE_MARKER} 048213 é o seu…`)
    ).toBe(true);
    expect(looksLikePortalCodeMessage('048213 é o seu código')).toBe(false);
    expect(looksLikePortalCodeMessage(`${PORTAL_CODE_MARKER} sem código`)).toBe(
      false
    );
    expect(looksLikePortalCodeMessage(null)).toBe(false);
  });
});

describe('deliverAccessCode', () => {
  const base = {
    accountId: 'acc1',
    accountName: 'Valen Ranch',
    contactId: 'c1',
    code: '048213',
    kind: 'code' as const,
    publicCode: 'ABCD2345',
    channelId: 'ch1',
    authTemplate: null,
    siteOrigin: 'https://dev.valenranch.com.br',
  };

  it('QRCode: provedor recebe o código; o banco do inbox, o texto redigido', async () => {
    findOrCreateConversation.mockResolvedValue('conv1');
    const db = fakeDb({
      accounts: { owner_user_id: 'u1' },
      conversations: { channel_id: 'ch1', last_customer_message_at: null },
      channels: { type: 'whatsapp_qr' },
    });

    expect(await deliverAccessCode({ ...base, db })).toEqual({
      ok: true,
      via: 'text',
    });

    expect(findOrCreateConversation).toHaveBeenCalledWith(
      db,
      'acc1',
      'c1',
      'ch1',
      'u1'
    );
    const call = sendAndPersistOutbound.mock.calls[0][0];
    expect(call.origin).toBe('contact_portal');
    expect(call.conversationId).toBe('conv1');
    expect(call.content.kind).toBe('text');
    expect(call.content.text).toContain('048213');
    expect(call.persist.contentText).toBe('[código de acesso enviado]');
    expect(call.persist.previewText).toBe('[código de acesso enviado]');
    expect(JSON.stringify(call.persist)).not.toContain('048213');
  });

  it('Cloud fora da janela, com template: AUTHENTICATION com componentes prontos', async () => {
    findOrCreateConversation.mockResolvedValue('conv1');
    const db = fakeDb({
      accounts: { owner_user_id: 'u1' },
      conversations: { channel_id: 'ch1', last_customer_message_at: null },
      channels: { type: 'whatsapp_cloud' },
    });

    const r = await deliverAccessCode({
      ...base,
      db,
      authTemplate: { name: 'area_codigo', language: 'pt_BR' },
    });
    expect(r).toEqual({ ok: true, via: 'template' });

    const call = sendAndPersistOutbound.mock.calls[0][0];
    expect(call.content).toMatchObject({
      kind: 'template',
      templateName: 'area_codigo',
      language: 'pt_BR',
    });
    expect(JSON.stringify(call.content.rawComponents)).toContain('048213');
    expect(call.persist).toMatchObject({
      contentType: 'template',
      contentText: '[código de acesso enviado]',
      extra: { template_name: 'area_codigo' },
    });
  });

  it('Cloud fora da janela, sem template: não envia e avisa', async () => {
    findOrCreateConversation.mockResolvedValue('conv1');
    const db = fakeDb({
      accounts: { owner_user_id: 'u1' },
      conversations: { channel_id: 'ch1', last_customer_message_at: null },
      channels: { type: 'whatsapp_cloud' },
    });
    expect(await deliverAccessCode({ ...base, db })).toEqual({
      ok: false,
      reason: 'needs_template',
    });
    expect(sendAndPersistOutbound).not.toHaveBeenCalled();
  });

  it('J2: responde na conversa recebida, sem procurar canal', async () => {
    const db = fakeDb({
      conversations: {
        channel_id: 'ch9',
        last_customer_message_at: new Date().toISOString(),
      },
      channels: { type: 'whatsapp_cloud' },
    });
    const r = await deliverAccessCode({
      ...base,
      db,
      channelId: null,
      conversationId: 'conv9',
    });
    expect(r).toEqual({ ok: true, via: 'text' });
    expect(resolveDefaultChannelId).not.toHaveBeenCalled();
    expect(findOrCreateConversation).not.toHaveBeenCalled();
    expect(sendAndPersistOutbound.mock.calls[0][0].conversationId).toBe(
      'conv9'
    );
  });

  it('sem canal na conta → no_channel, sem lançar', async () => {
    resolveDefaultChannelId.mockRejectedValue(new Error('none'));
    const errSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    const r = await deliverAccessCode({
      ...base,
      db: fakeDb({}),
      channelId: null,
    });
    expect(r).toEqual({ ok: false, reason: 'no_channel' });
    errSpy.mockRestore();
  });

  it('teto de envio frio do QRCode → cold_limit', async () => {
    findOrCreateConversation.mockResolvedValue('conv1');
    sendAndPersistOutbound.mockRejectedValue(
      Object.create(ColdSendLimitError.prototype)
    );
    const db = fakeDb({
      accounts: { owner_user_id: 'u1' },
      conversations: { channel_id: 'ch1', last_customer_message_at: null },
      channels: { type: 'whatsapp_qr' },
    });
    expect(await deliverAccessCode({ ...base, db })).toEqual({
      ok: false,
      reason: 'cold_limit',
    });
  });

  it('falha de envio: log só com o nome do erro (sem telefone nem código)', async () => {
    findOrCreateConversation.mockResolvedValue('conv1');
    sendAndPersistOutbound.mockRejectedValue(
      new Error('contact phone invalid: 5519992496598 code 048213')
    );
    const errSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    const db = fakeDb({
      accounts: { owner_user_id: 'u1' },
      conversations: { channel_id: 'ch1', last_customer_message_at: null },
      channels: { type: 'whatsapp_qr' },
    });
    expect(await deliverAccessCode({ ...base, db })).toEqual({
      ok: false,
      reason: 'send_failed',
    });
    const logged = errSpy.mock.calls.flat().join(' ');
    expect(logged).not.toContain('5519992496598');
    expect(logged).not.toContain('048213');
    errSpy.mockRestore();
  });
});

describe('loadAuthTemplate', () => {
  it('só template da conta, Authentication e APPROVED', async () => {
    const ok = fakeDb({
      message_templates: {
        name: 'area_codigo',
        language: 'pt_BR',
        category: 'Authentication',
        status: 'APPROVED',
      },
    });
    expect(await loadAuthTemplate(ok, 'acc1', 't1')).toEqual({
      name: 'area_codigo',
      language: 'pt_BR',
    });

    for (const row of [
      { name: 'x', language: 'pt_BR', category: 'Utility', status: 'APPROVED' },
      {
        name: 'x',
        language: 'pt_BR',
        category: 'Authentication',
        status: 'PENDING',
      },
      null,
    ]) {
      expect(
        await loadAuthTemplate(fakeDb({ message_templates: row }), 'acc1', 't1')
      ).toBeNull();
    }
    expect(await loadAuthTemplate(ok, 'acc1', null)).toBeNull();
  });
});
