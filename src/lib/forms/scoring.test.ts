import { describe, expect, it } from 'vitest';

import {
  computeScore,
  fieldPoints,
  maxPossibleScore,
  pointsForValue,
  resolveBand,
} from './scoring';
import { leadFields, makeField } from './test-fixtures';
import type { Band } from './types';

describe('fieldPoints (PRD 084 D-5)', () => {
  it('escolha única e lista somam os pontos das opções', () => {
    const single = makeField({
      key: 's',
      type: 'single_select',
      options: [
        { id: 'a', label: 'A', points: 5 },
        { id: 'b', label: 'B' },
      ],
    });
    expect(fieldPoints(single, 'a')).toBe(5);
    expect(fieldPoints(single, 'b')).toBe(0);
    expect(fieldPoints(single, 'zzz')).toBe(0);

    const multi = makeField({
      key: 'm',
      type: 'multi_select',
      options: [
        { id: 'a', label: 'A', points: 5 },
        { id: 'b', label: 'B', points: 7 },
      ],
    });
    expect(fieldPoints(multi, ['a', 'b'])).toBe(12);
  });

  it('sim/não aceita booleano ou yes/no e usa as opções fixas', () => {
    const yn = makeField({
      key: 'y',
      type: 'yes_no',
      options: [
        { id: 'yes', label: 'Sim', points: 10 },
        { id: 'no', label: 'Não', points: 0 },
      ],
    });
    expect(fieldPoints(yn, true)).toBe(10);
    expect(fieldPoints(yn, 'yes')).toBe(10);
    expect(fieldPoints(yn, false)).toBe(0);
    expect(fieldPoints(yn, 'qualquer')).toBe(0);
  });

  it('número e nota usam faixas inclusivas, com pontas abertas', () => {
    const ranges = [
      { min: null, max: 3, points: 0 },
      { min: 4, max: 7, points: 5 },
      { min: 8, max: null, points: 10 },
    ];
    expect(pointsForValue(ranges, 0)).toBe(0);
    expect(pointsForValue(ranges, 4)).toBe(5);
    expect(pointsForValue(ranges, 7)).toBe(5);
    expect(pointsForValue(ranges, 100)).toBe(10);
    expect(pointsForValue(ranges, Number.NaN)).toBe(0);
    expect(pointsForValue(undefined, 5)).toBe(0);
  });
});

describe('computeScore / resolveBand', () => {
  it('soma só os blocos respondidos e devolve o detalhe por bloco', () => {
    const { score, breakdown } = computeScore(leadFields(), {
      phone: '5511999999999',
      interest: 'now',
    });
    expect(score).toBe(40);
    expect(breakdown).toEqual({ phone: 0, interest: 40 });
  });

  const bands: Band[] = [
    { key: 'cold', label: 'Frio', min: 0, max: 20 },
    { key: 'hot', label: 'Quente', min: 61, max: null },
    { key: 'warm', label: 'Morno', min: 21, max: 60 },
  ];

  it('acha a faixa pela pontuação, com a última aberta; sem faixas → null', () => {
    expect(resolveBand(bands, 0)?.key).toBe('cold');
    expect(resolveBand(bands, 20)?.key).toBe('cold');
    expect(resolveBand(bands, 21)?.key).toBe('warm');
    expect(resolveBand(bands, 999)?.key).toBe('hot');
    expect(resolveBand([], 10)).toBeNull();
    expect(resolveBand(undefined, 10)).toBeNull();
  });

  it('maxPossibleScore soma o melhor de cada bloco', () => {
    const fields = [
      ...leadFields(),
      makeField({
        key: 'nota',
        type: 'rating',
        validation: {
          scale: 10,
          points_ranges: [
            { min: 1, max: 5, points: 2 },
            { min: 6, max: 10, points: 9 },
          ],
        },
      }),
    ];
    expect(maxPossibleScore(fields)).toBe(49);
  });
});
