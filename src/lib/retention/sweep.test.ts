import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * SPEC 062 §5.3 / F7 — o elo novo da cadeia de precedência dentro da
 * varredura. Dois casos, e só eles: o merge acontecendo (o console
 * definindo uma dimensão que o `.env` não define, sem apagar a que o
 * `.env` define) e a leitura de `platform_settings` FALHANDO sem
 * abortar o ciclo — a armadilha nomeada na §11 ("Varredura de retenção
 * parou de rodar | `sweep.ts` passou a depender de `platform_settings`
 * e a leitura falhou — precisa cair no `.env`, nunca abortar o ciclo").
 *
 * O que a varredura faz com os limites já resolvidos é assunto de
 * `policy.test.ts` e da própria `purge_channel_messages` (068) — aqui
 * a asserção é sobre os ARGUMENTOS que chegam à RPC.
 */

const adminState: { client: unknown } = { client: undefined };
vi.mock('@/lib/supabase/admin', () => ({
  supabaseAdmin: () => adminState.client,
}));

import { runMessageRetention } from './sweep';

interface DbOptions {
  /** Resposta de `platform_settings.retention_defaults`. */
  platformSettings: { data: unknown; error: unknown };
}

function makeDb(opts: DbOptions) {
  const rpcCalls: Record<string, unknown>[] = [];
  const stateUpdates: Record<string, unknown>[] = [];

  function thenable<T>(value: T) {
    const chain = {
      select: () => chain,
      eq: () => chain,
      in: () => chain,
      or: () => chain,
      maybeSingle: () => Promise.resolve(value),
      then: (resolve: (v: T) => unknown) =>
        Promise.resolve(value).then(resolve),
    };
    return chain;
  }

  const client = {
    from(table: string) {
      if (table === 'platform_settings') {
        return thenable(opts.platformSettings);
      }
      if (table === 'message_retention_state') {
        return {
          ...thenable({
            data: { last_run_at: null, running_since: null },
            error: null,
          }),
          update(payload: Record<string, unknown>) {
            stateUpdates.push(payload);
            // Serve ao claim (`.eq().or().select().maybeSingle()`) e à
            // liberação (`.eq()` aguardado direto).
            return thenable({ data: { id: true }, error: null });
          },
        };
      }
      if (table === 'channels') {
        return thenable({
          data: [{ account_id: 'acc-1', type: 'whatsapp_cloud' }],
          error: null,
        });
      }
      if (table === 'channel_retention_policies') {
        // Nenhuma política própria: a conta herda tudo da cadeia global,
        // que é justamente o que este teste quer observar.
        return thenable({ data: [], error: null });
      }
      throw new Error(`tabela inesperada no mock: ${table}`);
    },
    rpc(fn: string, args: Record<string, unknown>) {
      rpcCalls.push({ fn, ...args });
      return Promise.resolve({
        data: {
          by_age: 0,
          by_count: 0,
          favorites_demoted: 0,
          favorites_total: 0,
          messages_total: 0,
          truncated: false,
        },
        error: null,
      });
    },
  };

  return {
    client: client as unknown as SupabaseClient,
    rpcCalls,
    stateUpdates,
  };
}

const ENV_KEYS = [
  'MESSAGE_RETENTION_ENABLED',
  'MESSAGE_RETENTION_WHATSAPP_CLOUD_MAX_MESSAGES',
  'MESSAGE_RETENTION_WHATSAPP_CLOUD_DAYS',
  'MESSAGE_RETENTION_WHATSAPP_CLOUD_MAX_FAVORITES',
] as const;

beforeEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
  adminState.client = undefined;
});

afterEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
  vi.restoreAllMocks();
});

describe('runMessageRetention — padrão global do console (SPEC 062 §5.3)', () => {
  it('funde dimensão a dimensão: o console define maxMessages, o .env mantém retentionDays', async () => {
    process.env.MESSAGE_RETENTION_ENABLED = 'true';
    process.env.MESSAGE_RETENTION_WHATSAPP_CLOUD_DAYS = '365';

    const db = makeDb({
      platformSettings: {
        data: { retention_defaults: { whatsapp_cloud: { maxMessages: 5000 } } },
        error: null,
      },
    });
    adminState.client = db.client;

    const outcome = await runMessageRetention(new Date('2026-08-27T12:00:00Z'));

    expect(outcome.ran).toBe(true);
    expect(db.rpcCalls).toHaveLength(1);
    // Os DOIS: o número do console e o número do `.env` — é o item 15 do
    // teste manual da §12, aqui no nível da unidade.
    expect(db.rpcCalls[0]).toMatchObject({
      fn: 'purge_channel_messages',
      p_account_id: 'acc-1',
      p_channel_type: 'whatsapp_cloud',
      p_max_messages: 5000,
      p_retention_days: 365,
      p_max_favorites: null,
    });
  });

  it('o console passa na frente do .env na MESMA dimensão', async () => {
    process.env.MESSAGE_RETENTION_ENABLED = 'true';
    process.env.MESSAGE_RETENTION_WHATSAPP_CLOUD_MAX_MESSAGES = '100';

    const db = makeDb({
      platformSettings: {
        data: { retention_defaults: { whatsapp_cloud: { maxMessages: 9000 } } },
        error: null,
      },
    });
    adminState.client = db.client;

    await runMessageRetention(new Date('2026-08-27T12:00:00Z'));

    expect(db.rpcCalls[0]).toMatchObject({ p_max_messages: 9000 });
  });

  it('leitura de platform_settings falhando NÃO aborta o ciclo — cai no .env (§11)', async () => {
    process.env.MESSAGE_RETENTION_ENABLED = 'true';
    process.env.MESSAGE_RETENTION_WHATSAPP_CLOUD_MAX_MESSAGES = '100';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const db = makeDb({
      platformSettings: {
        data: null,
        // O caso real do projeto onde a 069 ainda não rodou: a coluna
        // não existe, e o PostgREST devolve erro em vez de linha.
        error: { message: 'column platform_settings.retention_defaults …' },
      },
    });
    adminState.client = db.client;

    const outcome = await runMessageRetention(new Date('2026-08-27T12:00:00Z'));

    expect(outcome.ran).toBe(true);
    expect(outcome.skippedReason).toBeUndefined();
    expect(db.rpcCalls).toHaveLength(1);
    expect(db.rpcCalls[0]).toMatchObject({ p_max_messages: 100 });
    expect(warn).toHaveBeenCalled();
  });

  it('desligado no .env continua saindo antes de qualquer leitura de banco', async () => {
    // O padrão global do console NUNCA liga a varredura sozinho (§3.8
    // ponto 3, D-13). `adminState.client` fica `undefined` de propósito:
    // se a função tocar o banco aqui, o teste explode.
    const outcome = await runMessageRetention(new Date('2026-08-27T12:00:00Z'));
    expect(outcome).toEqual({ ran: false, skippedReason: 'disabled' });
  });
});
