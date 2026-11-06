// ============================================================
// Instantâneo da resposta (PRD 084 D-4, SPEC 085 §6 `snapshot.ts`).
//
// `form_responses.answers` guarda, por bloco, RÓTULO, TIPO, VALOR e
// PONTOS no momento do envio. Editar o formulário depois não reescreve
// respostas antigas; apagar um bloco ou uma opção não apaga o que já
// foi respondido — por isso os rótulos das opções também vão junto.
// ============================================================

import type {
  AnswerSnapshotEntry,
  AnswerValue,
  Answers,
  AnswersSnapshot,
  FileRef,
  FormField,
} from './types';

type FieldLike = Pick<FormField, 'key' | 'type' | 'label' | 'options'>;

/** Rótulos das opções escolhidas (ou o id, se a opção já não existe). */
export function optionLabels(
  field: FieldLike,
  value: AnswerValue
): string[] | undefined {
  switch (field.type) {
    case 'single_select':
    case 'dropdown': {
      if (typeof value !== 'string') return undefined;
      return [field.options?.find((o) => o.id === value)?.label ?? value];
    }
    case 'multi_select': {
      if (!Array.isArray(value)) return undefined;
      return (value as string[]).map(
        (id) => field.options?.find((o) => o.id === id)?.label ?? id
      );
    }
    case 'yes_no': {
      const id = value === true || value === 'yes' ? 'yes' : 'no';
      const label = field.options?.find((o) => o.id === id)?.label;
      return [label ?? id];
    }
    default:
      return undefined;
  }
}

/**
 * Monta o JSONB de `answers` a partir das respostas já validadas e dos
 * pontos por bloco (`computeScore().breakdown`). Só os blocos presentes
 * em `answers` entram; `statement` nunca entra.
 */
export function snapshotAnswers(
  fields: readonly FieldLike[],
  answers: Answers,
  points: Record<string, number> = {}
): AnswersSnapshot {
  const out: AnswersSnapshot = {};
  for (const field of fields) {
    if (field.type === 'statement') continue;
    if (!(field.key in answers)) continue;
    const value = answers[field.key];
    const entry: AnswerSnapshotEntry = {
      label: field.label,
      type: field.type,
      value,
      points: points[field.key] ?? 0,
    };
    const labels = optionLabels(field, value);
    if (labels) entry.option_labels = labels;
    out[field.key] = entry;
  }
  return out;
}

/**
 * Valor legível de um bloco (para campo personalizado, exportação e IA):
 * escolhas pelos rótulos, sim/não como `yes`/`no` (quem exibe traduz),
 * arquivos pelo nome, número como texto.
 */
export function answerToText(field: FieldLike, value: AnswerValue): string {
  switch (field.type) {
    case 'single_select':
    case 'dropdown':
    case 'multi_select':
      return (optionLabels(field, value) ?? []).join(', ');
    case 'yes_no':
      return value === true || value === 'yes' ? 'yes' : 'no';
    case 'consent':
      return value === true ? 'yes' : 'no';
    case 'file_upload':
      return Array.isArray(value)
        ? (value as FileRef[]).map((f) => f.name).join(', ')
        : '';
    case 'number':
    case 'rating':
      return typeof value === 'number' ? String(value) : String(value ?? '');
    default:
      return typeof value === 'string' ? value : String(value ?? '');
  }
}

/** Arquivos referenciados num instantâneo (para apagar / varrer órfãos). */
export function fileRefsFromSnapshot(snapshot: AnswersSnapshot): FileRef[] {
  const out: FileRef[] = [];
  for (const entry of Object.values(snapshot)) {
    if (entry.type !== 'file_upload' || !Array.isArray(entry.value)) continue;
    for (const f of entry.value as FileRef[]) {
      if (f && typeof f.path === 'string') out.push(f);
    }
  }
  return out;
}

/** Soma dos bytes dos arquivos do instantâneo (`form_responses.upload_bytes`). */
export function uploadBytesFromSnapshot(snapshot: AnswersSnapshot): number {
  return fileRefsFromSnapshot(snapshot).reduce(
    (sum, f) => sum + (Number.isFinite(f.size) ? f.size : 0),
    0
  );
}
