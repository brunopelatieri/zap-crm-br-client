import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { COLD_SEND_DEFAULTS } from '@/lib/channels/cold-send-limit';
import {
  describeCheckLevels,
  readCheckLimitsFromSources,
  resolveCheckLimits,
} from './check-limits';

describe('readCheckLimitsFromSources — os três eixos + a rampa compartilhada (D-1)', () => {
  it('sem nenhuma configuração, os padrões de checagem, não os de envio frio', () => {
    const limits = readCheckLimitsFromSources({});
    expect(limits.perHour).toBe(60);
    expect(limits.perDay).toBe(300);
    expect(limits.minIntervalSeconds).toBe(5);
    // Os três são DIFERENTES dos padrões de envio frio — provar que não
    // é a mesma cota com outro nome.
    expect(limits.perHour).not.toBe(COLD_SEND_DEFAULTS.perHour);
    expect(limits.perDay).not.toBe(COLD_SEND_DEFAULTS.perDay);
  });

  it('warmupDays vem do eixo de ENVIO FRIO, não de um eixo próprio de checagem', () => {
    const limits = readCheckLimitsFromSources({
      env: { EVOLUTION_COLD_SEND_WARMUP_DAYS: '21' },
    });
    expect(limits.warmupDays).toBe(21);
  });

  it('override de checagem não vaza para o warmupDays compartilhado', () => {
    const limits = readCheckLimitsFromSources({
      account: {
        evolution_check_per_day: 999,
        evolution_cold_send_warmup_days: 5,
      },
    });
    expect(limits.perDay).toBe(999);
    expect(limits.warmupDays).toBe(5);
  });

  it('precedência instância > conta > env > código vale para os três eixos de checagem', () => {
    const limits = readCheckLimitsFromSources({
      instance: { evolution_check_per_hour: 10 },
      account: { evolution_check_per_hour: 20, evolution_check_per_day: 500 },
      env: { EVOLUTION_CHECK_PER_DAY: '400' },
    });
    expect(limits.perHour).toBe(10); // instância
    expect(limits.perDay).toBe(500); // conta
  });

  it('silenceHours é sempre 0 — não é lido por evaluateColdSend, mas o tipo exige o campo', () => {
    expect(readCheckLimitsFromSources({}).silenceHours).toBe(0);
  });
});

describe('describeCheckLevels', () => {
  it('reporta o nível de cada eixo, inclusive o compartilhado', () => {
    const levels = describeCheckLevels({
      instance: { evolution_check_per_hour: 10 },
      env: { EVOLUTION_COLD_SEND_WARMUP_DAYS: '7' },
    });
    expect(levels.perHour).toBe('instance');
    expect(levels.warmupDays).toBe('env');
    expect(levels.perDay).toBe('code');
  });
});

describe('resolveCheckLimits — a metade impura', () => {
  function makeDb(opts: { account?: unknown; instance?: unknown }) {
    return {
      rpc: () => Promise.resolve({ data: opts.account ?? {}, error: null }),
      from: () => ({
        select: () => ({
          eq: () => ({
            maybeSingle: () =>
              Promise.resolve({
                data: { limit_overrides: opts.instance ?? {} },
                error: null,
              }),
          }),
        }),
      }),
    } as unknown as SupabaseClient;
  }

  it('percorre a cascata de banco até resolver os três eixos', async () => {
    const db = makeDb({
      account: { evolution_check_per_day: 800 },
      instance: {},
    });

    const { limits, levels } = await resolveCheckLimits(
      db,
      { accountId: 'a', channelId: 'c' },
      undefined,
      {}
    );

    expect(limits.perDay).toBe(800);
    expect(levels.perDay).toBe('account');
  });

  it('sem nada configurado no banco, cai nos padrões de código', async () => {
    const db = makeDb({});
    const { limits } = await resolveCheckLimits(
      db,
      { accountId: 'a', channelId: 'c' },
      undefined,
      {}
    );
    expect(limits.perHour).toBe(60);
    expect(limits.perDay).toBe(300);
    expect(limits.minIntervalSeconds).toBe(5);
  });
});
