import { describe, expect, it } from 'vitest';

import {
  evaluateShowIf,
  isAnswered,
  nextFieldKey,
  pruneHiddenAnswers,
  resolveVisibleFields,
} from './logic';
import { makeField } from './test-fixtures';

describe('isAnswered', () => {
  it('vazio é string em branco, lista vazia, null e undefined; false conta como resposta', () => {
    expect(isAnswered('')).toBe(false);
    expect(isAnswered('  ')).toBe(false);
    expect(isAnswered([])).toBe(false);
    expect(isAnswered(null)).toBe(false);
    expect(isAnswered(undefined)).toBe(false);
    expect(isAnswered(false)).toBe(true);
    expect(isAnswered(0)).toBe(true);
  });
});

describe('evaluateShowIf (PRD 084 D-6: uma condição só)', () => {
  it('eq / neq comparam sem caixa e aceitam booleano', () => {
    expect(
      evaluateShowIf({ field_key: 'a', op: 'eq', value: 'Sim' }, { a: 'sim' })
    ).toBe(true);
    expect(
      evaluateShowIf({ field_key: 'a', op: 'eq', value: true }, { a: true })
    ).toBe(true);
    expect(
      evaluateShowIf({ field_key: 'a', op: 'neq', value: 'x' }, { a: 'y' })
    ).toBe(true);
    // Sem resposta: eq é falso, neq é verdadeiro.
    expect(evaluateShowIf({ field_key: 'a', op: 'eq', value: 'x' }, {})).toBe(
      false
    );
    expect(evaluateShowIf({ field_key: 'a', op: 'neq', value: 'x' }, {})).toBe(
      true
    );
  });

  it('contains olha dentro da lista (múltipla escolha) ou do texto', () => {
    expect(
      evaluateShowIf(
        { field_key: 'a', op: 'contains', value: 'b' },
        { a: ['a', 'b'] }
      )
    ).toBe(true);
    expect(
      evaluateShowIf(
        { field_key: 'a', op: 'contains', value: 'z' },
        { a: ['a', 'b'] }
      )
    ).toBe(false);
    expect(
      evaluateShowIf(
        { field_key: 'a', op: 'contains', value: 'olá' },
        { a: 'Olá mundo' }
      )
    ).toBe(true);
  });

  it('answered ignora o valor', () => {
    expect(evaluateShowIf({ field_key: 'a', op: 'answered' }, { a: 0 })).toBe(
      true
    );
    expect(evaluateShowIf({ field_key: 'a', op: 'answered' }, { a: '' })).toBe(
      false
    );
  });
});

describe('resolveVisibleFields', () => {
  const fields = [
    makeField({ key: 'q1', type: 'yes_no', position: 0 }),
    makeField({
      key: 'q2',
      type: 'short_text',
      position: 1,
      show_if: { field_key: 'q1', op: 'eq', value: true },
    }),
    makeField({ key: 'q3', type: 'short_text', position: 2 }),
  ];

  it('esconde o bloco cuja condição não bate e respeita a ordem por position', () => {
    expect(
      resolveVisibleFields(fields, { q1: false }).map((f) => f.key)
    ).toEqual(['q1', 'q3']);
    expect(
      resolveVisibleFields(fields, { q1: true }).map((f) => f.key)
    ).toEqual(['q1', 'q2', 'q3']);
  });

  it('jump_to pula tudo até o alvo (sim/não usa os ids yes/no)', () => {
    const withJump = [
      makeField({
        key: 'start',
        type: 'yes_no',
        position: 0,
        options: [
          { id: 'yes', label: 'Sim', jump_to: 'end' },
          { id: 'no', label: 'Não' },
        ],
      }),
      makeField({ key: 'mid1', type: 'short_text', position: 1 }),
      makeField({ key: 'mid2', type: 'short_text', position: 2 }),
      makeField({ key: 'end', type: 'short_text', position: 3 }),
    ];
    expect(
      resolveVisibleFields(withJump, { start: true }).map((f) => f.key)
    ).toEqual(['start', 'end']);
    expect(
      resolveVisibleFields(withJump, { start: false }).map((f) => f.key)
    ).toEqual(['start', 'mid1', 'mid2', 'end']);
  });

  it('nextFieldKey anda pela lista visível e devolve null no fim', () => {
    expect(nextFieldKey(fields, {}, null)).toBe('q1');
    expect(nextFieldKey(fields, { q1: false }, 'q1')).toBe('q3');
    expect(nextFieldKey(fields, { q1: true }, 'q1')).toBe('q2');
    expect(nextFieldKey(fields, { q1: true }, 'q3')).toBeNull();
  });
});

describe('pruneHiddenAnswers (SPEC 085 §4.2 item 3)', () => {
  it('descarta resposta de bloco escondido e chave desconhecida', () => {
    const fields = [
      makeField({ key: 'q1', type: 'yes_no', position: 0 }),
      makeField({
        key: 'q2',
        type: 'short_text',
        position: 1,
        show_if: { field_key: 'q1', op: 'eq', value: true },
      }),
    ];
    expect(
      pruneHiddenAnswers(fields, { q1: false, q2: 'sobrou', hack: 'x' })
    ).toEqual({ q1: false });
  });
});

describe('jump_to inválido não esconde o resto (achado da revisão)', () => {
  it('alvo atrás ou inexistente é ignorado em vez de pular tudo', () => {
    const fields = [
      makeField({ key: 'a', type: 'short_text', position: 0 }),
      makeField({
        key: 'b',
        type: 'single_select',
        position: 1,
        options: [
          { id: 'back', label: 'Volta', jump_to: 'a' },
          { id: 'ghost', label: 'Fantasma', jump_to: 'nao-existe' },
        ],
      }),
      makeField({ key: 'c', type: 'short_text', position: 2 }),
    ];
    expect(
      resolveVisibleFields(fields, { b: 'back' }).map((f) => f.key)
    ).toEqual(['a', 'b', 'c']);
    expect(
      resolveVisibleFields(fields, { b: 'ghost' }).map((f) => f.key)
    ).toEqual(['a', 'b', 'c']);
  });
});
