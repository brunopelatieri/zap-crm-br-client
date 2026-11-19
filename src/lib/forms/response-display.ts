// ============================================================
// Exibição das respostas (SPEC 085 §4.4, F4) — texto de uma entrada do
// instantâneo e ordem dos blocos. Puro: a tabela, o painel de detalhe,
// o cartão do inbox e a exportação usam as MESMAS funções.
//
// A ordem importa: o JSONB do Postgres não guarda a ordem de inserção
// das chaves (ordena por tamanho e depois alfabeticamente), então "os 3
// primeiros blocos" só existe a partir da posição dos blocos do
// formulário (`field_order`).
// ============================================================

import type { AnswerSnapshotEntry, AnswersSnapshot, FileRef } from './types';

export interface DisplayLabels {
  yes: string;
  no: string;
}

/** Valor do instantâneo como texto de uma célula/linha. */
export function entryText(
  entry: AnswerSnapshotEntry,
  labels: DisplayLabels
): string {
  switch (entry.type) {
    case 'single_select':
    case 'dropdown':
    case 'multi_select':
    case 'yes_no': {
      if (entry.option_labels?.length) return entry.option_labels.join(', ');
      if (entry.type === 'yes_no') {
        return entry.value === true || entry.value === 'yes'
          ? labels.yes
          : labels.no;
      }
      return Array.isArray(entry.value)
        ? (entry.value as string[]).join(', ')
        : String(entry.value ?? '');
    }
    case 'consent':
      return entry.value === true ? labels.yes : labels.no;
    case 'file_upload':
      return fileRefsOf(entry)
        .map((f) => f.name)
        .join(', ');
    case 'statement':
      return '';
    default:
      return entry.value === undefined || entry.value === null
        ? ''
        : String(entry.value);
  }
}

/** Arquivos de uma entrada `file_upload`, na ordem (o índice vai na rota de download). */
export function fileRefsOf(entry: AnswerSnapshotEntry): FileRef[] {
  if (entry.type !== 'file_upload' || !Array.isArray(entry.value)) return [];
  return (entry.value as FileRef[]).filter(
    (f) => f && typeof f === 'object' && typeof f.path === 'string'
  );
}

export interface OrderedEntry {
  key: string;
  entry: AnswerSnapshotEntry;
}

/**
 * Entradas na ordem dos blocos (`fieldOrder` = chaves por posição); o que
 * não está na lista (bloco apagado depois do envio) vai ao fim, em ordem
 * alfabética estável.
 */
export function orderedEntries(
  answers: AnswersSnapshot | null | undefined,
  fieldOrder: readonly string[] = []
): OrderedEntry[] {
  const snapshot = answers ?? {};
  const out: OrderedEntry[] = [];
  const seen = new Set<string>();
  for (const key of fieldOrder) {
    const entry = snapshot[key];
    if (entry && !seen.has(key)) {
      out.push({ key, entry });
      seen.add(key);
    }
  }
  for (const key of Object.keys(snapshot).sort()) {
    if (!seen.has(key)) out.push({ key, entry: snapshot[key] });
  }
  return out;
}

/** Os `n` primeiros blocos RESPONDIDOS com texto (o cartão do inbox). */
export function firstEntries(
  answers: AnswersSnapshot | null | undefined,
  fieldOrder: readonly string[],
  n: number,
  labels: DisplayLabels
): { key: string; label: string; text: string }[] {
  const out: { key: string; label: string; text: string }[] = [];
  for (const { key, entry } of orderedEntries(answers, fieldOrder)) {
    if (entry.type === 'file_upload' || entry.type === 'statement') continue;
    const text = entryText(entry, labels).trim();
    if (!text) continue;
    out.push({ key, label: entry.label, text });
    if (out.length >= n) break;
  }
  return out;
}

export interface ResponseFile {
  /** Índice estável usado em `GET …/responses/[rid]/files/[idx]`. */
  index: number;
  /** Bloco de origem. */
  key: string;
  file: FileRef;
}

/**
 * Todos os arquivos de uma resposta, numerados. A ordem NÃO depende do
 * formulário (que pode mudar depois): chaves em ordem alfabética, e dentro
 * de cada bloco a ordem do envio. A tela e a rota de download usam esta
 * mesma função — o índice de um é o do outro.
 */
export function listResponseFiles(
  answers: AnswersSnapshot | null | undefined
): ResponseFile[] {
  const snapshot = answers ?? {};
  const out: ResponseFile[] = [];
  for (const key of Object.keys(snapshot).sort()) {
    for (const file of fileRefsOf(snapshot[key])) {
      out.push({ index: out.length, key, file });
    }
  }
  return out;
}

/** O caminho do arquivo precisa estar na pasta DESTA resposta (SPEC §5.1). */
export function fileBelongsToResponse(
  path: string,
  accountId: string,
  formId: string,
  responseId: string
): boolean {
  return (
    path.startsWith(`account-${accountId}/${formId}/${responseId}/`) &&
    !path.split('/').some((seg) => seg === '..' || seg === '')
  );
}
