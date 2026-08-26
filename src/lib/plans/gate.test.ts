import { describe, it, expect } from 'vitest';

import { checkQuota } from './gate';

describe('checkQuota', () => {
  it('sempre permite quando ilimitado', () => {
    const decision = checkQuota({ limit: null, used: 999999, requested: 1 });
    expect(decision).toMatchObject({ allowed: true, remaining: null });
  });

  it('borda exata: used === limit bloqueia mesmo pedindo 1', () => {
    const decision = checkQuota({ limit: 2000, used: 2000, requested: 1 });
    expect(decision).toMatchObject({
      allowed: false,
      reason: 'quota_exceeded',
    });
  });

  it('borda exata: used === limit - 1 passa pedindo 1', () => {
    const decision = checkQuota({ limit: 2000, used: 1999, requested: 1 });
    expect(decision).toMatchObject({ allowed: true, remaining: 1 });
  });

  it('requested > 1 para pré-checagem em lote — bloqueia se estourar o lote inteiro', () => {
    const decision = checkQuota({ limit: 2000, used: 1990, requested: 50 });
    expect(decision).toMatchObject({
      allowed: false,
      reason: 'quota_exceeded',
      remaining: 10,
    });
  });

  it('lote que cabe exatamente no restante é permitido', () => {
    const decision = checkQuota({ limit: 2000, used: 1990, requested: 10 });
    expect(decision.allowed).toBe(true);
  });

  it('0 é bloqueado: qualquer requested > 0 falha', () => {
    const decision = checkQuota({ limit: 0, used: 0, requested: 1 });
    expect(decision).toMatchObject({
      allowed: false,
      reason: 'quota_exceeded',
    });
  });
});
