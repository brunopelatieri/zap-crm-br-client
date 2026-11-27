import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

import { buildBlankPdf } from './__fixtures__/build-pdf';
import { buildZip } from './__fixtures__/build-zip';
import { IngestError } from './errors';
import {
  csvToText,
  decodeText,
  extractFileText,
  extractPdfText,
  fileExtension,
  parseCsv,
} from './extract-file';
import {
  MAX_DOCUMENT_CHARS,
  MAX_FILE_BYTES,
  MAX_PDF_PAGES,
  MAX_ZIP_UNCOMPRESSED_BYTES,
} from './limits';

// PDF e DOCX de VERDADE (não texto inventado): o PDF foi impresso pelo
// Edge headless (fonte TrueType embutida, como um PDF comum), o DOCX saiu
// do pacote `docx`, `digitalizado.pdf` é uma página só com imagem (sem
// camada de texto) e `protegido.pdf` é o mesmo PDF cifrado com senha
// (AES-256). Os quatro vivem em `__fixtures__/`.
const fixture = (name: string) =>
  new Uint8Array(fs.readFileSync(path.join(__dirname, '__fixtures__', name)));

const utf8 = (text: string) => new TextEncoder().encode(text);

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof IngestError) return err.code;
    throw err;
  }
  return 'no error';
}

describe('extractFileText — PDF', () => {
  it('extracts the text of a real PDF, with accents and every section', async () => {
    const out = await extractFileText({
      name: 'politica-trocas.pdf',
      bytes: fixture('politica-trocas.pdf'),
    });
    expect(out.mimeType).toBe('application/pdf');
    expect(out.title).toBe('politica-trocas');
    expect(out.text).toContain('Política de Trocas e Devoluções');
    expect(out.text).toContain('O prazo para troca é de 7 dias corridos');
    expect(out.text).toContain('Plano Básico: R$ 129,00 por mês');
    expect(out.text).toContain('Calça R$ 149,90');
  });

  it('reports a scanned (image-only) PDF as empty_text, without OCR', async () => {
    expect(
      await codeOf(
        extractFileText({
          name: 'digitalizado.pdf',
          bytes: fixture('digitalizado.pdf'),
        })
      )
    ).toBe('empty_text');
  });

  it('reports a password-protected PDF as pdf_encrypted', async () => {
    expect(
      await codeOf(
        extractFileText({
          name: 'protegido.pdf',
          bytes: fixture('protegido.pdf'),
        })
      )
    ).toBe('pdf_encrypted');
  });

  it('rejects a .pdf that does not start with the PDF signature', async () => {
    expect(
      await codeOf(
        extractFileText({ name: 'falso.pdf', bytes: utf8('isto é texto') })
      )
    ).toBe('file_corrupt');
  });

  it('rejects a truncated PDF as file_corrupt', async () => {
    const bytes = fixture('politica-trocas.pdf').slice(0, 400);
    expect(await codeOf(extractFileText({ name: 'a.pdf', bytes }))).toBe(
      'file_corrupt'
    );
  });
});

describe('extractFileText — DOCX', () => {
  it('extracts a real DOCX keeping headings, bullets and table rows', async () => {
    const out = await extractFileText({
      name: 'politica-trocas.docx',
      bytes: fixture('politica-trocas.docx'),
    });
    expect(out.mimeType).toContain('wordprocessingml');
    // Títulos viram `#` (o fatiador os usa como título da seção, D-12).
    expect(out.text).toContain('# Política de Trocas e Devoluções');
    expect(out.text).toContain('## Frete');
    expect(out.text).toContain('- Plano Básico: R$ 129,00 por mês');
    // A tabela mantém uma linha por linha, células separadas por " | ".
    expect(out.text).toContain('Produto | Preço');
    expect(out.text).toContain('Calça | R$ 149,90');
  });

  it('rejects a .docx that is not a ZIP', async () => {
    expect(
      await codeOf(extractFileText({ name: 'x.docx', bytes: utf8('texto') }))
    ).toBe('file_corrupt');
  });

  it('rejects a ZIP that is not a DOCX', async () => {
    const zipLike = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4, 5, 6]);
    expect(
      await codeOf(extractFileText({ name: 'x.docx', bytes: zipLike }))
    ).toBe('file_corrupt');
  });
});

describe('extractFileText — text formats', () => {
  it('reads TXT and uses the file name as the title', async () => {
    const out = await extractFileText({
      name: 'horarios.txt',
      bytes: utf8('Atendemos de segunda a sexta.'),
    });
    expect(out).toMatchObject({
      title: 'horarios',
      text: 'Atendemos de segunda a sexta.',
      mimeType: 'text/plain',
    });
  });

  it('takes the Markdown title from the first # heading', async () => {
    const out = await extractFileText({
      name: 'guia.md',
      bytes: utf8('Intro\n\n# Guia de Uso\n\nTexto.'),
    });
    expect(out.title).toBe('Guia de Uso');
    expect(out.mimeType).toBe('text/markdown');
  });

  it('decodes a Windows-1252 file (the Excel CSV case) without turning accents into garbage', async () => {
    // "Preço;Descrição" em Windows-1252: ç = 0xE7, ã = 0xE3.
    const bytes = new Uint8Array([
      ...utf8('Produto;Pre'),
      0xe7,
      ...utf8('o\nCalça;'),
      ...utf8('59,90'),
    ]);
    expect(decodeText(bytes)).toContain('Preço');
    const out = await extractFileText({ name: 'tabela.csv', bytes });
    expect(out.text).toContain('Preço: 59,90');
  });

  it('strips a UTF-8 BOM', () => {
    expect(decodeText(new Uint8Array([0xef, 0xbb, 0xbf, ...utf8('oi')]))).toBe(
      'oi'
    );
  });

  it('decodes UTF-16 text with a BOM (Notepad "Unicode") instead of calling it binary', async () => {
    const utf16le = new Uint8Array([
      0xff,
      0xfe,
      ...Array.from('Preço R$ 59').flatMap((c) => [c.charCodeAt(0), 0]),
    ]);
    const out = await extractFileText({ name: 'a.txt', bytes: utf16le });
    expect(out.text).toBe('Preço R$ 59');
  });

  it('rejects a binary file with a text extension', async () => {
    expect(
      await codeOf(
        extractFileText({
          name: 'x.txt',
          bytes: new Uint8Array([1, 2, 0, 3, 4]),
        })
      )
    ).toBe('file_corrupt');
  });

  it('reports empty text', async () => {
    expect(
      await codeOf(
        extractFileText({ name: 'vazio.txt', bytes: utf8('  \n\n ') })
      )
    ).toBe('empty_text');
  });
});

describe('CSV', () => {
  it('detects ; and turns each row into self-explanatory text', () => {
    expect(csvToText('Produto;Preço\nCamiseta;R$ 59,90\nCalça;R$ 149,90')).toBe(
      'Produto: Camiseta; Preço: R$ 59,90\nProduto: Calça; Preço: R$ 149,90'
    );
  });

  it('handles quotes, escaped quotes, delimiters and line breaks inside a field', () => {
    const rows = parseCsv(
      'nome,obs\n"Silva, João","disse ""oi""\ntchau"\nAna,ok'
    );
    expect(rows).toEqual([
      ['nome', 'obs'],
      ['Silva, João', 'disse "oi"\ntchau'],
      ['Ana', 'ok'],
    ]);
  });

  it('skips empty cells and blank rows, and names missing headers', () => {
    expect(csvToText('a,b\n1,\n\n,\n3,4')).toBe('a: 1\na: 3; b: 4');
    expect(csvToText('a\n1,2')).toBe('a: 1; Col 2: 2');
  });

  it('keeps a header-only or single-column file readable', () => {
    expect(csvToText('só,cabeçalho')).toBe('só; cabeçalho');
    expect(csvToText('')).toBe('');
  });
});

describe('extractFileText — limits and types', () => {
  it('refuses an unsupported extension', async () => {
    expect(
      await codeOf(extractFileText({ name: 'planilha.xlsx', bytes: utf8('x') }))
    ).toBe('unsupported_type');
    expect(
      await codeOf(extractFileText({ name: 'semextensao', bytes: utf8('x') }))
    ).toBe('unsupported_type');
  });

  it('refuses a file over 10 MB before reading it', async () => {
    const big = new Uint8Array(MAX_FILE_BYTES + 1);
    expect(await codeOf(extractFileText({ name: 'a.txt', bytes: big }))).toBe(
      'file_too_large'
    );
  });

  it('refuses text over 500k characters even when the file is under 10 MB', async () => {
    const text = 'a '.repeat(1_500_000);
    expect(
      await codeOf(extractFileText({ name: 'a.txt', bytes: utf8(text) }))
    ).toBe('text_too_long');
  });

  it('accepts text exactly at the 500k character limit', async () => {
    const text = 'x'.repeat(MAX_DOCUMENT_CHARS);
    const out = await extractFileText({ name: 'a.txt', bytes: utf8(text) });
    expect(out.text).toHaveLength(MAX_DOCUMENT_CHARS);
  });

  it('is case-insensitive about the extension', () => {
    expect(fileExtension('Manual.PDF')).toBe('pdf');
    expect(fileExtension('a.tar.gz')).toBe('gz');
    expect(fileExtension('nome')).toBe('');
  });
});

describe('extractFileText — DOCX zip bomb', () => {
  it('refuses a small DOCX that inflates past the budget, before the converter runs', async () => {
    const bomb = buildZip([
      {
        name: 'word/document.xml',
        data: Buffer.alloc(MAX_ZIP_UNCOMPRESSED_BYTES + 1024, 0x61),
      },
    ]);
    expect(bomb.byteLength).toBeLessThan(200_000);
    const t0 = performance.now();
    expect(
      await codeOf(extractFileText({ name: 'bomba.docx', bytes: bomb }))
    ).toBe('file_too_complex');
    expect(performance.now() - t0).toBeLessThan(3000);
  });

  it('refuses a DOCX with a lying declared size and too many entries', async () => {
    const many = buildZip(
      Array.from({ length: 2_001 }, (_, i) => ({
        name: `f${i}`,
        data: Buffer.from('x'),
      }))
    );
    expect(await codeOf(extractFileText({ name: 'a.docx', bytes: many }))).toBe(
      'file_too_complex'
    );
  });

  it('still reads the real DOCX fixture through the guard', async () => {
    const out = await extractFileText({
      name: 'politica-trocas.docx',
      bytes: fixture('politica-trocas.docx'),
    });
    expect(out.text).toContain('# Política de Trocas e Devoluções');
  });
});

describe('extractFileText — hostile Markdown runs in linear time', () => {
  const EM = String.fromCharCode(0x2003);
  const hostile = [
    `# ${EM.repeat(12_000)}${'#'.repeat(12_000)}${EM.repeat(12_000)}x`,
    `# ${EM.repeat(50_000)}`,
    `# ${'#'.repeat(50_000)}`,
    `# ${'# '.repeat(25_000)}x`,
  ];

  it.each(hostile.map((h, i) => [i, h] as const))(
    'case %i stays under 200 ms',
    async (_i, md) => {
      const t0 = performance.now();
      await codeOf(extractFileText({ name: 'a.md', bytes: utf8(md) }));
      expect(performance.now() - t0).toBeLessThan(200);
    }
  );

  it('normalizes Unicode spaces in the extracted text', async () => {
    const out = await extractFileText({
      name: 'a.txt',
      bytes: utf8(`a${EM}${EM}b\u00a0\u00a0c`),
    });
    expect(out.text).toBe('a b c');
  });

  it('keeps the Markdown title behaviour for normal files', async () => {
    const title = async (md: string) =>
      (await extractFileText({ name: 'doc.md', bytes: utf8(md) })).title;
    expect(await title('texto\n\n# Guia ##\n\n## Outro')).toBe('Guia');
    expect(await title('## só h2\n\ntexto')).toBe('doc');
    expect(await title('#semespaco\n\ntexto')).toBe('doc');
  });
});

describe('extractPdfText — pathological PDFs', () => {
  it('refuses a PDF over the page cap with file_too_complex', async () => {
    const pdf = buildBlankPdf(MAX_PDF_PAGES + 1);
    expect(await codeOf(extractPdfText(pdf))).toBe('file_too_complex');
    expect(await codeOf(extractFileText({ name: 'a.pdf', bytes: pdf }))).toBe(
      'file_too_complex'
    );
  });

  it('accepts a PDF at the page cap (blank pages are reported as empty text)', async () => {
    expect(
      await codeOf(
        extractFileText({ name: 'a.pdf', bytes: buildBlankPdf(MAX_PDF_PAGES) })
      )
    ).toBe('empty_text');
  });

  it('stops as soon as the accumulated text passes the limit (text_too_long)', async () => {
    const bytes = fixture('politica-trocas.pdf');
    expect(await codeOf(extractPdfText(bytes, { maxChars: 20 }))).toBe(
      'text_too_long'
    );
  });

  it('stops at the deadline, checked between pages (file_too_complex)', async () => {
    const bytes = fixture('politica-trocas.pdf');
    expect(await codeOf(extractPdfText(bytes, { timeoutMs: -1 }))).toBe(
      'file_too_complex'
    );
  });

  it('reads the real PDF page by page with the default limits', async () => {
    const text = await extractPdfText(fixture('politica-trocas.pdf'));
    expect(text).toContain('Política de Trocas e Devoluções');
  });
});
