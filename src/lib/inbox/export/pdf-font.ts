/**
 * Partição de texto em runs de fonte + quebra de linha, para o render de
 * PDF (SPEC 067 §6). As 14 fontes padrão do `pdf-lib` são WinAnsi:
 * `drawText` lança exceção no primeiro caractere fora do Latin-1, e uma
 * conversa de WhatsApp sem emoji não existe — daí a necessidade de saber,
 * ANTES de desenhar, qual trecho vai em qual fonte embutida.
 *
 * Zero dependência do `pdf-lib`/`fontkit` aqui: cobertura de glifo e
 * medida de largura chegam como callbacks injetados, o que torna este
 * módulo testável sem carregar um `.ttf` de verdade.
 */

export type FontKind = 'text' | 'emoji';

export interface Run {
  text: string;
  font: FontKind;
}

const ZWJ_CODE_POINT = 0x200d;
const VARIATION_SELECTOR_16_CODE_POINT = 0xfe0f;
const SKIN_TONE_MODIFIER_START = 0x1f3fb;
const SKIN_TONE_MODIFIER_END = 0x1f3ff;
const REGIONAL_INDICATOR_START = 0x1f1e6;
const REGIONAL_INDICATOR_END = 0x1f1ff;

/**
 * Zero Width Joiner, seletor de variação e modificador de tom de pele não
 * têm glifo próprio visível — se o run atual já é `emoji`, eles precisam
 * ficar colados a ele independentemente do que `hasEmojiGlyph` diga,
 * senão uma família (`👨‍👩‍👧`) vira três pessoas soltas.
 */
function isEmojiJoinerContext(codePoint: number): boolean {
  return (
    codePoint === ZWJ_CODE_POINT ||
    codePoint === VARIATION_SELECTOR_16_CODE_POINT ||
    (codePoint >= SKIN_TONE_MODIFIER_START &&
      codePoint <= SKIN_TONE_MODIFIER_END) ||
    (codePoint >= REGIONAL_INDICATOR_START &&
      codePoint <= REGIONAL_INDICATOR_END)
  );
}

/**
 * Parte a string em runs conforme a fonte que cada trecho deve usar.
 *
 * ⚠️ `usesEmojiFont` é uma DECISÃO, não a pergunta "a fonte de emoji tem
 * esse glifo?". A `NotoEmoji` cobre espaço, dígitos e boa parte do ASCII
 * (por causa de `0️⃣`, `#️⃣`, `*️⃣`), então responder pela cobertura crua
 * manda espaço e número para a fonte errada — texto esparramado e
 * glifos trocados no PDF. Quem monta esse predicado é `pdf-fonts.ts`,
 * dando prioridade à fonte de texto.
 */
export function splitRuns(
  text: string,
  usesEmojiFont: (codePoint: number) => boolean
): Run[] {
  const runs: Run[] = [];
  let currentFont: FontKind | null = null;
  let currentText = '';

  for (const ch of text) {
    const codePoint = ch.codePointAt(0) ?? 0;
    const font: FontKind =
      currentFont === 'emoji' && isEmojiJoinerContext(codePoint)
        ? 'emoji'
        : usesEmojiFont(codePoint)
          ? 'emoji'
          : 'text';

    if (font === currentFont) {
      currentText += ch;
    } else {
      if (currentFont !== null) {
        runs.push({ text: currentText, font: currentFont });
      }
      currentFont = font;
      currentText = ch;
    }
  }

  if (currentFont !== null && currentText.length > 0) {
    runs.push({ text: currentText, font: currentFont });
  }

  return runs;
}

/**
 * Remove o que nenhuma das duas fontes cobre — senão `drawText` lança.
 * Itera por code point (não por unidade UTF-16): `'👍'.length === 2`, e
 * fatiar por índice partiria o par surrogate.
 */
export function sanitizeForPdf(
  text: string,
  covered: (codePoint: number) => boolean
): string {
  let result = '';
  for (const ch of text) {
    const codePoint = ch.codePointAt(0) ?? 0;
    if (covered(codePoint)) {
      result += ch;
    }
  }
  return result;
}

interface Token {
  text: string;
  font: FontKind;
  isSpace: boolean;
}

function tokenize(runs: Run[]): Token[] {
  const tokens: Token[] = [];
  for (const run of runs) {
    let buffer = '';
    let bufferIsSpace: boolean | null = null;
    for (const ch of run.text) {
      const isSpace = ch === ' ';
      if (bufferIsSpace === null || isSpace === bufferIsSpace) {
        buffer += ch;
        bufferIsSpace = isSpace;
      } else {
        tokens.push({ text: buffer, font: run.font, isSpace: !!bufferIsSpace });
        buffer = ch;
        bufferIsSpace = isSpace;
      }
    }
    if (buffer.length > 0) {
      tokens.push({ text: buffer, font: run.font, isSpace: !!bufferIsSpace });
    }
  }
  return tokens;
}

function widthOf(tokens: Token[], measure: (run: Run) => number): number {
  return tokens.reduce(
    (sum, t) => sum + measure({ text: t.text, font: t.font }),
    0
  );
}

/**
 * Quebra em linhas respeitando `maxWidth`, por palavra — e por grafema
 * quando uma única "palavra" (uma URL de 400 caracteres, comum em
 * conversa) já estoura a largura sozinha.
 */
export function wrapText(
  runs: Run[],
  maxWidth: number,
  measure: (run: Run) => number
): Run[][] {
  const tokens = tokenize(runs);

  const words: Token[][] = [];
  let currentWord: Token[] = [];
  for (const token of tokens) {
    if (token.isSpace) {
      if (currentWord.length > 0) {
        words.push(currentWord);
        currentWord = [];
      }
      words.push([token]);
    } else {
      currentWord.push(token);
    }
  }
  if (currentWord.length > 0) words.push(currentWord);

  const lines: Run[][] = [];
  let currentLine: Run[] = [];
  let currentLineWidth = 0;

  const flushLine = () => {
    if (currentLine.length > 0) lines.push(currentLine);
    currentLine = [];
    currentLineWidth = 0;
  };

  for (const wordTokens of words) {
    const isSpace = wordTokens.length === 1 && wordTokens[0].isSpace;

    if (isSpace) {
      if (currentLine.length === 0) continue; // sem espaço solto no início da linha
      const token = wordTokens[0];
      currentLine.push({ text: token.text, font: token.font });
      currentLineWidth += measure({ text: token.text, font: token.font });
      continue;
    }

    const wordWidth = widthOf(wordTokens, measure);

    if (wordWidth <= maxWidth) {
      if (currentLineWidth + wordWidth > maxWidth && currentLine.length > 0) {
        flushLine();
      }
      for (const t of wordTokens)
        currentLine.push({ text: t.text, font: t.font });
      currentLineWidth += wordWidth;
      continue;
    }

    // Palavra maior que a linha inteira: quebra dentro dela, por grafema.
    if (currentLine.length > 0) flushLine();
    let chunk = '';
    let chunkFont: FontKind | null = null;
    let chunkWidth = 0;
    for (const t of wordTokens) {
      for (const ch of t.text) {
        const chWidth = measure({ text: ch, font: t.font });
        if (
          chunk.length > 0 &&
          (chunkWidth + chWidth > maxWidth || chunkFont !== t.font)
        ) {
          currentLine.push({ text: chunk, font: chunkFont as FontKind });
          flushLine();
          chunk = '';
          chunkWidth = 0;
          chunkFont = null;
        }
        chunk += ch;
        chunkFont = t.font;
        chunkWidth += chWidth;
      }
    }
    if (chunk.length > 0) {
      currentLine.push({ text: chunk, font: chunkFont as FontKind });
      currentLineWidth = chunkWidth;
    }
  }

  flushLine();

  return lines.filter((line) => line.some((run) => run.text.length > 0));
}
