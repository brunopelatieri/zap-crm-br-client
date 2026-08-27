import { describe, it, expect } from 'vitest';

import { parseRetentionLimitInput } from './validate';

describe('parseRetentionLimitInput', () => {
  it('null/undefined/"" são válidos e significam "herdar" (null)', () => {
    expect(parseRetentionLimitInput(null)).toEqual({
      valid: true,
      value: null,
    });
    expect(parseRetentionLimitInput(undefined)).toEqual({
      valid: true,
      value: null,
    });
    expect(parseRetentionLimitInput('')).toEqual({ valid: true, value: null });
  });

  it('0 é válido e distinto de ausência — "sem limite explícito"', () => {
    expect(parseRetentionLimitInput(0)).toEqual({ valid: true, value: 0 });
    expect(parseRetentionLimitInput('0')).toEqual({ valid: true, value: 0 });
  });

  it('inteiro positivo, número ou string, é válido', () => {
    expect(parseRetentionLimitInput(5000)).toEqual({
      valid: true,
      value: 5000,
    });
    expect(parseRetentionLimitInput('5000')).toEqual({
      valid: true,
      value: 5000,
    });
  });

  it('acima do teto é inválido — protege make_interval() de estourar (code review, SPEC 060)', () => {
    expect(parseRetentionLimitInput(1_000_001)).toEqual({ valid: false });
    expect(parseRetentionLimitInput('999999999')).toEqual({ valid: false });
  });

  it('exatamente no teto é válido', () => {
    expect(parseRetentionLimitInput(1_000_000)).toEqual({
      valid: true,
      value: 1_000_000,
    });
  });

  it('negativo é inválido', () => {
    expect(parseRetentionLimitInput(-1)).toEqual({ valid: false });
    expect(parseRetentionLimitInput('-1')).toEqual({ valid: false });
  });

  it('fracionário é inválido', () => {
    expect(parseRetentionLimitInput(1.5)).toEqual({ valid: false });
    expect(parseRetentionLimitInput('1.5')).toEqual({ valid: false });
  });

  it('texto não numérico é inválido', () => {
    expect(parseRetentionLimitInput('abc')).toEqual({ valid: false });
  });

  it('tipos que não são string/number/null são inválidos', () => {
    expect(parseRetentionLimitInput({})).toEqual({ valid: false });
    expect(parseRetentionLimitInput([])).toEqual({ valid: false });
    expect(parseRetentionLimitInput(true)).toEqual({ valid: false });
  });
});
