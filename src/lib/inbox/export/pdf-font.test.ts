import { describe, expect, it } from 'vitest';
import { sanitizeForPdf, splitRuns, wrapText, type Run } from './pdf-font';

const SKIN_TONE_START = 0x1f3fb;
const SKIN_TONE_END = 0x1f3ff;

/** Simula uma fonte de emoji real: cobre tudo fora do BMP, exceto os
 *  modificadores de tom de pele isolados — para provar que `splitRuns`
 *  os gruda no run vizinho por contexto, não por cobertura própria. */
const hasEmojiGlyph = (codePoint: number): boolean =>
  codePoint > 0xffff &&
  !(codePoint >= SKIN_TONE_START && codePoint <= SKIN_TONE_END);

const CHAR_WIDTH = 1;
const measureByChar = (run: Run): number => run.text.length * CHAR_WIDTH;

describe('splitRuns', () => {
  it("'oi 👍' vira dois runs, o segundo com o par surrogate inteiro", () => {
    const runs = splitRuns('oi 👍', hasEmojiGlyph);
    expect(runs).toEqual([
      { text: 'oi ', font: 'text' },
      { text: '👍', font: 'emoji' },
    ]);
  });

  it('família com ZWJ permanece num run só', () => {
    const family = '👨‍👩‍👧';
    const runs = splitRuns(family, hasEmojiGlyph);
    expect(runs).toEqual([{ text: family, font: 'emoji' }]);
  });

  it('emoji com modificador de tom de pele fica colado ao run, mesmo sem cobertura própria', () => {
    const thumbsUpMedium = '👍\u{1F3FD}';
    const runs = splitRuns(thumbsUpMedium, hasEmojiGlyph);
    expect(runs).toEqual([{ text: thumbsUpMedium, font: 'emoji' }]);
  });

  it('texto puro sem emoji vira um único run de texto', () => {
    const runs = splitRuns('Olá, tudo bem?', hasEmojiGlyph);
    expect(runs).toEqual([{ text: 'Olá, tudo bem?', font: 'text' }]);
  });

  it('string vazia não gera runs', () => {
    expect(splitRuns('', hasEmojiGlyph)).toEqual([]);
  });
});

describe('sanitizeForPdf', () => {
  it('remove caractere sem cobertura em nenhuma das duas fontes', () => {
    const covered = (codePoint: number) => codePoint < 0x1f600;
    const withUncovered = `A${String.fromCodePoint(0x1f600)}B`; // 'A😀B'
    expect(sanitizeForPdf(withUncovered, covered)).toBe('AB');
  });

  it('mantém tudo quando cobertura é total', () => {
    const text = 'texto normal 123';
    expect(sanitizeForPdf(text, () => true)).toBe(text);
  });

  it('string vazia devolve string vazia', () => {
    expect(sanitizeForPdf('', () => true)).toBe('');
  });
});

describe('wrapText', () => {
  it('quebra dentro de uma "palavra" de 400 caracteres', () => {
    const runs: Run[] = [{ text: 'a'.repeat(400), font: 'text' }];
    const lines = wrapText(runs, 100, measureByChar);

    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) {
      const width = line.reduce((sum, r) => sum + measureByChar(r), 0);
      expect(width).toBeLessThanOrEqual(100);
    }
    const totalChars = lines.reduce(
      (sum, line) => sum + line.reduce((s, r) => s + r.text.length, 0),
      0
    );
    expect(totalChars).toBe(400);
  });

  it('quebra por palavra quando a linha estoura, sem partir palavras que cabem', () => {
    const runs = splitRuns('uma frase razoavelmente longa aqui', hasEmojiGlyph);
    const lines = wrapText(runs, 15, measureByChar);

    expect(lines.length).toBeGreaterThan(1);
    const words = lines.map((line) =>
      line
        .map((r) => r.text)
        .join('')
        .trim()
    );
    expect(words.join(' ').replace(/\s+/g, ' ')).toBe(
      'uma frase razoavelmente longa aqui'
    );
  });

  it('texto vazio não gera linha fantasma', () => {
    expect(wrapText([], 100, measureByChar)).toEqual([]);
  });

  it('texto só de espaços não gera linha fantasma', () => {
    const runs: Run[] = [{ text: '     ', font: 'text' }];
    expect(wrapText(runs, 100, measureByChar)).toEqual([]);
  });

  it('não quebra uma palavra que cabe inteira na linha', () => {
    const runs = splitRuns('oi tudo bem', hasEmojiGlyph);
    const lines = wrapText(runs, 1000, measureByChar);
    expect(lines).toHaveLength(1);
    expect(lines[0].map((r) => r.text).join('')).toBe('oi tudo bem');
  });
});
