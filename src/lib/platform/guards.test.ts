import { describe, expect, it } from 'vitest';

import { assertNotSelf, canBlockAccount, canBlockUser } from './guards';

const OWNER_EMAIL = 'bruno@zapcrmbr.com';

describe('canBlockAccount — autobloqueio recusado', () => {
  it('mesma conta (ownerAccountId === target.accountId)', () => {
    const result = canBlockAccount({
      ownerEmail: OWNER_EMAIL,
      ownerAccountId: 'acct-1',
      target: { accountId: 'acct-1' },
    });
    expect(result).toEqual({ ok: false, reason: 'self_account' });
  });

  it('e-mail do dono da conta-alvo com caixa diferente', () => {
    const result = canBlockAccount({
      ownerEmail: OWNER_EMAIL,
      ownerAccountId: null,
      target: { accountId: 'acct-2', ownerEmail: 'Bruno@ZapCRMBR.com' },
    });
    expect(result).toEqual({ ok: false, reason: 'self_account' });
  });

  it('e-mail do dono da conta-alvo com espaço ao redor', () => {
    const result = canBlockAccount({
      ownerEmail: OWNER_EMAIL,
      ownerAccountId: null,
      target: { accountId: 'acct-2', ownerEmail: '  bruno@zapcrmbr.com  ' },
    });
    expect(result).toEqual({ ok: false, reason: 'self_account' });
  });

  it('conta de terceiro é permitida', () => {
    const result = canBlockAccount({
      ownerEmail: OWNER_EMAIL,
      ownerAccountId: 'acct-1',
      target: { accountId: 'acct-2', ownerEmail: 'cliente@empresa.com' },
    });
    expect(result).toEqual({ ok: true, reason: null });
  });
});

describe('canBlockUser — autobloqueio recusado', () => {
  it('mesmo usuário (ownerUserId === target.userId)', () => {
    const result = canBlockUser({
      ownerEmail: OWNER_EMAIL,
      ownerUserId: 'user-1',
      target: { userId: 'user-1' },
    });
    expect(result).toEqual({ ok: false, reason: 'self_user' });
  });

  it('e-mail do alvo com caixa diferente', () => {
    const result = canBlockUser({
      ownerEmail: OWNER_EMAIL,
      ownerUserId: null,
      target: { userId: 'user-9', email: 'BRUNO@zapcrmbr.com' },
    });
    expect(result).toEqual({ ok: false, reason: 'self_user' });
  });

  it('e-mail do alvo com espaço ao redor', () => {
    const result = canBlockUser({
      ownerEmail: OWNER_EMAIL,
      ownerUserId: null,
      target: { userId: 'user-9', email: ' bruno@zapcrmbr.com ' },
    });
    expect(result).toEqual({ ok: false, reason: 'self_user' });
  });

  it('usuário de terceiro é permitido', () => {
    const result = canBlockUser({
      ownerEmail: OWNER_EMAIL,
      ownerUserId: 'user-1',
      target: { userId: 'user-2', email: 'colega@empresa.com' },
    });
    expect(result).toEqual({ ok: true, reason: null });
  });
});

describe('assertNotSelf', () => {
  it('e-mail candidato ausente nunca é o próprio', () => {
    expect(assertNotSelf(OWNER_EMAIL, null)).toBe(false);
    expect(assertNotSelf(OWNER_EMAIL, undefined)).toBe(false);
  });

  it('compara normalizado nos dois lados', () => {
    expect(assertNotSelf('  Bruno@ZapCRMBR.com  ', 'bruno@zapcrmbr.com')).toBe(
      true
    );
  });
});
