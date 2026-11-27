import { inflateRawSync } from 'node:zlib';

import { IngestError } from './errors';
import {
  MAX_ZIP_ENTRIES,
  MAX_ZIP_UNCOMPRESSED_BYTES,
  MAX_ZIP_XML_BYTES,
  MAX_ZIP_XML_TAGS,
} from './limits';

// ============================================================
// Guarda de ZIP antes do `mammoth` (DOCX é um ZIP).
//
// Um ZIP bomba (poucos KB que inflam para gigabytes) derrubava o Node por
// falta de memória: o `mammoth` descompactava sem teto e o limite de 500 mil
// caracteres só era conferido DEPOIS. Aqui o diretório central é lido à mão e
// CADA entrada é inflada de verdade, com `maxOutputLength` = o que resta de um
// orçamento TOTAL; o tamanho declarado no ZIP não é confiado (ele é só uma
// informação do arquivo, e quem o fabrica mente). Se o orçamento cabe, o que
// o `mammoth` for descompactar depois cabe também: todas as entradas do
// diretório já foram infladas dentro do orçamento (entradas sobrepostas
// pagam duas vezes).
//
// Lê o EOCD como o `jszip` (a ÚLTIMA assinatura do arquivo): um EOCD falso
// escondido no comentário não faz esta guarda ver um diretório e o `mammoth`
// outro. Não suporta ZIP64 (um DOCX de até 10 MB nunca precisa) nem entrada
// cifrada.
//
//   - ZIP malformado, método desconhecido, entrada cifrada → `file_corrupt`;
//   - ZIP64, entradas demais ou orçamento estourado → `file_too_complex`.
// ============================================================

const SIG_EOCD = 0x06054b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;
const EOCD_MIN = 22;

export interface ZipGuardLimits {
  maxTotalBytes?: number;
  maxEntries?: number;
  /** Teto só das entradas XML (`.xml`, `.rels`): ver `MAX_ZIP_XML_BYTES`. */
  maxXmlBytes?: number;
  /** Tags (`<`) somadas nas entradas XML: ver `MAX_ZIP_XML_TAGS`. */
  maxXmlTags?: number;
}

/** Quantos `<` há no buffer (linear; um `indexOf` nativo por tag). */
function countTags(buf: Uint8Array): number {
  let n = 0;
  let i = buf.indexOf(0x3c);
  while (i >= 0) {
    n++;
    i = buf.indexOf(0x3c, i + 1);
  }
  return n;
}

/**
 * Entrada que o `mammoth` pode ler como XML (e transformar em árvore na
 * memória). Pelo CONTEÚDO, não só pelo nome: o `mammoth` segue o `Target` do
 * `_rels/.rels`, que pode apontar para `word/main.dat` (achado da revisão
 * adversarial da F8: um `.dat` com 30 MB de XML passava pelo teto de XML).
 * XML é o que, depois de BOM e espaços, começa com `<`.
 */
function isXmlEntry(name: string, content: Uint8Array | null): boolean {
  const lower = name.toLowerCase();
  if (lower.endsWith('.xml') || lower.endsWith('.rels')) return true;
  if (!content) return false;
  let i = 0;
  // BOM UTF-8.
  if (content[0] === 0xef && content[1] === 0xbb && content[2] === 0xbf) i = 3;
  while (
    i < content.length &&
    (content[i] === 0x20 ||
      content[i] === 0x09 ||
      content[i] === 0x0a ||
      content[i] === 0x0d)
  ) {
    i++;
  }
  return content[i] === 0x3c;
}

const corrupt = () =>
  new IngestError('file_corrupt', 'The DOCX could not be read.');
const tooComplex = () =>
  new IngestError(
    'file_too_complex',
    'The file is too complex to process (it expands too much).'
  );

/** Lança `IngestError` se o ZIP for malformado ou expandir além do orçamento. */
export function assertSafeZip(
  bytes: Uint8Array,
  limits: ZipGuardLimits = {}
): void {
  const maxTotal = limits.maxTotalBytes ?? MAX_ZIP_UNCOMPRESSED_BYTES;
  const maxEntries = limits.maxEntries ?? MAX_ZIP_ENTRIES;
  let xmlRemaining = limits.maxXmlBytes ?? MAX_ZIP_XML_BYTES;
  let tagsRemaining = limits.maxXmlTags ?? MAX_ZIP_XML_TAGS;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const len = bytes.byteLength;

  // EOCD: a última assinatura (o comentário vem depois e tem até 65 535 bytes).
  let eocd = -1;
  for (let p = len - EOCD_MIN; p >= Math.max(0, len - EOCD_MIN - 0xffff); p--) {
    if (view.getUint32(p, true) === SIG_EOCD) {
      eocd = p;
      break;
    }
  }
  if (eocd < 0) throw corrupt();
  if (eocd + EOCD_MIN + view.getUint16(eocd + 20, true) !== len) {
    throw corrupt(); // o comentário não vai até o fim: EOCD falso ou truncado
  }

  const diskNumber = view.getUint16(eocd + 4, true);
  const cdDisk = view.getUint16(eocd + 6, true);
  const entriesOnDisk = view.getUint16(eocd + 8, true);
  const totalEntries = view.getUint16(eocd + 10, true);
  const cdSize = view.getUint32(eocd + 12, true);
  const cdOffset = view.getUint32(eocd + 16, true);

  if (
    totalEntries === 0xffff ||
    cdSize === 0xffffffff ||
    cdOffset === 0xffffffff
  ) {
    throw tooComplex(); // ZIP64
  }
  if (diskNumber !== 0 || cdDisk !== 0 || entriesOnDisk !== totalEntries) {
    throw corrupt(); // arquivo em vários volumes
  }
  if (totalEntries > maxEntries) throw tooComplex();
  if (cdOffset + cdSize > eocd) throw corrupt();

  let remaining = maxTotal;
  let p = cdOffset;
  for (let n = 0; n < totalEntries; n++) {
    if (p + 46 > cdOffset + cdSize || view.getUint32(p, true) !== SIG_CENTRAL) {
      throw corrupt();
    }
    const flags = view.getUint16(p + 8, true);
    const method = view.getUint16(p + 10, true);
    const compSize = view.getUint32(p + 20, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const localOffset = view.getUint32(p + 42, true);
    const nameStart = p + 46;
    p += 46 + nameLen + extraLen + commentLen;
    if (p > cdOffset + cdSize) throw corrupt();
    const entryName = new TextDecoder('latin1').decode(
      bytes.subarray(nameStart, nameStart + nameLen)
    );
    // Pelo nome já se sabe antes de inflar; pelo conteúdo, só depois.
    const xmlByName = isXmlEntry(entryName, null);

    if (compSize === 0xffffffff || localOffset === 0xffffffff) {
      throw tooComplex(); // ZIP64
    }
    if ((flags & 0x1) !== 0) throw corrupt(); // cifrada

    if (localOffset + 30 > cdOffset) throw corrupt();
    if (view.getUint32(localOffset, true) !== SIG_LOCAL) throw corrupt();
    const dataStart =
      localOffset +
      30 +
      view.getUint16(localOffset + 26, true) +
      view.getUint16(localOffset + 28, true);
    const dataEnd = dataStart + compSize;
    if (dataEnd > cdOffset) throw corrupt();

    // Entrada XML: o teto é o menor entre o que resta do total e do XML.
    const budget = xmlByName ? Math.min(remaining, xmlRemaining) : remaining;
    let size: number;
    let content: Uint8Array | null = null;
    if (method === 0) {
      // Armazenado: o conteúdo É os bytes que estão no arquivo.
      size = compSize;
      if (size > budget) throw tooComplex();
      content = bytes.subarray(dataStart, dataEnd);
    } else if (method === 8) {
      try {
        const out = inflateRawSync(bytes.subarray(dataStart, dataEnd), {
          // O zlib lança `ERR_BUFFER_TOO_LARGE` assim que a saída passa do teto.
          maxOutputLength: Math.max(1, budget),
        });
        size = out.byteLength;
        content = out;
      } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code === 'ERR_BUFFER_TOO_LARGE') {
          throw tooComplex();
        }
        throw corrupt();
      }
      if (size > budget) throw tooComplex();
    } else {
      throw corrupt();
    }
    remaining -= size;
    const xml = xmlByName || isXmlEntry(entryName, content);
    if (xml) {
      xmlRemaining -= size;
      if (xmlRemaining < 0) throw tooComplex();
      // O que pesa no `mammoth` é o número de elementos (ver `limits.ts`).
      if (content) tagsRemaining -= countTags(content);
      if (tagsRemaining < 0) throw tooComplex();
    }
  }
}
