import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { COLD_SEND_DEFAULTS } from '@/lib/channels/cold-send-limit';
import { resolveColdSendLimits } from '@/lib/channels/cold-send-resolve';
import {
  createLimitsCache,
  loadEvolutionLimits,
  loadLimitSources,
} from './load';
import { resetHardCapWarnings } from './resolve';

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  resetHardCapWarnings();
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  warn.mockRestore();
});

/**
 * Supabase de mentira com contagem de chamadas — o que importa aqui,
 * além do valor resolvido, é QUANTAS idas ao banco a resolução custa:
 * o §4.3 pede uma por instância por ciclo, não uma por contato.
 */
function makeDb(opts: {
  accountLimits?: unknown;
  accountError?: { message: string };
  instanceOverrides?: unknown;
  instanceError?: { message: string };
  noRpc?: boolean;
}) {
  const calls = { rpc: 0, from: 0 };

  const client = {
    rpc: opts.noRpc
      ? undefined
      : (_fn: string, _args: unknown) => {
          calls.rpc++;
          return Promise.resolve({
            data: opts.accountLimits ?? null,
            error: opts.accountError ?? null,
          });
        },
    from: () => {
      calls.from++;
      const c = {
        select: () => c,
        eq: () => c,
        maybeSingle: () =>
          Promise.resolve({
            data:
              opts.instanceOverrides === undefined
                ? null
                : { limit_overrides: opts.instanceOverrides },
            error: opts.instanceError ?? null,
          }),
      };
      return c;
    },
  } as unknown as SupabaseClient;

  return { client, calls };
}

describe('loadLimitSources', () => {
  it('lê os dois níveis numa ida só cada', async () => {
    const { client, calls } = makeDb({
      accountLimits: { evolution_cold_send_per_day: 150 },
      instanceOverrides: { evolution_cold_send_per_hour: 8 },
    });

    const sources = await loadLimitSources(
      client,
      { accountId: 'acct-1', channelId: 'chan-1' },
      {}
    );

    expect(sources.account).toEqual({ evolution_cold_send_per_day: 150 });
    expect(sources.instance).toEqual({ evolution_cold_send_per_hour: 8 });
    expect(calls).toEqual({ rpc: 1, from: 1 });
  });

  it('sem accountId, não chama a RPC', async () => {
    const { client, calls } = makeDb({ instanceOverrides: {} });
    await loadLimitSources(client, { channelId: 'chan-1' }, {});
    expect(calls.rpc).toBe(0);
    expect(calls.from).toBe(1);
  });

  it('sem channelId, não lê evolution_instances', async () => {
    const { client, calls } = makeDb({ accountLimits: {} });
    await loadLimitSources(client, { accountId: 'acct-1' }, {});
    expect(calls.from).toBe(0);
  });

  it('sem escopo nenhum, não toca o banco e devolve fontes vazias', async () => {
    const { client, calls } = makeDb({});
    const sources = await loadLimitSources(client, {}, {});
    expect(calls).toEqual({ rpc: 0, from: 0 });
    expect(sources.account).toEqual({});
    expect(sources.instance).toEqual({});
  });
});

/**
 * A postura que o cabeçalho de `load.ts` promete: nenhuma leitura
 * falha para cima. Um banco oscilando não pode virar "sem teto" (o
 * resultado perigoso) nem derrubar o envio (o resultado que faria
 * alguém querer desligar o freio).
 */
describe('loadLimitSources — degradação', () => {
  it('RPC devolvendo erro: nível de conta ignorado, cascata segue', async () => {
    const { client } = makeDb({
      accountError: { message: 'permission denied' },
      instanceOverrides: {},
    });

    const sources = await loadLimitSources(
      client,
      { accountId: 'acct-1', channelId: 'chan-1' },
      {}
    );

    expect(sources.account).toEqual({});
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('account_effective_limits')
    );
  });

  it('leitura da instância com erro: nível ignorado, com aviso', async () => {
    const { client } = makeDb({
      accountLimits: {},
      instanceError: { message: 'timeout' },
    });

    const sources = await loadLimitSources(
      client,
      { accountId: 'a', channelId: 'c' },
      {}
    );

    expect(sources.instance).toEqual({});
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('limit_overrides')
    );
  });

  it('cliente SEM rpc (o caso que mais dói: engano de wiring) não lança', async () => {
    const { client } = makeDb({ noRpc: true, instanceOverrides: {} });

    const sources = await loadLimitSources(
      client,
      { accountId: 'a', channelId: 'c' },
      {}
    );

    expect(sources.account).toEqual({});
    expect(sources.instance).toEqual({});
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('níveis de banco indisponíveis')
    );
  });

  it('JSONB que não é objeto (array, string) é ignorado sem quebrar', async () => {
    for (const lixo of [['a'], 'texto', 42, true]) {
      const { client } = makeDb({
        accountLimits: lixo,
        instanceOverrides: lixo,
      });
      const sources = await loadLimitSources(
        client,
        { accountId: 'a', channelId: 'c' },
        {}
      );
      expect(sources.account).toEqual({});
      expect(sources.instance).toEqual({});
    }
  });

  it('banco indisponível ⇒ os limites resolvidos são os padrões, nunca "sem limite"', async () => {
    const { client } = makeDb({ noRpc: true });
    const { limits } = await resolveColdSendLimits(
      client,
      { accountId: 'a', channelId: 'c' },
      undefined,
      {}
    );
    expect(limits).toEqual(COLD_SEND_DEFAULTS);
  });
});

describe('cache de ciclo (§4.3)', () => {
  it('mesma instância duas vezes no mesmo ciclo: uma ida ao banco', async () => {
    const { client, calls } = makeDb({
      accountLimits: {},
      instanceOverrides: {},
    });
    const cache = createLimitsCache();

    await loadEvolutionLimits(
      client,
      { accountId: 'a', channelId: 'c' },
      cache,
      {}
    );
    await loadEvolutionLimits(
      client,
      { accountId: 'a', channelId: 'c' },
      cache,
      {}
    );

    expect(calls).toEqual({ rpc: 1, from: 1 });
  });

  it('duas resoluções no MESMO tick compartilham o round-trip', async () => {
    const { client, calls } = makeDb({
      accountLimits: {},
      instanceOverrides: {},
    });
    const cache = createLimitsCache();

    await Promise.all([
      loadEvolutionLimits(
        client,
        { accountId: 'a', channelId: 'c' },
        cache,
        {}
      ),
      loadEvolutionLimits(
        client,
        { accountId: 'a', channelId: 'c' },
        cache,
        {}
      ),
    ]);

    expect(calls).toEqual({ rpc: 1, from: 1 });
  });

  it('instâncias diferentes não compartilham entrada de cache', async () => {
    const { client, calls } = makeDb({
      accountLimits: {},
      instanceOverrides: {},
    });
    const cache = createLimitsCache();

    await loadEvolutionLimits(
      client,
      { accountId: 'a', channelId: 'c1' },
      cache,
      {}
    );
    await loadEvolutionLimits(
      client,
      { accountId: 'a', channelId: 'c2' },
      cache,
      {}
    );

    expect(calls).toEqual({ rpc: 2, from: 2 });
  });

  it('sem cache, cada resolução vai ao banco — o cache é opt-in do chamador', async () => {
    const { client, calls } = makeDb({
      accountLimits: {},
      instanceOverrides: {},
    });

    await loadEvolutionLimits(
      client,
      { accountId: 'a', channelId: 'c' },
      undefined,
      {}
    );
    await loadEvolutionLimits(
      client,
      { accountId: 'a', channelId: 'c' },
      undefined,
      {}
    );

    expect(calls).toEqual({ rpc: 2, from: 2 });
  });
});

describe('loadEvolutionLimits — resultado', () => {
  it('devolve as 21 chaves numéricas do catálogo, já resolvidas', async () => {
    const { client } = makeDb({ accountLimits: {}, instanceOverrides: {} });
    const limits = await loadEvolutionLimits(
      client,
      { accountId: 'a', channelId: 'c' },
      undefined,
      {}
    );
    // 23 entradas (22 do §3 + o timeout info/avatar da F3) menos a de fuso, que não é número.
    expect(Object.keys(limits)).toHaveLength(22);
    expect(limits.evolution_cold_send_per_day).toMatchObject({
      value: 60,
      level: 'code',
    });
  });

  it('a cascata inteira, do banco à decisão, com os quatro níveis', async () => {
    const { client } = makeDb({
      accountLimits: {
        evolution_cold_send_per_day: 150,
        evolution_cold_send_per_hour: 30,
      },
      instanceOverrides: { evolution_cold_send_per_hour: 5 },
    });

    const { limits, levels } = await resolveColdSendLimits(
      client,
      { accountId: 'a', channelId: 'c' },
      undefined,
      {}
    );

    expect(limits.perHour).toBe(5); // instância
    expect(limits.perDay).toBe(150); // conta
    expect(limits.warmupDays).toBe(COLD_SEND_DEFAULTS.warmupDays); // código
    expect(levels).toMatchObject({
      perHour: 'instance',
      perDay: 'account',
      warmupDays: 'code',
    });
  });
});
