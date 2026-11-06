// ============================================================
// Fixtures e dublês compartilhados pelos testes de `src/lib/forms/`.
// Não é módulo de produção: nada em `src/` fora de `*.test.ts` importa
// daqui (o Vitest só coleta `*.test.ts`, então este arquivo não roda
// como suíte).
// ============================================================

import { vi } from 'vitest';

import type { Form, FormField } from './types';

export const ACCOUNT_ID = '11111111-1111-4111-8111-111111111111';
export const OTHER_ACCOUNT_ID = '99999999-9999-4999-8999-999999999999';
export const FORM_ID = '22222222-2222-4222-8222-222222222222';
export const CONTACT_ID = '33333333-3333-4333-8333-333333333333';
export const RESPONSE_ID = '44444444-4444-4444-8444-444444444444';
export const USER_ID = '55555555-5555-4555-8555-555555555555';
export const CUSTOM_FIELD_ID = '66666666-6666-4666-8666-666666666666';
export const TAG_ID = '77777777-7777-4777-8777-777777777777';
export const PIPELINE_ID = '88888888-8888-4888-8888-888888888888';
export const STAGE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

let fieldSeq = 0;

export function makeField(
  partial: Partial<FormField> & Pick<FormField, 'key' | 'type'>
): FormField {
  fieldSeq += 1;
  return {
    id: `field-${fieldSeq}`,
    form_id: FORM_ID,
    account_id: ACCOUNT_ID,
    position: fieldSeq,
    label: partial.key,
    description: null,
    required: false,
    is_identity: false,
    options: null,
    validation: {},
    media: null,
    mapping: null,
    show_if: null,
    created_at: '2026-11-01T00:00:00Z',
    updated_at: '2026-11-01T00:00:00Z',
    ...partial,
  };
}

export function makeForm(partial: Partial<Form> = {}): Form {
  return {
    id: FORM_ID,
    account_id: ACCOUNT_ID,
    user_id: USER_ID,
    name: 'Captação',
    slug: 'captacao',
    status: 'draft',
    locale: 'pt-BR',
    description: null,
    theme: {},
    settings: {},
    scoring: {},
    portal_visibility: 'none',
    ai_offerable: false,
    ai_offer_hint: null,
    version: 1,
    published_at: null,
    archived_at: null,
    created_at: '2026-11-01T00:00:00Z',
    updated_at: '2026-11-01T00:00:00Z',
    ...partial,
  };
}

/** Telefone (identidade) + nome + interesse pontuado + consentimento. */
export function leadFields(): FormField[] {
  return [
    makeField({
      key: 'phone',
      type: 'phone',
      position: 0,
      required: true,
      is_identity: true,
    }),
    makeField({
      key: 'name',
      type: 'short_text',
      position: 1,
      required: true,
      mapping: { target: 'contact.name' },
    }),
    makeField({
      key: 'interest',
      type: 'single_select',
      position: 2,
      required: true,
      options: [
        { id: 'now', label: 'Agora', points: 40 },
        { id: 'later', label: 'Depois', points: 10 },
      ],
    }),
    makeField({
      key: 'consent',
      type: 'consent',
      position: 3,
      required: true,
      mapping: { target: 'contact.opt_in' },
    }),
  ];
}

export interface FakeCall {
  table: string;
  method: string;
  args: unknown[];
}

export interface FakeResult {
  data?: unknown;
  error?: unknown;
  count?: number | null;
}

/**
 * Cliente Supabase de mentira: cada `from(tabela)` consome o próximo
 * resultado da fila daquela tabela (ou `{data:null,error:null}`), e toda
 * a cadeia (`select().eq().maybeSingle()`, `insert().select().single()`,
 * `upsert(...)`) resolve nesse resultado. As chamadas ficam em `calls`.
 */
export function fakeDb(queues: Record<string, FakeResult[]> = {}) {
  const calls: FakeCall[] = [];
  const pending: Record<string, FakeResult[]> = {};
  for (const [table, list] of Object.entries(queues)) {
    pending[table] = [...list];
  }

  function from(table: string) {
    const queue = pending[table] ?? [];
    const next = queue.length ? queue.shift()! : {};
    const result = {
      data: next.data ?? null,
      error: next.error ?? null,
      count: next.count ?? null,
    };
    const make = (): unknown =>
      new Proxy(
        {},
        {
          get(_target, prop) {
            if (prop === 'then') {
              return (
                resolve: (v: unknown) => unknown,
                reject: (e: unknown) => unknown
              ) => Promise.resolve(result).then(resolve, reject);
            }
            return (...args: unknown[]) => {
              calls.push({ table, method: String(prop), args });
              return make();
            };
          },
        }
      );
    return make();
  }

  const rpc = vi.fn().mockResolvedValue({ data: null, error: null });

  return {
    calls,
    rpc,
    from,
    /** Chamadas de um método numa tabela (ex.: `insert` em `contacts`). */
    callsTo(table: string, method: string): FakeCall[] {
      return calls.filter((c) => c.table === table && c.method === method);
    },
  };
}

export type FakeDb = ReturnType<typeof fakeDb>;
