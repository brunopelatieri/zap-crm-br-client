// ============================================================
// Lógica de pulo (PRD 084 D-6, SPEC 085 §6 `logic.ts`).
//
// Duas regras, nenhum grafo:
//   - `show_if`: UMA condição por bloco sobre um bloco ANTERIOR;
//   - `jump_to`: por opção de bloco de escolha, para um bloco POSTERIOR
//     (os blocos entre os dois são pulados).
//
// Usado no cliente (para avançar de tela) e no servidor (para descartar
// o valor de um bloco escondido antes de validar, pontuar e gravar —
// SPEC §4.2 item 3). Puro: sem Supabase, sem `node:`.
// ============================================================

import {
  CHOICE_FIELD_TYPES,
  type Answers,
  type FormField,
  type ShowIf,
} from './types';

type FieldLike = Pick<
  FormField,
  'key' | 'type' | 'position' | 'options' | 'show_if'
>;

/** Resposta "presente": não `undefined`/`null`, string não vazia, lista não vazia. */
export function isAnswered(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

function asComparable(value: unknown): string {
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') return value.trim().toLowerCase();
  return '';
}

/**
 * Avalia a condição contra as respostas. Bloco referenciado sem resposta:
 * `answered` → false; `eq` → false; `neq` → true; `contains` → false.
 */
export function evaluateShowIf(cond: ShowIf, answers: Answers): boolean {
  const value = answers[cond.field_key];
  const answered = isAnswered(value);

  switch (cond.op) {
    case 'answered':
      return answered;
    case 'eq': {
      if (!answered) return false;
      const expected = asComparable(cond.value);
      if (Array.isArray(value)) {
        return value.length === 1 && asComparable(value[0]) === expected;
      }
      return asComparable(value) === expected;
    }
    case 'neq': {
      if (!answered) return true;
      const expected = asComparable(cond.value);
      if (Array.isArray(value)) {
        return !(value.length === 1 && asComparable(value[0]) === expected);
      }
      return asComparable(value) !== expected;
    }
    case 'contains': {
      if (!answered) return false;
      const expected = asComparable(cond.value);
      if (!expected) return false;
      if (Array.isArray(value)) {
        return value.some((v) => asComparable(v) === expected);
      }
      return asComparable(value).includes(expected);
    }
    default:
      return false;
  }
}

/** Ordena por `position` sem mutar a entrada. */
export function sortFields<T extends Pick<FormField, 'position'>>(
  fields: readonly T[]
): T[] {
  return [...fields].sort((a, b) => a.position - b.position);
}

/** `jump_to` da opção escolhida num bloco de escolha única; `null` sem pulo. */
function jumpTargetFor(field: FieldLike, answers: Answers): string | null {
  if (
    !CHOICE_FIELD_TYPES.includes(field.type) ||
    field.type === 'multi_select'
  ) {
    return null;
  }
  const raw = answers[field.key];
  if (!isAnswered(raw)) return null;
  const chosenId =
    field.type === 'yes_no'
      ? raw === true || raw === 'yes'
        ? 'yes'
        : 'no'
      : String(raw);
  const option = field.options?.find((o) => o.id === chosenId);
  return option?.jump_to ?? null;
}

/**
 * Blocos visíveis na ordem em que o visitante os vê, dadas as respostas
 * até agora. Um bloco pulado por `jump_to` ou escondido por `show_if`
 * fica de fora — e o servidor DESCARTA qualquer valor dele (§4.2 item 3).
 */
export function resolveVisibleFields<T extends FieldLike>(
  fields: readonly T[],
  answers: Answers
): T[] {
  const ordered = sortFields(fields);
  const visible: T[] = [];
  let skipUntil: string | null = null;

  for (const field of ordered) {
    if (skipUntil !== null) {
      if (field.key !== skipUntil) continue;
      skipUntil = null;
    }
    if (field.show_if && !evaluateShowIf(field.show_if, answers)) continue;

    visible.push(field);

    // Só pulo PARA FRENTE conta (PRD D-6). Um alvo atrás ou inexistente
    // (rascunho inválido, prévia) é ignorado — nunca esconde o resto.
    const target = jumpTargetFor(field, answers);
    if (target) {
      const targetIndex = ordered.findIndex((f) => f.key === target);
      if (targetIndex > ordered.indexOf(field)) skipUntil = target;
    }
  }
  return visible;
}

/**
 * Próximo bloco visível depois de `currentKey` (ou o primeiro, com
 * `currentKey = null`); `null` quando acabou. O cliente chama a cada
 * resposta; o servidor usa `resolveVisibleFields` direto.
 */
export function nextFieldKey<T extends FieldLike>(
  fields: readonly T[],
  answers: Answers,
  currentKey: string | null
): string | null {
  const visible = resolveVisibleFields(fields, answers);
  if (currentKey === null) return visible[0]?.key ?? null;
  const idx = visible.findIndex((f) => f.key === currentKey);
  if (idx === -1) {
    // O bloco atual deixou de ser visível (resposta anterior mudou):
    // segue do primeiro visível depois dele na ordem original.
    const ordered = sortFields(fields);
    const pos = ordered.findIndex((f) => f.key === currentKey);
    if (pos === -1) return visible[0]?.key ?? null;
    const after = new Set(ordered.slice(pos + 1).map((f) => f.key));
    return visible.find((f) => after.has(f.key))?.key ?? null;
  }
  return visible[idx + 1]?.key ?? null;
}

/**
 * Respostas só dos blocos visíveis — o que o servidor valida, pontua e
 * grava. Chave desconhecida e bloco escondido somem aqui.
 */
export function pruneHiddenAnswers<T extends FieldLike>(
  fields: readonly T[],
  answers: Answers
): Answers {
  const visible = resolveVisibleFields(fields, answers);
  const out: Answers = {};
  for (const field of visible) {
    if (field.key in answers && isAnswered(answers[field.key])) {
      out[field.key] = answers[field.key];
    }
  }
  return out;
}
