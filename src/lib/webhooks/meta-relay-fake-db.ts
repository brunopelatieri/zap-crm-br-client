// ============================================================
// Test-only: in-memory `meta_webhook_relays` table behind a minimal
// PostgREST-like query builder (select with column projection, insert,
// update, delete, `.eq()` filters, `.maybeSingle()` / `.single()`).
//
// Shared by the route tests (SPEC 088 F4). Not imported by production
// code.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

export type RelayRow = Record<string, unknown>;

export function makeRelayFakeDb(initial: RelayRow[] = []) {
  const rows: RelayRow[] = initial.map((r) => ({ ...r }));
  /** Every write, in order, for "never touched" assertions. */
  const writes: Array<{
    op: 'insert' | 'update' | 'delete';
    filters: unknown;
  }> = [];

  const from = () => {
    let op: 'select' | 'insert' | 'update' | 'delete' = 'select';
    let cols = '*';
    let payload: RelayRow = {};
    const filters: Array<[string, unknown]> = [];

    const matched = () =>
      rows.filter((r) => filters.every(([c, v]) => r[c] === v));
    const project = (r: RelayRow) => {
      if (cols === '*') return { ...r };
      const out: RelayRow = {};
      for (const c of cols.split(',').map((x) => x.trim())) out[c] = r[c];
      return out;
    };

    const exec = (): {
      data: RelayRow[];
      error: { code?: string; message: string } | null;
    } => {
      if (op !== 'select') writes.push({ op, filters: [...filters] });
      if (op === 'insert') {
        const row = {
          failure_count: 0,
          is_enabled: false,
          last_delivery_at: null,
          last_failure_at: null,
          auto_disabled_at: null,
          ...payload,
        };
        rows.push(row);
        return { data: [project(row)], error: null };
      }
      if (op === 'update') {
        const hit = matched();
        hit.forEach((r) => Object.assign(r, payload));
        return { data: hit.map(project), error: null };
      }
      if (op === 'delete') {
        const hit = matched();
        hit.forEach((r) => rows.splice(rows.indexOf(r), 1));
        return { data: hit.map(project), error: null };
      }
      return { data: matched().map(project), error: null };
    };

    const b: Record<string, unknown> = {
      select: (c?: string) => {
        if (c) cols = c;
        return b;
      },
      eq: (c: string, v: unknown) => {
        filters.push([c, v]);
        return b;
      },
      insert: (p: RelayRow) => {
        op = 'insert';
        payload = p;
        return b;
      },
      update: (p: RelayRow) => {
        op = 'update';
        payload = p;
        return b;
      },
      delete: () => {
        op = 'delete';
        return b;
      },
      maybeSingle: async () => {
        const r = exec();
        return { data: r.data[0] ?? null, error: r.error };
      },
      single: async () => {
        const r = exec();
        return { data: r.data[0] ?? null, error: r.error };
      },
      then: (resolve: (v: unknown) => unknown) => resolve(exec()),
    };
    return b;
  };

  return { db: { from } as unknown as SupabaseClient, rows, writes };
}
