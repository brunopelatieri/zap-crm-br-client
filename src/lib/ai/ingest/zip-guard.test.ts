import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { buildZip } from './__fixtures__/build-zip';
import { IngestError } from './errors';
import {
  MAX_ZIP_UNCOMPRESSED_BYTES,
  MAX_ZIP_XML_BYTES,
  MAX_ZIP_XML_TAGS,
} from './limits';
import { assertSafeZip } from './zip-guard';

function codeOf(fn: () => void): string {
  try {
    fn();
  } catch (err) {
    if (err instanceof IngestError) return err.code;
    throw err;
  }
  return 'no error';
}

const small = (name = 'word/document.xml') => ({
  name,
  data: Buffer.from('<w:document>texto</w:document>'),
});

describe('assertSafeZip', () => {
  it('accepts the real DOCX fixture and small hand-built archives', () => {
    const real = new Uint8Array(
      fs.readFileSync(
        path.join(__dirname, '__fixtures__', 'politica-trocas.docx')
      )
    );
    expect(codeOf(() => assertSafeZip(real))).toBe('no error');
    expect(codeOf(() => assertSafeZip(buildZip([small()])))).toBe('no error');
    expect(
      codeOf(() =>
        assertSafeZip(buildZip([{ ...small(), method: 0 }, small('b.xml')]))
      )
    ).toBe('no error');
  });

  // SPEC 089 F8 (/code-review): 15 MB of document.xml passed the 40 MB total
  // and took the mammoth to 2.1 GB of RSS; 35 MB crashed a 2 GB heap.
  it('refuses XML well under the total budget but over the XML budget', () => {
    const xml = Buffer.from(
      '<w:p><w:r><w:t>a</w:t></w:r></w:p>'.repeat(
        Math.ceil((MAX_ZIP_XML_BYTES + 1024) / 34)
      )
    );
    expect(xml.byteLength).toBeLessThan(MAX_ZIP_UNCOMPRESSED_BYTES);
    expect(
      codeOf(() =>
        assertSafeZip(buildZip([{ name: 'word/document.xml', data: xml }]))
      )
    ).toBe('file_too_complex');
    // Far fewer bytes, but too many elements: memory follows the node count.
    const manyTags = Buffer.from('<w:p/>'.repeat(MAX_ZIP_XML_TAGS + 10));
    expect(manyTags.byteLength).toBeLessThan(MAX_ZIP_XML_BYTES);
    expect(
      codeOf(() =>
        assertSafeZip(buildZip([{ name: 'word/document.xml', data: manyTags }]))
      )
    ).toBe('file_too_complex');
    // XML under another name (`_rels/.rels` can point the mammoth at
    // `word/main.dat`): judged by the content, not the extension.
    for (const name of ['word/main.dat', 'word/document', 'x.bin']) {
      expect(codeOf(() => assertSafeZip(buildZip([{ name, data: xml }])))).toBe(
        'file_too_complex'
      );
    }
    // The same size of binary media (not parsed into a tree) is fine.
    const png = Buffer.alloc(xml.byteLength, 0x89);
    expect(
      codeOf(() =>
        assertSafeZip(buildZip([{ name: 'word/media/image1.png', data: png }]))
      )
    ).toBe('no error');
  });

  it('refuses a zip bomb (a few KB that inflate far past the budget)', () => {
    const bomb = buildZip([
      {
        name: 'word/document.xml',
        data: Buffer.alloc(MAX_ZIP_UNCOMPRESSED_BYTES + 1, 0x61),
      },
    ]);
    expect(bomb.byteLength).toBeLessThan(100_000);
    const t0 = performance.now();
    expect(codeOf(() => assertSafeZip(bomb))).toBe('file_too_complex');
    expect(performance.now() - t0).toBeLessThan(2000);
  });

  it('counts the budget across entries, not per entry', () => {
    const part = Buffer.alloc(1024, 0x61);
    const zip = buildZip([
      { name: 'a', data: part },
      { name: 'b', data: part },
      { name: 'c', data: part },
    ]);
    expect(codeOf(() => assertSafeZip(zip, { maxTotalBytes: 2048 }))).toBe(
      'file_too_complex'
    );
    expect(codeOf(() => assertSafeZip(zip, { maxTotalBytes: 3072 }))).toBe(
      'no error'
    );
  });

  it('does not trust the sizes declared in the archive', () => {
    const lying = buildZip([
      {
        name: 'word/document.xml',
        data: Buffer.alloc(5000, 0x61),
        declaredSize: 10,
      },
    ]);
    expect(codeOf(() => assertSafeZip(lying, { maxTotalBytes: 1000 }))).toBe(
      'file_too_complex'
    );
  });

  it('counts stored (method 0) entries too', () => {
    const zip = buildZip([
      { name: 'a', data: Buffer.alloc(5000, 0x61), method: 0 },
    ]);
    expect(codeOf(() => assertSafeZip(zip, { maxTotalBytes: 1000 }))).toBe(
      'file_too_complex'
    );
  });

  it('refuses too many entries', () => {
    const zip = buildZip(
      Array.from({ length: 30 }, (_, i) => ({
        name: `f${i}`,
        data: Buffer.from('x'),
      }))
    );
    expect(codeOf(() => assertSafeZip(zip, { maxEntries: 29 }))).toBe(
      'file_too_complex'
    );
    expect(codeOf(() => assertSafeZip(zip, { maxEntries: 30 }))).toBe(
      'no error'
    );
  });

  it('refuses ZIP64', () => {
    expect(
      codeOf(() => assertSafeZip(buildZip([small()], { zip64Marker: true })))
    ).toBe('file_too_complex');
  });

  it('refuses encrypted entries as unreadable', () => {
    expect(
      codeOf(() => assertSafeZip(buildZip([{ ...small(), flags: 1 }])))
    ).toBe('file_corrupt');
  });

  it('refuses malformed archives', () => {
    const good = buildZip([small()]);
    expect(
      codeOf(() => assertSafeZip(new Uint8Array([0x50, 0x4b, 3, 4])))
    ).toBe('file_corrupt');
    expect(codeOf(() => assertSafeZip(good.slice(0, good.length - 5)))).toBe(
      'file_corrupt'
    );
    expect(codeOf(() => assertSafeZip(good.slice(0, 40)))).toBe('file_corrupt');
    expect(
      codeOf(() => assertSafeZip(buildZip([{ ...small(), centralMethod: 99 }])))
    ).toBe('file_corrupt');
    // Corpo "deflate" que não é deflate.
    expect(
      codeOf(() =>
        assertSafeZip(
          buildZip([
            {
              name: 'a',
              data: Buffer.from('não é deflate'),
              method: 0,
              centralMethod: 8,
            },
          ])
        )
      )
    ).toBe('file_corrupt');
  });

  it('reads the LAST end-of-directory record, like the unzipper does (no fake EOCD in the comment)', () => {
    // Um EOCD falso no comentário, apontando para um "diretório" inválido. O
    // `jszip` lê a ÚLTIMA assinatura (a falsa); a guarda tem de ler a mesma e
    // por isso recusa. Se lesse a verdadeira (válida), aprovaria um arquivo
    // que o `mammoth` leria de outro jeito.
    const fake = Buffer.alloc(22);
    fake.writeUInt32LE(0x06054b50, 0);
    fake.writeUInt16LE(1, 8);
    fake.writeUInt16LE(1, 10);
    fake.writeUInt32LE(46, 12);
    const zip = buildZip([small()], { comment: fake });
    expect(codeOf(() => assertSafeZip(buildZip([small()])))).toBe('no error');
    expect(codeOf(() => assertSafeZip(zip))).toBe('file_corrupt');
  });
});
