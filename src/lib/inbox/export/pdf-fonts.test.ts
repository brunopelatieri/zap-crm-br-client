import { describe, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { loadExportFonts } from './pdf-fonts';
import { splitRuns } from './pdf-font';

async function fonts(embedEmoji = true) {
  const doc = await PDFDocument.create();
  return loadExportFonts(doc, { embedEmoji });
}

const cp = (ch: string) => ch.codePointAt(0)!;

describe('loadExportFonts — carregamento', () => {
  it('lê os .ttf de process.cwd() e embute as três fontes', async () => {
    const loaded = await fonts();
    expect(loaded.text).toBeDefined();
    expect(loaded.semibold).toBeDefined();
    expect(loaded.emoji).not.toBeNull();
  });

  it('sem emoji no documento, a fonte de emoji não é embutida', async () => {
    // Ela não pode ser subsetada (glifos saem em branco), então são
    // ~580 KB que só se paga quando o documento realmente precisa.
    const loaded = await fonts(false);
    expect(loaded.emoji).toBeNull();
    // A cobertura continua respondendo — ela vem do fontkit, não do
    // embed.
    expect(loaded.usesEmojiFont(0x1f44d)).toBe(true);
  });
});

describe('usesEmojiFont — a fonte de texto tem prioridade', () => {
  it('REGRESSÃO: espaço e dígito NÃO vão para a fonte de emoji', async () => {
    const { usesEmojiFont } = await fonts();
    // A NotoEmoji cobre espaço, dígitos e ASCII por causa de 0️⃣ / #️⃣ /
    // *️⃣. Decidir pela cobertura crua mandava o espaço para lá — 15,23pt
    // em vez de 3,12pt — e o texto saía esparramado, com os dígitos
    // desenhados como símbolos errados. Só a inspeção visual do PDF
    // pegou isso; nenhum teste de "não lançou" pegaria.
    expect(usesEmojiFont(cp(' '))).toBe(false);
    for (const digit of '0123456789') {
      expect(usesEmojiFont(cp(digit))).toBe(false);
    }
    expect(usesEmojiFont(cp('#'))).toBe(false);
    expect(usesEmojiFont(cp('*'))).toBe(false);
  });

  it('letras e acentuação ficam na fonte de texto', async () => {
    const { usesEmojiFont } = await fonts();
    for (const ch of 'aZçãêüñÇ,.!?-') {
      expect(usesEmojiFont(cp(ch))).toBe(false);
    }
  });

  it('emoji de verdade vai para a fonte de emoji', async () => {
    const { usesEmojiFont } = await fonts();
    expect(usesEmojiFont(0x1f44d)).toBe(true); // 👍
    expect(usesEmojiFont(0x2764)).toBe(true); // ❤
    expect(usesEmojiFont(0x2b50)).toBe(true); // ⭐
  });

  it('o espaço medido na fonte certa é ~5x mais estreito', async () => {
    const { text, emoji } = await fonts();
    const inText = text.widthOfTextAtSize(' ', 12);
    const inEmoji = emoji!.widthOfTextAtSize(' ', 12);
    expect(inText).toBeLessThan(inEmoji / 3);
  });

  it('uma frase comum vira UM único run de texto', async () => {
    const { usesEmojiFont } = await fonts();
    const runs = splitRuns('Bom dia, Maria! Ação 123', usesEmojiFont);
    expect(runs).toEqual([{ text: 'Bom dia, Maria! Ação 123', font: 'text' }]);
  });

  it('frase com emoji parte só no emoji', async () => {
    const { usesEmojiFont } = await fonts();
    const runs = splitRuns('Obrigada 👍', usesEmojiFont);
    expect(runs).toEqual([
      { text: 'Obrigada ', font: 'text' },
      { text: '👍', font: 'emoji' },
    ]);
  });
});

describe('isCovered — o que sobrevive à sanitização', () => {
  it('cobre latino, acentuação, espaço e emoji', async () => {
    const { isCovered } = await fonts();
    for (const ch of 'aZçãê 1!') expect(isCovered(cp(ch))).toBe(true);
    expect(isCovered(0x1f44d)).toBe(true);
  });

  it('NÃO cobre CJK nem árabe — limite conhecido das fontes vendorizadas', async () => {
    const { isCovered } = await fonts();
    expect(isCovered(cp('漢'))).toBe(false);
    expect(isCovered(cp('ع'))).toBe(false);
  });

  it('NÃO cobre ★ nem → — por isso nenhum selo do render os usa', async () => {
    const { isCovered } = await fonts();
    expect(isCovered(0x2605)).toBe(false); // ★
    expect(isCovered(0x2192)).toBe(false); // →
  });
});
