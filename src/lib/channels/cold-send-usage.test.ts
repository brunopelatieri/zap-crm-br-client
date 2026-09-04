import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { loadColdSendUsage } from './cold-send-usage';

/**
 * Supabase de mentira que devolve um resultado por chamada a `.from()`,
 * na ORDEM em que `loadColdSendUsage` as constrói (last24h, lastHour,
 * lastColdSendAt, instanceCreatedAt) — a mesma ordem do array passado a
 * `Promise.all`, que é síncrona antes do `await`.
 */
function makeDb(results: Array<{ count?: number; data?: unknown }>) {
  let i = 0;
  const tables: string[] = [];

  function chain() {
    // Capturado NA CONSTRUÇÃO (ordem em que `loadColdSendUsage` chama
    // `db.from()`), não na resolução — `Promise.all` não garante que os
    // `.then()` disparem na ordem do array.
    const r = results[i++] ?? {};
    const settled = { data: r.data ?? null, count: r.count, error: null };
    const c = {
      select: () => c,
      eq: () => c,
      gte: () => c,
      order: () => c,
      limit: () => c,
      maybeSingle: () => Promise.resolve(settled),
      then: (
        resolve: (v: unknown) => unknown,
        reject?: (e: unknown) => unknown
      ) => Promise.resolve(settled).then(resolve, reject),
    };
    return c;
  }

  return {
    client: {
      from: (table: string) => {
        tables.push(table);
        return chain();
      },
    } as unknown as SupabaseClient,
    tables,
  };
}

describe('loadColdSendUsage', () => {
  it('reúne as três contagens e a data de criação do canal', async () => {
    const now = new Date('2026-08-14T12:00:00Z');
    const { client } = makeDb([
      { count: 7 }, // last24h
      { count: 2 }, // lastHour
      { data: { sent_at: '2026-08-14T11:50:00Z' } }, // lastColdSendAt
      { data: { created_at: '2026-01-01T00:00:00Z' } }, // channels.created_at
    ]);

    const usage = await loadColdSendUsage(client, 'chan-1', now);

    expect(usage).toEqual({
      last24h: 7,
      lastHour: 2,
      lastColdSendAt: new Date('2026-08-14T11:50:00Z'),
      instanceCreatedAt: new Date('2026-01-01T00:00:00Z'),
    });
  });

  it('nenhum envio frio ainda: contagens zero e lastColdSendAt nulo', async () => {
    const now = new Date('2026-08-14T12:00:00Z');
    const { client } = makeDb([
      { count: 0 },
      { count: 0 },
      { data: null },
      { data: { created_at: '2026-08-01T00:00:00Z' } },
    ]);

    const usage = await loadColdSendUsage(client, 'chan-1', now);

    expect(usage.last24h).toBe(0);
    expect(usage.lastHour).toBe(0);
    expect(usage.lastColdSendAt).toBeNull();
  });

  it('canal apagado fora do fluxo normal: cai no piso conservador (now)', async () => {
    const now = new Date('2026-08-14T12:00:00Z');
    const { client } = makeDb([
      { count: 0 },
      { count: 0 },
      { data: null },
      { data: null }, // channels.select não encontrou a linha
    ]);

    const usage = await loadColdSendUsage(client, 'chan-1', now);

    expect(usage.instanceCreatedAt).toEqual(now);
  });

  it('count nulo (falha silenciosa do provedor) vira zero, não NaN', async () => {
    const now = new Date('2026-08-14T12:00:00Z');
    const { client } = makeDb([
      {},
      {},
      { data: null },
      { data: { created_at: '2026-08-01T00:00:00Z' } },
    ]);

    const usage = await loadColdSendUsage(client, 'chan-1', now);

    expect(usage.last24h).toBe(0);
    expect(usage.lastHour).toBe(0);
  });
});

/**
 * Supabase de mentira que APLICA os filtros, em vez de ignorá-los:
 * cada `.eq()`/`.gte()` vira um predicado sobre um conjunto de linhas
 * em memória. É o que permite provar o comportamento — "a linha de
 * checagem não entra na contagem de envio" — em vez de só conferir que
 * a string 'kind' aparece na chamada.
 */
function makeFilteringDb(rows: Array<Record<string, unknown>>) {
  function chain(table: string) {
    const eqs: Array<[string, unknown]> = [];
    const gtes: Array<[string, string]> = [];
    let desc = false;

    const matching = () =>
      rows
        .filter(
          (r) =>
            (r.__table ?? 'channel_cold_sends') === table &&
            eqs.every(([k, v]) => r[k] === v) &&
            gtes.every(([k, v]) => String(r[k]) >= v)
        )
        .sort((a, b) =>
          desc
            ? String(b.sent_at).localeCompare(String(a.sent_at))
            : String(a.sent_at).localeCompare(String(b.sent_at))
        );

    const c = {
      select: () => c,
      eq: (k: string, v: unknown) => {
        eqs.push([k, v]);
        return c;
      },
      gte: (k: string, v: string) => {
        gtes.push([k, v]);
        return c;
      },
      order: (_k: string, o?: { ascending?: boolean }) => {
        desc = o?.ascending === false;
        return c;
      },
      limit: () => c,
      maybeSingle: () =>
        Promise.resolve({ data: matching()[0] ?? null, error: null }),
      then: (resolve: (v: unknown) => unknown) =>
        Promise.resolve({
          data: matching(),
          count: matching().length,
          error: null,
        }).then(resolve),
    };
    return c;
  }

  return { from: (t: string) => chain(t) } as unknown as SupabaseClient;
}

// SPEC 069 D-1 / migração 078: `channel_cold_sends` virou o livro-caixa
// de dois eixos. Sem o `.eq('kind','send')`, uma checagem apagaria do
// dia um envio real que o cliente pagou — é a armadilha "contagem de
// envio frio dobrou depois da 078" da §14 da SPEC.
describe('loadColdSendUsage — recorte por kind (SPEC 069 D-1)', () => {
  const now = new Date('2026-09-03T12:00:00Z');

  const rows = [
    // Dois envios de verdade, dentro das 24 h; um deles na última hora.
    { channel_id: 'chan-1', kind: 'send', sent_at: '2026-09-03T02:00:00Z' },
    { channel_id: 'chan-1', kind: 'send', sent_at: '2026-09-03T11:30:00Z' },
    // Quatro CHECAGENS na mesma janela: consomem a cota de checagem,
    // não a de envio. Nenhuma delas pode aparecer abaixo.
    { channel_id: 'chan-1', kind: 'check', sent_at: '2026-09-03T03:00:00Z' },
    { channel_id: 'chan-1', kind: 'check', sent_at: '2026-09-03T11:40:00Z' },
    { channel_id: 'chan-1', kind: 'check', sent_at: '2026-09-03T11:50:00Z' },
    { channel_id: 'chan-1', kind: 'check', sent_at: '2026-09-03T11:55:00Z' },
    // Outro canal, para provar que o filtro de canal continua valendo.
    { channel_id: 'chan-2', kind: 'send', sent_at: '2026-09-03T11:00:00Z' },
    {
      __table: 'channels',
      id: 'chan-1',
      created_at: '2026-01-01T00:00:00Z',
    },
  ];

  it('linha com kind=check não conta como envio frio em nenhum dos três eixos', async () => {
    const usage = await loadColdSendUsage(makeFilteringDb(rows), 'chan-1', now);

    expect(usage.last24h).toBe(2);
    expect(usage.lastHour).toBe(1);
    // A checagem das 11:55 é a linha mais recente da tabela; se ela
    // vazasse para cá, o intervalo mínimo entre ENVIOS passaria a ser
    // contado a partir de uma consulta — e o próximo envio legítimo
    // seria adiado por engano.
    expect(usage.lastColdSendAt).toEqual(new Date('2026-09-03T11:30:00Z'));
  });

  it('instância que só checou, nunca enviou: cota de envio intacta', async () => {
    const onlyChecks = rows.filter(
      (r) => r.kind !== 'send' || r.channel_id === 'chan-2'
    );

    const usage = await loadColdSendUsage(
      makeFilteringDb(onlyChecks),
      'chan-1',
      now
    );

    expect(usage.last24h).toBe(0);
    expect(usage.lastHour).toBe(0);
    expect(usage.lastColdSendAt).toBeNull();
  });
});
