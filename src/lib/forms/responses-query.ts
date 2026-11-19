// ============================================================
// Consulta das respostas (SPEC 085 §4.4 / §7.1, F4) — parte PURA.
//
// `parseResponsesFilter` lê a query string da rota; `planResponsesFilter`
// devolve a lista de operações a aplicar no builder do PostgREST (declarativa,
// para testar sem banco); `buildBlockContainment` monta o `@>` que a GIN
// `idx_form_responses_answers` (jsonb_path_ops) atende.
//
// Período: dia civil em `America/Sao_Paulo` (UTC−3, sem horário de verão
// desde 2019), o mesmo fuso da métrica mensal de quota.
// ============================================================

import { isUuid } from '@/lib/api/uuid';

import {
  RESPONSE_SOURCES,
  RESPONSE_STATUSES,
  type FieldType,
  type FormField,
  type ResponseSource,
  type ResponseStatus,
} from './types';

export const RESPONSES_DEFAULT_PAGE_SIZE = 25;
export const RESPONSES_MAX_PAGE_SIZE = 100;
/** Teto de uma exportação (o mesmo da exportação de contatos, SPEC 051). */
export const RESPONSES_EXPORT_MAX_ROWS = 50_000;
export const RESPONSES_EXPORT_BATCH = 1000;
/** Teto de ids numa chamada de apagar. */
export const RESPONSES_DELETE_MAX_IDS = 500;

/** Chaves de query que `parseResponsesFilter` lê (a exportação as repassa). */
export const FILTER_QUERY_KEYS = [
  'status',
  'band',
  'from',
  'to',
  'source',
  'block',
  'value',
  'q',
  'response',
] as const;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const KEY_RE = /^[a-z0-9_]{1,40}$/;
const BAND_RE = /^[A-Za-z0-9_-]{1,40}$/;

export interface ResponsesFilter {
  page: number;
  pageSize: number;
  statuses: ResponseStatus[];
  band: string | null;
  /** `YYYY-MM-DD` inclusive. */
  from: string | null;
  /** `YYYY-MM-DD` inclusive. */
  to: string | null;
  source: ResponseSource | null;
  /** "bloco X = valor": `key` do bloco e valor cru (id da opção, texto…). */
  block: { key: string; value: string } | null;
  /** Nome ou telefone do contato. */
  search: string | null;
  /** Uma resposta só (link profundo da notificação). */
  responseId: string | null;
}

export type ParsedFilter =
  { ok: true; filter: ResponsesFilter } | { ok: false; reason: string };

function intParam(
  raw: string | null,
  fallback: number,
  min: number,
  max: number
): number | null {
  if (raw === null || raw === '') return fallback;
  if (!/^\d{1,9}$/.test(raw)) return null;
  const n = Number(raw);
  if (n < min || n > max) return null;
  return n;
}

/**
 * Query string → filtro. Valor inválido devolve `ok: false` (a rota
 * responde 400): um filtro ignorado em silêncio mostraria linhas que o
 * usuário pediu para excluir.
 */
export function parseResponsesFilter(params: URLSearchParams): ParsedFilter {
  const page = intParam(params.get('page'), 1, 1, 100_000);
  if (page === null) return { ok: false, reason: 'page' };
  const pageSize = intParam(
    params.get('pageSize'),
    RESPONSES_DEFAULT_PAGE_SIZE,
    1,
    RESPONSES_MAX_PAGE_SIZE
  );
  if (pageSize === null) return { ok: false, reason: 'pageSize' };

  const statuses: ResponseStatus[] = [];
  const rawStatus = params.get('status');
  if (rawStatus) {
    for (const s of rawStatus.split(',')) {
      if (!(RESPONSE_STATUSES as readonly string[]).includes(s)) {
        return { ok: false, reason: 'status' };
      }
      if (!statuses.includes(s as ResponseStatus)) {
        statuses.push(s as ResponseStatus);
      }
    }
  }

  const band = params.get('band');
  if (band && !BAND_RE.test(band)) return { ok: false, reason: 'band' };

  const from = params.get('from');
  if (from && !DATE_RE.test(from)) return { ok: false, reason: 'from' };
  const to = params.get('to');
  if (to && !DATE_RE.test(to)) return { ok: false, reason: 'to' };
  if (from && to && from > to) return { ok: false, reason: 'period' };
  if ((from && !isRealDate(from)) || (to && !isRealDate(to))) {
    return { ok: false, reason: 'period' };
  }

  const source = params.get('source');
  if (source && !(RESPONSE_SOURCES as readonly string[]).includes(source)) {
    return { ok: false, reason: 'source' };
  }

  const blockKey = params.get('block');
  const blockValue = params.get('value');
  let block: ResponsesFilter['block'] = null;
  if (blockKey || blockValue) {
    if (!blockKey || !KEY_RE.test(blockKey) || blockValue === null) {
      return { ok: false, reason: 'block' };
    }
    if (blockValue.length > 200) return { ok: false, reason: 'block' };
    block = { key: blockKey, value: blockValue };
  }

  const search = (params.get('q') ?? '').trim().slice(0, 80);

  const responseId = params.get('response');
  if (responseId && !isUuid(responseId)) {
    return { ok: false, reason: 'response' };
  }

  return {
    ok: true,
    filter: {
      page,
      pageSize,
      statuses,
      band: band || null,
      from: from || null,
      to: to || null,
      source: (source as ResponseSource | null) || null,
      block,
      search: search || null,
      responseId: responseId || null,
    },
  };
}

/**
 * `YYYY-MM-DD` que existe no calendário. `Date.parse` não serve: o V8 aceita
 * 2026-02-31 e rola para 03/03 em silêncio.
 */
export function isRealDate(value: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  return (
    date.getUTCFullYear() === y &&
    date.getUTCMonth() === mo - 1 &&
    date.getUTCDate() === d
  );
}

/** Início do dia `YYYY-MM-DD` em São Paulo, como instante ISO (UTC). */
export function dayStartIso(date: string): string {
  return new Date(`${date}T00:00:00-03:00`).toISOString();
}

/** Início do dia SEGUINTE (limite exclusivo do filtro `to`). */
export function nextDayStartIso(date: string): string {
  const start = new Date(`${date}T00:00:00-03:00`);
  return new Date(start.getTime() + 24 * 60 * 60 * 1000).toISOString();
}

/**
 * Termo de busca seguro para a sintaxe de `.or()` do PostgREST: vírgula,
 * parênteses, aspas, `*`, `%`, `_` e `\` mudam o significado do filtro.
 */
export function sanitizeSearchTerm(term: string): string {
  // Ponto, dois-pontos e apóstrofo ficam: "j.silva" e "D'Ávila" são nomes
  // reais e, dentro do VALOR do filtro, não têm significado para o PostgREST.
  return term
    .replace(/[,()"*%_\\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export type FilterOp =
  | { op: 'eq'; column: string; value: string }
  | { op: 'in'; column: string; value: string[] }
  | { op: 'gte'; column: string; value: string }
  | { op: 'lt'; column: string; value: string }
  | { op: 'contains'; column: string; value: Record<string, unknown> }
  | { op: 'or'; filter: string; referencedTable: string };

/**
 * Filtros → operações. `block` já vem convertido por
 * `buildBlockContainment` (precisa dos blocos do formulário).
 */
export function planResponsesFilter(
  filter: ResponsesFilter,
  blockContainment: Record<string, unknown> | null
): FilterOp[] {
  const ops: FilterOp[] = [];
  if (filter.responseId) {
    ops.push({ op: 'eq', column: 'id', value: filter.responseId });
  }
  if (filter.statuses.length === 1) {
    ops.push({ op: 'eq', column: 'status', value: filter.statuses[0] });
  } else if (filter.statuses.length > 1) {
    ops.push({ op: 'in', column: 'status', value: filter.statuses });
  }
  if (filter.band)
    ops.push({ op: 'eq', column: 'band_key', value: filter.band });
  if (filter.source)
    ops.push({ op: 'eq', column: 'source', value: filter.source });
  if (filter.from) {
    ops.push({
      op: 'gte',
      column: 'started_at',
      value: dayStartIso(filter.from),
    });
  }
  if (filter.to) {
    ops.push({
      op: 'lt',
      column: 'started_at',
      value: nextDayStartIso(filter.to),
    });
  }
  if (blockContainment) {
    ops.push({ op: 'contains', column: 'answers', value: blockContainment });
  }
  const term = filter.search ? sanitizeSearchTerm(filter.search) : '';
  if (term) {
    const digits = term.replace(/\D/g, '');
    const parts = [`name.ilike.%${term}%`, `phone.ilike.%${term}%`];
    if (digits.length >= 3) parts.push(`phone_normalized.ilike.%${digits}%`);
    ops.push({
      op: 'or',
      filter: parts.join(','),
      referencedTable: 'contacts',
    });
  }
  return ops;
}

/** O embed de contato precisa ser `!inner` quando há busca (senão só esconde o contato). */
export function needsInnerContactJoin(filter: ResponsesFilter): boolean {
  return !!(filter.search && sanitizeSearchTerm(filter.search));
}

/** Tipos cujo valor guardado em `answers` é um id de opção (ou vários). */
const OPTION_TYPES: readonly FieldType[] = [
  'single_select',
  'dropdown',
  'multi_select',
];

/**
 * `{ [key]: { value: … } }` para o `@>` do Postgres, no formato do
 * instantâneo (`{key: {label, type, value, points}}`). `multi_select`
 * guarda array: contém o id escolhido. `yes_no`/`consent` aceitam
 * `yes`/`no`/`true`/`false`. `null` quando o valor não faz sentido para
 * o tipo (a rota responde 400) ou o bloco não existe/não filtra.
 */
export function buildBlockContainment(
  field: Pick<FormField, 'key' | 'type'> | undefined,
  rawValue: string
): Record<string, unknown> | null {
  if (!field) return null;
  let value: unknown;
  if (field.type === 'multi_select') {
    value = [rawValue];
  } else if (OPTION_TYPES.includes(field.type)) {
    value = rawValue;
  } else if (field.type === 'yes_no' || field.type === 'consent') {
    if (rawValue === 'yes' || rawValue === 'true') value = true;
    else if (rawValue === 'no' || rawValue === 'false') value = false;
    else return null;
  } else if (field.type === 'number' || field.type === 'rating') {
    const n = Number(rawValue);
    if (rawValue.trim() === '' || !Number.isFinite(n)) return null;
    value = n;
  } else if (
    field.type === 'short_text' ||
    field.type === 'email' ||
    field.type === 'phone' ||
    field.type === 'date'
  ) {
    // Igualdade exata (o `@>` não faz "contém texto"): a busca parcial é
    // pelo contato, não pelo texto livre.
    value = rawValue;
  } else {
    return null; // long_text, file_upload e statement não filtram
  }
  return { [field.key]: { value } };
}

/** Intervalo `.range(from, to)` da página. */
export function pageRange(filter: Pick<ResponsesFilter, 'page' | 'pageSize'>): {
  from: number;
  to: number;
} {
  const from = (filter.page - 1) * filter.pageSize;
  return { from, to: from + filter.pageSize - 1 };
}

/** Colunas da resposta que a conta pode ler (nunca hash, IP nem token). */
export const RESPONSE_COLUMNS =
  'id, form_id, contact_id, status, identity_mode, source, form_version, answers, score, band_key, upload_bytes, deal_id, utm, locale, started_at, completed_at, updated_at';

export interface FilterableBuilder<Q> {
  eq(column: string, value: unknown): Q;
  in(column: string, values: readonly unknown[]): Q;
  gte(column: string, value: unknown): Q;
  lt(column: string, value: unknown): Q;
  contains(column: string, value: Record<string, unknown>): Q;
  or(filters: string, options?: { referencedTable?: string }): Q;
}

/** Aplica as operações num builder do supabase-js. */
export function applyFilterOps<Q extends FilterableBuilder<Q>>(
  query: Q,
  ops: readonly FilterOp[]
): Q {
  let q = query;
  for (const o of ops) {
    switch (o.op) {
      case 'eq':
        q = q.eq(o.column, o.value);
        break;
      case 'in':
        q = q.in(o.column, o.value);
        break;
      case 'gte':
        q = q.gte(o.column, o.value);
        break;
      case 'lt':
        q = q.lt(o.column, o.value);
        break;
      case 'contains':
        q = q.contains(o.column, o.value);
        break;
      case 'or':
        q = q.or(o.filter, { referencedTable: o.referencedTable });
        break;
    }
  }
  return q;
}
