// ============================================================
// Pontuação e faixa (PRD 084 D-5, SPEC 085 E-5).
//
// Calculado SÓ no servidor, a partir das respostas já validadas e da
// definição ATUAL dos blocos. O payload de envio não tem campo de
// pontos; o que o cliente mandar nesse sentido é ignorado antes de
// chegar aqui. Puro e determinístico: a mesma resposta dá sempre a
// mesma faixa, e o owner entende por quê (D-5).
// ============================================================

import type {
  Answers,
  Band,
  FieldOption,
  FormField,
  PointsRange,
} from './types';

type FieldLike = Pick<FormField, 'key' | 'type' | 'options' | 'validation'>;

export interface ScoreResult {
  score: number;
  /** Pontos por `key` de bloco — vai para o instantâneo (PRD D-4). */
  breakdown: Record<string, number>;
}

function optionPoints(options: FieldOption[] | null, id: string): number {
  const opt = options?.find((o) => o.id === id);
  return Number.isFinite(opt?.points) ? (opt!.points as number) : 0;
}

/** Primeira faixa que contém `value` (inclusiva nas duas pontas; `null` = aberta). */
export function pointsForValue(
  ranges: PointsRange[] | undefined,
  value: number
): number {
  if (!ranges || !Number.isFinite(value)) return 0;
  for (const r of ranges) {
    const aboveMin = r.min === null || r.min === undefined || value >= r.min;
    const belowMax = r.max === null || r.max === undefined || value <= r.max;
    if (aboveMin && belowMax) return Number.isFinite(r.points) ? r.points : 0;
  }
  return 0;
}

/** Pontos de UM bloco para o valor dado (0 para tipos que não pontuam). */
export function fieldPoints(field: FieldLike, value: unknown): number {
  switch (field.type) {
    case 'single_select':
    case 'dropdown':
      return typeof value === 'string' ? optionPoints(field.options, value) : 0;
    case 'yes_no': {
      if (typeof value !== 'boolean' && value !== 'yes' && value !== 'no') {
        return 0;
      }
      const id = value === true || value === 'yes' ? 'yes' : 'no';
      return optionPoints(field.options, id);
    }
    case 'multi_select':
      return Array.isArray(value)
        ? (value as unknown[]).reduce<number>(
            (sum, id) =>
              sum +
              (typeof id === 'string' ? optionPoints(field.options, id) : 0),
            0
          )
        : 0;
    case 'number':
    case 'rating':
      return typeof value === 'number'
        ? pointsForValue(field.validation?.points_ranges, value)
        : 0;
    default:
      return 0;
  }
}

/** Soma dos pontos dos blocos respondidos (só os presentes em `answers`). */
export function computeScore(
  fields: readonly FieldLike[],
  answers: Answers
): ScoreResult {
  const breakdown: Record<string, number> = {};
  let score = 0;
  for (const field of fields) {
    if (!(field.key in answers)) continue;
    const points = fieldPoints(field, answers[field.key]);
    breakdown[field.key] = points;
    score += points;
  }
  return { score, breakdown };
}

/**
 * Faixa em que `score` cai: `min ≤ score ≤ max` (`max` nulo = aberta).
 * Sem faixa que case → `null` (o `validate.ts` cobra cobertura do
 * domínio ao publicar, mas uma faixa editada depois pode deixar buraco;
 * `null` é o resultado honesto, não um erro).
 */
export function resolveBand(
  bands: readonly Band[] | undefined,
  score: number
): Band | null {
  if (!bands?.length) return null;
  const ordered = [...bands].sort((a, b) => a.min - b.min);
  return (
    ordered.find(
      (b) =>
        score >= b.min &&
        (b.max === null || b.max === undefined || score <= b.max)
    ) ?? null
  );
}

/** Maior pontuação possível com a definição atual (para o editor de faixas). */
export function maxPossibleScore(fields: readonly FieldLike[]): number {
  let total = 0;
  for (const field of fields) {
    switch (field.type) {
      case 'single_select':
      case 'dropdown':
      case 'yes_no':
        total += Math.max(
          0,
          ...(field.options ?? []).map((o) => o.points ?? 0)
        );
        break;
      case 'multi_select':
        total += (field.options ?? []).reduce(
          (sum, o) => sum + Math.max(0, o.points ?? 0),
          0
        );
        break;
      case 'number':
      case 'rating':
        total += Math.max(
          0,
          ...(field.validation?.points_ranges ?? []).map((r) => r.points ?? 0)
        );
        break;
      default:
        break;
    }
  }
  return total;
}
