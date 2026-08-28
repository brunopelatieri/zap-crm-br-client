/**
 * Tier e cota POR NÚMERO (SPEC 064 D-4 / §3.9, fase F3).
 *
 * Os dois erros que estes testes existem para impedir são silenciosos:
 *
 *   1. **A escrita do cache por `account_id`.** Numa conta com dois
 *      números, gravar o tier lido do número A na linha do número B faz
 *      a leitura seguinte "funcionar" — com o teto errado. Nada falha,
 *      nada loga.
 *   2. **Erro de cota lido como zero.** `Number(usedRaw ?? 0)` fazia
 *      qualquer falha da RPC virar "0 de 1.000 usados nas últimas 24 h"
 *      numa tela usada para decidir tamanho de audiência.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { ChannelNotConfiguredError } from '@/lib/channels/errors';
import { FALLBACK_TIER, tierCap } from './messaging-limit';
import { loadAccountQuota } from './messaging-limit-server';

const resolveCloudConfig = vi.fn();
vi.mock('@/lib/whatsapp/cloud-channels', () => ({
  resolveCloudConfig: (...a: unknown[]) => resolveCloudConfig(...a),
}));

vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: (v: string) => `decrypted:${v}`,
}));

const fetchMessagingLimit = vi.fn();
vi.mock('@/lib/whatsapp/meta-api', () => ({
  fetchMessagingLimit: (...a: unknown[]) => fetchMessagingLimit(...a),
}));

interface UpdateOp {
  payload: Record<string, unknown>;
  filters: Array<[string, unknown]>;
}

function makeDb(rpcResult: { data?: unknown; error?: unknown }) {
  const updates: UpdateOp[] = [];
  const rpcCalls: Array<[string, Record<string, unknown>]> = [];

  const client = {
    from: () => {
      const op: UpdateOp = { payload: {}, filters: [] };
      const chain: Record<string, unknown> = {
        update: (payload: Record<string, unknown>) => {
          op.payload = payload;
          updates.push(op);
          return chain;
        },
        eq: (k: string, v: unknown) => {
          op.filters.push([k, v]);
          return chain;
        },
        then: (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) =>
          Promise.resolve({ error: null }).then(onF, onR),
      };
      return chain;
    },
    rpc: (name: string, args: Record<string, unknown>) => {
      rpcCalls.push([name, args]);
      return Promise.resolve(rpcResult);
    },
  };

  return { db: client as unknown as SupabaseClient, updates, rpcCalls };
}

/** Canal + config de um número oficial, como `resolveCloudConfig` devolve. */
function cloudNumber(channelId: string, phoneNumberId: string) {
  return {
    channel: { id: channelId, status: 'connected' },
    config: {
      id: `cfg-${channelId}`,
      channel_id: channelId,
      phone_number_id: phoneNumberId,
      access_token: `cipher-${channelId}`,
      messaging_limit_tier: null,
      messaging_limit_checked_at: null,
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  resolveCloudConfig.mockResolvedValue(cloudNumber('ch-a', 'pnid-a'));
  fetchMessagingLimit.mockResolvedValue({ messaging_limit_tier: 'TIER_1K' });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('loadAccountQuota — por canal', () => {
  it('chama a RPC de cota com p_channel_id do canal resolvido', async () => {
    const { db, rpcCalls } = makeDb({ data: 42, error: null });

    const result = await loadAccountQuota(db, 'acct-1');

    expect(rpcCalls).toEqual([
      [
        'broadcast_quota_usage',
        { p_account_id: 'acct-1', p_channel_id: 'ch-a' },
      ],
    ]);
    expect(result).toMatchObject({ configured: true });
    if (result.configured) {
      expect(result.snapshot.usedLast24h).toBe(42);
      expect(result.snapshot.usageUnavailable).toBe(false);
    }
  });

  it('repassa o channelId pedido — mede o número escolhido, não o padrão', async () => {
    resolveCloudConfig.mockResolvedValue(cloudNumber('ch-b', 'pnid-b'));
    const { db, rpcCalls } = makeDb({ data: 7, error: null });

    await loadAccountQuota(db, 'acct-1', { channelId: 'ch-b' });

    expect(resolveCloudConfig).toHaveBeenCalledWith(db, 'acct-1', 'ch-b');
    expect(rpcCalls[0][1]).toMatchObject({ p_channel_id: 'ch-b' });
    // E a Meta é consultada com o phone_number_id DAQUELE número.
    expect(fetchMessagingLimit).toHaveBeenCalledWith({
      phoneNumberId: 'pnid-b',
      accessToken: 'decrypted:cipher-ch-b',
    });
  });

  it('grava o tier na linha DO CANAL, nunca só por conta (§9, armadilha 2)', async () => {
    const { db, updates } = makeDb({ data: 0, error: null });

    await loadAccountQuota(db, 'acct-1');

    expect(updates).toHaveLength(1);
    expect(updates[0].payload).toMatchObject({
      messaging_limit_tier: 'TIER_1K',
    });
    // O filtro por canal é o que impede o tier do número A de ser
    // gravado na linha do número B.
    expect(updates[0].filters).toContainEqual(['channel_id', 'ch-a']);
    expect(updates[0].filters).toContainEqual(['account_id', 'acct-1']);
  });

  it('falha da RPC vira usageUnavailable, não zero', async () => {
    const { db } = makeDb({ data: null, error: { message: 'PGRST202' } });

    const result = await loadAccountQuota(db, 'acct-1');

    expect(result.configured).toBe(true);
    if (result.configured) {
      // `PGRST202` é exatamente o que a troca de assinatura da 072
      // devolve enquanto o cache de schema do PostgREST não recarrega.
      expect(result.snapshot.usageUnavailable).toBe(true);
    }
  });

  it('RPC sem erro mas sem dado também é "indisponível"', async () => {
    const { db } = makeDb({ data: null, error: null });

    const result = await loadAccountQuota(db, 'acct-1');

    expect(result.configured).toBe(true);
    if (result.configured) expect(result.snapshot.usageUnavailable).toBe(true);
  });

  it('conta sem número oficial devolve no_config, sem chamar a Meta', async () => {
    resolveCloudConfig.mockRejectedValue(new ChannelNotConfiguredError());
    const { db, rpcCalls } = makeDb({ data: 0, error: null });

    await expect(loadAccountQuota(db, 'acct-1')).resolves.toEqual({
      configured: false,
      reason: 'no_config',
    });
    expect(rpcCalls).toHaveLength(0);
    expect(fetchMessagingLimit).not.toHaveBeenCalled();
  });

  it('canal INUTILIZÁVEL não vira "sem WhatsApp": teto restritivo, nunca infinito', async () => {
    // O achado que este teste fixa: `configured: false` faz
    // `broadcasts/send/route.ts` usar `batchLimit = Infinity`. Um token
    // zerado pelo "Reset Configuration" (D-12) não pode apagar o teto
    // por disparo em silêncio — e o medidor, que se esconde quando
    // `configured` é falso, deixaria o operador sem nenhum sinal.
    resolveCloudConfig.mockRejectedValue(
      new ChannelNotConfiguredError(
        'channel ch-a has no access token — reconnect the number',
        'no_credentials'
      )
    );
    const { db } = makeDb({ data: 0, error: null });

    const result = await loadAccountQuota(db, 'acct-1');

    expect(result.configured).toBe(true);
    if (result.configured) {
      expect(result.snapshot.batchLimit).toBe(tierCap(FALLBACK_TIER));
      expect(Number.isFinite(result.snapshot.batchLimit)).toBe(true);
      expect(result.snapshot.usageUnavailable).toBe(true);
      expect(result.snapshot.stale).toBe(true);
    }
  });

  it('canal desativado recebe o mesmo tratamento conservador', async () => {
    resolveCloudConfig.mockRejectedValue(
      new ChannelNotConfiguredError('channel ch-a is disabled', 'disabled')
    );
    const { db } = makeDb({ data: 0, error: null });

    const result = await loadAccountQuota(db, 'acct-1');
    expect(result.configured).toBe(true);
  });

  it('falha de LEITURA também não apaga o teto', async () => {
    // Um timeout do PostgREST lendo `channels` devolvia "conta sem
    // WhatsApp" — e, com ele, teto infinito.
    resolveCloudConfig.mockRejectedValue(
      new ChannelNotConfiguredError(
        'failed to read channel ch-a: timeout',
        'read_failed'
      )
    );
    const { db } = makeDb({ data: 0, error: null });

    const result = await loadAccountQuota(db, 'acct-1');
    expect(result.configured).toBe(true);
    if (result.configured) {
      expect(Number.isFinite(result.snapshot.batchLimit)).toBe(true);
    }
  });

  it('erro que NÃO é "sem canal" sobe — não vira "não configurado"', async () => {
    // Um timeout de banco travestido de `no_config` mandaria o operador
    // reconectar um número que está conectado.
    resolveCloudConfig.mockRejectedValue(new Error('connection reset'));
    const { db } = makeDb({ data: 0, error: null });

    await expect(loadAccountQuota(db, 'acct-1')).rejects.toThrow(
      /connection reset/
    );
  });

  it('Meta fora do ar não derruba a leitura nem vira "sem limite"', async () => {
    fetchMessagingLimit.mockRejectedValue(new Error('502'));
    const { db, updates } = makeDb({ data: 5, error: null });

    const result = await loadAccountQuota(db, 'acct-1');

    expect(result.configured).toBe(true);
    if (result.configured) {
      expect(result.snapshot.source).toBe('fallback');
      expect(result.snapshot.stale).toBe(true);
    }
    // Sem leitura nova, nada é gravado no cache.
    expect(updates).toHaveLength(0);
  });
});
