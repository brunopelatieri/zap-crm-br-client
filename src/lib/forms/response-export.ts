// ============================================================
// Exportação das respostas (SPEC 085 §4.4 / §7.1, F4) — matriz e CSV.
//
// Colunas fixas + uma por bloco. O XLSX é gerado pela rota (import
// dinâmico de `write-excel-file/node`, como a exportação de contatos).
//
// As respostas vêm de um visitante anônimo: toda célula passa por
// `neutralizeFormula` (injeção de fórmula no Excel/Sheets — `=`, `+`, `-`,
// `@`, TAB, CR no início viram texto com apóstrofo).
// ============================================================

import { format as formatDate } from 'date-fns';

import { entryText, type DisplayLabels } from './response-display';
import type {
  AnswersSnapshot,
  FormField,
  ResponseSource,
  ResponseStatus,
} from './types';

export const RESPONSE_EXPORT_FIXED_COLUMNS = [
  'contact_name',
  'contact_phone',
  'status',
  'source',
  'started_at',
  'completed_at',
  'score',
  'band',
] as const;

export type ResponseExportFixedColumn =
  (typeof RESPONSE_EXPORT_FIXED_COLUMNS)[number];

export interface ResponseExportRow {
  status: ResponseStatus;
  source: ResponseSource;
  started_at: string;
  completed_at: string | null;
  score: number | null;
  band_key: string | null;
  answers: AnswersSnapshot;
  contacts: { name: string | null; phone: string | null } | null;
}

export interface ResponseExportLabels extends DisplayLabels {
  columns: Record<ResponseExportFixedColumn, string>;
  statuses: Record<ResponseStatus, string>;
  sources: Record<ResponseSource, string>;
  /** `band_key` → rótulo da faixa atual (cai na chave se a faixa sumiu). */
  bands: Record<string, string>;
  datePattern: string;
}

/** `=`, `+`, `-`, `@`, TAB e CR no início fazem o Excel executar a célula. */
export function neutralizeFormula(cell: string): string {
  if (!/^[=+\-@\t\r]/.test(cell)) return cell;
  // Número/telefone puro (`-5`, `+5511 99999-0000`): só dígitos e pontuação,
  // sem como chamar função — fica como está.
  if (/^[+-]?\d[\d\s().,-]*$/.test(cell)) return cell;
  return `'${cell}`;
}

export interface BlockColumn {
  key: string;
  label: string;
}

/**
 * Colunas de bloco: os blocos do formulário em ordem (sem `statement`),
 * mais as chaves que só existem em respostas antigas (bloco apagado
 * depois), com o rótulo do instantâneo. `onlyKeys` restringe (UI).
 */
export function resolveBlockColumns(
  fields: readonly Pick<FormField, 'key' | 'label' | 'type'>[],
  rows: readonly Pick<ResponseExportRow, 'answers'>[],
  onlyKeys?: readonly string[]
): BlockColumn[] {
  const cols: BlockColumn[] = [];
  const seen = new Set<string>();
  for (const f of fields) {
    if (f.type === 'statement' || seen.has(f.key)) continue;
    cols.push({ key: f.key, label: f.label });
    seen.add(f.key);
  }
  const orphan = new Map<string, string>();
  for (const r of rows) {
    for (const [key, entry] of Object.entries(r.answers ?? {})) {
      if (!seen.has(key) && !orphan.has(key)) orphan.set(key, entry.label);
    }
  }
  for (const key of [...orphan.keys()].sort()) {
    cols.push({ key, label: orphan.get(key)! });
  }
  if (!onlyKeys) return cols;
  const allowed = new Set(onlyKeys);
  return cols.filter((c) => allowed.has(c.key));
}

export function buildResponsesExportMatrix(
  rows: readonly ResponseExportRow[],
  blocks: readonly BlockColumn[],
  labels: ResponseExportLabels
): string[][] {
  const fmt = (iso: string | null) =>
    iso ? formatDate(new Date(iso), labels.datePattern) : '';
  const header = [
    ...RESPONSE_EXPORT_FIXED_COLUMNS.map((c) => labels.columns[c]),
    ...blocks.map((b) => b.label),
  ];
  const body = rows.map((r) => {
    const fixed = [
      r.contacts?.name ?? '',
      r.contacts?.phone ?? '',
      labels.statuses[r.status] ?? r.status,
      labels.sources[r.source] ?? r.source,
      fmt(r.started_at),
      fmt(r.completed_at),
      r.score === null || r.score === undefined ? '' : String(r.score),
      r.band_key ? (labels.bands[r.band_key] ?? r.band_key) : '',
    ];
    const cells = blocks.map((b) => {
      const entry = r.answers?.[b.key];
      return entry ? entryText(entry, labels) : '';
    });
    return [...fixed, ...cells].map(neutralizeFormula);
  });
  // O cabeçalho vem de rótulos do owner: também passa pelo neutralizador.
  return [header.map(neutralizeFormula), ...body];
}

/** `<prefixo>-<slug>-YYYY-MM-DD.<formato>`; o slug do formulário já é `[a-z0-9-]`. */
export function responsesExportFilename(
  prefix: string,
  formSlug: string,
  format: 'csv' | 'xlsx',
  now: Date
): string {
  return `${prefix}-${formSlug}-${now.toISOString().slice(0, 10)}.${format}`;
}

/** Nome do arquivo no `Content-Disposition` (RFC 5987, com fallback). */
export function filenameFromDisposition(
  header: string | null,
  fallback: string
): string {
  if (!header) return fallback;
  const star = /filename\*=UTF-8''([^;]+)/i.exec(header);
  if (star) {
    try {
      return decodeURIComponent(star[1]);
    } catch {
      /* cai no próximo */
    }
  }
  const plain = /filename="([^"]+)"/i.exec(header);
  return plain ? plain[1] : fallback;
}
