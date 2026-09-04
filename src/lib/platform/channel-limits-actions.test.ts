import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * SPEC 069 §6.6/F10 — o editor de três estados do nível 1a/1b.
 *
 * ✅ Correção (code review): este módulo — a lógica compartilhada pelas
 * duas rotas de `channel-limits` (secreta e de sessão) — não tinha
 * `*.test.ts` co-locado, violando a regra do AGENTS.md ("todo módulo
 * relevante já tem *.test.ts co-locado"). A ternária do teto duro
 * (`entry.hardCap.kind === 'max' ? value > capValue : value < capValue`)
 * é o único guardião que impede um operador de configurar um eixo de
 * segurança acima do teto do deployment — um `>`/`<` trocado ali
 * passaria batido sem um teste olhando as duas direções.
 */

let accountPlanOverrides: Record<string, unknown> = {};
let accountHasNoPlan = false;
let instanceRows: Array<{
  id: string;
  channel_id: string;
  limit_overrides: Record<string, unknown>;
  channels: { name: string } | { name: string }[];
}> = [];
const updates: Array<{ table: string; payload: unknown; channelId?: string }> =
  [];

function makeDb() {
  return {
    from: (table: string) => {
      const filters: Record<string, unknown> = {};
      const chain: Record<string, unknown> = {};
      chain.select = () => chain;
      chain.eq = (key: string, value: unknown) => {
        filters[key] = value;
        return chain;
      };
      chain.update = (payload: Record<string, unknown>) => {
        updates.push({
          table,
          payload,
          channelId: filters.channel_id as string | undefined,
        });
        return {
          eq: () => Promise.resolve({ error: null }),
        };
      };
      chain.maybeSingle = () => {
        if (table === 'account_plans') {
          return Promise.resolve({
            data: accountHasNoPlan
              ? null
              : { limit_overrides: accountPlanOverrides },
            error: null,
          });
        }
        if (table === 'evolution_instances') {
          const row = instanceRows.find(
            (r) => r.channel_id === filters.channel_id
          );
          return Promise.resolve({
            data: row
              ? { id: row.id, limit_overrides: row.limit_overrides }
              : null,
            error: null,
          });
        }
        return Promise.resolve({ data: null, error: null });
      };
      chain.then = (resolve: (v: unknown) => unknown) => {
        if (table === 'evolution_instances') {
          return Promise.resolve({ data: instanceRows, error: null }).then(
            resolve
          );
        }
        return Promise.resolve({ data: null, error: null }).then(resolve);
      };
      return chain;
    },
    rpc: (fn: string) => {
      if (fn === 'account_effective_limits') {
        return Promise.resolve({ data: accountPlanOverrides, error: null });
      }
      return Promise.resolve({ data: {}, error: null });
    },
  };
}

vi.mock('@/lib/supabase/admin', () => ({
  supabaseAdmin: () => makeDb(),
}));

import {
  applyChannelLimits,
  loadChannelLimits,
  validateChannelLimitsPatch,
  validateLimitEntries,
} from './channel-limits-actions';
import {
  ACCOUNT_CONFIGURABLE_LIMIT_KEYS,
  INSTANCE_CONFIGURABLE_LIMIT_KEYS,
} from '@/lib/limits/registry';

beforeEach(() => {
  updates.length = 0;
  accountPlanOverrides = {};
  accountHasNoPlan = false;
  instanceRows = [
    {
      id: 'inst-1',
      channel_id: 'chan-1',
      limit_overrides: {},
      channels: { name: 'Comercial' },
    },
  ];
});

describe('validateLimitEntries', () => {
  it('chave desconhecida → erro', () => {
    expect(
      validateLimitEntries({ nao_existe: 10 }, ACCOUNT_CONFIGURABLE_LIMIT_KEYS)
    ).toMatchObject({ error: expect.stringContaining('unknown limit key') });
  });

  it('valor não inteiro → erro', () => {
    expect(
      validateLimitEntries(
        { evolution_cold_send_per_day: 1.5 },
        ACCOUNT_CONFIGURABLE_LIMIT_KEYS
      )
    ).toMatchObject({ error: expect.stringContaining('non-negative integer') });
  });

  it('valor negativo → erro', () => {
    expect(
      validateLimitEntries(
        { evolution_cold_send_per_day: -1 },
        ACCOUNT_CONFIGURABLE_LIMIT_KEYS
      )
    ).toMatchObject({ error: expect.stringContaining('non-negative integer') });
  });

  it('null passa direto (é como se remove o override, não é validado como valor)', () => {
    expect(
      validateLimitEntries(
        { evolution_cold_send_per_day: null },
        ACCOUNT_CONFIGURABLE_LIMIT_KEYS
      )
    ).toBeNull();
  });

  it('0 é aceito numa chave com allowZero e sem teto duro que o rejeite', () => {
    // per_day tem allowZero:true e o teto duro é de MÁXIMO (250) — 0
    // nunca ultrapassa um teto de máximo, então nada barra o zero aqui.
    expect(
      validateLimitEntries(
        { evolution_cold_send_per_day: 0 },
        ACCOUNT_CONFIGURABLE_LIMIT_KEYS
      )
    ).toBeNull();
  });

  it('0 numa chave com allowZero mas cujo teto duro é um PISO → ainda erra (o piso vale mesmo com allowZero)', () => {
    // min_interval_seconds tem allowZero:true (0 bloquearia o intervalo
    // mínimo), mas o teto duro do deployment é um piso de 10 — os dois
    // são checagens independentes, e 0 < 10 fere o piso de qualquer jeito.
    expect(
      validateLimitEntries(
        { evolution_cold_send_min_interval_seconds: 0 },
        ACCOUNT_CONFIGURABLE_LIMIT_KEYS
      )
    ).toMatchObject({
      error: expect.stringContaining('below the floor of 10'),
    });
  });

  it('valor acima do teto duro (kind max) → erro "above the ceiling"', () => {
    const result = validateLimitEntries(
      { evolution_cold_send_per_day: 5000 },
      ACCOUNT_CONFIGURABLE_LIMIT_KEYS
    );
    expect(result).toMatchObject({
      error: expect.stringContaining('above the ceiling of 250'),
    });
  });

  it('valor abaixo do piso duro (kind min) → erro "below the floor"', () => {
    const result = validateLimitEntries(
      { evolution_cold_send_min_interval_seconds: 1 },
      ACCOUNT_CONFIGURABLE_LIMIT_KEYS
    );
    expect(result).toMatchObject({
      error: expect.stringContaining('below the floor of 10'),
    });
  });

  it('valor dentro dos dois tetos duros → sem erro (não confunde max com min)', () => {
    expect(
      validateLimitEntries(
        { evolution_cold_send_per_day: 100 },
        ACCOUNT_CONFIGURABLE_LIMIT_KEYS
      )
    ).toBeNull();
    expect(
      validateLimitEntries(
        { evolution_cold_send_min_interval_seconds: 30 },
        ACCOUNT_CONFIGURABLE_LIMIT_KEYS
      )
    ).toBeNull();
  });

  it('chave de instância não permitida no conjunto de conta → erro', () => {
    // Uma chave só de instância (não em ACCOUNT_CONFIGURABLE_LIMIT_KEYS)
    // testada contra o conjunto de CONTA deve ser rejeitada como
    // desconhecida ali, provando que os dois conjuntos são distintos.
    const instanceOnlyKey = INSTANCE_CONFIGURABLE_LIMIT_KEYS.find(
      (k) => !ACCOUNT_CONFIGURABLE_LIMIT_KEYS.includes(k)
    );
    if (!instanceOnlyKey) return; // nada a provar se os conjuntos forem iguais
    expect(
      validateLimitEntries(
        { [instanceOnlyKey]: 1 },
        ACCOUNT_CONFIGURABLE_LIMIT_KEYS
      )
    ).toMatchObject({ error: expect.stringContaining('unknown limit key') });
  });

  it('undefined (nenhuma entrada) → null, nada a validar', () => {
    expect(
      validateLimitEntries(undefined, ACCOUNT_CONFIGURABLE_LIMIT_KEYS)
    ).toBeNull();
  });
});

describe('validateChannelLimitsPatch', () => {
  it('propaga o erro do lado account primeiro', () => {
    const result = validateChannelLimitsPatch({
      account: { nao_existe: 1 },
    });
    expect(result).toMatchObject({ error: expect.stringContaining('unknown') });
  });

  it('propaga o erro de uma instância específica', () => {
    const result = validateChannelLimitsPatch({
      instances: { 'chan-1': { evolution_cold_send_per_day: 5000 } },
    });
    expect(result).toMatchObject({
      error: expect.stringContaining('above the ceiling'),
    });
  });

  it('patch válido nos dois lados → null', () => {
    const result = validateChannelLimitsPatch({
      account: { evolution_cold_send_per_day: 100 },
      instances: { 'chan-1': { evolution_cold_send_per_hour: 8 } },
    });
    expect(result).toBeNull();
  });

  it('patch vazio → null', () => {
    expect(validateChannelLimitsPatch({})).toBeNull();
  });
});

describe('loadChannelLimits', () => {
  it('resolve os limites de conta com value/level/hardCap/override', async () => {
    accountPlanOverrides = { evolution_cold_send_per_day: 150 };

    const snapshot = await loadChannelLimits(makeDb() as never, 'acct-1');

    expect(snapshot.account.evolution_cold_send_per_day).toMatchObject({
      value: 150,
      level: 'account',
      override: 150,
    });
    expect(snapshot.account.evolution_cold_send_per_hour).toMatchObject({
      value: 12,
      level: 'code',
      override: null,
    });
  });

  it('monta a lista de instâncias com overrides numéricos e o nome do canal', async () => {
    instanceRows = [
      {
        id: 'inst-1',
        channel_id: 'chan-1',
        limit_overrides: {
          evolution_cold_send_per_hour: 8,
          chave_desconhecida: 99,
          nao_numerico: 'x',
        },
        channels: { name: 'Comercial' },
      },
    ];

    const snapshot = await loadChannelLimits(makeDb() as never, 'acct-1');

    expect(snapshot.instances).toEqual([
      {
        channelId: 'chan-1',
        label: 'Comercial',
        overrides: { evolution_cold_send_per_hour: 8 },
      },
    ]);
  });

  it('relação channels como array (join do Supabase) também resolve o label', async () => {
    instanceRows = [
      {
        id: 'inst-1',
        channel_id: 'chan-1',
        limit_overrides: {},
        channels: [{ name: 'Comercial' }],
      },
    ];

    const snapshot = await loadChannelLimits(makeDb() as never, 'acct-1');

    expect(snapshot.instances[0]).toMatchObject({ label: 'Comercial' });
  });
});

describe('applyChannelLimits — validação bloqueia antes de tocar o banco', () => {
  it('patch inválido → 400, nenhum update é gravado', async () => {
    const result = await applyChannelLimits('acct-1', {
      account: { nao_existe: 10 },
    });
    expect(result).toEqual({
      ok: false,
      status: 400,
      error: expect.stringContaining('unknown limit key'),
    });
    expect(updates).toHaveLength(0);
  });

  it('valor acima do teto duro → 400, nenhum update é gravado', async () => {
    const result = await applyChannelLimits('acct-1', {
      account: { evolution_cold_send_per_day: 5000 },
    });
    expect(result).toEqual({
      ok: false,
      status: 400,
      error: expect.stringContaining('above the ceiling of 250'),
    });
    expect(updates).toHaveLength(0);
  });
});

describe('applyChannelLimits — grava e remove (merge, nunca substitui)', () => {
  it('salva um override de conta SEM apagar os outros já existentes', async () => {
    accountPlanOverrides = { contacts: 5000 }; // override de QUOTA, não de segurança

    await applyChannelLimits('acct-1', {
      account: { evolution_cold_send_per_day: 150 },
    });

    const update = updates.find((u) => u.table === 'account_plans');
    expect(update?.payload).toEqual({
      limit_overrides: { contacts: 5000, evolution_cold_send_per_day: 150 },
    });
  });

  it('null REMOVE o override (volta a herdar)', async () => {
    accountPlanOverrides = {
      evolution_cold_send_per_day: 150,
      contacts: 5000,
    };

    await applyChannelLimits('acct-1', {
      account: { evolution_cold_send_per_day: null },
    });

    const update = updates.find((u) => u.table === 'account_plans');
    expect(update?.payload).toEqual({ limit_overrides: { contacts: 5000 } });
  });

  it('0 é um valor válido (bloqueia o eixo), não é tratado como remoção', async () => {
    await applyChannelLimits('acct-1', {
      account: { evolution_cold_send_per_day: 0 },
    });

    const update = updates.find((u) => u.table === 'account_plans');
    expect(update?.payload).toEqual({
      limit_overrides: { evolution_cold_send_per_day: 0 },
    });
  });

  it('conta sem plano atribuído → 404, nada gravado', async () => {
    accountHasNoPlan = true;
    const result = await applyChannelLimits('acct-1', {
      account: { evolution_cold_send_per_day: 100 },
    });
    expect(result).toEqual({
      ok: false,
      status: 404,
      error: 'account has no plan assigned',
    });
    expect(updates).toHaveLength(0);
  });

  it('salva override por instância, escopado ao channel_id certo', async () => {
    await applyChannelLimits('acct-1', {
      instances: { 'chan-1': { evolution_cold_send_per_hour: 8 } },
    });

    const update = updates.find((u) => u.table === 'evolution_instances');
    expect(update?.payload).toEqual({
      limit_overrides: { evolution_cold_send_per_hour: 8 },
    });
  });

  it('instância de outra conta (não encontrada) → 404, nada gravado', async () => {
    instanceRows = [];
    const result = await applyChannelLimits('acct-1', {
      instances: { 'chan-outro': { evolution_cold_send_per_hour: 8 } },
    });
    expect(result).toEqual({
      ok: false,
      status: 404,
      error: 'instance not found for channel chan-outro',
    });
    expect(updates).toHaveLength(0);
  });

  it('patch sem account nem instances → ok, nada gravado', async () => {
    const result = await applyChannelLimits('acct-1', {});
    expect(result).toEqual({ ok: true });
    expect(updates).toHaveLength(0);
  });

  it('entradas vazias em instances (objeto {} para um canal) não geram update', async () => {
    const result = await applyChannelLimits('acct-1', {
      instances: { 'chan-1': {} },
    });
    expect(result).toEqual({ ok: true });
    expect(updates).toHaveLength(0);
  });
});
