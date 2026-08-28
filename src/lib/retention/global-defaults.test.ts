import { describe, expect, it, vi } from 'vitest';

import {
  mergeGlobalDefaults,
  validateRetentionDefaults,
} from './global-defaults';
import type { RetentionDefaults } from './types';

function envDefaults(
  overrides: Partial<RetentionDefaults> = {}
): RetentionDefaults {
  return {
    enabled: true,
    minAgeHours: 72,
    intervalHours: 6,
    batchLimit: 5000,
    whatsapp_qr: { maxMessages: 5000, retentionDays: 30, maxFavorites: 200 },
    whatsapp_cloud: {
      maxMessages: 50000,
      retentionDays: 365,
      maxFavorites: 2000,
    },
    ...overrides,
  };
}

describe('mergeGlobalDefaults', () => {
  it('console vazio: tudo cai no .env', () => {
    const env = envDefaults();
    const result = mergeGlobalDefaults({}, env);
    expect(result).toEqual(env);
  });

  it('console undefined/null: tudo cai no .env', () => {
    const env = envDefaults();
    expect(mergeGlobalDefaults(undefined, env)).toEqual(env);
    expect(mergeGlobalDefaults(null, env)).toEqual(env);
  });

  it('dimensão a dimensão: definir só retentionDays mantém maxMessages do .env', () => {
    const env = envDefaults();
    const result = mergeGlobalDefaults(
      { whatsapp_qr: { retentionDays: 10 } },
      env
    );
    expect(result.whatsapp_qr).toEqual({
      maxMessages: env.whatsapp_qr.maxMessages, // veio do .env, intacto
      retentionDays: 10, // veio do console
      maxFavorites: env.whatsapp_qr.maxFavorites, // veio do .env, intacto
    });
    // O outro canal não é tocado.
    expect(result.whatsapp_cloud).toEqual(env.whatsapp_cloud);
  });

  it('0 explícito no console vira "sem limite" (null), não some a dimensão', () => {
    const env = envDefaults();
    const result = mergeGlobalDefaults(
      { whatsapp_qr: { maxMessages: 0 } },
      env
    );
    expect(result.whatsapp_qr.maxMessages).toBeNull();
  });

  // Achado de code review: esta era a asserção ERRADA até a correção —
  // `{ maxMessages: null }` é exatamente a forma como
  // `validateRetentionDefaults` PERSISTE um `0` digitado no formulário
  // (§5.3, "0 normalizado para null, mesma semântica de sem limite").
  // Tratar isso como "não configurado, cai para o .env" faz a escolha
  // "sem limite" do proprietário reverter sozinha no próximo ciclo da
  // varredura — o oposto do que a §11 promete ("editar um campo não
  // apaga outro limite" também vale ao contrário: não FAZ reaparecer
  // um limite que foi desligado).
  it('null explícito no console é override "sem limite" — sobrevive ao ciclo seguinte', () => {
    const env = envDefaults();
    const result = mergeGlobalDefaults(
      { whatsapp_qr: { maxMessages: null } },
      env
    );
    expect(result.whatsapp_qr.maxMessages).toBeNull();
    // As outras duas dimensões do mesmo canal continuam vindo do
    // `.env`, intactas — a fusão continua sendo dimensão a dimensão.
    expect(result.whatsapp_qr.retentionDays).toBe(
      env.whatsapp_qr.retentionDays
    );
    expect(result.whatsapp_qr.maxFavorites).toBe(env.whatsapp_qr.maxFavorites);
  });

  it('chave AUSENTE no canal do console (nunca configurada) cai para o .env', () => {
    const env = envDefaults();
    // Diferente do teste acima: aqui `maxMessages` nem existe no
    // objeto — é o estado real de "o proprietário nunca mexeu nisso",
    // não "mexeu e escolheu sem limite".
    const result = mergeGlobalDefaults(
      { whatsapp_qr: { retentionDays: 10 } },
      env
    );
    expect(result.whatsapp_qr.maxMessages).toBe(env.whatsapp_qr.maxMessages);
  });

  it('chave de canal desconhecida é ignorada, canais conhecidos continuam válidos', () => {
    const env = envDefaults();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = mergeGlobalDefaults(
      { whatsapp_qr: { retentionDays: 15 }, telegram: { retentionDays: 1 } },
      env
    );
    expect(result.whatsapp_qr.retentionDays).toBe(15);
    expect(result.whatsapp_cloud).toEqual(env.whatsapp_cloud);
    warn.mockRestore();
  });

  it('tipo errado numa dimensão cai para o .env só naquela dimensão, com warning', () => {
    const env = envDefaults();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = mergeGlobalDefaults(
      { whatsapp_qr: { retentionDays: 'trinta', maxFavorites: 50 } },
      env
    );
    expect(result.whatsapp_qr.retentionDays).toBe(
      env.whatsapp_qr.retentionDays
    );
    expect(result.whatsapp_qr.maxFavorites).toBe(50);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('valor negativo é inválido e cai para o .env, com warning', () => {
    const env = envDefaults();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = mergeGlobalDefaults(
      { whatsapp_qr: { maxMessages: -5 } },
      env
    );
    expect(result.whatsapp_qr.maxMessages).toBe(env.whatsapp_qr.maxMessages);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  // Achado de code review: este parser reimplementava a validação de
  // `validate.ts` sem o teto de `retentionDays` que existe
  // especificamente porque `purge_channel_messages` (`NOW() -
  // make_interval(days => p_retention_days)`) estoura o intervalo
  // representável de `timestamptz` acima de ~2,46 milhões de dias.
  it('valor acima do teto de retenção é inválido e cai para o .env, com warning', () => {
    const env = envDefaults();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = mergeGlobalDefaults(
      { whatsapp_qr: { retentionDays: 1_000_001 } },
      env
    );
    expect(result.whatsapp_qr.retentionDays).toBe(
      env.whatsapp_qr.retentionDays
    );
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('exatamente no teto (1_000_000) é válido', () => {
    const env = envDefaults();
    const result = mergeGlobalDefaults(
      { whatsapp_qr: { retentionDays: 1_000_000 } },
      env
    );
    expect(result.whatsapp_qr.retentionDays).toBe(1_000_000);
  });

  it('JSON corrompido (string, array, número) no lugar do objeto todo não derruba a varredura', () => {
    const env = envDefaults();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(mergeGlobalDefaults('garbage', env)).toEqual(env);
    expect(mergeGlobalDefaults(42, env)).toEqual(env);
    expect(mergeGlobalDefaults(['a', 'b'], env)).toEqual(env);
    warn.mockRestore();
  });

  it('canal com valor de tipo errado (não objeto) cai por inteiro para o .env, canal irmão intacto', () => {
    const env = envDefaults();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = mergeGlobalDefaults(
      { whatsapp_qr: 'garbage', whatsapp_cloud: { retentionDays: 100 } },
      env
    );
    expect(result.whatsapp_qr).toEqual(env.whatsapp_qr);
    expect(result.whatsapp_cloud.retentionDays).toBe(100);
    warn.mockRestore();
  });

  it('não toca enabled/minAgeHours/intervalHours/batchLimit — só dimensões de canal', () => {
    const env = envDefaults({ enabled: true, minAgeHours: 72 });
    const result = mergeGlobalDefaults(
      { whatsapp_qr: { retentionDays: 1 } },
      env
    );
    expect(result.enabled).toBe(true);
    expect(result.minAgeHours).toBe(72);
    expect(result.intervalHours).toBe(env.intervalHours);
    expect(result.batchLimit).toBe(env.batchLimit);
  });
});

describe('validateRetentionDefaults', () => {
  it('aceita objeto vazio', () => {
    expect(validateRetentionDefaults({})).toEqual({ ok: true, value: {} });
  });

  it('aceita dimensões parciais por canal', () => {
    const result = validateRetentionDefaults({
      whatsapp_qr: { retentionDays: 10 },
    });
    expect(result).toEqual({
      ok: true,
      value: { whatsapp_qr: { retentionDays: 10 } },
    });
  });

  it('normaliza 0 para null', () => {
    const result = validateRetentionDefaults({
      whatsapp_cloud: { maxMessages: 0 },
    });
    expect(result).toEqual({
      ok: true,
      value: { whatsapp_cloud: { maxMessages: null } },
    });
  });

  it('rejeita não-objeto', () => {
    expect(validateRetentionDefaults(null).ok).toBe(false);
    expect(validateRetentionDefaults('x').ok).toBe(false);
    expect(validateRetentionDefaults([]).ok).toBe(false);
  });

  it('rejeita chave de canal desconhecida', () => {
    const result = validateRetentionDefaults({ telegram: {} });
    expect(result.ok).toBe(false);
  });

  it('rejeita chave de dimensão desconhecida', () => {
    const result = validateRetentionDefaults({
      whatsapp_qr: { maxUsers: 10 },
    });
    expect(result.ok).toBe(false);
  });

  it('rejeita valor negativo', () => {
    const result = validateRetentionDefaults({
      whatsapp_qr: { retentionDays: -1 },
    });
    expect(result.ok).toBe(false);
  });

  it('rejeita valor acima do teto de retenção (overflow de timestamptz em purge_channel_messages)', () => {
    const result = validateRetentionDefaults({
      whatsapp_qr: { retentionDays: 1_000_001 },
    });
    expect(result.ok).toBe(false);
  });

  it('aceita exatamente o teto (1_000_000)', () => {
    const result = validateRetentionDefaults({
      whatsapp_qr: { retentionDays: 1_000_000 },
    });
    expect(result).toEqual({
      ok: true,
      value: { whatsapp_qr: { retentionDays: 1_000_000 } },
    });
  });

  it('rejeita valor não inteiro', () => {
    const result = validateRetentionDefaults({
      whatsapp_qr: { retentionDays: 1.5 },
    });
    expect(result.ok).toBe(false);
  });

  it('rejeita tipo errado', () => {
    const result = validateRetentionDefaults({
      whatsapp_qr: { retentionDays: '10' },
    });
    expect(result.ok).toBe(false);
  });

  it('aceita null explícito como dimensão não configurada', () => {
    const result = validateRetentionDefaults({
      whatsapp_qr: { retentionDays: null },
    });
    expect(result).toEqual({
      ok: true,
      value: { whatsapp_qr: { retentionDays: null } },
    });
  });
});
