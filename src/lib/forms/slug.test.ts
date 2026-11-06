import { describe, expect, it } from 'vitest';

import {
  isReservedSlug,
  isValidSlug,
  RESERVED_SLUGS,
  SLUG_MAX_LENGTH,
  slugify,
  suggestSlug,
} from './slug';

describe('slugify', () => {
  it('tira acento, baixa a caixa e troca o resto por hífen', () => {
    expect(slugify('Pesquisa de Satisfação — Ação 2026!')).toBe(
      'pesquisa-de-satisfacao-acao-2026'
    );
  });

  it('corta em 60 sem terminar em hífen e devolve vazio sem letra', () => {
    const long = 'a'.repeat(59) + ' b c';
    const out = slugify(long);
    expect(out.length).toBeLessThanOrEqual(SLUG_MAX_LENGTH);
    expect(out.endsWith('-')).toBe(false);
    expect(slugify('!!! ???')).toBe('');
  });
});

describe('isValidSlug (SPEC 085 E-3)', () => {
  it.each([
    ['abc', true],
    ['meu-form-2026', true],
    ['ab', false],
    ['-abc', false],
    ['abc-', false],
    ['Abc', false],
    ['a'.repeat(61), false],
    ['com espaço', false],
  ])('%s → %s', (slug, ok) => {
    expect(isValidSlug(slug)).toBe(ok);
  });

  it('reservados cobrem as rotas do app e são rejeitados sem distinguir caixa', () => {
    for (const s of ['api', '_next', 'area', 'admin', 'f', 'forms', 'login']) {
      expect(RESERVED_SLUGS.has(s)).toBe(true);
    }
    expect(isReservedSlug('API')).toBe(true);
    expect(isValidSlug('admin')).toBe(false);
  });
});

describe('suggestSlug', () => {
  it('nome livre vira o slug direto', () => {
    expect(suggestSlug('Captação de leads')).toBe('captacao-de-leads');
  });

  it('colisão ganha -2, -3, … (sem distinguir caixa no que já existe)', () => {
    expect(suggestSlug('Captação', ['CAPTACAO'])).toBe('captacao-2');
    expect(suggestSlug('Captação', ['captacao', 'captacao-2'])).toBe(
      'captacao-3'
    );
  });

  it('nome reservado ou curto demais ganha o prefixo form-', () => {
    expect(suggestSlug('Admin')).toBe('form-admin');
    expect(suggestSlug('Ab')).toBe('form-ab');
    expect(suggestSlug('???')).toBe('form');
  });

  it('nunca estoura 60 mesmo com sufixo', () => {
    const name = 'x'.repeat(80);
    const taken = [slugify(name)];
    const out = suggestSlug(name, taken);
    expect(out.length).toBeLessThanOrEqual(SLUG_MAX_LENGTH);
    expect(out.endsWith('-2')).toBe(true);
    expect(isValidSlug(out)).toBe(true);
  });
});
