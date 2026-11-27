/**
 * Uso de canais no medidor do plano (SPEC 064 D-5 / §6.5, fase F3).
 *
 * A regra que estes testes fixam é uma só: **o medidor tem de contar o
 * que a trigger conta**. `enforce_channel_quota()` (migração 072) filtra
 * `status <> 'disabled'`; se a tela contasse os desativados também, a
 * barra diria "1 de 1" enquanto o banco aceitaria mais um número — e a
 * pré-checagem da UI bloquearia uma conexão que a trigger deixaria
 * passar. Divergência entre medidor e enforcement não dá erro: dá
 * suporte.
 */

import { aiToolCallsMetricKey } from '@/lib/ai/tools/quota';
import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { getAccountPlan } from './account-plan';
import {
  BYTES_PER_MB,
  FORM_UPLOAD_BYTES_METRIC,
  FORMS_METRIC,
  monthMetricKey,
} from '@/lib/forms/quota';

interface ChannelRow {
  type: string;
  status: string;
}

interface RecordedQuery {
  table: string;
  filters: Array<[string, unknown]>;
}

function makeDb(options: {
  channels: ChannelRow[];
  cloudLimit?: number | null;
  /** Linhas de `account_usage_counters` por métrica (SPEC 085 §5.3). */
  counters?: Record<string, number>;
}) {
  const queries: RecordedQuery[] = [];

  function builder(table: string) {
    const q: RecordedQuery = { table, filters: [] };
    queries.push(q);

    const value = () => {
      switch (table) {
        case 'platform_settings':
          return { data: { quotas_enforced: true }, error: null };
        case 'account_plans':
          return {
            data: {
              account_id: 'acct-1',
              plan_id: 'plan-1',
              status: 'active',
              limit_overrides: {},
              billing_cycle: 'monthly',
            },
            error: null,
          };
        case 'plans':
          return {
            data: {
              id: 'plan-1',
              code: 'pro',
              name: 'Pro',
              description: null,
              price_cents: 0,
              currency: 'BRL',
              billing_period: 'monthly',
              limits:
                options.cloudLimit === undefined
                  ? { channels_whatsapp_cloud: 2 }
                  : { channels_whatsapp_cloud: options.cloudLimit },
              features: {},
              is_public: true,
              is_active: true,
              sort_order: 1,
            },
            error: null,
          };
        case 'account_usage_counters': {
          const wanted = q.filters.find(([k]) => k === 'in:metric')?.[1];
          if (Array.isArray(wanted)) {
            // Consulta em lote dos contadores dos formulários: devolve
            // só as métricas pedidas que existem.
            const rows = wanted
              .filter((m) => (options.counters ?? {})[m] !== undefined)
              .map((metric) => ({
                metric,
                value: (options.counters ?? {})[metric],
              }));
            return { data: rows, error: null };
          }
          const metric = q.filters.find(([k]) => k === 'metric')?.[1];
          const value = (options.counters ?? {})[String(metric)] ?? 0;
          return { data: { value }, error: null };
        }
        case 'profiles':
          return { data: [{ account_role: 'owner' }], error: null };
        case 'channels': {
          const type = q.filters.find(([k]) => k === 'type')?.[1];
          // O fake aplica o filtro que a CONSULTA pediu — é o que faz o
          // teste falhar se o `.neq('status','disabled')` sumir do
          // código, em vez de passar por sorte.
          const excludeDisabled = q.filters.some(
            ([k, v]) => k === 'neq:status' && v === 'disabled'
          );
          const rows = options.channels.filter(
            (c) =>
              c.type === type && (!excludeDisabled || c.status !== 'disabled')
          );
          return { data: null, error: null, count: rows.length };
        }
        default:
          return { data: null, error: null };
      }
    };

    const chain: Record<string, unknown> = {
      select: () => chain,
      eq: (k: string, v: unknown) => {
        q.filters.push([k, v]);
        return chain;
      },
      neq: (k: string, v: unknown) => {
        q.filters.push([`neq:${k}`, v]);
        return chain;
      },
      in: (k: string, v: unknown) => {
        q.filters.push([`in:${k}`, v]);
        return chain;
      },
      maybeSingle: () => Promise.resolve(value()),
      then: (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) =>
        Promise.resolve(value()).then(onF, onR),
    };
    return chain;
  }

  return {
    client: { from: builder } as unknown as SupabaseClient,
    queries,
  };
}

function cloudBucket(usage: Awaited<ReturnType<typeof getAccountPlan>>) {
  return usage.usage.buckets.find((b) => b.key === 'channels_whatsapp_cloud')!;
}

describe('getAccountPlan — uso de canais (SPEC 064)', () => {
  it('conta dois números oficiais contra um limite de 2', async () => {
    // O caso que a 072 tornou possível e que o medidor nunca tinha
    // visto: antes dela o limite era sempre 1 por construção do índice.
    const { client } = makeDb({
      channels: [
        { type: 'whatsapp_cloud', status: 'connected' },
        { type: 'whatsapp_cloud', status: 'disconnected' },
      ],
    });

    const snapshot = await getAccountPlan('acct-1', client);
    const bucket = cloudBucket(snapshot);

    expect(bucket.used).toBe(2);
    expect(bucket.limit).toBe(2);
  });

  it('canal desativado NÃO ocupa vaga — igual à trigger da 072 (D-12)', async () => {
    const { client, queries } = makeDb({
      channels: [
        { type: 'whatsapp_cloud', status: 'connected' },
        { type: 'whatsapp_cloud', status: 'disabled' },
        { type: 'whatsapp_qr', status: 'disabled' },
      ],
    });

    const snapshot = await getAccountPlan('acct-1', client);

    expect(cloudBucket(snapshot).used).toBe(1);
    // O QRCode desativado também não conta: a trigger é a mesma para os
    // dois tipos, e o `vn` de hoje tem exatamente essa linha.
    expect(
      snapshot.usage.buckets.find((b) => b.key === 'channels_whatsapp_qr')!.used
    ).toBe(0);

    // E o filtro está na CONSULTA — não numa filtragem em memória que
    // só existiria no teste.
    const channelQueries = queries.filter((q) => q.table === 'channels');
    expect(channelQueries).toHaveLength(2);
    for (const q of channelQueries) {
      expect(q.filters).toContainEqual(['neq:status', 'disabled']);
      expect(q.filters).toContainEqual(['account_id', 'acct-1']);
    }
  });

  it('limite 1 com o único número desativado deixa a vaga livre', async () => {
    // O caminho de reconexão do D-12: desativar libera a vaga, senão o
    // operador não conseguiria reconectar o próprio número.
    const { client } = makeDb({
      channels: [{ type: 'whatsapp_cloud', status: 'disabled' }],
      cloudLimit: 1,
    });

    const bucket = cloudBucket(await getAccountPlan('acct-1', client));

    expect(bucket.used).toBe(0);
    expect(bucket.limit).toBe(1);
  });
});

describe('getAccountPlan — uso de formulários (SPEC 085 §5.3)', () => {
  const bucket = (
    usage: Awaited<ReturnType<typeof getAccountPlan>>,
    key: string
  ) => usage.usage.buckets.find((b) => b.key === key)!;

  it('lê forms, o mês corrente em America/Sao_Paulo e os bytes em MB (teto)', async () => {
    const monthKey = monthMetricKey(new Date());
    const { client, queries } = makeDb({
      channels: [],
      counters: {
        contacts: 7,
        [FORMS_METRIC]: 2,
        [monthKey]: 15,
        // Mês passado NÃO entra no balde do mês.
        'form_responses:2000-01': 999,
        [FORM_UPLOAD_BYTES_METRIC]: BYTES_PER_MB + 1,
        // SPEC 089 D-20: documentos da base de conhecimento da IA.
        knowledge_documents: 4,
        // SPEC 089 F5: chamadas de ferramenta do agente no mês corrente.
        [aiToolCallsMetricKey(new Date())]: 6,
        'ai_tool_calls:2000-01': 999,
      },
    });
    const snapshot = await getAccountPlan('acct-1', client);

    expect(bucket(snapshot, 'contacts').used).toBe(7);
    expect(bucket(snapshot, 'forms').used).toBe(2);
    expect(bucket(snapshot, 'form_responses_month').used).toBe(15);
    expect(bucket(snapshot, 'form_upload_mb').used).toBe(2);
    expect(bucket(snapshot, 'knowledge_documents').used).toBe(4);
    expect(bucket(snapshot, 'ai_tool_calls_month').used).toBe(6);

    const batch = queries.find((q) =>
      q.filters.some(([k]) => k === 'in:metric')
    )!;
    expect(batch.table).toBe('account_usage_counters');
    expect(batch.filters).toContainEqual(['account_id', 'acct-1']);
    expect(batch.filters).toContainEqual([
      'in:metric',
      [
        FORMS_METRIC,
        monthKey,
        FORM_UPLOAD_BYTES_METRIC,
        'knowledge_documents',
        aiToolCallsMetricKey(new Date()),
      ],
    ]);
  });

  it('sem contadores, os três baldes começam em zero', async () => {
    const { client } = makeDb({ channels: [] });
    const snapshot = await getAccountPlan('acct-1', client);
    expect(bucket(snapshot, 'forms').used).toBe(0);
    expect(bucket(snapshot, 'form_responses_month').used).toBe(0);
    expect(bucket(snapshot, 'form_upload_mb').used).toBe(0);
    expect(bucket(snapshot, 'knowledge_documents').used).toBe(0);
  });
});
