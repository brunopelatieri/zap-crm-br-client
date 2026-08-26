import { describe, it, expect } from 'vitest';

import { isBlocked, isUnlimited, mergeLimits, resolveLimit } from './limits';

describe('resolveLimit', () => {
  it('chave ausente nos dois níveis é ilimitada (null)', () => {
    expect(resolveLimit({}, {}, 'contacts')).toBeNull();
  });

  it('usa o valor do plano quando não há override', () => {
    expect(resolveLimit({ contacts: 2000 }, {}, 'contacts')).toBe(2000);
  });

  it('override da conta tem precedência sobre o plano', () => {
    expect(
      resolveLimit({ contacts: 2000 }, { contacts: 15000 }, 'contacts')
    ).toBe(15000);
  });

  it('0 é um valor explícito (bloqueado), não é tratado como ausente', () => {
    expect(
      resolveLimit(
        { channels_whatsapp_cloud: 0 },
        {},
        'channels_whatsapp_cloud'
      )
    ).toBe(0);
  });

  it('override 0 vence mesmo com plano ilimitado (ausente)', () => {
    expect(resolveLimit({}, { contacts: 0 }, 'contacts')).toBe(0);
  });
});

describe('isUnlimited / isBlocked', () => {
  it('null é ilimitado, não bloqueado', () => {
    expect(isUnlimited(null)).toBe(true);
    expect(isBlocked(null)).toBe(false);
  });

  it('0 é bloqueado, não ilimitado', () => {
    expect(isUnlimited(0)).toBe(false);
    expect(isBlocked(0)).toBe(true);
  });

  it('número positivo não é nem ilimitado nem bloqueado', () => {
    expect(isUnlimited(10)).toBe(false);
    expect(isBlocked(10)).toBe(false);
  });
});

describe('mergeLimits', () => {
  it('override vence, resto do plano permanece', () => {
    expect(
      mergeLimits({ contacts: 2000, members_total: 5 }, { contacts: 15000 })
    ).toEqual({ contacts: 15000, members_total: 5 });
  });
});
