import { describe, it, expect } from 'vitest';
import { IngestError } from './errors';
import { buildFaqText, normalizeFaqPairs, parseFaqText } from './faq';
import {
  MAX_FAQ_ANSWER_CHARS,
  MAX_FAQ_PAIRS,
  MAX_FAQ_QUESTION_CHARS,
} from './limits';

describe('buildFaqText / parseFaqText', () => {
  it('round-trips pairs, keeping line breaks inside an answer', () => {
    const pairs = [
      {
        question: 'Qual o horário?',
        answer: 'Seg a sex: 9h às 18h\nSábado: 9h às 12h',
      },
      { question: 'Aceita Pix?', answer: 'Sim.' },
    ];
    const text = buildFaqText(pairs);
    expect(text).toBe(
      'Q: Qual o horário?\nA: Seg a sex: 9h às 18h\nSábado: 9h às 12h\n\nQ: Aceita Pix?\nA: Sim.'
    );
    expect(parseFaqText(text)).toEqual(pairs);
  });

  it('collapses blank lines in an answer (they would split the pair on re-read)', () => {
    const text = buildFaqText([{ question: 'P?', answer: 'um\n\n\ndois' }]);
    expect(parseFaqText(text)).toEqual([
      { question: 'P?', answer: 'um\ndois' },
    ]);
  });

  it('keeps the question on one line', () => {
    const text = buildFaqText([{ question: 'Qual\no   prazo?', answer: 'R' }]);
    expect(text.startsWith('Q: Qual o prazo?\n')).toBe(true);
  });

  it('ignores blocks that do not follow the format', () => {
    expect(parseFaqText('solto\n\nQ: P?\nA: R')).toEqual([
      { question: 'P?', answer: 'R' },
    ]);
  });
});

describe('normalizeFaqPairs', () => {
  it('accepts valid pairs and trims them', () => {
    expect(normalizeFaqPairs([{ question: '  P?  ', answer: ' R ' }])).toEqual([
      { question: 'P?', answer: 'R' },
    ]);
  });

  const reject = (input: unknown) =>
    expect(() => normalizeFaqPairs(input)).toThrow(IngestError);

  it('rejects empty, non-array and malformed input', () => {
    reject([]);
    reject(undefined);
    reject('x');
    reject([{ question: 'P?' }]);
    reject([{ question: '  ', answer: 'R' }]);
    reject([{ question: 'P?', answer: ' ' }]);
  });

  it('rejects limits that would make a pair not fit in one chunk', () => {
    reject([{ question: 'q'.repeat(MAX_FAQ_QUESTION_CHARS + 1), answer: 'R' }]);
    reject([{ question: 'P?', answer: 'a'.repeat(MAX_FAQ_ANSWER_CHARS + 1) }]);
    reject(
      Array.from({ length: MAX_FAQ_PAIRS + 1 }, () => ({
        question: 'P?',
        answer: 'R',
      }))
    );
  });

  it('carries the faq_invalid code', () => {
    try {
      normalizeFaqPairs([]);
    } catch (e) {
      expect((e as IngestError).code).toBe('faq_invalid');
      expect((e as IngestError).status).toBe(400);
    }
  });
});
