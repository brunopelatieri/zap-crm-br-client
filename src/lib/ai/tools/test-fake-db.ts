import type { SupabaseClient } from '@supabase/supabase-js';

// ============================================================
// Test helper (not imported by production code): an in-memory Supabase
// client that APPLIES `.eq()` / `.in()` filters to seeded rows, so a test
// with two accounts proves a handler cannot reach the other tenant's data
// (a mock that only records calls would pass a handler that forgot a
// filter). Embedded relations are stored on the row (`row.tags = {…}`); a
// dotted filter (`tags.account_id`) filters on them like `!inner` does.
//
// Writes (F5): `insert`, `upsert`, `update` and `delete` mutate the seeded
// rows UNDER THE SAME FILTERS (an `update` without `.eq('account_id')`
// would touch the other tenant's row and the test would see it), and every
// write is recorded in `writes`. `rpc` is answered by the test.
// ============================================================

export type Row = Record<string, unknown>;

export interface FakeDbCall {
  table: string;
  filters: { op: 'eq' | 'in'; column: string; value: unknown }[];
}

export interface FakeWrite {
  table: string;
  op: 'insert' | 'upsert' | 'update' | 'delete';
  values: unknown;
  filters: FakeDbCall['filters'];
}

export interface FakeRpcCall {
  name: string;
  args: Record<string, unknown>;
}

type RpcHandler = (args: Record<string, unknown>) => {
  data: unknown;
  error: { message: string } | null;
};

function readPath(row: Row, column: string): unknown[] {
  const [head, ...rest] = column.split('.');
  const v = row[head];
  if (rest.length === 0) return [v];
  const items = Array.isArray(v) ? v : [v];
  return items.flatMap((item) =>
    item && typeof item === 'object'
      ? readPath(item as Row, rest.join('.'))
      : []
  );
}

export function fakeDb(
  seed: Record<string, Row[]>,
  opts: {
    failOn?: string[];
    rpc?: Record<string, RpcHandler>;
    /**
     * A partial unique index: an insert whose row repeats a stored row on
     * every listed column (all non-null), with `where` also holding for the
     * stored row, fails with 23505.
     */
    unique?: Record<string, { columns: string[]; where?: (r: Row) => boolean }>;
    /** Columns the table does not have yet (an un-applied migration):
     *  an insert carrying one fails like PostgREST does (PGRST204). */
    missingColumns?: Record<string, string[]>;
  } = {}
): {
  db: SupabaseClient;
  calls: FakeDbCall[];
  writes: FakeWrite[];
  rpcCalls: FakeRpcCall[];
  tables: Record<string, Row[]>;
} {
  const calls: FakeDbCall[] = [];
  const writes: FakeWrite[] = [];
  const rpcCalls: FakeRpcCall[] = [];
  let idSeq = 0;

  const matches = (r: Row, filters: FakeDbCall['filters']) =>
    filters.every((f) => {
      const values = readPath(r, f.column);
      return f.op === 'eq'
        ? values.some((v) => v === f.value)
        : values.some((v) => (f.value as unknown[]).includes(v));
    });

  const from = (table: string) => {
    const call: FakeDbCall = { table, filters: [] };
    calls.push(call);
    let limit = Infinity;
    let op: FakeWrite['op'] | null = null;
    let values: unknown;
    let onConflict: string | undefined;

    const run = (): { data: unknown; error: { message: string } | null } => {
      if (opts.failOn?.includes(table)) {
        return { data: null, error: { message: `boom on ${table}` } };
      }
      if (!seed[table]) seed[table] = [];
      const store = seed[table];

      if (op === 'insert' || op === 'upsert') {
        const incoming = (Array.isArray(values) ? values : [values]) as Row[];
        const missing = opts.missingColumns?.[table] ?? [];
        if (incoming.some((r) => missing.some((c) => c in r))) {
          return {
            data: null,
            error: { code: 'PGRST204', message: 'column not found' },
          } as { data: unknown; error: { message: string } };
        }
        const uniq = opts.unique?.[table];
        if (
          uniq &&
          incoming.some((r) =>
            store.some(
              (s) =>
                (uniq.where ? uniq.where(s) : true) &&
                uniq.columns.every((c) => r[c] != null && s[c] === r[c])
            )
          )
        ) {
          return {
            data: null,
            error: { code: '23505', message: 'duplicate key' },
          } as { data: unknown; error: { message: string } };
        }
        const out: Row[] = [];
        for (const raw of incoming) {
          const row: Row = { id: `gen-${++idSeq}`, ...raw };
          if (op === 'upsert' && onConflict) {
            const cols = onConflict.split(',').map((c) => c.trim());
            const existing = store.find((r) =>
              cols.every((c) => r[c] === row[c])
            );
            if (existing) {
              Object.assign(existing, raw);
              out.push(existing);
              continue;
            }
          }
          store.push(row);
          out.push(row);
        }
        writes.push({ table, op, values, filters: [...call.filters] });
        return { data: out, error: null };
      }
      if (op === 'update') {
        const hit = store.filter((r) => matches(r, call.filters));
        for (const r of hit) Object.assign(r, values as Row);
        writes.push({ table, op, values, filters: [...call.filters] });
        return { data: hit, error: null };
      }
      if (op === 'delete') {
        const hit = store.filter((r) => matches(r, call.filters));
        seed[table] = store.filter((r) => !hit.includes(r));
        writes.push({ table, op, values: null, filters: [...call.filters] });
        return { data: hit, error: null };
      }
      const rows = store.filter((r) => matches(r, call.filters));
      return { data: rows.slice(0, limit), error: null };
    };

    const chain = {
      select: () => chain,
      insert: (v: unknown) => {
        op = 'insert';
        values = v;
        return chain;
      },
      upsert: (v: unknown, o?: { onConflict?: string }) => {
        op = 'upsert';
        values = v;
        onConflict = o?.onConflict;
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
        call.filters.push({ op: 'eq', column, value });
        return chain;
      },
      in: (column: string, value: unknown[]) => {
        call.filters.push({ op: 'in', column, value });
        return chain;
      },
      order: () => chain,
      limit: (n: number) => {
        limit = n;
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
    calls,
    writes,
    rpcCalls,
    tables: seed,
  };
}

/** A client that fails the test if anything touches it (dry-run proofs). */
export function untouchableDb(): SupabaseClient {
  return new Proxy(
    {},
    {
      get() {
        throw new Error('the database must not be touched here');
      },
    }
  ) as SupabaseClient;
}
