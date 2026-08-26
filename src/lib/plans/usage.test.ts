import { describe, it, expect } from 'vitest';

import { bucketStatus, overageAmount, ratio, remaining } from './usage';

describe('remaining', () => {
  it('null quando ilimitado', () => {
    expect(remaining(500, null)).toBeNull();
  });

  it('diferença limite - uso, nunca negativa', () => {
    expect(remaining(1800, 2000)).toBe(200);
    expect(remaining(2500, 2000)).toBe(0);
  });
});

describe('ratio', () => {
  it('null quando ilimitado', () => {
    expect(ratio(500, null)).toBeNull();
  });

  it('null quando o limite é 0 — divisão por zero não estoura', () => {
    expect(ratio(0, 0)).toBeNull();
  });

  it('uso / limite', () => {
    expect(ratio(1600, 2000)).toBe(0.8);
  });
});

describe('bucketStatus', () => {
  it('ilimitado é sempre ok', () => {
    expect(bucketStatus(999999, null)).toBe('ok');
  });

  it('abaixo de 80% é ok', () => {
    expect(bucketStatus(1000, 2000)).toBe('ok');
  });

  it('a partir de 80% é warn', () => {
    expect(bucketStatus(1600, 2000)).toBe('warn');
  });

  it('uso == limite é full', () => {
    expect(bucketStatus(2000, 2000)).toBe('full');
  });

  it('uso > limite é over', () => {
    expect(bucketStatus(2001, 2000)).toBe('over');
  });
});

describe('overageAmount', () => {
  it('0 quando ilimitado ou dentro do limite', () => {
    expect(overageAmount(500, null)).toBe(0);
    expect(overageAmount(1800, 2000)).toBe(0);
  });

  it('excedente exato quando estourado', () => {
    expect(overageAmount(2450, 2000)).toBe(450);
  });
});
