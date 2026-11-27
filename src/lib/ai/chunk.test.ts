import { describe, it, expect } from 'vitest';
import { chunkDocument, chunkFaq, chunkText } from './chunk';
import { buildFaqText } from './ingest/faq';

const contents = (text: string, opts?: Parameters<typeof chunkText>[1]) =>
  chunkText(text, opts).map((c) => c.content);

describe('chunkText', () => {
  it('returns nothing for empty / whitespace input', () => {
    expect(chunkText('')).toEqual([]);
    expect(chunkText('   \n\n  ')).toEqual([]);
  });

  it('keeps a short document as a single chunk, without prefix when there is no title', () => {
    expect(chunkText('Hello world')).toEqual([
      { heading: null, content: 'Hello world' },
    ]);
  });

  it('packs multiple paragraphs up to the char budget', () => {
    const a = 'A'.repeat(400);
    const b = 'B'.repeat(400);
    const c = 'C'.repeat(400);
    // Sem sobreposição: 400 + 2 + 400 = 802 <= 900, mas c não cabe → nova fatia.
    const out = contents(`${a}\n\n${b}\n\n${c}`, {
      maxChars: 900,
      overlapChars: 0,
    });
    expect(out).toEqual([`${a}\n\n${b}`, c]);
  });

  it('collapses extra blank lines without emitting an empty chunk', () => {
    expect(contents('one\n\n\n\ntwo')).toEqual(['one\n\ntwo']);
  });

  it('is deterministic: the same input gives the same chunks', () => {
    const text = Array.from(
      { length: 30 },
      (_, i) => `Parágrafo ${i}. ${'palavra '.repeat(40)}`
    ).join('\n\n');
    expect(chunkText(text, { title: 'T' })).toEqual(
      chunkText(text, { title: 'T' })
    );
  });

  describe('title of the section (D-12)', () => {
    it('prefixes the document title when there is no heading', () => {
      const [c] = chunkText('O prazo é de 7 dias.', {
        title: 'Política de Trocas',
      });
      expect(c.heading).toBe('Política de Trocas');
      expect(c.content).toBe('Política de Trocas\n\nO prazo é de 7 dias.');
    });

    it('prefixes title › heading and splits the document at Markdown headings', () => {
      const out = chunkText(
        '# Política\n\nIntro.\n\n## Frete\n\nO frete é grátis.\n\n## Prazo\n\nSão 7 dias.',
        { title: 'Loja' }
      );
      expect(out.map((c) => c.heading)).toEqual([
        'Loja › Política',
        'Loja › Frete',
        'Loja › Prazo',
      ]);
      expect(out[2].content).toBe('Loja › Prazo\n\nSão 7 dias.');
    });

    it('does not repeat the title when the heading is the same', () => {
      const [c] = chunkText('# Frete\n\nGrátis.', { title: 'Frete' });
      expect(c.heading).toBe('Frete');
    });

    it('ignores # lines inside a fenced code block', () => {
      const out = chunkText('Texto\n\n```\n# comentário\n```\n\nFim');
      expect(out).toHaveLength(1);
      expect(out[0].content).toContain('# comentário');
    });

    it('caps a huge prefix', () => {
      const [c] = chunkText('corpo', { title: 'T'.repeat(500) });
      expect(c.heading!.length).toBeLessThanOrEqual(150);
    });
  });

  describe('overlap (D-12)', () => {
    const sentences = Array.from(
      { length: 40 },
      (_, i) => `Frase número ${i} termina aqui.`
    ).join(' ');

    it('starts each next chunk of a section with the tail of the previous one', () => {
      const out = chunkText(sentences, { maxChars: 400, overlapChars: 150 });
      expect(out.length).toBeGreaterThan(2);
      for (let i = 1; i < out.length; i++) {
        const previousTail = out[i - 1].content.slice(-60).trim();
        // O trecho final da fatia anterior reaparece no começo da seguinte.
        const lastWords = previousTail.split(' ').slice(-3).join(' ');
        expect(out[i].content.slice(0, 200)).toContain(lastWords);
      }
    });

    it('never exceeds maxChars, prefix and overlap included', () => {
      const out = chunkText(sentences, {
        maxChars: 400,
        overlapChars: 150,
        title: 'Título do documento',
      });
      expect(out.every((c) => c.content.length <= 400)).toBe(true);
    });

    it('does not overlap across sections', () => {
      const out = chunkText(
        '## A\n\nalfa alfa alfa.\n\n## B\n\nbeta beta beta.'
      );
      expect(out[1].content).toBe('B\n\nbeta beta beta.');
    });

    it('can be turned off', () => {
      const out = contents(sentences, { maxChars: 400, overlapChars: 0 });
      expect(out.join(' ')).toBe(sentences);
    });
  });

  describe('oversized paragraphs', () => {
    it('splits by lines first, never inside a line that fits (CSV rows, lists)', () => {
      const rows = Array.from(
        { length: 30 },
        (_, i) => `Produto: Item ${i}; Preço: R$ ${i},90`
      );
      const out = contents(rows.join('\n'), { maxChars: 300, overlapChars: 0 });
      expect(out.length).toBeGreaterThan(1);
      // Toda linha original aparece inteira em alguma fatia.
      for (const row of rows) {
        expect(out.some((c) => c.includes(row))).toBe(true);
      }
    });

    it('splits a long line by sentences', () => {
      const line = Array.from(
        { length: 30 },
        (_, i) => `Sentença ${i} completa.`
      ).join(' ');
      const out = contents(line, { maxChars: 250, overlapChars: 0 });
      for (const c of out) expect(c.endsWith('.')).toBe(true);
      expect(out.join(' ')).toBe(line);
    });

    it('hard-splits a run with no spaces at the budget', () => {
      const big = 'x'.repeat(2500);
      const out = contents(big, { maxChars: 1000, overlapChars: 0 });
      expect(out).toHaveLength(3);
      expect(out.every((c) => c.length <= 1000)).toBe(true);
      expect(out.join('')).toBe(big);
    });

    it('cuts a long sentence at the last word that fits', () => {
      const long = 'palavra '.repeat(200).trim();
      const out = contents(long, { maxChars: 300, overlapChars: 0 });
      for (const c of out) {
        expect(c.length).toBeLessThanOrEqual(300);
        expect(c.startsWith('palavra')).toBe(true);
        expect(c.endsWith('palavra')).toBe(true);
      }
    });
  });

  it('survives a tiny maxChars without looping forever', () => {
    const out = chunkText('palavra '.repeat(100), { maxChars: 20, title: 'T' });
    expect(out.length).toBeGreaterThan(0);
  });
});

describe('chunkFaq', () => {
  const pairs = [
    { question: 'Qual o prazo?', answer: 'Sete dias.' },
    { question: 'Aceita Pix?', answer: 'Sim, com 5% de desconto.' },
  ];

  it('makes one chunk per pair, with the document title prefixed', () => {
    expect(chunkFaq(pairs, 'FAQ Loja')).toEqual([
      {
        heading: 'FAQ Loja',
        content: 'FAQ Loja\n\nQ: Qual o prazo?\nA: Sete dias.',
      },
      {
        heading: 'FAQ Loja',
        content: 'FAQ Loja\n\nQ: Aceita Pix?\nA: Sim, com 5% de desconto.',
      },
    ]);
  });

  it('never splits a pair, even a long one', () => {
    const answer = 'resposta longa. '.repeat(200).trim(); // ~3.2 mil caracteres
    const [chunk] = chunkFaq([{ question: 'Pergunta?', answer }], 'FAQ');
    expect(chunk.content).toContain(`A: ${answer}`);
  });
});

describe('chunkDocument', () => {
  it('chunks a faq document one pair per chunk, after a round trip through the text format', () => {
    const content = buildFaqText([
      { question: 'Qual o prazo?', answer: 'Sete dias.' },
      { question: 'Aceita Pix?', answer: 'Sim.' },
    ]);
    const out = chunkDocument({ title: 'FAQ', sourceType: 'faq', content });
    expect(out).toHaveLength(2);
    expect(out[1].content).toBe('FAQ\n\nQ: Aceita Pix?\nA: Sim.');
  });

  it('falls back to plain chunking when a faq document has no parsable pair', () => {
    const out = chunkDocument({
      title: 'FAQ',
      sourceType: 'faq',
      content: 'texto solto',
    });
    expect(out).toEqual([{ heading: 'FAQ', content: 'FAQ\n\ntexto solto' }]);
  });

  it('uses the text chunker for every other source', () => {
    const out = chunkDocument({
      title: 'Manual',
      sourceType: 'file',
      content: '## Passo 1\n\nLigue.',
    });
    expect(out[0].heading).toBe('Manual › Passo 1');
  });
});

describe('chunkText — hostile input runs in linear time', () => {
  // `\u2003` (EM SPACE) is whitespace for `\s` but not for `[ \t]`.
  const EM = String.fromCharCode(0x2003);
  const N = 12_000;
  const cases: Record<string, string> = {
    'heading with em-space / # / em-space and a trailing char': `# ${EM.repeat(N)}${'#'.repeat(N)}${EM.repeat(N)}x`,
    'heading of only em-spaces': `## ${EM.repeat(50_000)}`,
    'heading of only #': `# ${'#'.repeat(50_000)}`,
    'heading with spaces and hashes alternating': `# ${'# '.repeat(25_000)}x`,
    'many hostile headings': Array.from(
      { length: 200 },
      () => `# ${EM.repeat(250)}${'#'.repeat(250)}${EM.repeat(250)}x`
    ).join('\n'),
    'long run of blank lines with spaces': `a${'\n '.repeat(25_000)}b`,
    'long unpunctuated sentence run': `${'. '.repeat(25_000)}x`,
  };

  it.each(Object.keys(cases))('%s', (name) => {
    const t0 = performance.now();
    chunkText(cases[name]);
    expect(performance.now() - t0).toBeLessThan(200);
  });

  it('keeps the heading semantics of normal Markdown', () => {
    const out = chunkText(
      '# Título ##\n\ncorpo\n\n####### não é título\n\n###### Fundo\n\nx\n\n#semespaco\n\n#\ttab\n\ny'
    );
    expect(out.map((c) => c.heading)).toEqual(['Título', 'Fundo', 'tab']);
    expect(out[0].content).toContain('####### não é título');
    expect(out[1].content).toContain('#semespaco');
    expect(out[2].content).toBe('tab\n\ny');
  });
});
