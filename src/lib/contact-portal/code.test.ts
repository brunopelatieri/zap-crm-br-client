import { describe, expect, it } from 'vitest';

import {
  CODE_LENGTH,
  generateCode,
  normalizeCodeInput,
  normalizePublicCode,
} from './code';

describe('generateCode', () => {
  it('sempre 6 dígitos, com zeros à esquerda', () => {
    for (let i = 0; i < 500; i++) {
      expect(generateCode()).toMatch(/^\d{6}$/);
    }
    expect(CODE_LENGTH).toBe(6);
  });

  it('não repete o mesmo valor em sequência curta (gerador aleatório)', () => {
    const seen = new Set(Array.from({ length: 50 }, generateCode));
    expect(seen.size).toBeGreaterThan(40);
  });
});

describe('normalizeCodeInput', () => {
  it('aceita espaço, hífen e ponto que a pessoa digita ou cola', () => {
    expect(normalizeCodeInput('123456')).toBe('123456');
    expect(normalizeCodeInput(' 123 456 ')).toBe('123456');
    expect(normalizeCodeInput('123-456')).toBe('123456');
    expect(normalizeCodeInput('012.345')).toBe('012345');
  });

  it('recusa tamanho errado ou letra', () => {
    expect(normalizeCodeInput('12345')).toBeNull();
    expect(normalizeCodeInput('1234567')).toBeNull();
    expect(normalizeCodeInput('12a456')).toBeNull();
    expect(normalizeCodeInput('')).toBeNull();
  });
});

describe('normalizePublicCode', () => {
  it('aceita o alfabeto da 093, em qualquer caixa', () => {
    expect(normalizePublicCode('abcd2345')).toBe('ABCD2345');
    expect(normalizePublicCode(' xyzw7899 ')).toBe('XYZW7899');
  });

  it('recusa I, L, O, 0, 1, tamanho errado e vazio', () => {
    for (const bad of [
      'ABCDI234',
      'ABCDL234',
      'ABCDO234',
      'ABCD0234',
      'ABC',
      '',
      null,
      undefined,
    ]) {
      expect(normalizePublicCode(bad)).toBeNull();
    }
  });
});
