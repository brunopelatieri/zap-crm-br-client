import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * `recordColdSend` escala pra supabaseAdmin() internamente (062: só
 * service_role escreve em channel_cold_sends) — este mock intercepta
 * essa chamada. `throwOnCall` simula o modo de falha que o try/catch
 * de dentro de `recordColdSend` existe pra cobrir: a CONSTRUÇÃO do
 * cliente falhando (env var de service-role ausente nesta instância),
 * não só o INSERT devolvendo `{error}`.
 */
const adminState: { client: unknown; throwOnCall: boolean } = {
  client: undefined,
  throwOnCall: false,
};
vi.mock('@/lib/supabase/admin', () => ({
  supabaseAdmin: () => {
    if (adminState.throwOnCall) {
      throw new Error('supabaseUrl is required.');
    }
    return adminState.client;
  },
}));

import {
  checkColdSend,
  loadLastInboundAt,
  recordColdSend,
  ColdSendLimitError,
} from './cold-send-wiring';
import { COLD_SEND_DEFAULTS } from './cold-send-limit';

const ENV_KEYS = [
  'EVOLUTION_COLD_SEND_SILENCE_HOURS',
  'EVOLUTION_COLD_SEND_PER_HOUR',
  'EVOLUTION_COLD_SEND_PER_DAY',
  'EVOLUTION_COLD_SEND_MIN_INTERVAL_SECONDS',
  'EVOLUTION_COLD_SEND_WARMUP_DAYS',
] as const;

beforeEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
  adminState.throwOnCall = false;
  adminState.client = undefined;
});

/**
 * Supabase de mentira: cada `.from()` CONSTRÓI a partir do próximo
 * resultado da fila — capturado na CONSTRUÇÃO (ordem em que o código
 * chama `db.from()`), não na resolução, porque `Promise.all` não
 * garante que os `.then()` disparem na ordem do array.
 */
function makeDb(
  results: Array<{ count?: number; data?: unknown; error?: unknown }>
) {
  let i = 0;
  const inserts: unknown[] = [];

  function chain(table: string) {
    const r = results[i++] ?? {};
    const settled = {
      data: r.data ?? null,
      count: r.count,
      error: r.error ?? null,
    };
    const c = {
      insert: (payload: unknown) => {
        inserts.push({ table, payload });
        return Promise.resolve({ data: settled.data, error: settled.error });
      },
      select: () => c,
      eq: () => c,
      gte: () => c,
      order: () => c,
      limit: () => c,
      maybeSingle: () => Promise.resolve(settled),
      then: (resolve: (v: unknown) => unknown) =>
        Promise.resolve(settled).then(resolve),
    };
    return c;
  }

  return {
    client: { from: (t: string) => chain(t) } as unknown as SupabaseClient,
    inserts,
  };
}

describe('checkColdSend', () => {
  it('canal Cloud: nunca aplicável, nunca toca o banco', async () => {
    const db = {
      from: vi.fn(() => {
        throw new Error('não deveria consultar');
      }),
    };

    const check = await checkColdSend(db as unknown as SupabaseClient, {
      channelId: 'chan-cloud',
      channelType: 'whatsapp_cloud',
      lastInboundAt: null,
    });

    expect(check).toEqual({ applicable: false, cold: false, decision: null });
  });

  it('canal QR, conversa viva (não frio): aplicável mas não frio, sem consulta de uso', async () => {
    const db = {
      from: vi.fn(() => {
        throw new Error('não deveria consultar uso');
      }),
    };

    const check = await checkColdSend(
      db as unknown as SupabaseClient,
      {
        channelId: 'chan-qr',
        channelType: 'whatsapp_qr',
        lastInboundAt: new Date('2026-08-14T11:00:00Z'),
      },
      new Date('2026-08-14T12:00:00Z')
    );

    expect(check).toEqual({ applicable: true, cold: false, decision: null });
  });

  it('canal QR, contato nunca escreveu: frio, dentro do teto', async () => {
    const now = new Date('2026-08-14T12:00:00Z');
    const { client } = makeDb([
      // SPEC 069 F2: `checkColdSend` resolve os tetos pela cascata antes
      // de avaliar, e o nível de instância é uma leitura de
      // `evolution_instances.limit_overrides`. Sem override, a cascata
      // desce para o `.env`/padrão de código — que são exatamente os
      // valores que este teste já esperava.
      { data: null }, // evolution_instances.limit_overrides
      { count: 0 }, // last24h
      { count: 0 }, // lastHour
      { data: null }, // lastColdSendAt
      { data: { created_at: '2026-01-01T00:00:00Z' } }, // channels.created_at
    ]);

    const check = await checkColdSend(
      client,
      { channelId: 'chan-qr', channelType: 'whatsapp_qr', lastInboundAt: null },
      now
    );

    expect(check.applicable).toBe(true);
    expect(check.cold).toBe(true);
    expect(check.decision?.allowed).toBe(true);
  });

  it('canal QR sobre o teto diário: nega com o motivo certo', async () => {
    const now = new Date('2026-08-14T12:00:00Z');
    const { client } = makeDb([
      { data: null }, // evolution_instances.limit_overrides (cascata, F2)
      { count: COLD_SEND_DEFAULTS.perDay }, // last24h já no teto
      { count: 0 },
      { data: null },
      { data: { created_at: '2020-01-01T00:00:00Z' } }, // veterana, sem aquecimento
    ]);

    const check = await checkColdSend(
      client,
      { channelId: 'chan-qr', channelType: 'whatsapp_qr', lastInboundAt: null },
      now
    );

    expect(check.cold).toBe(true);
    expect(check.decision?.allowed).toBe(false);
    expect(check.decision?.reason).toBe('daily_limit');
  });
});

describe('loadLastInboundAt', () => {
  /** Uma leitura só; guarda tabela e filtros para conferir a consulta. */
  function oneRead(result: { data?: unknown; error?: unknown }) {
    const calls: Array<[string, ...unknown[]]> = [];
    const c = {
      select: (...a: unknown[]) => (calls.push(['select', ...a]), c),
      eq: (...a: unknown[]) => (calls.push(['eq', ...a]), c),
      order: (...a: unknown[]) => (calls.push(['order', ...a]), c),
      limit: (...a: unknown[]) => (calls.push(['limit', ...a]), c),
      maybeSingle: () =>
        Promise.resolve({
          data: result.data ?? null,
          error: result.error ?? null,
        }),
    };
    const from = vi.fn((table: string) => {
      calls.push(['from', table]);
      return c;
    });
    return { client: { from } as unknown as SupabaseClient, calls };
  }

  it('lê a mensagem mais recente DO CONTATO na conversa, em messages', async () => {
    const { client, calls } = oneRead({
      data: { created_at: '2026-10-31T10:00:00Z' },
    });

    const at = await loadLastInboundAt(client, 'conv-1');

    expect(at).toEqual(new Date('2026-10-31T10:00:00Z'));
    expect(calls).toContainEqual(['from', 'messages']);
    expect(calls).toContainEqual(['eq', 'conversation_id', 'conv-1']);
    expect(calls).toContainEqual(['eq', 'sender_type', 'customer']);
    expect(calls).toContainEqual(['order', 'created_at', { ascending: false }]);
    // Nunca a âncora da janela — ela é NULL no QRCode por construção.
    expect(calls).not.toContainEqual(['from', 'conversations']);
  });

  it('contato que nunca escreveu → null (frio)', async () => {
    const { client } = oneRead({ data: null });
    expect(await loadLastInboundAt(client, 'conv-1')).toBeNull();
  });

  it('falha de leitura → null (frio), sem lançar', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { client } = oneRead({ error: { message: 'boom' } });
    expect(await loadLastInboundAt(client, 'conv-1')).toBeNull();
    spy.mockRestore();
  });
});

describe('recordColdSend', () => {
  it('grava channel_id, account_id, contact_id e origin — via supabaseAdmin(), nunca um db passado', async () => {
    const { client, inserts } = makeDb([{ data: null, error: null }]);
    adminState.client = client;

    await recordColdSend({
      channelId: 'chan-qr',
      accountId: 'acct-1',
      contactId: 'contact-1',
      origin: 'human',
    });

    expect(inserts).toEqual([
      {
        table: 'channel_cold_sends',
        payload: {
          channel_id: 'chan-qr',
          account_id: 'acct-1',
          contact_id: 'contact-1',
          origin: 'human',
        },
      },
    ]);
  });

  it('falha de INSERT não lança — a mensagem já saiu, perder a linha só subconta', async () => {
    const { client } = makeDb([{ error: { message: 'boom' } }]);
    adminState.client = client;
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(
      recordColdSend({
        channelId: 'chan-qr',
        accountId: 'acct-1',
        contactId: null,
        origin: 'engine',
      })
    ).resolves.toBeUndefined();
  });

  it('supabaseAdmin() lançando na CONSTRUÇÃO (env var de service-role ausente) também não propaga', async () => {
    // Regressão: até esta correção, o call site fazia `recordColdSend(
    // supabaseAdmin(), ...)` sem try/catch — se `createClient()` lançasse
    // (URL/chave ausente), o erro escapava e transformava uma mensagem já
    // ENTREGUE num 500 pro chamador. O try/catch agora mora aqui dentro,
    // onde a função sabe que a escrita é sempre best-effort.
    adminState.throwOnCall = true;
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(
      recordColdSend({
        channelId: 'chan-qr',
        accountId: 'acct-1',
        contactId: null,
        origin: 'human',
      })
    ).resolves.toBeUndefined();
  });
});

describe('ColdSendLimitError', () => {
  it('carrega a decisão e o motivo legível de describeDenial()', () => {
    const decision = {
      allowed: false as const,
      reason: 'hourly_limit' as const,
      retryAfterSeconds: 600,
      remainingToday: 5,
      remainingThisHour: 0,
      dailyLimit: 60,
      hourlyLimit: 12,
      warmingUp: false,
    };

    const err = new ColdSendLimitError(decision);

    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('ColdSendLimitError');
    expect(err.decision).toBe(decision);
    expect(err.message).toMatch(/hourly limit reached/);
  });
});
