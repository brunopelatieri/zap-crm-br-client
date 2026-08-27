import { describe, it, expect } from 'vitest';

import {
  formatRetentionLimit,
  formatRetentionDays,
  formatRetentionSource,
  formatRetentionDaysSource,
} from './format';

describe('formatRetentionLimit', () => {
  it('null → "Sem limite" em pt-BR', () => {
    expect(formatRetentionLimit(null, 'pt-BR')).toBe('Sem limite');
  });

  it('null → "No limit" em en', () => {
    expect(formatRetentionLimit(null, 'en')).toBe('No limit');
  });

  it('número formatado por locale', () => {
    expect(formatRetentionLimit(5000, 'pt-BR')).toContain('5');
    expect(formatRetentionLimit(5000, 'en')).toBe('5,000');
  });
});

describe('formatRetentionDays', () => {
  it('sem limite nos dois idiomas', () => {
    expect(formatRetentionDays(null, 'pt-BR')).toBe('Sem limite');
    expect(formatRetentionDays(null, 'en')).toBe('No limit');
  });

  it('singular/plural em pt-BR', () => {
    expect(formatRetentionDays(1, 'pt-BR')).toBe('1 dia');
    expect(formatRetentionDays(30, 'pt-BR')).toBe('30 dias');
  });

  it('singular/plural em en', () => {
    expect(formatRetentionDays(1, 'en')).toBe('1 day');
    expect(formatRetentionDays(30, 'en')).toBe('30 days');
  });
});

describe('formatRetentionSource', () => {
  it('policy: string vazia — nada herdado a anunciar', () => {
    expect(formatRetentionSource('policy', 5000, 'pt-BR')).toBe('');
  });

  it('default: anuncia o padrão do sistema formatado', () => {
    expect(formatRetentionSource('default', 5000, 'pt-BR')).toBe(
      'Padrão do sistema (5.000)'
    );
    expect(formatRetentionSource('default', 5000, 'en')).toBe(
      'System default (5,000)'
    );
  });

  it('unlimited: também anuncia como herdado', () => {
    expect(formatRetentionSource('unlimited', null, 'pt-BR')).toBe(
      'Padrão do sistema (Sem limite)'
    );
  });
});

describe('formatRetentionDaysSource', () => {
  it('policy: string vazia', () => {
    expect(formatRetentionDaysSource('policy', 30, 'pt-BR')).toBe('');
  });

  it('default: usa o formato de dias, não o número cru', () => {
    expect(formatRetentionDaysSource('default', 30, 'pt-BR')).toBe(
      'Padrão do sistema (30 dias)'
    );
    expect(formatRetentionDaysSource('default', 1, 'en')).toBe(
      'System default (1 day)'
    );
  });
});
