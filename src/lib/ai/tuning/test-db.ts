import type { SupabaseClient } from '@supabase/supabase-js';

// ============================================================
// Test helper for the tuning service (not imported by production code): an
// in-memory Supabase client over seeded rows that APPLIES the filters the
// service uses (`eq`, `neq`, `in`, `gt`, `lt`, `is null`, `not … is null`),
// `order`, `range`, `limit`, head counts, and the writes (`insert`,
// `update`, `delete`). Because filters really filter, a test with two
// accounts proves a query cannot reach the other tenant's rows (a mock that
// only records calls passes a query that forgot `account_id`).
//
// A table can declare a unique key list (`unique`) so the helper answers a
// duplicate insert with Postgres' 23505, as the real partial indexes do.
// ============================================================

export type Row = Record<string, unknown>;

type Filter =
  | { op: 'eq' | 'neq' | 'gt' | 'lt'; column: string; value: unknown }
  | { op: 'in'; column: string; value: unknown[] }
  | { op: 'null'; column: string; negate: boolean };

export interface FakeWrite {
  table: string;
  op: 'insert' | 'update' | 'delete';
  values: unknown;
}

export interface FakeRpcCall {
  name: string;
  args: Record<string, unknown>;
}

type RpcHandler = (args: Record<string, unknown>) => {
  data: unknown;
  error: { message: string; code?: string } | null;
};

interface Options {
  /** Tables whose every call fails. */
  failOn?: string[];
  rpc?: Record<string, RpcHandler>;
  /** `table → column lists` that must stay unique (23505 on a duplicate). */
  unique?: Record<string, string[][]>;
}

export function tuningDb(seed: Record<string, Row[]>, opts: Options = {}) {
  const writes: FakeWrite[] = [];
  const rpcCalls: FakeRpcCall[] = [];
  let idSeq = 0;

  const passes = (row: Row, f: Filter): boolean => {
    const v = row[f.column];
    switch (f.op) {
      case 'eq':
        return v === f.value;
      case 'neq':
        return v !== f.value;
      case 'gt':
        return (v as string) > (f.value as string);
      case 'lt':
        return (v as string) < (f.value as string);
      case 'in':
        return f.value.includes(v);
      case 'null':
        return f.negate ? v !== null && v !== undefined : v == null;
    }
  };

  const from = (table: string) => {
    const filters: Filter[] = [];
    let op: 'select' | FakeWrite['op'] = 'select';
    let values: unknown;
    let limit = Infinity;
    let range: [number, number] | null = null;
    const order: { column: string; ascending: boolean }[] = [];
    let head = false;
    let wantCount = false;

    const run = (): {
      data: unknown;
      error: { message: string; code?: string } | null;
      count?: number | null;
    } => {
      if (opts.failOn?.includes(table)) {
        return { data: null, error: { message: `boom on ${table}` } };
      }
      if (!seed[table]) seed[table] = [];
      const store = seed[table];
      const match = (r: Row) => filters.every((f) => passes(r, f));

      if (op === 'insert') {
        const incoming = (Array.isArray(values) ? values : [values]) as Row[];
        const out: Row[] = [];
        for (const raw of incoming) {
          const row: Row = { id: `gen-${++idSeq}`, ...raw };
          for (const cols of opts.unique?.[table] ?? []) {
            const dup = store.some((r) =>
              cols.every((c) => row[c] != null && r[c] === row[c])
            );
            if (dup) {
              return {
                data: null,
                error: { message: 'duplicate key', code: '23505' },
              };
            }
          }
          store.push(row);
          out.push(row);
        }
        writes.push({ table, op, values });
        return { data: out, error: null };
      }
      if (op === 'update') {
        const hit = store.filter(match);
        for (const r of hit) Object.assign(r, values as Row);
        writes.push({ table, op, values });
        return { data: hit, error: null };
      }
      if (op === 'delete') {
        const hit = store.filter(match);
        seed[table] = store.filter((r) => !hit.includes(r));
        writes.push({ table, op, values: null });
        return { data: hit, error: null };
      }

      let rows = store.filter(match);
      for (const o of [...order].reverse()) {
        rows = [...rows].sort((a, b) => {
          const x = a[o.column] as string;
          const y = b[o.column] as string;
          if (x === y) return 0;
          return (x > y ? 1 : -1) * (o.ascending ? 1 : -1);
        });
      }
      if (head) {
        return { data: null, error: null, count: rows.length };
      }
      const total = rows.length;
      if (range) rows = rows.slice(range[0], range[1] + 1);
      return {
        data: rows.slice(0, limit),
        error: null,
        ...(wantCount ? { count: total } : {}),
      };
    };

    const chain = {
      select: (_cols?: string, o?: { count?: string; head?: boolean }) => {
        if (o?.count) wantCount = true;
        if (o?.head) head = true;
        return chain;
      },
      insert: (v: unknown) => {
        op = 'insert';
        values = v;
        return chain;
      },
      update: (v: unknown) => {
        op = 'update';
        values = v;
        return chain;
      },
      delete: () => {
        op = 'delete';
        return chain;
      },
      eq: (column: string, value: unknown) => {
        filters.push({ op: 'eq', column, value });
        return chain;
      },
      neq: (column: string, value: unknown) => {
        filters.push({ op: 'neq', column, value });
        return chain;
      },
      gt: (column: string, value: unknown) => {
        filters.push({ op: 'gt', column, value });
        return chain;
      },
      lt: (column: string, value: unknown) => {
        filters.push({ op: 'lt', column, value });
        return chain;
      },
      in: (column: string, value: unknown[]) => {
        filters.push({ op: 'in', column, value });
        return chain;
      },
      is: (column: string, value: null) => {
        if (value === null) filters.push({ op: 'null', column, negate: false });
        return chain;
      },
      not: (column: string, operator: string, value: unknown) => {
        if (operator === 'is' && value === null) {
          filters.push({ op: 'null', column, negate: true });
        }
        return chain;
      },
      order: (column: string, o?: { ascending?: boolean }) => {
        order.push({ column, ascending: o?.ascending ?? true });
        return chain;
      },
      limit: (n: number) => {
        limit = n;
        return chain;
      },
      range: (from: number, to: number) => {
        range = [from, to];
        return chain;
      },
      maybeSingle: () => {
        const r = run();
        if (r.error) return Promise.resolve(r);
        const data = r.data as Row[];
        return Promise.resolve({ data: data[0] ?? null, error: null });
      },
      single: () => {
        const r = run();
        if (r.error) return Promise.resolve(r);
        const data = r.data as Row[];
        return Promise.resolve(
          data[0]
            ? { data: data[0], error: null }
            : { data: null, error: { message: 'no rows' } }
        );
      },
      then: (
        resolve: (v: unknown) => unknown,
        reject?: (e: unknown) => unknown
      ) => Promise.resolve(run()).then(resolve, reject),
    };
    return chain;
  };

  const rpc = (name: string, args: Record<string, unknown>) => {
    rpcCalls.push({ name, args });
    const handler = opts.rpc?.[name];
    return Promise.resolve(
      handler
        ? handler(args)
        : { data: null, error: { message: `no rpc ${name}` } }
    );
  };

  return {
    db: { from, rpc } as unknown as SupabaseClient,
    writes,
    rpcCalls,
    tables: seed,
  };
}
