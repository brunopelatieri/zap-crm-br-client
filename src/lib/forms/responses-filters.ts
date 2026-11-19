// Estado dos filtros da tela de respostas e sua tradução para a query string
// (e para o `scope.filter` da exportação). Puro e testado: é o contrato entre
// a tela e `parseResponsesFilter` (src/lib/forms/responses-query.ts).

import type { FieldType, ResponseSource, ResponseStatus } from './types';

export interface FilterState {
  q: string;
  status: '' | ResponseStatus;
  band: string;
  source: '' | ResponseSource;
  from: string;
  to: string;
  blockKey: string;
  blockValue: string;
}

/** Por padrão só as concluídas: parciais e abandonadas poluem a lista. */
export const DEFAULT_FILTERS: FilterState = {
  q: '',
  status: 'completed',
  band: '',
  source: '',
  from: '',
  to: '',
  blockKey: '',
  blockValue: '',
};

/** Tipos de bloco que o "bloco X = valor" sabe filtrar (ver `buildBlockContainment`). */
export const FILTERABLE_BLOCK_TYPES: readonly FieldType[] = [
  'short_text',
  'email',
  'phone',
  'date',
  'number',
  'rating',
  'single_select',
  'multi_select',
  'dropdown',
  'yes_no',
  'consent',
];

/** Só os campos preenchidos; `block`/`value` só juntos. */
export function filtersToRecord(f: FilterState): Record<string, string> {
  const out: Record<string, string> = {};
  if (f.q.trim()) out.q = f.q.trim();
  if (f.status) out.status = f.status;
  if (f.band) out.band = f.band;
  if (f.source) out.source = f.source;
  if (f.from) out.from = f.from;
  if (f.to) out.to = f.to;
  if (f.blockKey && f.blockValue.trim() !== '') {
    out.block = f.blockKey;
    out.value = f.blockValue.trim();
  }
  return out;
}

export function filtersToParams(
  f: FilterState,
  page: number,
  pageSize: number
): URLSearchParams {
  const params = new URLSearchParams(filtersToRecord(f));
  params.set('page', String(page));
  params.set('pageSize', String(pageSize));
  return params;
}

/** O que difere do padrão — habilita "Limpar filtros". */
export function hasActiveFilters(f: FilterState): boolean {
  return (
    JSON.stringify(filtersToRecord(f)) !==
    JSON.stringify(filtersToRecord(DEFAULT_FILTERS))
  );
}

export function totalPages(total: number, pageSize: number): number {
  return Math.max(1, Math.ceil(total / pageSize));
}
