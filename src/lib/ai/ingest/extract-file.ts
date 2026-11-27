import { IngestError } from './errors';
import { htmlToText } from './html-to-text';
import {
  ACCEPTED_FILE_EXTENSIONS,
  MAX_DOCUMENT_CHARS,
  MAX_FILE_BYTES,
  MAX_PDF_PAGES,
  PDF_EXTRACT_TIMEOUT_MS,
  type AcceptedFileExtension,
} from './limits';
import type { ExtractedText } from './extract-url';
import { parseMarkdownHeading } from './markdown-heading';
import { assertSafeZip } from './zip-guard';

// ============================================================
// Arquivo → texto puro (SPEC 089 D-7). PDF (`unpdf`), DOCX (`mammoth`),
// TXT, MD e CSV. Só o texto é guardado; o arquivo original não sai da
// memória da requisição.
//
// O tipo é decidido pela EXTENSÃO e conferido pelos primeiros bytes (um
// `.pdf` que não começa em `%PDF-` não é PDF): o `Content-Type` que o
// navegador manda é inconsistente (CSV vem como `application/vnd.ms-excel`
// no Windows, MD como vazio) e, de qualquer modo, vem do cliente.
//
// Sem OCR: PDF só de imagem devolve texto vazio → `empty_text`.
// ============================================================

const MIME_BY_EXTENSION: Record<AcceptedFileExtension, string> = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  txt: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
};

export function fileExtension(name: string): string {
  const m = /\.([a-z0-9]+)$/i.exec(name.trim());
  return m ? m[1].toLowerCase() : '';
}

function stripExtension(name: string): string {
  return name.replace(/\.[a-z0-9]+$/i, '').trim();
}

function startsWith(bytes: Uint8Array, signature: number[]): boolean {
  return signature.every((b, i) => bytes[i] === b);
}

function hasUtf16Bom(bytes: Uint8Array): boolean {
  return (
    (bytes[0] === 0xff && bytes[1] === 0xfe) ||
    (bytes[0] === 0xfe && bytes[1] === 0xff)
  );
}

/** UTF-8; se os bytes não forem UTF-8 válido (CSV do Excel em Windows-1252), Windows-1252. */
export function decodeText(bytes: Uint8Array): string {
  // UTF-16 com BOM (o "Unicode" do Bloco de Notas): tem bytes NUL por
  // natureza, então é decidido ANTES do teste de arquivo binário.
  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder('utf-16le').decode(bytes.subarray(2));
  }
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    return new TextDecoder('utf-16be').decode(bytes.subarray(2));
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    text = new TextDecoder('windows-1252').decode(bytes);
  }
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

// ------------------------------------------------------------
// CSV → linhas legíveis: "Coluna: valor; Coluna: valor"
// ------------------------------------------------------------

function detectDelimiter(firstLines: string): string {
  const candidates = [';', ',', '\t', '|'];
  let best = ',';
  let bestCount = -1;
  for (const d of candidates) {
    const count = firstLines.split(d).length - 1;
    if (count > bestCount) {
      best = d;
      bestCount = count;
    }
  }
  return best;
}

/** Parser de CSV (aspas, aspas duplas escapadas e quebra de linha dentro de campo). */
export function parseCsv(text: string): string[][] {
  const delimiter = detectDelimiter(
    text.slice(0, 2000).split('\n').slice(0, 5).join('\n')
  );
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;

  const endField = () => {
    row.push(field);
    field = '';
  };
  const endRow = () => {
    endField();
    if (row.some((c) => c.trim() !== '')) rows.push(row);
    row = [];
  };

  const src = text.replace(/\r\n?/g, '\n');
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"' && field === '') {
      quoted = true;
    } else if (ch === delimiter) {
      endField();
    } else if (ch === '\n') {
      endRow();
    } else {
      field += ch;
    }
  }
  if (field !== '' || row.length > 0) endRow();
  return rows;
}

/**
 * Cada linha vira uma frase que se explica sozinha ("Produto: Camiseta;
 * Preço: R$ 59,90"): uma fatia que traga só a linha ainda diz o que é cada
 * valor. Com uma coluna só, devolve os valores um por linha.
 */
export function csvToText(text: string): string {
  const rows = parseCsv(text);
  if (rows.length === 0) return '';
  if (rows.length === 1) return rows[0].map((c) => c.trim()).join('; ');
  const [header, ...data] = rows;
  const names = header.map((h) => h.trim());
  return data
    .map((cells) =>
      cells
        .map((c, i) => [names[i] || `Col ${i + 1}`, c.trim()] as const)
        .filter(([, v]) => v !== '')
        .map(([k, v]) => `${k}: ${v}`)
        .join('; ')
    )
    .filter(Boolean)
    .join('\n');
}

// ------------------------------------------------------------
// PDF e DOCX
// ------------------------------------------------------------

export interface PdfLimits {
  maxPages?: number;
  maxChars?: number;
  timeoutMs?: number;
}

/**
 * Texto de um PDF, página a página (não `extractText({ mergePages })`: um PDF
 * de 61 KB com 20 páginas apontando para um stream de 20 MB custava 63 s de
 * CPU sem chance de parar no meio). Teto de páginas, parada assim que o texto
 * acumulado passa do limite do documento e prazo total conferido entre
 * páginas (o pdf.js roda no mesmo thread: não dá para interromper no meio de
 * uma página, por isso o prazo só vale entre elas).
 */
export async function extractPdfText(
  bytes: Uint8Array,
  limits: PdfLimits = {}
): Promise<string> {
  const maxPages = limits.maxPages ?? MAX_PDF_PAGES;
  const maxChars = limits.maxChars ?? MAX_DOCUMENT_CHARS;
  const timeoutMs = limits.timeoutMs ?? PDF_EXTRACT_TIMEOUT_MS;
  const { getDocumentProxy } = await import('unpdf');
  const startedAt = Date.now();
  let pdf: Awaited<ReturnType<typeof getDocumentProxy>> | null = null;
  try {
    // Cópia: o pdf.js assume a posse do buffer e o zera.
    pdf = await getDocumentProxy(new Uint8Array(bytes));
    if (pdf.numPages > maxPages) {
      throw new IngestError(
        'file_too_complex',
        `The PDF has more than ${maxPages} pages.`
      );
    }
    const pages: string[] = [];
    let chars = 0;
    for (let n = 1; n <= pdf.numPages; n++) {
      if (Date.now() - startedAt > timeoutMs) {
        throw new IngestError(
          'file_too_complex',
          'The PDF took too long to process.'
        );
      }
      const page = await pdf.getPage(n);
      const content = await page.getTextContent();
      page.cleanup();
      const text = content.items
        .map((item) =>
          'str' in item && item.str != null
            ? item.str + (item.hasEOL ? '\n' : '')
            : ''
        )
        .join('');
      pages.push(text);
      chars += text.length + 1;
      if (chars > maxChars) {
        throw new IngestError(
          'text_too_long',
          'The text is over 500,000 characters.'
        );
      }
    }
    return pages.join('\n');
  } catch (err) {
    if (err instanceof IngestError) throw err;
    const name = (err as { name?: string } | null)?.name ?? '';
    if (name === 'PasswordException') {
      throw new IngestError('pdf_encrypted', 'This PDF is password-protected.');
    }
    throw new IngestError('file_corrupt', 'The PDF could not be read.');
  } finally {
    await pdf?.loadingTask.destroy().catch(() => {});
  }
}

async function extractDocx(
  bytes: Uint8Array
): Promise<{ title: string | null; text: string }> {
  // ZIP bomba: confere o que o arquivo vira DESCOMPACTADO antes de entregar
  // ao `mammoth` (que descompacta sem teto).
  assertSafeZip(bytes);
  const mammoth = await import('mammoth');
  try {
    // `convertToHtml` (e não `extractRawText`) preserva títulos, lista e
    // tabela; o mesmo conversor da página por URL fecha o texto (F0 §2).
    const { value } = await mammoth.convertToHtml(
      { buffer: Buffer.from(bytes) },
      {
        // Imagens não viram texto: sem isto cada uma entra no HTML como
        // data URI em base64 e um DOCX cheio de fotos infla a memória à toa.
        convertImage: mammoth.images.imgElement(() =>
          Promise.resolve({ src: '' })
        ),
      }
    );
    const { text } = htmlToText(value);
    return { title: null, text };
  } catch {
    throw new IngestError('file_corrupt', 'The DOCX could not be read.');
  }
}

/** Normaliza o texto extraído: quebras, espaços e linhas em branco em excesso. */
function tidy(text: string): string {
  return (
    text
      .replace(/\r\n?/g, '\n')
      .replace(/\x00/g, '')
      .split('\n')
      // `[^\S\n]` = qualquer espaço Unicode (U+2003, U+00A0…) menos a quebra.
      .map((l) => l.replace(/[^\S\n]+/g, ' ').trim())
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  );
}

export interface FileInput {
  name: string;
  bytes: Uint8Array;
}

export async function extractFileText(file: FileInput): Promise<ExtractedText> {
  if (file.bytes.byteLength > MAX_FILE_BYTES) {
    throw new IngestError('file_too_large', 'The file is larger than 10 MB.');
  }
  const ext = fileExtension(file.name);
  if (!(ACCEPTED_FILE_EXTENSIONS as readonly string[]).includes(ext)) {
    throw new IngestError(
      'unsupported_type',
      'Only PDF, DOCX, TXT, MD and CSV files are accepted.'
    );
  }
  const kind = ext as AcceptedFileExtension;
  const fallbackTitle = stripExtension(file.name) || null;

  let raw: string;
  let title: string | null = fallbackTitle;

  if (kind === 'pdf') {
    if (!startsWith(file.bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) {
      throw new IngestError('file_corrupt', 'The file is not a valid PDF.');
    }
    raw = await extractPdfText(file.bytes);
  } else if (kind === 'docx') {
    // DOCX é um ZIP: assinatura `PK\x03\x04`.
    if (!startsWith(file.bytes, [0x50, 0x4b, 0x03, 0x04])) {
      throw new IngestError('file_corrupt', 'The file is not a valid DOCX.');
    }
    raw = (await extractDocx(file.bytes)).text;
  } else {
    // Texto: um arquivo com NUL é binário disfarçado.
    if (!hasUtf16Bom(file.bytes) && file.bytes.subarray(0, 4096).includes(0)) {
      throw new IngestError('file_corrupt', 'The file is not a text file.');
    }
    const decoded = decodeText(file.bytes);
    raw = kind === 'csv' ? csvToText(decoded) : decoded;
  }

  const text = tidy(raw);
  if (!text) {
    throw new IngestError(
      'empty_text',
      kind === 'pdf'
        ? 'No text found in this PDF (scanned or image-only PDFs are not supported).'
        : 'The file has no readable text.'
    );
  }
  if (text.length > MAX_DOCUMENT_CHARS) {
    throw new IngestError(
      'text_too_long',
      'The text is over 500,000 characters.'
    );
  }
  if (kind === 'md') {
    // Título do documento Markdown: o primeiro `# Título`, se houver.
    // Sem regex com retrocesso (ReDoS cúbico): ver `markdown-heading.ts`.
    for (const line of text.split('\n')) {
      const heading = parseMarkdownHeading(line);
      if (heading?.level === 1 && heading.text) {
        title = heading.text;
        break;
      }
    }
  }

  return { title, text, mimeType: MIME_BY_EXTENSION[kind] };
}
