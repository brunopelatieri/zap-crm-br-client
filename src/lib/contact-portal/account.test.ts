import { describe, expect, it, vi } from 'vitest';

import { createPortalAccountService, toPortalAccountSettings } from './account';
import { PortalServiceError } from './service';

const raw = {
  account_id: 'acc1',
  enabled: true,
  channel_id: 'ch1',
  auth_template_id: null,
  keyword: 'SENHA',
  public_code: 'ABCD2345',
  terms_version: 'v1',
  eligible: true,
};

describe('createPortalAccountService.getSettings', () => {
  it('chama portal_account_settings_get e converte o JSON', async () => {
    const db = { rpc: vi.fn().mockResolvedValue({ data: raw, error: null }) };
    expect(await createPortalAccountService(db).getSettings('acc1')).toEqual({
      accountId: 'acc1',
      enabled: true,
      channelId: 'ch1',
      authTemplateId: null,
      keyword: 'SENHA',
      publicCode: 'ABCD2345',
      termsVersion: 'v1',
      eligible: true,
    });
    expect(db.rpc).toHaveBeenCalledWith('portal_account_settings_get', {
      p_account_id: 'acc1',
    });
  });

  it('conta que nunca configurou → null', async () => {
    const db = { rpc: vi.fn().mockResolvedValue({ data: null, error: null }) };
    expect(await createPortalAccountService(db).getSettings('acc1')).toBeNull();
    expect(toPortalAccountSettings(null)).toBeNull();
  });

  it('erro do banco vira PortalServiceError', async () => {
    const db = {
      rpc: vi.fn().mockResolvedValue({ data: null, error: { code: '42501' } }),
    };
    await expect(
      createPortalAccountService(db).getSettings('acc1')
    ).rejects.toBeInstanceOf(PortalServiceError);
  });
});
