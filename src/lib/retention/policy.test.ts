import { describe, it, expect } from 'vitest';

import {
  resolveEffectivePolicy,
  resolveEffectivePolicyWithSource,
  rowToPolicy,
} from './policy';
import type { RetentionChannelDefaults } from './types';

const DEFAULTS: RetentionChannelDefaults = {
  maxMessages: 5000,
  retentionDays: 30,
  maxFavorites: 200,
};

const UNLIMITED_DEFAULTS: RetentionChannelDefaults = {
  maxMessages: null,
  retentionDays: null,
  maxFavorites: null,
};

describe('resolveEffectivePolicy — a matriz da §3.4', () => {
  it('linha ausente (null): tudo herda o padrão do .env', () => {
    expect(resolveEffectivePolicy(null, DEFAULTS)).toEqual({
      maxMessages: 5000,
      retentionDays: 30,
      maxFavorites: 200,
    });
  });

  it('linha vazia ({}): mesmo resultado de linha ausente', () => {
    expect(resolveEffectivePolicy({}, DEFAULTS)).toEqual({
      maxMessages: 5000,
      retentionDays: 30,
      maxFavorites: 200,
    });
  });

  it('NULL numa dimensão, valor na outra: cada dimensão resolve independente', () => {
    expect(
      resolveEffectivePolicy(
        { maxMessages: 1000, retentionDays: null, maxFavorites: undefined },
        DEFAULTS
      )
    ).toEqual({ maxMessages: 1000, retentionDays: 30, maxFavorites: 200 });
  });

  it('0 na política é "sem limite", NUNCA "apagar tudo" — o teste que mais importa da SPEC', () => {
    expect(
      resolveEffectivePolicy({ retentionDays: 0 }, DEFAULTS).retentionDays
    ).toBeNull();
    expect(
      resolveEffectivePolicy({ maxMessages: 0 }, DEFAULTS).maxMessages
    ).toBeNull();
    expect(
      resolveEffectivePolicy({ maxFavorites: 0 }, DEFAULTS).maxFavorites
    ).toBeNull();
  });

  it('política presente com .env ausente (defaults unlimited): a política ainda vence', () => {
    expect(
      resolveEffectivePolicy({ maxMessages: 900 }, UNLIMITED_DEFAULTS)
        .maxMessages
    ).toBe(900);
  });

  it('.env presente com política ausente: cai no padrão', () => {
    expect(resolveEffectivePolicy(null, DEFAULTS).maxMessages).toBe(5000);
  });

  it('.env ausente E política ausente: sem limite (fim da cadeia)', () => {
    expect(resolveEffectivePolicy(null, UNLIMITED_DEFAULTS)).toEqual({
      maxMessages: null,
      retentionDays: null,
      maxFavorites: null,
    });
  });
});

describe('resolveEffectivePolicyWithSource', () => {
  it('marca a origem de cada dimensão independentemente', () => {
    const result = resolveEffectivePolicyWithSource(
      { maxMessages: 900, retentionDays: 0 },
      DEFAULTS
    );
    expect(result.maxMessages).toBe(900);
    expect(result.maxMessagesSource).toBe('policy');
    // 0 explícito também é "policy" — a ORIGEM é a política, o VALOR
    // resolvido é que vira null (sem limite).
    expect(result.retentionDays).toBeNull();
    expect(result.retentionDaysSource).toBe('policy');
    expect(result.maxFavorites).toBe(200);
    expect(result.maxFavoritesSource).toBe('default');
  });

  it('sem política e sem padrão: origem "unlimited"', () => {
    const result = resolveEffectivePolicyWithSource(null, UNLIMITED_DEFAULTS);
    expect(result.maxMessagesSource).toBe('unlimited');
    expect(result.maxMessages).toBeNull();
  });
});

describe('rowToPolicy', () => {
  it('null vira null', () => {
    expect(rowToPolicy(null)).toBeNull();
  });

  it('mapeia snake_case para camelCase', () => {
    expect(
      rowToPolicy({
        max_messages: 5000,
        retention_days: null,
        max_favorites: 0,
      })
    ).toEqual({ maxMessages: 5000, retentionDays: null, maxFavorites: 0 });
  });
});
