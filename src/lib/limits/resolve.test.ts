import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

import { COLD_SEND_DEFAULTS } from '@/lib/channels/cold-send-limit';
import { readColdSendLimitsFromSources } from '@/lib/channels/cold-send-limit';
import {
  getLimitEntry,
  type IntegerLimitEntry,
  type LimitHardCap,
} from './registry';
import {
  resetHardCapWarnings,
  resolveKey,
  resolveLimitValue,
  resolveTimeZoneValue,
  type LimitSources,
} from './resolve';

function entry(key: string): IntegerLimitEntry {
  const e = getLimitEntry(key);
  if (!e || e.valueType !== 'integer') throw new Error(`sem entrada: ${key}`);
  return e;
}

/** Entrada sintética — o resolvedor é testável sem depender de nenhum
 *  limite real existir, que é a razão de catálogo e resolvedor serem
 *  arquivos separados. */
function synthetic(over: Partial<IntegerLimitEntry> = {}): IntegerLimitEntry {
  return {
    key: 'x_teto',
    envVar: 'X_TETO',
    valueType: 'integer',
    codeDefault: 100,
    accountConfigurable: true,
    instanceConfigurable: true,
    allowZero: true,
    ...over,
  };
}

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  resetHardCapWarnings();
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  warn.mockRestore();
});

// ============================================================
// O teste que a F2 existe para passar (SPEC 069 §11.1)
// ============================================================

describe('compatibilidade — o R7 troca a ORIGEM do valor, não a política', () => {
  it('env vazio + sem override de conta + sem override de instância ⇒ COLD_SEND_DEFAULTS', () => {
    const resolvido = readColdSendLimitsFromSources({
      env: {},
      account: {},
      instance: {},
    });

    // deepEqual, não toMatchObject: um eixo a mais ou a menos aqui
    // seria uma mudança de política silenciosa num deployment que não
    // pediu nada.
    expect(resolvido).toEqual(COLD_SEND_DEFAULTS);
  });

  it('fontes inteiramente ausentes (nem objeto vazio) dão o mesmo resultado', () => {
    expect(readColdSendLimitsFromSources({})).toEqual(COLD_SEND_DEFAULTS);
  });

  it('todo eixo resolvido sem configuração vem do nível "code"', () => {
    for (const key of Object.values({
      silenceHours: 'evolution_cold_send_silence_hours',
      perHour: 'evolution_cold_send_per_hour',
      perDay: 'evolution_cold_send_per_day',
      minIntervalSeconds: 'evolution_cold_send_min_interval_seconds',
      warmupDays: 'evolution_cold_send_warmup_days',
    })) {
      expect(resolveKey(key, {}).level).toBe('code');
    }
  });
});

// ============================================================
// §3.4 regra 1 — o nível 3 sempre responde
// ============================================================

describe('regra 1 — nunca existe "sem limite" por ausência de configuração', () => {
  it('sem nenhuma fonte, devolve o padrão de código', () => {
    const r = resolveLimitValue(synthetic());
    expect(r).toEqual({
      key: 'x_teto',
      value: 100,
      level: 'code',
      clamped: false,
      hardCap: null,
    });
  });

  it('fontes presentes mas com a chave ausente também caem no código', () => {
    const r = resolveLimitValue(synthetic(), {
      instance: { outra_coisa: 5 },
      account: { outra_coisa: 7 },
      env: { OUTRA: '9' },
    });
    expect(r.value).toBe(100);
    expect(r.level).toBe('code');
  });

  it('nenhum caminho devolve undefined, null, NaN ou Infinity', () => {
    const lixos: unknown[] = [
      null,
      undefined,
      'sessenta',
      '60',
      -1,
      1.5,
      NaN,
      Infinity,
      [],
      {},
      true,
    ];
    for (const lixo of lixos) {
      const r = resolveLimitValue(synthetic(), { instance: { x_teto: lixo } });
      expect(Number.isInteger(r.value)).toBe(true);
      expect(r.value).toBe(100);
    }
  });
});

// ============================================================
// §3.4 regra 2 — valor inválido desce um nível, em TODO nível
// ============================================================

describe('regra 2 — valor inválido desce um nível, nunca vira ausência de limite', () => {
  // Os mesmos casos que `cold-send-limit.test.ts` já cobria para o
  // `.env`, agora exigidos também do JSONB da instância e da conta: um
  // JSONB torto é exatamente onde um teto poderia virar "sem teto".
  const invalidosJson = [-1, 1.5, 'abc', '60', true, null, [], {}];

  it.each(invalidosJson)(
    'instância com %j inválido desce para a conta',
    (bad) => {
      const r = resolveLimitValue(synthetic(), {
        instance: { x_teto: bad },
        account: { x_teto: 42 },
      });
      expect(r.value).toBe(42);
      expect(r.level).toBe('account');
    }
  );

  it.each(invalidosJson)('conta com %j inválido desce para o .env', (bad) => {
    const r = resolveLimitValue(synthetic(), {
      account: { x_teto: bad },
      env: { X_TETO: '33' },
    });
    expect(r.value).toBe(33);
    expect(r.level).toBe('env');
  });

  it.each(['abc', '-1', '3.5', '', '  '])(
    '.env com %j inválido desce para o código',
    (bad) => {
      const r = resolveLimitValue(synthetic(), { env: { X_TETO: bad } });
      expect(r.value).toBe(100);
      expect(r.level).toBe('code');
    }
  );

  it('notação científica no .env continua sendo aceita, como antes da F2', () => {
    // `Number('1e3') === 1000` e `Number.isInteger(1000)` — é o que o
    // `positiveInt` de `readColdSendLimits` sempre fez. Documentado
    // aqui porque parece um caso de "string inválida" e não é: mudar
    // isso seria mudar a política, que é justamente o que o R7 promete
    // não fazer.
    expect(
      resolveLimitValue(synthetic(), { env: { X_TETO: '1e3' } })
    ).toMatchObject({ value: 1000, level: 'env' });
  });

  it('instância inválida E conta inválida E env inválido ⇒ código', () => {
    const r = resolveLimitValue(synthetic(), {
      instance: { x_teto: 'lixo' },
      account: { x_teto: -5 },
      env: { X_TETO: 'nada' },
    });
    expect(r.value).toBe(100);
    expect(r.level).toBe('code');
  });

  it('JSONB inválido avisa em vez de sumir em silêncio', () => {
    resolveLimitValue(synthetic(), { instance: { x_teto: 'lixo' } });
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('instance.x_teto')
    );
  });

  it('fonte que não é objeto não derruba a resolução', () => {
    const r = resolveLimitValue(synthetic(), {
      instance: null,
      account: null,
      env: {},
    });
    expect(r.value).toBe(100);
  });
});

// ============================================================
// §3.4 regra 3 — `0` é valor, não ausência
// ============================================================

describe('regra 3 — 0 bloqueia o eixo; a exceção é silence_hours', () => {
  it('0 na instância é um valor (bloqueia), não uma ausência', () => {
    const r = resolveLimitValue(synthetic(), {
      instance: { x_teto: 0 },
      account: { x_teto: 50 },
      env: { X_TETO: '80' },
    });
    expect(r.value).toBe(0);
    expect(r.level).toBe('instance');
  });

  it('0 na conta é um valor (bloqueia)', () => {
    const r = resolveLimitValue(synthetic(), {
      account: { x_teto: 0 },
      env: { X_TETO: '80' },
    });
    expect(r.value).toBe(0);
    expect(r.level).toBe('account');
  });

  it('0 no .env é um valor (bloqueia) — mesma semântica de hoje', () => {
    const r = resolveLimitValue(synthetic(), { env: { X_TETO: '0' } });
    expect(r.value).toBe(0);
    expect(r.level).toBe('env');
  });

  it('silence_hours: 0 cai no padrão em TODOS os níveis (allowZero: false)', () => {
    const e = entry('evolution_cold_send_silence_hours');
    expect(e.allowZero).toBe(false);

    expect(
      resolveLimitValue(e, {
        env: { EVOLUTION_COLD_SEND_SILENCE_HOURS: '0' },
      }).value
    ).toBe(COLD_SEND_DEFAULTS.silenceHours);

    expect(
      resolveLimitValue(e, {
        account: { evolution_cold_send_silence_hours: 0 },
      }).value
    ).toBe(COLD_SEND_DEFAULTS.silenceHours);

    expect(
      resolveLimitValue(e, {
        instance: { evolution_cold_send_silence_hours: 0 },
      }).value
    ).toBe(COLD_SEND_DEFAULTS.silenceHours);
  });

  it('os quatro valores de evolution/config.ts também rejeitam 0 (comportamento de sempre)', () => {
    for (const key of [
      'channels_whatsapp_qr',
      'evolution_max_instances_total',
      'evolution_request_timeout_ms',
      'evolution_media_request_timeout_ms',
    ]) {
      const e = entry(key);
      expect(e.allowZero).toBe(false);
      expect(resolveLimitValue(e, { env: { [e.envVar]: '0' } }).value).toBe(
        e.codeDefault
      );
    }
  });
});

// ============================================================
// §3.4 regra 4 — o resolvedor devolve o nível que venceu
// ============================================================

describe('regra 4 — precedência instância > conta > .env > código', () => {
  it('os quatro níveis com valores DIFERENTES: a instância vence', () => {
    const sources: LimitSources = {
      instance: { x_teto: 1 },
      account: { x_teto: 2 },
      env: { X_TETO: '3' },
    };
    expect(resolveLimitValue(synthetic(), sources)).toMatchObject({
      value: 1,
      level: 'instance',
    });
  });

  it('sem instância, a conta vence o .env', () => {
    expect(
      resolveLimitValue(synthetic(), {
        account: { x_teto: 2 },
        env: { X_TETO: '3' },
      })
    ).toMatchObject({ value: 2, level: 'account' });
  });

  it('sem instância nem conta, o .env vence o código', () => {
    expect(
      resolveLimitValue(synthetic(), { env: { X_TETO: '3' } })
    ).toMatchObject({ value: 3, level: 'env' });
  });

  it('chave não configurável por instância IGNORA o override de instância', () => {
    const r = resolveLimitValue(synthetic({ instanceConfigurable: false }), {
      instance: { x_teto: 1 },
      account: { x_teto: 2 },
    });
    expect(r).toMatchObject({ value: 2, level: 'account' });
  });

  it('chave não configurável por conta IGNORA o override de conta', () => {
    // É o que impede uma conta de afrouxar um timeout ou o teto de
    // instâncias da VPS por `curl` na rota de plano.
    const r = resolveLimitValue(
      synthetic({ accountConfigurable: false, instanceConfigurable: false }),
      { instance: { x_teto: 1 }, account: { x_teto: 2 }, env: { X_TETO: '3' } }
    );
    expect(r).toMatchObject({ value: 3, level: 'env' });
  });
});

// ============================================================
// D-7 — teto duro do deployment
// ============================================================

const capMax: LimitHardCap = {
  envVar: 'X_TETO_MAX',
  codeDefault: 50,
  kind: 'max',
};
const capMin: LimitHardCap = {
  envVar: 'X_PISO_MIN',
  codeDefault: 10,
  kind: 'min',
};

describe('D-7 — clamp dos níveis 1a/1b, e o .env deliberadamente livre', () => {
  it('override de CONTA acima do teto é clampado, com clamped: true', () => {
    const r = resolveLimitValue(synthetic({ hardCap: capMax }), {
      account: { x_teto: 5000 },
    });
    expect(r).toMatchObject({
      value: 50,
      level: 'account',
      clamped: true,
      hardCap: 50,
    });
  });

  it('override de INSTÂNCIA acima do teto é clampado', () => {
    const r = resolveLimitValue(synthetic({ hardCap: capMax }), {
      instance: { x_teto: 999 },
    });
    expect(r).toMatchObject({ value: 50, level: 'instance', clamped: true });
  });

  it('override dentro do teto não é clampado', () => {
    const r = resolveLimitValue(synthetic({ hardCap: capMax }), {
      account: { x_teto: 30 },
    });
    expect(r).toMatchObject({ value: 30, clamped: false });
  });

  it('.env acima do teto NÃO é clampado — o nível 2 é a palavra do operador', () => {
    const r = resolveLimitValue(synthetic({ hardCap: capMax }), {
      env: { X_TETO: '5000' },
    });
    expect(r).toMatchObject({ value: 5000, level: 'env', clamped: false });
  });

  it('.env acima do teto avisa, porque significa teto mal configurado', () => {
    resolveLimitValue(synthetic({ hardCap: capMax }), {
      env: { X_TETO: '5000' },
    });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('X_TETO_MAX'));
  });

  it('o aviso do .env sai UMA vez por processo, não a cada envio', () => {
    const e = synthetic({ hardCap: capMax });
    for (let i = 0; i < 5; i++) {
      resolveLimitValue(e, { env: { X_TETO: '5000' } });
    }
    const avisos = warn.mock.calls.filter((c: unknown[]) =>
      String(c[0]).includes('X_TETO_MAX')
    );
    expect(avisos).toHaveLength(1);
  });

  it('PISO: valor abaixo do mínimo é ELEVADO (menor é mais perigoso)', () => {
    const r = resolveLimitValue(synthetic({ hardCap: capMin }), {
      account: { x_teto: 2 },
    });
    expect(r).toMatchObject({ value: 10, clamped: true, hardCap: 10 });
  });

  it('PISO: `0` numa conta também é elevado — não existe "sem intervalo" comprável', () => {
    const r = resolveLimitValue(synthetic({ hardCap: capMin }), {
      instance: { x_teto: 0 },
    });
    expect(r.value).toBe(10);
  });

  it('o teto duro pode ser afrouxado pelo .env do deployment', () => {
    const r = resolveLimitValue(synthetic({ hardCap: capMax }), {
      account: { x_teto: 200 },
      env: { X_TETO_MAX: '300' },
    });
    expect(r).toMatchObject({ value: 200, clamped: false, hardCap: 300 });
  });

  it('teto duro com valor inválido no .env cai no padrão do teto', () => {
    const r = resolveLimitValue(synthetic({ hardCap: capMax }), {
      account: { x_teto: 200 },
      env: { X_TETO_MAX: 'abc' },
    });
    expect(r).toMatchObject({ value: 50, clamped: true, hardCap: 50 });
  });

  it('chave sem teto duro devolve hardCap: null e nunca clampa', () => {
    const r = resolveLimitValue(synthetic(), { account: { x_teto: 99_999 } });
    expect(r).toMatchObject({ value: 99_999, clamped: false, hardCap: null });
  });
});

// ============================================================
// Os tetos reais do §3.3, com os valores que a SPEC fixou
// ============================================================

describe('§3.3 — os tetos duros reais', () => {
  it.each([
    ['evolution_cold_send_per_hour', 40, 'max'],
    ['evolution_cold_send_per_day', 250, 'max'],
    ['evolution_cold_send_min_interval_seconds', 10, 'min'],
    ['evolution_cold_send_warmup_days', 0, 'min'],
    ['evolution_check_per_hour', 200, 'max'],
    ['evolution_check_per_day', 2000, 'max'],
    ['evolution_check_min_interval_seconds', 1, 'min'],
    ['evolution_check_batch_size', 100, 'max'],
    ['evolution_harvest_per_run', 200, 'max'],
    ['evolution_harvest_max_per_instance', 2000, 'max'],
  ])('%s tem teto %d do tipo %s', (key, valor, tipo) => {
    const e = entry(key as string);
    expect(e.hardCap?.codeDefault).toBe(valor);
    expect(e.hardCap?.kind).toBe(tipo);
  });

  it('conta pedindo 5.000 envios/dia é clampada em 250 — fura o número do cliente, não a política', () => {
    const r = resolveKey('evolution_cold_send_per_day', {
      account: { evolution_cold_send_per_day: 5000 },
    });
    expect(r).toMatchObject({ value: 250, clamped: true, level: 'account' });
  });

  it('piso do intervalo mínimo: conta pedindo 1s recebe 10s', () => {
    const r = resolveKey('evolution_cold_send_min_interval_seconds', {
      account: { evolution_cold_send_min_interval_seconds: 1 },
    });
    expect(r).toMatchObject({ value: 10, clamped: true });
  });
});

// ============================================================
// A cascata montando ColdSendLimits inteiro
// ============================================================

describe('readColdSendLimitsFromSources — a cascata em cima do objeto real', () => {
  it('instância vence conta vence .env, eixo a eixo', () => {
    const limits = readColdSendLimitsFromSources({
      instance: { evolution_cold_send_per_day: 90 },
      account: {
        evolution_cold_send_per_hour: 20,
        evolution_cold_send_per_day: 70,
      },
      env: {
        EVOLUTION_COLD_SEND_PER_DAY: '65',
        EVOLUTION_COLD_SEND_WARMUP_DAYS: '7',
      },
    });

    expect(limits).toEqual({
      silenceHours: 24, // ninguém configurou: código
      perHour: 20, // conta
      perDay: 90, // instância vence conta e .env
      minIntervalSeconds: 45, // código
      warmupDays: 7, // .env
    });
  });

  it('um eixo torto não contamina os outros', () => {
    const limits = readColdSendLimitsFromSources({
      instance: { evolution_cold_send_per_day: 'muitos' },
      account: { evolution_cold_send_per_hour: 20 },
    });
    expect(limits.perDay).toBe(COLD_SEND_DEFAULTS.perDay);
    expect(limits.perHour).toBe(20);
  });
});

// ============================================================
// resolveKey e a entrada de fuso
// ============================================================

describe('resolveKey', () => {
  it('chave desconhecida LANÇA — é erro de programação, não estado', () => {
    expect(() => resolveKey('evolution_teto_inventado', {})).toThrow(
      /chave numérica desconhecida/
    );
  });

  it('a entrada de fuso não é resolvível como número', () => {
    expect(() => resolveKey('evolution_harvest_timezone', {})).toThrow();
  });
});

describe('resolveTimeZoneValue', () => {
  const tz = getLimitEntry('evolution_harvest_timezone');
  if (!tz || tz.valueType !== 'timezone') throw new Error('entrada ausente');

  it('sem .env, usa America/Sao_Paulo', () => {
    expect(resolveTimeZoneValue(tz, {})).toEqual({
      key: 'evolution_harvest_timezone',
      value: 'America/Sao_Paulo',
      level: 'code',
    });
  });

  it('fuso IANA válido no .env vence', () => {
    expect(
      resolveTimeZoneValue(tz, {
        env: { EVOLUTION_HARVEST_TIMEZONE: 'Europe/Lisbon' },
      })
    ).toMatchObject({ value: 'Europe/Lisbon', level: 'env' });
  });

  it('fuso inexistente cai no padrão em vez de fazer Intl lançar no cron', () => {
    expect(
      resolveTimeZoneValue(tz, {
        env: { EVOLUTION_HARVEST_TIMEZONE: 'Marte/Olympus_Mons' },
      })
    ).toMatchObject({ value: 'America/Sao_Paulo', level: 'code' });
  });
});
