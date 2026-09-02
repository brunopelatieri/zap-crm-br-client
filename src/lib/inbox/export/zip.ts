/**
 * Pacote `.zip` da exportação de conversa (SPEC 067 §8).
 *
 * Monta o arquivo em memória — PDF + `midias/` + `MANIFESTO.csv` +
 * `LEIA-ME.txt` — e nunca toca em disco nem em bucket: o pacote é um
 * conjunto de dados pessoais, então existe só durante a resposta (§15).
 *
 * Duas decisões que não são estéticas:
 *
 * 1. **Compressão por arquivo.** JPEG, MP4 e OGG já saem comprimidos da
 *    origem; passar deflate por cima queima CPU (e memória de buffer
 *    intermediário) para ganhar ~1%. Mídia entra com `level: 0`
 *    (armazenada), texto e PDF com `level: 6`.
 * 2. **`mtime` = `created_at` da mensagem.** Quem descompacta vê a pasta
 *    `midias/` na ordem cronológica da conversa sem precisar abrir o
 *    manifesto — de graça, porque o dado já está no plano.
 *
 *    Ressalva medida: o formato ZIP guarda data/hora no formato DOS, que
 *    **não tem fuso**, e o `fflate` converte o `Date` usando a hora
 *    LOCAL do processo. Num servidor em UTC, uma mensagem das 14:32 UTC
 *    aparece como 14:32 no gerenciador de arquivos de quem baixa, mesmo
 *    que no fuso dele fossem 11:32. A ORDEM — que é o objetivo — fica
 *    correta de qualquer jeito, e o horário exato, no fuso de quem
 *    exportou, está no `MANIFESTO.csv` (D-7).
 *
 * **Zip slip** é responsabilidade nossa e está resolvida na origem:
 * todo caminho vem de `buildMediaPlan`, que o constrói a partir de
 * índice + tipo + hex do id, sem nenhum texto do usuário no meio
 * (`media-plan.test.ts` cobre `../../etc/passwd` explicitamente).
 */

import { zipSync, type Zippable } from 'fflate';
import { buildContactsCsv } from '@/lib/contacts/export-file';
import type { FetchedMedia, MediaFetchStatus } from './fetch-media';
import type { MediaPlanEntry } from './media-plan';
import type { TranscriptBlock, TranscriptAttachment } from './model';

export const MANIFEST_FILENAME = 'MANIFESTO.csv';
export const README_FILENAME = 'LEIA-ME.txt';

/** JPEG/MP4/OGG já vêm comprimidos: deflate por cima é CPU jogada fora. */
const LEVEL_STORED = 0;
const LEVEL_TEXT = 6;

export interface ZipInput {
  pdfBytes: Uint8Array;
  /** `conversa-maria-silva-2026-09-02.pdf` */
  pdfName: string;
  plan: MediaPlanEntry[];
  media: Map<number, FetchedMedia>;
  /** CSV pronto, já com BOM — ver `buildMediaManifestCsv`. */
  manifest: string;
  readme: string;
  /** Injetável para o pacote ser reproduzível em teste. */
  now?: Date;
}

export interface ManifestLabels {
  columns: {
    file: string;
    index: string;
    dateTime: string;
    sender: string;
    type: string;
    displayName: string;
    byteSize: string;
    status: string;
    messageId: string;
  };
  types: Record<TranscriptAttachment['contentType'], string>;
  status: Record<MediaFetchStatus, string>;
  /** Formata o ISO no fuso de quem exportou (D-7). */
  formatDateTime: (iso: string) => string;
  /** Valor da coluna `arquivo` quando o item não entrou na pasta. */
  notIncluded: string;
}

export interface ReadmeLabels {
  title: string;
  contactLine: (contactName: string) => string;
  exportedByLine: (exportedBy: string) => string;
  exportIdLine: (exportId: string) => string;
  pdfLine: (pdfName: string) => string;
  mediaLine: (included: number, total: number) => string;
  manifestLine: (manifestName: string) => string;
  /** Ressalvas honestas — ver §8 da SPEC. */
  noteStickersAndVideos: string;
  noteMissingMedia: string;
  noteMonochromeEmoji: string;
  notePersonalData: string;
}

/**
 * U+FEFF, construído por código de propósito: como caractere literal
 * ele é invisível no editor e some numa cópia de código descuidada —
 * e sem ele o Excel abre `ção` como `Ã§Ã£o`.
 */
const BOM = String.fromCharCode(0xfeff);

/**
 * Manifesto que amarra cada arquivo à mensagem que o carregava.
 *
 * Devolve o CSV **com BOM** — diferente da SPEC 051, que o acrescenta na
 * rota. Aqui não há rota no meio: o valor vai direto para dentro do zip,
 * e sem o BOM o Excel abre `ção` como `Ã§Ã£o`. O dialeto é o mesmo da
 * 051 (CRLF, toda célula entre aspas), por isso reusa `buildContactsCsv`
 * em vez de reimplementar o escape.
 *
 * Toda entrada do plano vira uma linha, inclusive as duplicatas: duas
 * mensagens que encaminharam o mesmo arquivo apontam para o mesmo nome
 * em `midias/`, e é exatamente esse vínculo que o manifesto existe para
 * registrar.
 */
export function buildMediaManifestCsv(
  plan: MediaPlanEntry[],
  media: Map<number, FetchedMedia>,
  blocks: TranscriptBlock[],
  labels: ManifestLabels
): string {
  const senderByMessage = new Map<string, string>();
  for (const block of blocks) {
    if (block.kind === 'bubble') {
      senderByMessage.set(block.bubble.messageId, block.bubble.senderLabel);
    }
  }

  const { columns } = labels;
  const header = [
    columns.file,
    columns.index,
    columns.dateTime,
    columns.sender,
    columns.type,
    columns.displayName,
    columns.byteSize,
    columns.status,
    columns.messageId,
  ];

  const rows = plan.map((entry) => {
    const fetched = media.get(entry.index);
    const status = fetched?.status ?? 'skipped';
    const included = status === 'ok';
    return [
      included ? entry.zipPath : labels.notIncluded,
      String(entry.index),
      labels.formatDateTime(entry.createdAt),
      senderByMessage.get(entry.messageId) ?? '',
      labels.types[entry.contentType],
      entry.displayName,
      included ? String(fetched?.byteLength ?? 0) : '',
      labels.status[status],
      entry.messageId,
    ];
  });

  return BOM + buildContactsCsv([header, ...rows]);
}

/** Texto do `LEIA-ME.txt`, em CRLF (abre certo no Bloco de Notas). */
export function buildReadmeText(
  input: {
    contactName: string;
    exportedByLabel: string;
    exportId: string;
    pdfName: string;
    includedMediaCount: number;
    totalMediaCount: number;
  },
  labels: ReadmeLabels
): string {
  const lines = [
    labels.title,
    '',
    labels.contactLine(input.contactName),
    labels.exportedByLine(input.exportedByLabel),
    labels.exportIdLine(input.exportId),
    '',
    labels.pdfLine(input.pdfName),
    labels.mediaLine(input.includedMediaCount, input.totalMediaCount),
    labels.manifestLine(MANIFEST_FILENAME),
    '',
    labels.noteStickersAndVideos,
    labels.noteMissingMedia,
    labels.noteMonochromeEmoji,
    labels.notePersonalData,
  ];
  return lines.join('\r\n');
}

/**
 * Nome do arquivo entregue (D-10), no molde de `contactExportFilename`
 * da SPEC 051: `conversa-<contato-slug>-<AAAA-MM-DD>.<ext>`.
 */
export function conversationExportFilename(
  prefix: string,
  contactName: string,
  format: 'pdf' | 'zip',
  now: Date
): string {
  const slug = slugifyContactName(contactName);
  const isoDate = now.toISOString().slice(0, 10);
  return `${prefix}-${slug}-${isoDate}.${format}`;
}

const MAX_SLUG_LENGTH = 40;

/** Marcas de acentuação que o NFKD separa da letra base (U+0300–U+036F).
 *  Montado por `RegExp` para o range não virar caractere invisível no
 *  fonte, como aconteceria num literal `/[..]/`. */
const COMBINING_MARKS = new RegExp('[\\u0300-\\u036f]', 'g');

function slugifyContactName(name: string): string {
  const slug = name
    .normalize('NFKD')
    .replace(COMBINING_MARKS, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-+$/g, '');
  // Contato sem nome, ou nome só de emoji / alfabeto não-latino: o
  // arquivo ainda precisa de um nome utilizável.
  return slug || 'contato';
}

export function buildConversationZip(input: ZipInput): Uint8Array {
  const encoder = new TextEncoder();
  const now = input.now ?? new Date();

  const files: Zippable = {
    [input.pdfName]: [input.pdfBytes, { level: LEVEL_TEXT, mtime: now }],
    [README_FILENAME]: [
      encoder.encode(input.readme),
      { level: LEVEL_TEXT, mtime: now },
    ],
    [MANIFEST_FILENAME]: [
      encoder.encode(input.manifest),
      { level: LEVEL_TEXT, mtime: now },
    ],
  };

  for (const entry of input.plan) {
    // A duplicata compartilha o `zipPath` do original: escrever de novo
    // só sobrescreveria a mesma entrada. Ela continua no manifesto.
    if (entry.duplicateOfIndex !== null) continue;

    const fetched = input.media.get(entry.index);
    // Só `ok` vira arquivo. Ausente, grande demais ou cortado pelo teto
    // aparecem no manifesto com o motivo, e a pasta não ganha um arquivo
    // de 0 byte que o usuário abriria em vão.
    if (!fetched || fetched.status !== 'ok' || !fetched.bytes) continue;

    files[entry.zipPath] = [
      fetched.bytes,
      { level: LEVEL_STORED, mtime: new Date(entry.createdAt) },
    ];
  }

  return zipSync(files, { level: LEVEL_TEXT });
}
