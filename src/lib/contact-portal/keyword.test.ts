import type { SupabaseClient } from '@supabase/supabase-js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { PortalAccountSettings } from './account';
import {
  couldBeKeyword,
  handlePortalKeyword,
  matchesKeyword,
  normalizeKeyword,
  type KeywordDeps,
} from './keyword';
import { hashIp } from './request';

const settings: PortalAccountSettings = {
  accountId: 'acc1',
  enabled: true,
  channelId: null,
  authTemplateId: null,
  keyword: 'SENHA',
  publicCode: 'ABCD2345',
  termsVersion: null,
  eligible: true,
};

function deps(over: Partial<KeywordDeps> = {}): KeywordDeps {
  return {
    getSettings: vi.fn().mockResolvedValue(settings),
    requestCode: vi.fn().mockResolvedValue({
      status: 'sent',
      contactId: 'c1',
      accountId: 'acc1',
    }),
    accountName: vi.fn().mockResolvedValue('Valen Ranch'),
    deliver: vi.fn().mockResolvedValue({ ok: true, via: 'text' }),
    ...over,
  };
}

const input = {
  db: {} as SupabaseClient,
  accountId: 'acc1',
  contactId: 'c1',
  contactPhone: '5519991234567',
  conversationId: 'conv1',
  text: 'senha',
};

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('normalização', () => {
  it('sem acento, sem caixa, espaços colapsados', () => {
    expect(normalizeKeyword('  Sénha  ')).toBe('SENHA');
    expect(normalizeKeyword('meu   acesso')).toBe('MEU ACESSO');
  });

  it('casa a palavra inteira, não um trecho', () => {
    expect(matchesKeyword(' senha ', 'SENHA')).toBe(true);
    expect(matchesKeyword('SÊNHA', 'senha')).toBe(true);
    expect(matchesKeyword('minha senha', 'SENHA')).toBe(false);
    expect(matchesKeyword('senha', null)).toBe(false);
  });

  it('só texto de tamanho de palavra-chave vai ao banco', () => {
    expect(couldBeKeyword('SENHA')).toBe(true);
    expect(couldBeKeyword('a')).toBe(false);
    expect(couldBeKeyword('bom dia, tudo bem com vocês por aí hoje?')).toBe(
      false
    );
  });
});

describe('handlePortalKeyword', () => {
  it('casa: pede o código no escopo da conta e responde na conversa', async () => {
    const d = deps();
    expect(await handlePortalKeyword(input, d)).toBe(true);

    expect(d.requestCode).toHaveBeenCalledWith({
      phones: ['5519991234567', '551991234567'],
      publicCode: 'ABCD2345',
      purpose: 'reset',
      code: expect.stringMatching(/^\d{6}$/),
      ipHash: hashIp('whatsapp:c1'),
    });
    const sentCode = (d.requestCode as ReturnType<typeof vi.fn>).mock
      .calls[0][0].code;
    expect(d.deliver).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: 'acc1',
        accountName: 'Valen Ranch',
        contactId: 'c1',
        conversationId: 'conv1',
        code: sentCode,
        kind: 'code',
        authTemplate: null,
      })
    );
  });

  it('texto comprido nem consulta as configurações', async () => {
    const d = deps();
    expect(
      await handlePortalKeyword(
        {
          ...input,
          text: 'quero saber o horário da prova de sábado, por favor',
        },
        d
      )
    ).toBe(false);
    expect(d.getSettings).not.toHaveBeenCalled();
  });

  it('não casa, área não elegível ou palavra-chave desligada → caminho normal', async () => {
    expect(await handlePortalKeyword({ ...input, text: 'oi' }, deps())).toBe(
      false
    );
    expect(
      await handlePortalKeyword(
        input,
        deps({
          getSettings: vi
            .fn()
            .mockResolvedValue({ ...settings, eligible: false }),
        })
      )
    ).toBe(false);
    expect(
      await handlePortalKeyword(
        input,
        deps({
          getSettings: vi
            .fn()
            .mockResolvedValue({ ...settings, keyword: null }),
        })
      )
    ).toBe(false);
    expect(
      await handlePortalKeyword(
        input,
        deps({ getSettings: vi.fn().mockResolvedValue(null) })
      )
    ).toBe(false);
  });

  it('limite ou contato bloqueado: consome sem responder', async () => {
    for (const status of ['throttled', 'no_match'] as const) {
      const d = deps({
        requestCode: vi
          .fn()
          .mockResolvedValue({ status, contactId: null, accountId: null }),
      });
      expect(await handlePortalKeyword(input, d)).toBe(true);
      expect(d.deliver).not.toHaveBeenCalled();
    }
  });

  it('nunca lança: erro ao ler configurações segue o caminho normal', async () => {
    const d = deps({
      getSettings: vi.fn().mockRejectedValue(new Error('db down')),
    });
    expect(await handlePortalKeyword(input, d)).toBe(false);
  });

  it('nunca lança: erro depois de casar ainda consome (a IA não responde "SENHA")', async () => {
    const d = deps({
      requestCode: vi.fn().mockRejectedValue(new Error('boom')),
    });
    expect(await handlePortalKeyword(input, d)).toBe(true);
  });

  it('telefone do contato que não normaliza: consome sem pedir código', async () => {
    const d = deps();
    expect(
      await handlePortalKeyword({ ...input, contactPhone: '123' }, d)
    ).toBe(true);
    expect(d.requestCode).not.toHaveBeenCalled();
  });
});
