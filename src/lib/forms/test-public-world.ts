// ============================================================
// Mundo falso das rotas e da página PÚBLICAS dos formulários (F3).
//
// Um "banco" em memória atrás do mesmo dublê encadeável que os testes da
// F2 usam: `from(tabela).select().eq()…` resolve olhando as operações
// registradas. Suficiente para provar o que importa nas rotas (o que vai
// para o INSERT/UPDATE, o que a RPC devolve, o que o Storage vê) sem banco
// nem rede. Não é módulo de produção: só testes importam daqui (o Vitest
// só coleta `*.test.ts`).
// ============================================================

import { vi } from 'vitest';

import type { AvailabilityReason } from './availability';
import {
  ACCOUNT_ID,
  FORM_ID,
  leadFields,
  makeField,
  makeForm,
  TAG_ID,
} from './test-fixtures';
import type { Form, FormField } from './types';

export const SLUG = 'captacao';
export const NEW_CONTACT_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
export const EXISTING_CONTACT_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

type Op = { method: string; args: unknown[] };

export interface StoredResponse {
  id: string;
  form_id: string;
  account_id: string;
  contact_id: string;
  status: string;
  identity_mode: string;
  started_at: string;
  answers: Record<string, unknown>;
  resume_token_hash: string | null;
  [k: string]: unknown;
}

export interface StoredContact {
  id: string;
  account_id: string;
  name: string | null;
  phone_normalized: string;
}

export function defaultFields(): FormField[] {
  return [
    ...leadFields(),
    makeField({
      key: 'cv',
      type: 'file_upload',
      position: 4,
      validation: { max_files: 2 },
    }),
    makeField({
      key: 'extra',
      type: 'short_text',
      position: 5,
      show_if: { field_key: 'interest', op: 'eq', value: 'later' },
    }),
  ];
}

export function defaultForm(over: Partial<Form> = {}): Form {
  return makeForm({
    slug: SLUG,
    status: 'published',
    scoring: {
      bands: [
        { key: 'cold', label: 'Frio', min: 0, max: 19 },
        {
          key: 'hot',
          label: 'Quente',
          min: 20,
          max: null,
          actions: { tag_ids: [TAG_ID] },
        },
      ],
    },
    ...over,
  });
}

export interface StoredProof {
  id: string;
  account_id: string;
  form_id: string;
  phone: string;
  code: string;
  secret_hash: string;
  status: string;
  ip_hash: string | null;
  expires_at: string;
  confirmed_at: string | null;
  consumed_at: string | null;
  created_at: string;
}

/**
 * `form_phone_proofs` (F7) em memória: eq/gt/gte/lt/in, order, limit,
 * select/insert/update/delete, `count` com `head` e o índice único parcial
 * `(account_id, code) WHERE status = 'pending'` (23505).
 */
function resolveProofs(
  rows: StoredProof[],
  ops: Op[],
  clock: () => number
): Record<string, unknown> {
  const filters = ops.filter((o) =>
    ['eq', 'gt', 'gte', 'lt', 'lte', 'in'].includes(o.method)
  );
  const match = (r: StoredProof) =>
    filters.every((f) => {
      const x = (r as unknown as Record<string, unknown>)[String(f.args[0])];
      const v = f.args[1];
      switch (f.method) {
        case 'eq':
          return x === v;
        case 'gt':
          return String(x) > String(v);
        case 'gte':
          return String(x) >= String(v);
        case 'lt':
          return String(x) < String(v);
        case 'lte':
          return String(x) <= String(v);
        default:
          return (v as unknown[]).includes(x);
      }
    });
  const insertOp = ops.find((o) => o.method === 'insert');
  if (insertOp) {
    const row = insertOp.args[0] as Record<string, unknown>;
    if (
      rows.some(
        (r) =>
          r.status === 'pending' &&
          r.account_id === row.account_id &&
          r.code === row.code
      )
    ) {
      return { data: null, error: { code: '23505', message: 'duplicate' } };
    }
    const stored = {
      status: 'pending',
      ip_hash: null,
      confirmed_at: null,
      consumed_at: null,
      ...row,
      id: crypto.randomUUID(),
      created_at: new Date(clock()).toISOString(),
    } as StoredProof;
    rows.push(stored);
    return { data: { id: stored.id } };
  }
  const updateOp = ops.find((o) => o.method === 'update');
  if (updateOp) {
    const hit = rows.filter(match);
    for (const r of hit) Object.assign(r, updateOp.args[0]);
    return { data: hit.map((r) => ({ id: r.id })) };
  }
  if (ops.some((o) => o.method === 'delete')) {
    const hit = rows.filter(match);
    for (const r of hit) rows.splice(rows.indexOf(r), 1);
    return { data: hit.map((r) => ({ id: r.id })) };
  }
  let hit = rows.filter(match);
  const order = ops.find((o) => o.method === 'order');
  if (order) {
    const col = String(order.args[0]);
    const asc = (order.args[1] as { ascending?: boolean } | undefined)
      ?.ascending;
    hit = [...hit].sort((a, b) => {
      const x = String((a as unknown as Record<string, unknown>)[col]);
      const y = String((b as unknown as Record<string, unknown>)[col]);
      return asc === false ? y.localeCompare(x) : x.localeCompare(y);
    });
  }
  const limit = ops.find((o) => o.method === 'limit');
  if (limit) hit = hit.slice(0, Number(limit.args[0]));
  const select = ops.find((o) => o.method === 'select');
  if ((select?.args[1] as { head?: boolean } | undefined)?.head) {
    return { data: null, count: hit.length };
  }
  if (ops.some((o) => o.method === 'maybeSingle' || o.method === 'single')) {
    return { data: hit[0] ?? null };
  }
  return { data: hit };
}

export function createWorld(
  initial: { form?: Form; fields?: FormField[] } = {}
) {
  const state = {
    availability: 'ok' as AvailabilityReason,
    form: initial.form ?? defaultForm(),
    fields: initial.fields ?? defaultFields(),
    contacts: [] as StoredContact[],
    /** F7: `form_phone_proofs`. */
    proofs: [] as StoredProof[],
    /** Relógio do banco falso (carimbo de `created_at` das provas). */
    clock: () => Date.now(),
    responses: new Map<string, StoredResponse>(),
    /** Respostas `completed` do contato (para `allow_multiple_responses`). */
    completed: [] as { id: string }[],
    uploadQuota: { used_bytes: 0, limit_bytes: null as number | null },
    objects: new Map<string, number>(),
    raceOnComplete: false,
    startedAgoMs: 60_000,
    inserts: [] as { table: string; row: Record<string, unknown> }[],
    updates: [] as { table: string; patch: Record<string, unknown> }[],
    rpcCalls: [] as { name: string; args: Record<string, unknown> }[],
  };

  const eqs = (ops: Op[]) =>
    new Map(
      ops
        .filter((o) => o.method === 'eq')
        .map((o) => [String(o.args[0]), o.args[1]] as const)
    );
  const has = (ops: Op[], m: string) => ops.some((o) => o.method === m);
  const arg = (ops: Op[], m: string) =>
    ops.find((o) => o.method === m)?.args[0];

  function resolve(table: string, ops: Op[]): Record<string, unknown> {
    const where = eqs(ops);
    switch (table) {
      case 'forms':
        return { data: state.form };
      case 'form_fields':
        return { data: state.fields };
      case 'contacts': {
        if (has(ops, 'insert')) {
          const row = arg(ops, 'insert') as Record<string, unknown>;
          state.inserts.push({ table, row });
          state.contacts.push({
            id: NEW_CONTACT_ID,
            account_id: ACCOUNT_ID,
            name: null,
            phone_normalized: String(row.phone),
          });
          return { data: { id: NEW_CONTACT_ID } };
        }
        const found = state.contacts.find(
          (c) =>
            c.account_id === where.get('account_id') &&
            (where.has('id')
              ? c.id === where.get('id')
              : c.phone_normalized === where.get('phone_normalized'))
        );
        return { data: found ?? null };
      }
      case 'form_responses': {
        if (has(ops, 'insert')) {
          const row = arg(ops, 'insert') as Record<string, unknown>;
          state.inserts.push({ table, row });
          const id = crypto.randomUUID();
          state.responses.set(id, {
            ...(row as object),
            id,
            started_at: new Date(Date.now() - state.startedAgoMs).toISOString(),
          } as StoredResponse);
          return { data: { id } };
        }
        if (has(ops, 'update')) {
          const patch = arg(ops, 'update') as Record<string, unknown>;
          const row = state.responses.get(String(where.get('id')));
          if (!row) return { data: [] };
          if (where.get('status') === 'partial' && row.status !== 'partial') {
            return { data: [] };
          }
          if (patch.status === 'completed' && state.raceOnComplete) {
            return { data: [] };
          }
          state.updates.push({ table, patch });
          Object.assign(row, patch);
          return { data: [{ id: row.id }] };
        }
        if (where.get('status') === 'completed') {
          return { data: state.completed };
        }
        const row = state.responses.get(String(where.get('id')));
        const ok =
          row &&
          row.form_id === where.get('form_id') &&
          row.account_id === where.get('account_id');
        return { data: ok ? row : null };
      }
      case 'form_phone_proofs':
        return resolveProofs(state.proofs, ops, state.clock);
      case 'channels':
        return { data: { identifier: '+55 (11) 98888-7777' } };
      default:
        return {};
    }
  }

  const from = (table: string) => {
    const ops: Op[] = [];
    const proxy: unknown = new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === 'then') {
            return (
              ok: (v: unknown) => unknown,
              fail: (e: unknown) => unknown
            ) =>
              Promise.resolve({
                data: null,
                error: null,
                ...resolve(table, ops),
              }).then(ok, fail);
          }
          return (...args: unknown[]) => {
            ops.push({ method: String(prop), args });
            return proxy;
          };
        },
      }
    );
    return proxy;
  };

  const storage = {
    createSignedUploadUrl: vi.fn(async (path: string) => ({
      data: {
        signedUrl: `https://sb.example/upload/${path}?t=x`,
        token: 'tok',
        path,
      },
      error: null,
    })),
    createSignedUrls: vi.fn(async (paths: string[]) => ({
      data: paths.map((p) => ({
        path: p,
        signedUrl: `https://sb.example/sign/${p}`,
      })),
      error: null,
    })),
    list: vi.fn(async (prefix: string, opts?: { search?: string }) => ({
      data: [...state.objects.entries()]
        .filter(([path]) => path.startsWith(`${prefix}/`))
        .map(([path, size]) => ({
          name: path.slice(prefix.length + 1),
          metadata: { size },
        }))
        .filter((o) => !opts?.search || o.name === opts.search),
      error: null,
    })),
  };

  const db = {
    from,
    storage: { from: () => storage },
    rpc: async (name: string, args: Record<string, unknown>) => {
      state.rpcCalls.push({ name, args });
      switch (name) {
        case 'form_public_availability': {
          const reason = state.availability;
          if (reason === 'ok') {
            return {
              data: [
                {
                  status: 'available',
                  reason: 'ok',
                  form_id: FORM_ID,
                  account_id: ACCOUNT_ID,
                },
              ],
              error: null,
            };
          }
          const known = reason !== 'not_found';
          return {
            data: [
              {
                status: 'unavailable',
                reason,
                form_id: known ? FORM_ID : null,
                account_id: known ? ACCOUNT_ID : null,
              },
            ],
            error: null,
          };
        }
        case 'form_upload_quota_state':
          return { data: [state.uploadQuota], error: null };
        default:
          return { data: null, error: null };
      }
    },
  };

  return { state, db, storage };
}

export type World = ReturnType<typeof createWorld>;
