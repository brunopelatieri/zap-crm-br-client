/**
 * SÓ PARA TESTE (SPEC 076 F4): Supabase de mentira em memória, compartilhado
 * por `billing-server.test.ts` e pelos `route.test.ts` das rotas do §9.
 *
 * Por que existe, em vez de um banco falso por arquivo: o que a F4 precisa
 * provar é de COMPORTAMENTO — "o upsert não toca `payment_*`", "só o
 * `admin` escreve em `whatsapp_billing_status`", "sem a linha o select
 * devolve vazio" — e isso só aparece se `upsert` mescla de verdade só as
 * colunas enviadas, se `update` respeita os filtros e se cada cliente
 * registra o que escreveu. Os `.eq()` filtram de verdade: uma consulta
 * sem `account_id` devolve a linha de OUTRA conta, e o teste de
 * isolamento vê isso.
 *
 * Não simula RLS (o que muda no mundo real é a política, não a forma da
 * consulta) — por isso o log de escritas é por RÓTULO de cliente.
 *
 * SIMULA os CHECK e NOT NULL da migração 086 em `whatsapp_billing_status`
 * ({@link checkBillingRow}): um upsert que o Postgres recusaria (ex.:
 * `health_overall = 'FOO'`, mensagem de erro com mais de 500 caracteres)
 * falha aqui com `23514`, em vez de passar no teste e quebrar em produção.
 *
 * Fica em `src/lib/whatsapp/` por precedente (`lib/emoji/fake-storage.ts`):
 * nenhum código de aplicação o importa, então o Next não o empacota — só o
 * typecheck o vê, como vê qualquer `*.test.ts`.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export type Row = Record<string, unknown>;

export interface FakeState {
  channels: Row[];
  whatsapp_config: Row[];
  whatsapp_billing_status: Row[];
  platform_settings: Row[];
  profiles?: Row[];
}

export interface WriteLog {
  client: string;
  table: string;
  verb: 'insert' | 'update' | 'upsert' | 'delete';
  payload: Row;
}

export interface FakeError {
  code?: string;
  message: string;
}

export interface FakeDbOptions {
  /** Injeta um erro numa operação (tabela + verbo). */
  fail?: (op: {
    table: string;
    verb: 'select' | 'insert' | 'update' | 'upsert' | 'delete';
  }) => FakeError | null;
}

/**
 * Defaults de coluna que o Postgres aplicaria no INSERT do upsert — e,
 * por isso, uma linha COMPLETA de `whatsapp_billing_status` para semear.
 */
export const BILLING_ROW_DEFAULTS: Row = {
  currency: null,
  health_overall: null,
  health_entities: null,
  business_id: null,
  health_checked_at: null,
  spend_period_start: null,
  spend_tz_offset_seconds: null,
  spend_total: null,
  spend_by_category: null,
  spend_currency: null,
  spend_checked_at: null,
  health_error_kind: null,
  health_error_code: null,
  health_error_message: null,
  health_error_at: null,
  health_consecutive_failures: 0,
  health_next_retry_at: null,
  spend_error_kind: null,
  spend_error_code: null,
  spend_error_message: null,
  spend_error_at: null,
  spend_consecutive_failures: 0,
  spend_next_retry_at: null,
  payment_blocked_since: null,
  last_payment_error_at: null,
  last_payment_error_phone_number_id: null,
  payment_cleared_at: null,
  payment_cleared_by: null,
  payment_clear_reason: null,
};

const HEALTH_VALUES = ['AVAILABLE', 'LIMITED', 'BLOCKED'];
const ERROR_KINDS = [
  'auth',
  'permission',
  'rate_limit',
  'transient',
  'unknown',
];
const CLEAR_REASONS = ['billable_delivered', 'manual'];

/**
 * CHECK e NOT NULL da 086 que um payload de escrita pode violar.
 * `null` = ok; senão a mensagem do erro (`23514` / `23502`).
 */
export function checkBillingRow(payload: Row): FakeError | null {
  const bad = (message: string): FakeError => ({ code: '23514', message });

  const health = payload.health_overall;
  if (health != null && !HEALTH_VALUES.includes(health as string)) {
    return bad(`health_overall check violated: ${String(health)}`);
  }
  for (const col of ['health_error_kind', 'spend_error_kind']) {
    const v = payload[col];
    if (v != null && !ERROR_KINDS.includes(v as string)) {
      return bad(`${col} check violated: ${String(v)}`);
    }
  }
  const reason = payload.payment_clear_reason;
  if (reason != null && !CLEAR_REASONS.includes(reason as string)) {
    return bad(`payment_clear_reason check violated: ${String(reason)}`);
  }
  for (const col of ['health_error_message', 'spend_error_message']) {
    const v = payload[col];
    if (typeof v === 'string' && v.length > 500) {
      return bad(`${col} check violated: ${v.length} characters`);
    }
  }
  for (const col of [
    'account_id',
    'waba_id',
    'health_consecutive_failures',
    'spend_consecutive_failures',
  ]) {
    if (col in payload && payload[col] === null) {
      return { code: '23502', message: `null value in column "${col}"` };
    }
  }
  return null;
}

type Verb = 'select' | 'insert' | 'update' | 'upsert' | 'delete';
type Table = keyof FakeState & string;

export function makeFakeDb(
  label: string,
  state: FakeState,
  writes: WriteLog[],
  options: FakeDbOptions = {}
): SupabaseClient {
  function from(table: Table) {
    const eqFilters: Array<{ col: string; val: unknown; neg: boolean }> = [];
    const notNull: string[] = [];
    let inFilter: { col: string; vals: unknown[] } | null = null;
    let verb: Verb = 'select';
    let payload: Row = {};
    let onConflict: string[] = [];

    const store = (): Row[] => {
      const rows = state[table];
      if (!rows) throw new Error(`fake db: no table ${table}`);
      return rows;
    };

    const matching = (): Row[] =>
      store().filter(
        (r) =>
          eqFilters.every((f) =>
            f.neg ? r[f.col] !== f.val : r[f.col] === f.val
          ) &&
          notNull.every((c) => r[c] !== null && r[c] !== undefined) &&
          (!inFilter || inFilter.vals.includes(r[inFilter.col]))
      );

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const run = (): { data: any; error: FakeError | null } => {
      const injected = options.fail?.({ table, verb }) ?? null;
      if (injected) return { data: null, error: injected };

      if (verb === 'select') return { data: matching(), error: null };

      if (table === 'whatsapp_billing_status' && verb !== 'delete') {
        const violation = checkBillingRow(payload);
        if (violation) return { data: null, error: violation };
      }

      if (verb !== 'delete') {
        writes.push({ client: label, table, verb, payload: { ...payload } });
      }

      if (verb === 'insert') {
        const row = { ...payload };
        store().push(row);
        return { data: [row], error: null };
      }
      if (verb === 'update') {
        const hit = matching();
        for (const r of hit) Object.assign(r, payload);
        return { data: hit, error: null };
      }
      if (verb === 'upsert') {
        const existing = store().find((r) =>
          onConflict.every((c) => r[c] === payload[c])
        );
        if (existing) {
          // Mescla SÓ as colunas enviadas — é o que o PostgREST faz.
          Object.assign(existing, payload);
          return { data: [existing], error: null };
        }
        const defaults =
          table === 'whatsapp_billing_status' ? BILLING_ROW_DEFAULTS : {};
        const row = { ...defaults, ...payload };
        store().push(row);
        return { data: [row], error: null };
      }
      const hit = matching();
      state[table] = store().filter((r) => !hit.includes(r));
      return { data: hit, error: null };
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const b: any = {};
    b.select = () => b;
    b.eq = (col: string, val: unknown) => {
      eqFilters.push({ col, val, neg: false });
      return b;
    };
    b.neq = (col: string, val: unknown) => {
      eqFilters.push({ col, val, neg: true });
      return b;
    };
    b.in = (col: string, vals: unknown[]) => {
      inFilter = { col, vals };
      return b;
    };
    b.not = (col: string, op: string, val: unknown) => {
      if (op !== 'is' || val !== null) {
        throw new Error(`fake db: unsupported .not(${col}, ${op})`);
      }
      notNull.push(col);
      return b;
    };
    b.insert = (p: Row) => {
      verb = 'insert';
      payload = p;
      return b;
    };
    b.update = (p: Row) => {
      verb = 'update';
      payload = p;
      return b;
    };
    b.upsert = (p: Row, opts?: { onConflict?: string }) => {
      verb = 'upsert';
      payload = p;
      onConflict = (opts?.onConflict ?? 'id').split(',').map((c) => c.trim());
      return b;
    };
    b.delete = () => {
      verb = 'delete';
      return b;
    };
    b.maybeSingle = async () => {
      const res = run();
      if (res.error) return { data: null, error: res.error };
      return { data: res.data[0] ?? null, error: null };
    };
    b.single = async () => {
      const res = run();
      if (res.error) return { data: null, error: res.error };
      return res.data[0]
        ? { data: res.data[0], error: null }
        : { data: null, error: { message: 'no rows' } };
    };
    b.then = (
      resolve: (v: unknown) => unknown,
      reject?: (e: unknown) => unknown
    ) => Promise.resolve(run()).then(resolve, reject);
    return b;
  }

  return {
    from: (t: string) => from(t as Table),
    rpc: async () => ({ data: null, error: null }),
  } as unknown as SupabaseClient;
}
