import type { SupabaseClient } from '@supabase/supabase-js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { deliverAccessCode, loadAuthTemplate } = vi.hoisted(() => ({
  deliverAccessCode: vi.fn(),
  loadAuthTemplate: vi.fn(),
}));
vi.mock('./delivery', () => ({ deliverAccessCode, loadAuthTemplate }));

import {
  createPortalAccountService,
  inviteContactToPortal,
  toSettingsPatchJson,
} from './account';
import { PORTAL_LIMITS } from './limits';

const SETTINGS = {
  account_id: 'acc1',
  enabled: true,
  channel_id: 'ch1',
  auth_template_id: 't1',
  keyword: 'SENHA',
  public_code: 'ABCD2345',
  terms_version: null,
  eligible: true,
};

/** `rpc(fn)` responde por nome de função. */
function rpcDb(byFn: Record<string, unknown>) {
  return {
    rpc: vi.fn().mockImplementation(async (fn: string) => ({
      data: byFn[fn] ?? null,
      error: null,
    })),
  };
}

beforeEach(() => {
  deliverAccessCode.mockResolvedValue({ ok: true, via: 'text' });
  loadAuthTemplate.mockResolvedValue(null);
});

describe('toSettingsPatchJson', () => {
  it('só as chaves informadas, em snake_case; null desliga', () => {
    expect(toSettingsPatchJson({ enabled: true })).toEqual({ enabled: true });
    expect(
      toSettingsPatchJson({
        channelId: null,
        authTemplateId: 't',
        keyword: null,
      })
    ).toEqual({ channel_id: null, auth_template_id: 't', keyword: null });
    expect(toSettingsPatchJson({})).toEqual({});
  });
});

describe('createPortalAccountService', () => {
  it('setSettings manda o patch convertido e devolve as configurações', async () => {
    const db = rpcDb({ portal_account_settings_set: SETTINGS });
    const s = await createPortalAccountService(db).setSettings(
      'acc1',
      { enabled: false, keyword: 'ACESSO' },
      'u1'
    );
    expect(s.publicCode).toBe('ABCD2345');
    expect(db.rpc).toHaveBeenCalledWith('portal_account_settings_set', {
      p_account_id: 'acc1',
      p_patch: { enabled: false, keyword: 'ACESSO' },
      p_user_id: 'u1',
    });
  });

  it('accessStatus: lista vazia nem vai ao banco; linhas viram camelCase', async () => {
    const db = rpcDb({
      portal_access_status: [
        {
          contact_id: 'c1',
          status: 'active',
          invited_at: null,
          activated_at: '2026-10-30T19:15:04Z',
          last_login_at: '2026-10-30T20:08:00Z',
          blocked_at: null,
        },
      ],
    });
    const svc = createPortalAccountService(db);
    expect(await svc.accessStatus('acc1', [])).toEqual([]);
    expect(db.rpc).not.toHaveBeenCalled();
    expect(await svc.accessStatus('acc1', ['c1'])).toEqual([
      {
        contactId: 'c1',
        status: 'active',
        invitedAt: null,
        activatedAt: '2026-10-30T19:15:04Z',
        lastLoginAt: '2026-10-30T20:08:00Z',
        blockedAt: null,
      },
    ]);
  });

  it('invite manda o código e os limites', async () => {
    const db = rpcDb({ portal_invite: [{ status: 'sent', phone: '55…' }] });
    expect(
      await createPortalAccountService(db).invite({
        accountId: 'acc1',
        contactId: 'c1',
        code: '123456',
        userId: 'u1',
      })
    ).toBe('sent');
    expect(db.rpc).toHaveBeenCalledWith('portal_invite', {
      p_account_id: 'acc1',
      p_contact_id: 'c1',
      p_code: '123456',
      p_user_id: 'u1',
      p_limits: PORTAL_LIMITS,
    });
  });

  it('summary sem linha de configurações: tudo desligado', async () => {
    const db = rpcDb({
      portal_account_summary: [
        { enabled: false, eligible: false, active_count: 0, public_code: null },
      ],
    });
    expect(await createPortalAccountService(db).summary('acc1')).toEqual({
      enabled: false,
      eligible: false,
      activeCount: 0,
      publicCode: null,
    });
  });
});

describe('inviteContactToPortal (J1)', () => {
  const base = {
    accountId: 'acc1',
    accountName: 'Valen Ranch',
    contactId: 'c1',
    userId: 'u1',
    siteOrigin: 'https://dev.valenranch.com.br',
  };

  it('emite o convite e entrega na hora, pelo canal e template da conta', async () => {
    const db = rpcDb({
      portal_invite: [{ status: 'sent', phone: '55…' }],
      portal_account_settings_get: SETTINGS,
    });
    loadAuthTemplate.mockResolvedValue({
      name: 'area_codigo',
      language: 'pt_BR',
    });

    expect(
      await inviteContactToPortal({
        ...base,
        db: db as unknown as SupabaseClient,
      })
    ).toEqual({ ok: true, via: 'text' });

    const code = (db.rpc.mock.calls[0] as unknown[])[1] as { p_code: string };
    expect(code.p_code).toMatch(/^\d{6}$/);
    expect(deliverAccessCode).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'invite',
        code: code.p_code,
        channelId: 'ch1',
        publicCode: 'ABCD2345',
        authTemplate: { name: 'area_codigo', language: 'pt_BR' },
      })
    );
  });

  it('recusa do banco (opt-out, bloqueado…) não chega a enviar', async () => {
    for (const status of [
      'opted_out',
      'blocked',
      'not_eligible',
      'throttled',
    ] as const) {
      deliverAccessCode.mockClear();
      const db = rpcDb({ portal_invite: [{ status, phone: null }] });
      expect(
        await inviteContactToPortal({
          ...base,
          db: db as unknown as SupabaseClient,
        })
      ).toEqual({ ok: false, reason: status });
      expect(deliverAccessCode).not.toHaveBeenCalled();
    }
  });

  it('entrega que falha volta com o motivo (ex.: falta template)', async () => {
    deliverAccessCode.mockResolvedValue({
      ok: false,
      reason: 'needs_template',
    });
    const db = rpcDb({
      portal_invite: [{ status: 'sent', phone: '55…' }],
      portal_account_settings_get: SETTINGS,
    });
    expect(
      await inviteContactToPortal({
        ...base,
        db: db as unknown as SupabaseClient,
      })
    ).toEqual({ ok: false, reason: 'needs_template' });
  });
});
