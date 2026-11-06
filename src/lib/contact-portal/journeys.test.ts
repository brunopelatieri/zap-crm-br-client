import type { SupabaseClient } from '@supabase/supabase-js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const deliverAccessCode = vi.fn();
const loadAuthTemplate = vi.fn();
vi.mock('./delivery', () => ({
  deliverAccessCode: (...a: unknown[]) => deliverAccessCode(...a),
  loadAuthTemplate: (...a: unknown[]) => loadAuthTemplate(...a),
}));

import {
  PORTAL_TERMS_VERSION,
  changePortalPassword,
  completeAccessCode,
  maskedPhoneOf,
  requestAccessCode,
  signIn,
  signOut,
  type JourneyDeps,
} from './journeys';
import type { PortalService } from './service';
import { hashSessionToken } from './session';
import type { PortalSession } from './types';

const STRONG = 'Rodeio#2026';
const IP = 'a'.repeat(64);

function fakeService(over: Partial<PortalService> = {}): PortalService {
  return {
    requestCode: vi
      .fn()
      .mockResolvedValue({ status: 'sent', contactId: 'c1', accountId: 'a1' }),
    completeCode: vi
      .fn()
      .mockResolvedValue({ status: 'ok', contactId: 'c1', accountId: 'a1' }),
    login: vi
      .fn()
      .mockResolvedValue({ status: 'ok', contactIds: ['c1', 'c2'] }),
    createSession: vi.fn().mockResolvedValue('s1'),
    resolveSession: vi.fn(),
    selectAccount: vi.fn(),
    changePassword: vi.fn().mockResolvedValue({ status: 'ok', changed: 1 }),
    logout: vi.fn().mockResolvedValue(undefined),
    ...over,
  } as PortalService;
}

/** `from(t)…maybeSingle()` e `rpc()` com respostas fixas. */
function fakeDb(rows: Record<string, unknown>, rpcData: unknown = null) {
  return {
    from(table: string) {
      const chain = {
        select: () => chain,
        eq: () => chain,
        maybeSingle: async () => ({ data: rows[table] ?? null, error: null }),
      };
      return chain;
    },
    rpc: vi.fn().mockResolvedValue({ data: rpcData, error: null }),
  } as unknown as SupabaseClient;
}

function deps(service = fakeService(), db = fakeDb({})): JourneyDeps {
  return { service, db: () => db };
}

const session: PortalSession = {
  sessionId: 's1',
  tokenHash: 'f'.repeat(64),
  accesses: [
    {
      contactId: 'c1',
      accountId: 'a1',
      contactName: 'Ana',
      accountName: 'Valen Ranch',
      isCurrent: true,
    },
  ],
  current: {
    contactId: 'c1',
    accountId: 'a1',
    contactName: 'Ana',
    accountName: 'Valen Ranch',
    isCurrent: true,
  },
};

beforeEach(() => {
  deliverAccessCode.mockResolvedValue({ ok: true, via: 'text' });
  loadAuthTemplate.mockResolvedValue(null);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('requestAccessCode', () => {
  it('telefone que não normaliza: nem vai ao banco, nada a enviar', async () => {
    const svc = fakeService();
    const r = await requestAccessCode(
      {
        rawPhone: '123',
        publicCode: null,
        purpose: 'reset',
        ipHash: IP,
        siteOrigin: null,
      },
      deps(svc)
    );
    expect(r.deliver).toBeNull();
    expect(svc.requestCode).not.toHaveBeenCalled();
  });

  it('sem contato, limite ou bloqueio: nada a enviar (a rota responde igual)', async () => {
    for (const status of ['no_match', 'throttled'] as const) {
      const svc = fakeService({
        requestCode: vi
          .fn()
          .mockResolvedValue({ status, contactId: null, accountId: null }),
      });
      const r = await requestAccessCode(
        {
          rawPhone: '19992496598',
          publicCode: null,
          purpose: 'first_access',
          ipHash: IP,
          siteOrigin: null,
        },
        deps(svc)
      );
      expect(r.deliver).toBeNull();
    }
  });

  it('código emitido: o envio fica para depois da resposta, com as configurações da conta', async () => {
    const svc = fakeService();
    const db = fakeDb(
      { accounts: { name: 'Valen Ranch' } },
      {
        account_id: 'a1',
        enabled: true,
        channel_id: 'ch1',
        auth_template_id: 't1',
        keyword: 'SENHA',
        public_code: 'ABCD2345',
        terms_version: null,
        eligible: true,
      }
    );
    loadAuthTemplate.mockResolvedValue({
      name: 'area_codigo',
      language: 'pt_BR',
    });

    const r = await requestAccessCode(
      {
        rawPhone: '(19) 99249-6598',
        publicCode: 'ABCD2345',
        purpose: 'first_access',
        ipHash: IP,
        siteOrigin: 'https://dev.valenranch.com.br',
      },
      deps(svc, db)
    );
    expect(deliverAccessCode).not.toHaveBeenCalled();
    expect(r.deliver).not.toBeNull();

    await r.deliver!();
    const sentCode = (svc.requestCode as ReturnType<typeof vi.fn>).mock
      .calls[0][0].code;
    expect(deliverAccessCode).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: 'a1',
        accountName: 'Valen Ranch',
        contactId: 'c1',
        code: sentCode,
        kind: 'code',
        publicCode: 'ABCD2345',
        channelId: 'ch1',
        authTemplate: { name: 'area_codigo', language: 'pt_BR' },
        siteOrigin: 'https://dev.valenranch.com.br',
      })
    );
  });

  it('o envio em segundo plano nunca lança', async () => {
    deliverAccessCode.mockRejectedValue(new Error('meta down'));
    const db = fakeDb(
      {},
      { account_id: 'a1', public_code: 'ABCD2345', eligible: true }
    );
    const r = await requestAccessCode(
      {
        rawPhone: '19992496598',
        publicCode: null,
        purpose: 'reset',
        ipHash: IP,
        siteOrigin: null,
      },
      deps(fakeService(), db)
    );
    await expect(r.deliver!()).resolves.toBeUndefined();
  });
});

describe('completeAccessCode', () => {
  const base = {
    rawPhone: '19992496598',
    publicCode: null,
    rawCode: '123 456',
    password: STRONG,
    confirmPassword: STRONG,
    termsAccepted: true,
    ipHash: IP,
  };

  it('ok: grava a senha normalizada, o aceite e já abre a sessão', async () => {
    const svc = fakeService();
    const r = await completeAccessCode(
      { ...base, password: ` ${STRONG} ` },
      deps(svc)
    );
    expect(r.status).toBe('ok');
    expect(svc.completeCode).toHaveBeenCalledWith({
      phones: ['5519992496598', '551992496598'],
      publicCode: null,
      code: '123456',
      password: STRONG,
      termsVersion: PORTAL_TERMS_VERSION,
      ipHash: IP,
    });
    const token = (r as { token: string }).token;
    expect(svc.createSession).toHaveBeenCalledWith({
      tokenHash: hashSessionToken(token),
      contactIds: ['c1'],
    });
  });

  it('valida senha, confirmação e aceite antes de gastar tentativa de código', async () => {
    const svc = fakeService();
    expect(
      (
        await completeAccessCode(
          { ...base, password: 'fraca', confirmPassword: 'fraca' },
          deps(svc)
        )
      ).status
    ).toBe('weak_password');
    expect(
      (
        await completeAccessCode(
          { ...base, confirmPassword: 'Outra#2026x' },
          deps(svc)
        )
      ).status
    ).toBe('password_mismatch');
    expect(
      (await completeAccessCode({ ...base, termsAccepted: false }, deps(svc)))
        .status
    ).toBe('terms_required');
    expect(svc.completeCode).not.toHaveBeenCalled();
  });

  it('código errado, código malformado e limite', async () => {
    expect(
      (await completeAccessCode({ ...base, rawCode: '12' }, deps())).status
    ).toBe('invalid_code');
    const invalid = fakeService({
      completeCode: vi.fn().mockResolvedValue({
        status: 'invalid',
        contactId: null,
        accountId: null,
      }),
    });
    expect((await completeAccessCode(base, deps(invalid))).status).toBe(
      'invalid_code'
    );
    const throttled = fakeService({
      completeCode: vi.fn().mockResolvedValue({
        status: 'throttled',
        contactId: null,
        accountId: null,
      }),
    });
    expect((await completeAccessCode(base, deps(throttled))).status).toBe(
      'throttled'
    );
  });
});

describe('signIn', () => {
  it('ok: sessão com todos os acessos em que a senha bateu', async () => {
    const svc = fakeService();
    const r = await signIn(
      { rawPhone: '19992496598', password: STRONG, ipHash: IP },
      deps(svc)
    );
    expect(r).toMatchObject({ status: 'ok', accessCount: 2 });
    expect(
      (svc.createSession as ReturnType<typeof vi.fn>).mock.calls[0][0]
        .contactIds
    ).toEqual(['c1', 'c2']);
  });

  it('telefone inválido ou senha acima de 72 bytes: invalid sem banco', async () => {
    const svc = fakeService();
    expect(
      (await signIn({ rawPhone: 'x', password: STRONG, ipHash: IP }, deps(svc)))
        .status
    ).toBe('invalid');
    expect(
      (
        await signIn(
          { rawPhone: '19992496598', password: 'a'.repeat(73), ipHash: IP },
          deps(svc)
        )
      ).status
    ).toBe('invalid');
    expect(svc.login).not.toHaveBeenCalled();
  });

  it('nenhum acesso elegível na hora de criar a sessão: invalid', async () => {
    const svc = fakeService({ createSession: vi.fn().mockResolvedValue(null) });
    expect(
      (
        await signIn(
          { rawPhone: '19992496598', password: STRONG, ipHash: IP },
          deps(svc)
        )
      ).status
    ).toBe('invalid');
  });
});

describe('sessão aberta', () => {
  it('signOut sem token não faz nada; com token, apaga pelo hash', async () => {
    const svc = fakeService();
    await signOut(null, true, deps(svc));
    expect(svc.logout).not.toHaveBeenCalled();
    await signOut('t'.repeat(43), true, deps(svc));
    expect(svc.logout).toHaveBeenCalledWith(
      hashSessionToken('t'.repeat(43)),
      true
    );
  });

  it('changePortalPassword: política antes do banco; senha atual errada → invalid_current', async () => {
    const svc = fakeService({
      changePassword: vi
        .fn()
        .mockResolvedValue({ status: 'invalid', changed: 0 }),
    });
    expect(
      (
        await changePortalPassword(
          session,
          { current: 'x', next: 'fraca', confirmNext: 'fraca', ipHash: IP },
          deps(svc)
        )
      ).status
    ).toBe('weak_password');
    expect(svc.changePassword).not.toHaveBeenCalled();
    expect(
      (
        await changePortalPassword(
          session,
          {
            current: 'Errada#2026',
            next: STRONG,
            confirmNext: STRONG,
            ipHash: IP,
          },
          deps(svc)
        )
      ).status
    ).toBe('invalid_current');
  });

  it('maskedPhoneOf mascara o telefone do acesso atual', async () => {
    const db = fakeDb({ contacts: { phone: '+55 19 99249-6598' } });
    const masked = await maskedPhoneOf(session, { db: () => db });
    expect(masked).not.toBeNull();
    expect(masked).not.toContain('99249');
    expect(masked).toContain('98');
    expect(
      await maskedPhoneOf({ ...session, current: null }, { db: () => db })
    ).toBeNull();
  });
});
