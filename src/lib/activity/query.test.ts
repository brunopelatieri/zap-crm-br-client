import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { encodeCursor } from '@/lib/api/v1/pagination';
import { queryActivity, type ActivityRow } from './query';

// ------------------------------------------------------------
// Um Postgres de brinquedo: interpreta o SUBCONJUNTO de sintaxe
// PostgREST que query.ts realmente produz — `.eq`/`.gte`/`.lte`/`.in`/
// `.is`/`.or()` (busca livre E o cursor keyset), `.order`/`.limit` — o
// bastante para provar o CONTRATO de `queryActivity` sem subir um
// banco. Vive só neste arquivo.
// ------------------------------------------------------------

type Row = ActivityRow;

function parseOrExpression(expr: string): (row: Row) => boolean {
  // Separa por vírgula NO NÍVEL RAIZ — `and(a,b)` não pode ser
  // partido no meio (é o formato do cursor keyset).
  const clauses: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < expr.length; i++) {
    if (expr[i] === '(') depth++;
    if (expr[i] === ')') depth--;
    if (expr[i] === ',' && depth === 0) {
      clauses.push(expr.slice(start, i));
      start = i + 1;
    }
  }
  clauses.push(expr.slice(start));

  const matchers = clauses.map((clause) => parseClause(clause));
  return (row) => matchers.some((m) => m(row));
}

function parseClause(clause: string): (row: Row) => boolean {
  if (clause.startsWith('and(')) {
    const inner = clause.slice(4, -1);
    const parts = inner.split(',').map((c) => parseSimple(c));
    return (row) => parts.every((p) => p(row));
  }
  return parseSimple(clause);
}

function parseSimple(clause: string): (row: Row) => boolean {
  const [field, op, ...rest] = clause.split('.');
  const value = rest.join('.');
  return (row) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rowValue = (row as any)[field];
    if (op === 'eq') return String(rowValue) === value;
    if (op === 'lt') return String(rowValue) < value;
    if (op === 'ilike') {
      const needle = value.replace(/%/g, '').toLowerCase();
      return String(rowValue ?? '')
        .toLowerCase()
        .includes(needle);
    }
    throw new Error(`unsupported op in fake db: ${op}`);
  };
}

function makeFakeDb(rows: Row[]) {
  function builder(initialSelectIsCount: boolean) {
    const predicates: Array<(row: Row) => boolean> = [];
    const ascending: Record<string, boolean> = {};
    let limitN = Infinity;
    let isCountQuery = initialSelectIsCount;

    const chain = {
      select(_cols: unknown, opts?: { count?: string; head?: boolean }) {
        if (opts?.head) isCountQuery = true;
        return chain;
      },
      eq(field: string, value: unknown) {
        predicates.push(
          (row) =>
            String((row as unknown as Record<string, unknown>)[field]) ===
            String(value)
        );
        return chain;
      },
      gte(field: string, value: unknown) {
        predicates.push(
          (row) =>
            ((row as unknown as Record<string, unknown>)[field] as string) >=
            (value as string)
        );
        return chain;
      },
      lte(field: string, value: unknown) {
        predicates.push(
          (row) =>
            ((row as unknown as Record<string, unknown>)[field] as string) <=
            (value as string)
        );
        return chain;
      },
      in(field: string, values: unknown[]) {
        predicates.push((row) =>
          values.includes((row as unknown as Record<string, unknown>)[field])
        );
        return chain;
      },
      is(field: string, value: null) {
        predicates.push(
          (row) => (row as unknown as Record<string, unknown>)[field] === value
        );
        return chain;
      },
      or(expr: string) {
        predicates.push(parseOrExpression(expr));
        return chain;
      },
      order(field: string, opts?: { ascending?: boolean }) {
        ascending[field] = opts?.ascending ?? true;
        return chain;
      },
      limit(n: number) {
        limitN = n;
        return chain;
      },
      then(resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) {
        try {
          let result = rows.filter((r) => predicates.every((p) => p(r)));
          const orderFields = Object.entries(ascending);
          if (orderFields.length > 0) {
            result = [...result].sort((a, b) => {
              for (const [field, asc] of orderFields) {
                const av = (a as unknown as Record<string, unknown>)[
                  field
                ] as string;
                const bv = (b as unknown as Record<string, unknown>)[
                  field
                ] as string;
                if (av === bv) continue;
                return asc ? (av < bv ? -1 : 1) : av < bv ? 1 : -1;
              }
              return 0;
            });
          }
          if (isCountQuery) {
            return Promise.resolve({ count: result.length, error: null }).then(
              resolve,
              reject
            );
          }
          result = result.slice(0, limitN);
          return Promise.resolve({ data: result, error: null }).then(
            resolve,
            reject
          );
        } catch (err) {
          return Promise.resolve({
            data: null,
            error: { message: String(err) },
          }).then(resolve, reject);
        }
      },
    };
    return chain;
  }

  return {
    from: () => ({
      select: (_cols: unknown, opts?: { count?: string; head?: boolean }) =>
        builder(!!opts?.head),
    }),
  } as unknown as SupabaseClient;
}

const ACCOUNT_ID = 'acct-1';

function row(overrides: Partial<Row> & { account_id?: string }): Row {
  return {
    id: 'evt-1',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    account_id: ACCOUNT_ID as any,
    created_at: '2026-09-01T12:00:00.000Z',
    actor_kind: 'user',
    actor_user_id: 'user-1',
    actor_name: 'Bruno',
    actor_role: 'owner',
    resource_type: 'contact',
    action: 'contact.created',
    resource_id: 'contact-1',
    resource_label: 'Ana Paula',
    channel_id: null,
    channel_type: null,
    conversation_id: null,
    contact_id: 'contact-1',
    source_table: null,
    source_id: null,
    metadata: {},
    ...overrides,
  };
}

describe('queryActivity — período', () => {
  it('sem from/to, usa a janela padrão de 30 dias', async () => {
    const recent = row({ id: 'a', created_at: new Date().toISOString() });
    const old = row({
      id: 'b',
      created_at: new Date(Date.now() - 40 * 86400000).toISOString(),
    });
    const db = makeFakeDb([recent, old]);

    const result = await queryActivity(db, ACCOUNT_ID, {});
    if ('error' in result) throw new Error('unexpected error');

    expect(result.items.map((i) => i.id)).toEqual(['a']);
  });

  it('fuso inválido devolve ActivityQueryError, não lança', async () => {
    const db = makeFakeDb([]);
    const result = await queryActivity(db, ACCOUNT_ID, {
      from: '2026-08-01',
      timeZone: 'Marte/Olympus',
    });

    expect(result).toEqual({ error: 'invalid_time_zone' });
  });

  it('data sem sentido devolve ActivityQueryError com o campo', async () => {
    const db = makeFakeDb([]);
    const result = await queryActivity(db, ACCOUNT_ID, { from: 'ontem' });

    expect(result).toEqual({ error: 'invalid_date', field: 'from' });
  });

  it('AAAA-MM-DD puro expande para o dia INTEIRO no fuso informado', async () => {
    // 2026-09-01 em America/Sao_Paulo (UTC-3) vira 2026-09-01T03:00:00Z
    // até 2026-09-02T02:59:59.999Z.
    const insideStart = row({
      id: 'inside-start',
      created_at: '2026-09-01T03:00:00.000Z',
    });
    const insideEnd = row({
      id: 'inside-end',
      created_at: '2026-09-02T02:59:59.999Z',
    });
    const before = row({
      id: 'before',
      created_at: '2026-09-01T02:59:59.999Z',
    });
    const after = row({ id: 'after', created_at: '2026-09-02T03:00:00.000Z' });
    const db = makeFakeDb([insideStart, insideEnd, before, after]);

    const result = await queryActivity(db, ACCOUNT_ID, {
      from: '2026-09-01',
      to: '2026-09-01',
      timeZone: 'America/Sao_Paulo',
    });
    if ('error' in result) throw new Error('unexpected error');

    expect(new Set(result.items.map((i) => i.id))).toEqual(
      new Set(['inside-start', 'inside-end'])
    );
  });
});

describe('queryActivity — filtros', () => {
  const BASE_ROWS = [
    row({
      id: '1',
      resource_type: 'contact',
      action: 'contact.created',
      actor_user_id: 'user-1',
    }),
    row({
      id: '2',
      resource_type: 'deal',
      action: 'deal.created',
      actor_user_id: 'user-2',
    }),
    row({
      id: '3',
      resource_type: 'broadcast',
      action: 'broadcast.dispatched',
      actor_kind: 'system',
      actor_user_id: null,
      channel_id: 'chan-1',
    }),
    row({
      id: '4',
      resource_type: 'contact',
      action: 'contact.updated',
      resource_label: 'Marina Souza',
      channel_id: 'chan-2',
    }),
  ];

  it('filtro de ator (UUID)', async () => {
    const db = makeFakeDb(BASE_ROWS);
    const result = await queryActivity(db, ACCOUNT_ID, {
      actorUserId: 'user-2',
    });
    if ('error' in result) throw new Error('x');
    expect(result.items.map((i) => i.id)).toEqual(['2']);
  });

  it('filtro de ator "system"', async () => {
    const db = makeFakeDb(BASE_ROWS);
    const result = await queryActivity(db, ACCOUNT_ID, {
      actorUserId: 'system',
    });
    if ('error' in result) throw new Error('x');
    expect(result.items.map((i) => i.id)).toEqual(['3']);
  });

  it('filtro de tipo (multi-seleção vira IN)', async () => {
    const db = makeFakeDb(BASE_ROWS);
    const result = await queryActivity(db, ACCOUNT_ID, {
      resourceTypes: ['contact', 'deal'],
    });
    if ('error' in result) throw new Error('x');
    expect(new Set(result.items.map((i) => i.id))).toEqual(
      new Set(['1', '2', '4'])
    );
  });

  it('busca livre casa resource_label OU actor_name, case-insensitive', async () => {
    const db = makeFakeDb(BASE_ROWS);
    const result = await queryActivity(db, ACCOUNT_ID, { search: 'marina' });
    if ('error' in result) throw new Error('x');
    expect(result.items.map((i) => i.id)).toEqual(['4']);
  });

  it('combinação de filtros (tipo + busca)', async () => {
    const db = makeFakeDb(BASE_ROWS);
    const result = await queryActivity(db, ACCOUNT_ID, {
      resourceTypes: ['contact'],
      search: 'marina',
    });
    if ('error' in result) throw new Error('x');
    expect(result.items.map((i) => i.id)).toEqual(['4']);
  });

  it('D-10: filtro de canal esconde eventos sem canal e conta quantos', async () => {
    const db = makeFakeDb(BASE_ROWS);
    const result = await queryActivity(db, ACCOUNT_ID, {
      channelIds: ['chan-1'],
    });
    if ('error' in result) throw new Error('x');

    expect(result.items.map((i) => i.id)).toEqual(['3']);
    // '1' e '2' não têm canal nenhum; '4' tem chan-2 (outro canal) — só
    // os SEM canal entram nesta contagem, não "canal diferente".
    expect(result.hiddenByChannelFilter).toBe(2);
  });

  it('sem filtro de canal, hiddenByChannelFilter é null (não zero)', async () => {
    const db = makeFakeDb(BASE_ROWS);
    const result = await queryActivity(db, ACCOUNT_ID, {});
    if ('error' in result) throw new Error('x');
    expect(result.hiddenByChannelFilter).toBeNull();
  });
});

// `decodeCursor` (pagination.ts) só aceita um `id` que PAREÇA um UUID
// de verdade — é a defesa contra cursor forjado carregando sintaxe de
// filtro. Ids como "evt-5" são silenciosamente tratados como "sem
// cursor", então os testes de paginação usam UUIDs de verdade.
const EVT_ID = (n: number) => `00000000-0000-0000-0000-00000000000${n}`;

describe('queryActivity — paginação por cursor', () => {
  // 5 eventos, do mais novo (5) ao mais antigo (1).
  const ROWS = [5, 4, 3, 2, 1].map((n) =>
    row({
      id: EVT_ID(n),
      created_at: `2026-09-0${n}T00:00:00.000Z`,
    })
  );

  it('primeira página respeita o limite e devolve nextCursor', async () => {
    const db = makeFakeDb(ROWS);
    const result = await queryActivity(db, ACCOUNT_ID, { limit: 2 });
    if ('error' in result) throw new Error('x');

    expect(result.items.map((i) => i.id)).toEqual([EVT_ID(5), EVT_ID(4)]);
    expect(result.nextCursor).not.toBeNull();
  });

  it('segunda página, via cursor, não repete linha nenhuma', async () => {
    const db = makeFakeDb(ROWS);
    const first = await queryActivity(db, ACCOUNT_ID, { limit: 2 });
    if ('error' in first) throw new Error('x');

    const second = await queryActivity(db, ACCOUNT_ID, {
      limit: 2,
      cursor: first.nextCursor,
    });
    if ('error' in second) throw new Error('x');

    expect(second.items.map((i) => i.id)).toEqual([EVT_ID(3), EVT_ID(2)]);
    // Nenhuma sobreposição entre as duas páginas.
    const seen = new Set(first.items.map((i) => i.id));
    for (const item of second.items) expect(seen.has(item.id)).toBe(false);
  });

  it('última página não devolve nextCursor', async () => {
    const db = makeFakeDb(ROWS);
    const page1 = await queryActivity(db, ACCOUNT_ID, { limit: 2 });
    if ('error' in page1) throw new Error('x');
    const page2 = await queryActivity(db, ACCOUNT_ID, {
      limit: 2,
      cursor: page1.nextCursor,
    });
    if ('error' in page2) throw new Error('x');
    const page3 = await queryActivity(db, ACCOUNT_ID, {
      limit: 2,
      cursor: page2.nextCursor,
    });
    if ('error' in page3) throw new Error('x');

    expect(page3.items.map((i) => i.id)).toEqual([EVT_ID(1)]);
    expect(page3.nextCursor).toBeNull();
  });

  it('cursor malformado é tratado como ausente — reinicia da primeira página', async () => {
    const db = makeFakeDb(ROWS);
    const result = await queryActivity(db, ACCOUNT_ID, {
      limit: 2,
      cursor: 'lixo-nao-base64url-valido!!',
    });
    if ('error' in result) throw new Error('x');
    expect(result.items.map((i) => i.id)).toEqual([EVT_ID(5), EVT_ID(4)]);
  });

  it('limite é clampado em ACTIVITY_MAX_LIMIT (100)', async () => {
    const many = Array.from({ length: 150 }, (_, i) =>
      row({
        id: `00000000-0000-0000-0000-${String(i).padStart(12, '0')}`,
        created_at: new Date(Date.now() - i * 1000).toISOString(),
      })
    );
    const db = makeFakeDb(many);
    const result = await queryActivity(db, ACCOUNT_ID, { limit: 9999 });
    if ('error' in result) throw new Error('x');
    expect(result.items).toHaveLength(100);
  });
});

// Confere que o cursor real de `encodeCursor` (o mesmo formato que
// `/api/v1` usa) é aceito de volta — não é um formato próprio de
// `activity`.
describe('queryActivity — cursor é o formato compartilhado de pagination.ts', () => {
  it('aceita um cursor pré-fabricado com encodeCursor', async () => {
    const ROWS = [3, 2, 1].map((n) =>
      row({ id: EVT_ID(n), created_at: `2026-09-0${n}T00:00:00.000Z` })
    );
    const db = makeFakeDb(ROWS);
    const cursor = encodeCursor({
      created_at: '2026-09-03T00:00:00.000Z',
      id: EVT_ID(3),
    });

    const result = await queryActivity(db, ACCOUNT_ID, { cursor });
    if ('error' in result) throw new Error('x');
    expect(result.items.map((i) => i.id)).toEqual([EVT_ID(2), EVT_ID(1)]);
  });
});
