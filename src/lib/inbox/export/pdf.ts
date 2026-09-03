/**
 * Render do PDF da conversa (SPEC 067 §7).
 *
 * Recebe blocos declarativos (`model.ts`), o plano de mídia
 * (`media-plan.ts`) e os bytes já baixados (`fetch-media.ts`) — não sabe
 * o que é `interactive_payload` nem como se fala com a Meta. Aqui só
 * existe geometria.
 *
 * Duas escolhas estruturais que valem explicação:
 *
 * 1. **A bolha é uma lista de linhas, não um bloco atômico.** É o que
 *    permite uma mensagem de 8 000 caracteres quebrar entre páginas
 *    continuando o corpo, em vez de estourar silenciosamente para fora
 *    da margem. Cada segmento redesenha o próprio fundo.
 * 2. **Todo texto passa por `sanitizeForPdf` + `splitRuns`.** Com fonte
 *    embutida, um caractere sem glifo não lança — vira um retângulo
 *    vazio no meio da frase (medido; ver `pdf-fonts.ts`). Sanitizar é o
 *    que impede o documento de sair com "tofu".
 */

import {
  PDFDocument,
  rgb,
  type PDFFont,
  type PDFImage,
  type PDFPage,
  type RGB,
} from 'pdf-lib';
import type { FetchedMedia } from './fetch-media';
import type { MediaPlanEntry } from './media-plan';
import type { TranscriptBlock, TranscriptBubble } from './model';
import {
  loadExportFonts,
  loadGlyphCoverage,
  textNeedsEmojiFont,
  type GlyphCoverage,
  type LoadedFonts,
} from './pdf-fonts';
import { sanitizeForPdf, splitRuns, wrapText, type Run } from './pdf-font';

// ── Geometria (pontos PostScript) ───────────────────────────────────
const PAGE_WIDTH = 595.28; // A4
const PAGE_HEIGHT = 841.89;
const MARGIN = 40;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;
const BUBBLE_MAX_WIDTH = CONTENT_WIDTH * 0.7;
const BUBBLE_PADDING = 8;
const BUBBLE_GAP = 8;
const DAY_GAP = 14;
const FOOTER_HEIGHT = 24;
const IMAGE_MAX_WIDTH = 260;
const IMAGE_MAX_HEIGHT = 320;

const SIZE_TITLE = 14;
const SIZE_HEADER = 9;
const SIZE_BODY = 10;
const SIZE_SENDER = 8;
const SIZE_META = 7;
const SIZE_FOOTER = 6;
const SIZE_DAY = 8;

const COLOR_TEXT = rgb(0.1, 0.1, 0.1);
const COLOR_MUTED = rgb(0.45, 0.45, 0.45);
const COLOR_FAINT = rgb(0.6, 0.6, 0.6);
const COLOR_ERROR = rgb(0.7, 0.15, 0.15);
const COLOR_BUBBLE_IN = rgb(0.937, 0.937, 0.937);
const COLOR_BUBBLE_OUT = rgb(0.85, 0.94, 0.83);
const COLOR_CARD_BORDER = rgb(0.72, 0.72, 0.72);
const COLOR_QUOTE_BAR = rgb(0.55, 0.6, 0.55);

export interface PdfLabels {
  documentTitle: string;
  headerContact: string;
  headerPhone: string;
  headerChannel: string;
  headerPeriod: string;
  headerCounts: string;
  headerExportedBy: string;
  headerExportId: string;
  /** `(n) => "37 anexos"` — plural resolvido pelo i18n. */
  messageCount: (n: number) => string;
  attachmentCount: (n: number) => string;
  attachmentImage: string;
  attachmentVideo: string;
  attachmentAudio: string;
  attachmentDocument: string;
  attachmentSticker: string;
  mediaMissing: string;
  mediaTooLarge: string;
  mediaSkipped: string;
  mediaError: string;
  /** Prefixo do caminho dentro do zip. Sem seta: `→` não tem glifo em
   *  nenhuma das fontes vendorizadas (medido). */
  inZip: string;
  replyPrefix: string;
  buttonPrefix: string;
  /** `(bytes) => "1,2 MB"` — formatação é locale, então vem pronta. */
  formatBytes: (bytes: number) => string;
  page: (current: number, total: number) => string;
}

export interface PdfHeaderInput {
  contactName: string;
  contactPhone: string;
  channelLabel: string;
  periodLabel: string;
  messageCount: number;
  attachmentCount: number;
  exportedByLabel: string;
  exportId: string;
  /** Nome da conta — vai para os metadados do arquivo. */
  accountName?: string;
}

export interface PdfRenderInput {
  header: PdfHeaderInput;
  blocks: TranscriptBlock[];
  plan: MediaPlanEntry[];
  media: Map<number, FetchedMedia>;
  labels: PdfLabels;
  /** false quando o formato é só PDF: sem `midias/...` nos cartões. */
  includeZipReferences: boolean;
  /** Injetável para o PDF ser reproduzível em teste. */
  now?: Date;
}

// ── Helpers puros (exportados para teste) ───────────────────────────

/**
 * Formato realmente embutível pelo `pdf-lib` — só JPEG e PNG (D-3: o
 * byte original vira o stream do PDF, sem recodificar).
 *
 * Decide pelos MAGIC BYTES, não pelo MIME: o MIME vem do bucket, da
 * Meta ou de um header de terceiro e pode mentir; `embedJpg` com bytes
 * que não são JPEG lança e derrubaria a página inteira.
 */
export function detectEmbeddableImage(
  bytes: Uint8Array | null
): 'jpeg' | 'png' | null {
  if (!bytes || bytes.length < 8) return null;
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'jpeg';
  }
  const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (PNG_SIGNATURE.every((byte, i) => bytes[i] === byte)) return 'png';
  return null;
}

const WEBP_RIFF_SIGNATURE = [0x52, 0x49, 0x46, 0x46]; // "RIFF"
const WEBP_FORMAT_SIGNATURE = [0x57, 0x45, 0x42, 0x50]; // "WEBP", offset 8

/**
 * RIFF....WEBP pelos magic bytes — o formato real dos stickers do
 * WhatsApp (nunca embutível por `detectEmbeddableImage`).
 *
 * Existe porque `messages.content_type` não distingue sticker de foto
 * comum (o webhook normaliza os dois para `'image'` na ingestão — não
 * há coluna que preserve a diferença, achado da SPEC 067). O sinal só
 * fica disponível aqui, com os bytes em mãos, depois do download —
 * antes disso (`model.ts`, ao montar o transcrito) é cedo demais para
 * saber. Sem mídia baixada (status ausente/erro), a checagem degrada
 * para "não é sticker" e o cartão sai rotulado como imagem genérica —
 * pior que o rótulo certo, melhor que o "Imagem" sempre-errado de antes.
 */
export function isWebpImage(bytes: Uint8Array | null): boolean {
  if (!bytes || bytes.length < 12) return false;
  const hasRiff = WEBP_RIFF_SIGNATURE.every((byte, i) => bytes[i] === byte);
  const hasWebp = WEBP_FORMAT_SIGNATURE.every(
    (byte, i) => bytes[8 + i] === byte
  );
  return hasRiff && hasWebp;
}

/**
 * Varre tudo que vai virar texto no documento, parando no primeiro
 * caractere que exija a fonte de emoji.
 *
 * Existe para não embutir 580 KB de `NotoEmoji` num PDF que não tem um
 * único emoji — a fonte de emoji não pode ser subsetada (ver
 * `pdf-fonts.ts`), então a alternativa a esta varredura seria pagar o
 * peso sempre.
 */
export function documentNeedsEmojiFont(
  input: PdfRenderInput,
  coverage: GlyphCoverage
): boolean {
  const needs = (value: string | null | undefined): boolean =>
    !!value && textNeedsEmojiFont(value, coverage);

  const { header, labels } = input;
  const headerTexts = [
    header.contactName,
    header.contactPhone,
    header.channelLabel,
    header.periodLabel,
    header.exportedByLabel,
    header.exportId,
    header.accountName,
  ];
  if (headerTexts.some(needs)) return true;

  // Rótulos estáticos: o i18n pode legitimamente pôr um emoji num selo
  // (⭐ favorita).
  for (const value of Object.values(labels)) {
    if (typeof value === 'string' && needs(value)) return true;
  }

  // Rótulos de FUNÇÃO (messageCount/attachmentCount/formatBytes/page):
  // ao contrário do que um comentário antigo desta função afirmava, o
  // texto que elas produzem NÃO chega pronto dentro de `blocks` — é
  // interpolado direto no cabeçalho, no cartão de anexo e no rodapé,
  // em `drawHeader`/`buildAttachmentCard`/`drawFooters`, sem nunca
  // passar por esta varredura. Sem isto, um tradutor pondo um emoji em
  // qualquer um desses quatro templates (ex.: "📎 {count} anexos")
  // reintroduz em silêncio o bug de glifo em branco que `sanitizeForPdf`
  // existe para evitar — `fonts.emoji` ficaria `null` porque a varredura
  // disse "não precisa", e o desenho cairia de volta para a fonte de
  // texto, que não tem o glifo. Os números interpolados nunca contêm
  // emoji (são dígitos/separadores do locale), então qualquer amostra
  // serve — só o texto FIXO ao redor do placeholder importa aqui.
  if (
    needs(labels.messageCount(1)) ||
    needs(labels.attachmentCount(1)) ||
    needs(labels.formatBytes(0)) ||
    needs(labels.page(1, 1))
  ) {
    return true;
  }

  for (const block of input.blocks) {
    if (block.kind === 'day') {
      if (needs(block.label)) return true;
      continue;
    }
    const b = block.bubble;
    if (
      needs(b.senderLabel) ||
      needs(b.timeLabel) ||
      needs(b.statusLabel) ||
      needs(b.errorText) ||
      b.text.some(needs) ||
      b.badges.some(needs) ||
      b.reactions.some(needs) ||
      b.buttons.some(needs) ||
      needs(b.quote?.senderLabel) ||
      needs(b.quote?.snippet) ||
      needs(b.attachment?.displayName) ||
      needs(b.attachment?.caption)
    ) {
      return true;
    }
  }

  return false;
}

/** Escala preservando proporção; nunca AMPLIA (uma miniatura de 40px
 *  esticada para 260 sairia borrada no documento). */
export function scaleToFit(
  width: number,
  height: number,
  maxWidth: number,
  maxHeight: number
): { width: number; height: number } {
  if (width <= 0 || height <= 0) return { width: 0, height: 0 };
  const ratio = Math.min(maxWidth / width, maxHeight / height, 1);
  return { width: width * ratio, height: height * ratio };
}

// ── Texto ───────────────────────────────────────────────────────────

function lineHeight(size: number): number {
  return size * 1.35;
}

interface TextEngine {
  /** Sanitiza, parte em runs e quebra em linhas. */
  layout(text: string, size: number, maxWidth: number): Run[][];
  measure(runs: Run[], size: number): number;
  draw(
    page: PDFPage,
    runs: Run[],
    x: number,
    baseline: number,
    size: number,
    color: RGB,
    bold?: boolean
  ): void;
}

function createTextEngine(fonts: LoadedFonts): TextEngine {
  const fontFor = (run: Run, bold: boolean): PDFFont =>
    // `emoji` nulo só acontece quando a varredura não achou emoji
    // nenhum — nesse caso `splitRuns` também não produz run de emoji.
    // O fallback existe para nunca desenhar com `null`.
    run.font === 'emoji' && fonts.emoji
      ? fonts.emoji
      : bold
        ? fonts.semibold
        : fonts.text;

  const widthOf = (run: Run, size: number, bold = false): number => {
    if (run.text.length === 0) return 0;
    try {
      return fontFor(run, bold).widthOfTextAtSize(run.text, size);
    } catch (err) {
      // Defesa em profundidade: `sanitizeForPdf` já deveria ter tirado
      // o que não é mensurável. Uma exceção aqui não pode custar a
      // página inteira — mas também não pode passar calada: um
      // fallback silencioso foi o que escondeu o bug de fonte trocada
      // (texto esparramado) até a inspeção visual do documento.
      console.warn(
        '[conversation-export] falha ao medir texto:',
        err instanceof Error ? err.message : err
      );
      return size * 0.5 * run.text.length;
    }
  };

  return {
    layout(text, size, maxWidth) {
      const safe = sanitizeForPdf(text, fonts.isCovered);
      if (safe.trim().length === 0) return [];
      const runs = splitRuns(safe, fonts.usesEmojiFont);
      return wrapText(runs, maxWidth, (run) => widthOf(run, size));
    },
    measure(runs, size) {
      return runs.reduce((sum, run) => sum + widthOf(run, size), 0);
    },
    draw(page, runs, x, baseline, size, color, bold = false) {
      let cursorX = x;
      for (const run of runs) {
        if (run.text.length === 0) continue;
        const font = fontFor(run, bold);
        try {
          page.drawText(run.text, {
            x: cursorX,
            y: baseline,
            size,
            font,
            color,
          });
        } catch {
          // Idem: nunca derrubar o documento por um glifo.
        }
        cursorX += widthOf(run, size, bold);
      }
    },
  };
}

// ── Cursor de página ────────────────────────────────────────────────

class PageCursor {
  readonly pages: PDFPage[] = [];
  page: PDFPage;
  y: number;

  constructor(private readonly doc: PDFDocument) {
    this.page = this.addPage();
    this.y = PAGE_HEIGHT - MARGIN;
  }

  private addPage(): PDFPage {
    const page = this.doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    this.pages.push(page);
    return page;
  }

  newPage(): void {
    this.page = this.addPage();
    this.y = PAGE_HEIGHT - MARGIN;
  }

  /** Espaço vertical utilizável restante na página atual. */
  get available(): number {
    return this.y - MARGIN - FOOTER_HEIGHT;
  }
}

// ── Linhas desenháveis ──────────────────────────────────────────────

interface DrawLine {
  height: number;
  /** `top` é a borda SUPERIOR da linha. */
  draw: (page: PDFPage, x: number, top: number) => void;
  /** Largura natural, para dimensionar a bolha. */
  width: number;
}

interface BubbleLayout {
  side: 'left' | 'right';
  width: number;
  lines: DrawLine[];
}

export function attachmentTypeLabel(
  contentType: MediaPlanEntry['contentType'],
  labels: PdfLabels,
  isSticker: boolean
): string {
  switch (contentType) {
    case 'video':
      return labels.attachmentVideo;
    case 'audio':
      return labels.attachmentAudio;
    case 'document':
      return labels.attachmentDocument;
    // Inalcançável hoje: `MediaPlanEntry['contentType']` nunca chega
    // aqui como 'sticker' (ver `isWebpImage` acima) — mantido só pela
    // exaustividade do switch sobre o tipo.
    case 'sticker':
      return labels.attachmentSticker;
    case 'image':
      return isSticker ? labels.attachmentSticker : labels.attachmentImage;
  }
}

function mediaStatusLabel(
  media: FetchedMedia | undefined,
  labels: PdfLabels
): string | null {
  if (!media) return null;
  switch (media.status) {
    case 'missing':
      return labels.mediaMissing;
    case 'too_large':
      return labels.mediaTooLarge;
    case 'skipped':
      return labels.mediaSkipped;
    case 'error':
      return labels.mediaError;
    case 'ok':
      return null;
  }
}

/**
 * ⚠️ As fontes são embutidas AQUI, no documento que esta função cria —
 * e é de propósito que ela não receba um `LoadedFonts` pronto (a SPEC
 * §7 desenhou a assinatura assim).
 *
 * Um `PDFFont` pertence ao `PDFDocument` em que foi embutido. Desenhar
 * com a fonte de OUTRO documento não lança e não falha em teste nenhum:
 * o PDF sai íntegro, reabre, tem o número certo de páginas — e todo o
 * texto aparece com **glifos trocados**. Foi exatamente o que aconteceu
 * aqui, e só a inspeção visual do documento pegou. Receber o
 * `LoadedFonts` de fora deixaria essa armadilha aberta para a rota da
 * F7; criar o documento junto com as fontes a torna impossível.
 */
export async function renderConversationPdf(
  input: PdfRenderInput
): Promise<Uint8Array> {
  const { labels } = input;
  const doc = await PDFDocument.create();

  const coverage = await loadGlyphCoverage();
  const fonts: LoadedFonts = await loadExportFonts(doc, {
    embedEmoji: documentNeedsEmojiFont(input, coverage),
  });
  const text = createTextEngine(fonts);

  const now = input.now ?? new Date();
  doc.setTitle(`${labels.documentTitle} — ${input.header.contactName}`);
  if (input.header.accountName) doc.setAuthor(input.header.accountName);
  doc.setSubject(`${input.header.contactName} · ${input.header.periodLabel}`);
  doc.setCreator('ZAP CRM BR');
  doc.setProducer('ZAP CRM BR');
  doc.setCreationDate(now);
  doc.setModificationDate(now);

  const planByMessage = new Map(
    input.plan.map((entry) => [entry.messageId, entry])
  );

  // Imagens são embutidas UMA vez por objeto e reusadas: a mesma foto
  // encaminhada 5 vezes vira 5 desenhos do mesmo XObject, não 5 cópias
  // dos bytes dentro do PDF.
  const embeddedImages = new Map<number, PDFImage | null>();
  const embedImage = async (
    entryIndex: number,
    media: FetchedMedia
  ): Promise<PDFImage | null> => {
    const cached = embeddedImages.get(entryIndex);
    if (cached !== undefined) return cached;

    const kind = detectEmbeddableImage(media.bytes);
    let image: PDFImage | null = null;
    if (kind && media.bytes) {
      try {
        image =
          kind === 'jpeg'
            ? await doc.embedJpg(media.bytes)
            : await doc.embedPng(media.bytes);
      } catch {
        // JPEG progressivo, PNG interlaçado, bytes truncados: o anexo
        // degrada para cartão em vez de derrubar a exportação.
        image = null;
      }
    }
    embeddedImages.set(entryIndex, image);
    return image;
  };

  const cursor = new PageCursor(doc);
  drawHeader(cursor, input, text, fonts);

  for (const block of input.blocks) {
    if (block.kind === 'day') {
      drawDaySeparator(cursor, block.label, text);
      continue;
    }
    const layout = await buildBubbleLayout(
      block.bubble,
      input,
      text,
      planByMessage,
      embedImage
    );
    drawBubble(cursor, layout);
  }

  drawFooters(cursor, input.header.exportId, labels, fonts);

  return doc.save();
}

function drawHeader(
  cursor: PageCursor,
  input: PdfRenderInput,
  text: TextEngine,
  fonts: LoadedFonts
): void {
  const { header, labels } = input;

  const titleLines = text.layout(
    labels.documentTitle,
    SIZE_TITLE,
    CONTENT_WIDTH
  );
  for (const line of titleLines) {
    cursor.y -= lineHeight(SIZE_TITLE);
    text.draw(
      cursor.page,
      line,
      MARGIN,
      cursor.y + lineHeight(SIZE_TITLE) - SIZE_TITLE * 1.05,
      SIZE_TITLE,
      COLOR_TEXT,
      true
    );
  }
  cursor.y -= 6;

  const rows: [string, string][] = [
    [labels.headerContact, header.contactName],
    [labels.headerPhone, header.contactPhone],
    [labels.headerChannel, header.channelLabel],
    [labels.headerPeriod, header.periodLabel],
    [
      labels.headerCounts,
      `${labels.messageCount(header.messageCount)} · ${labels.attachmentCount(header.attachmentCount)}`,
    ],
    [labels.headerExportedBy, header.exportedByLabel],
    [labels.headerExportId, header.exportId],
  ];

  for (const [label, value] of rows) {
    const labelRuns = text.layout(`${label}:`, SIZE_HEADER, CONTENT_WIDTH)[0];
    const labelWidth = labelRuns ? text.measure(labelRuns, SIZE_HEADER) + 6 : 0;
    const valueLines = text.layout(
      value,
      SIZE_HEADER,
      CONTENT_WIDTH - labelWidth
    );

    const rowLines = Math.max(1, valueLines.length);
    for (let i = 0; i < rowLines; i++) {
      cursor.y -= lineHeight(SIZE_HEADER);
      const baseline = cursor.y + lineHeight(SIZE_HEADER) - SIZE_HEADER * 1.05;
      if (i === 0 && labelRuns) {
        text.draw(
          cursor.page,
          labelRuns,
          MARGIN,
          baseline,
          SIZE_HEADER,
          COLOR_MUTED,
          true
        );
      }
      const valueLine = valueLines[i];
      if (valueLine) {
        text.draw(
          cursor.page,
          valueLine,
          MARGIN + labelWidth,
          baseline,
          SIZE_HEADER,
          COLOR_TEXT
        );
      }
    }
  }

  cursor.y -= 8;
  cursor.page.drawLine({
    start: { x: MARGIN, y: cursor.y },
    end: { x: PAGE_WIDTH - MARGIN, y: cursor.y },
    thickness: 0.5,
    color: COLOR_FAINT,
  });
  cursor.y -= DAY_GAP;
  void fonts;
}

function drawDaySeparator(
  cursor: PageCursor,
  label: string,
  text: TextEngine
): void {
  const lines = text.layout(label, SIZE_DAY, CONTENT_WIDTH);
  const height = lineHeight(SIZE_DAY) + DAY_GAP;
  if (cursor.available < height) cursor.newPage();

  const line = lines[0];
  if (line) {
    const width = text.measure(line, SIZE_DAY);
    const x = MARGIN + (CONTENT_WIDTH - width) / 2;
    cursor.y -= lineHeight(SIZE_DAY);
    text.draw(
      cursor.page,
      line,
      x,
      cursor.y + lineHeight(SIZE_DAY) - SIZE_DAY * 1.05,
      SIZE_DAY,
      COLOR_MUTED
    );
  }
  cursor.y -= DAY_GAP;
}

/** Uma linha simples de texto já quebrado. */
function textLine(
  engine: TextEngine,
  runs: Run[],
  size: number,
  color: RGB,
  bold = false,
  indent = 0
): DrawLine {
  return {
    height: lineHeight(size),
    width: engine.measure(runs, size) + indent,
    draw: (page, x, top) =>
      engine.draw(page, runs, x + indent, top - size * 1.05, size, color, bold),
  };
}

async function buildBubbleLayout(
  bubble: TranscriptBubble,
  input: PdfRenderInput,
  engine: TextEngine,
  planByMessage: Map<string, MediaPlanEntry>,
  embedImage: (
    entryIndex: number,
    media: FetchedMedia
  ) => Promise<PDFImage | null>
): Promise<BubbleLayout> {
  const { labels } = input;
  const innerWidth = BUBBLE_MAX_WIDTH - BUBBLE_PADDING * 2;
  const lines: DrawLine[] = [];

  // 1) Remetente + horário/status.
  const senderRuns = engine.layout(
    bubble.senderLabel,
    SIZE_SENDER,
    innerWidth
  )[0];
  const metaText = bubble.statusLabel
    ? `${bubble.timeLabel} · ${bubble.statusLabel}`
    : bubble.timeLabel;
  const metaRuns = engine.layout(metaText, SIZE_META, innerWidth)[0];
  if (senderRuns || metaRuns) {
    const senderWidth = senderRuns
      ? engine.measure(senderRuns, SIZE_SENDER)
      : 0;
    const metaWidth = metaRuns ? engine.measure(metaRuns, SIZE_META) : 0;
    lines.push({
      height: lineHeight(SIZE_SENDER),
      width: senderWidth + metaWidth + 12,
      draw: (page, x, top) => {
        if (senderRuns) {
          engine.draw(
            page,
            senderRuns,
            x,
            top - SIZE_SENDER * 1.05,
            SIZE_SENDER,
            COLOR_MUTED,
            true
          );
        }
        if (metaRuns) {
          engine.draw(
            page,
            metaRuns,
            x + senderWidth + 12,
            top - SIZE_SENDER * 1.05,
            SIZE_META,
            COLOR_FAINT
          );
        }
      },
    });
  }

  // 2) Selos.
  if (bubble.badges.length > 0) {
    for (const line of engine.layout(
      bubble.badges.join(' · '),
      SIZE_META,
      innerWidth
    )) {
      lines.push(textLine(engine, line, SIZE_META, COLOR_MUTED));
    }
  }

  // 3) Citação — barra vertical + trecho.
  if (bubble.quote) {
    const quoteText = `${labels.replyPrefix} ${bubble.quote.senderLabel}: ${bubble.quote.snippet}`;
    for (const line of engine.layout(quoteText, SIZE_META, innerWidth - 8)) {
      const base = textLine(engine, line, SIZE_META, COLOR_MUTED, false, 8);
      lines.push({
        ...base,
        draw: (page, x, top) => {
          page.drawRectangle({
            x,
            y: top - base.height,
            width: 2,
            height: base.height,
            color: COLOR_QUOTE_BAR,
          });
          base.draw(page, x, top);
        },
      });
    }
  }

  // 4) Corpo.
  for (const paragraph of bubble.text) {
    const wrapped = engine.layout(paragraph, SIZE_BODY, innerWidth);
    if (wrapped.length === 0) {
      // Parágrafo vazio é uma quebra intencional do usuário.
      lines.push({
        height: lineHeight(SIZE_BODY) / 2,
        width: 0,
        draw: () => {},
      });
      continue;
    }
    for (const line of wrapped) {
      lines.push(textLine(engine, line, SIZE_BODY, COLOR_TEXT));
    }
  }

  // 5) Anexo: imagem em linha (D-3) ou cartão.
  if (bubble.attachment) {
    const entry = planByMessage.get(bubble.attachment.messageId);
    const media = entry ? input.media.get(entry.index) : undefined;
    // Chave de cache é o índice CANÔNICO, não o da própria entrada: uma
    // duplicata (mesma foto encaminhada/citada de novo) tem `entry.index`
    // sempre novo — sem isto o cache nunca acerta para ela, e a mesma
    // imagem é decodificada e embutida de novo como um XObject próprio a
    // cada ocorrência, em vez de reusar o já embutido (achado de review).
    const image =
      entry && media && media.status === 'ok'
        ? await embedImage(entry.duplicateOfIndex ?? entry.index, media)
        : null;

    if (image) {
      const { width, height } = scaleToFit(
        image.width,
        image.height,
        Math.min(IMAGE_MAX_WIDTH, innerWidth),
        IMAGE_MAX_HEIGHT
      );
      lines.push({
        height: height + 4,
        width,
        draw: (page, x, top) => {
          page.drawImage(image, { x, y: top - height, width, height });
        },
      });
      if (input.includeZipReferences && entry) {
        for (const line of engine.layout(
          `${labels.inZip} ${entry.zipPath}`,
          SIZE_META,
          innerWidth
        )) {
          lines.push(textLine(engine, line, SIZE_META, COLOR_FAINT));
        }
      }
    } else {
      lines.push(
        ...buildAttachmentCard(bubble, entry, media, input, engine, innerWidth)
      );
    }

    if (bubble.attachment.caption) {
      for (const line of engine.layout(
        bubble.attachment.caption,
        SIZE_BODY,
        innerWidth
      )) {
        lines.push(textLine(engine, line, SIZE_BODY, COLOR_TEXT));
      }
    }
  }

  // 6) Botões.
  for (const button of bubble.buttons) {
    for (const line of engine.layout(
      `${labels.buttonPrefix} ${button}`,
      SIZE_META,
      innerWidth
    )) {
      lines.push(textLine(engine, line, SIZE_META, COLOR_MUTED));
    }
  }

  // 7) Reações.
  if (bubble.reactions.length > 0) {
    for (const line of engine.layout(
      bubble.reactions.join('   '),
      SIZE_META,
      innerWidth
    )) {
      lines.push(textLine(engine, line, SIZE_META, COLOR_MUTED));
    }
  }

  // 8) Motivo da falha de entrega.
  if (bubble.errorText) {
    for (const line of engine.layout(bubble.errorText, SIZE_META, innerWidth)) {
      lines.push(textLine(engine, line, SIZE_META, COLOR_ERROR));
    }
  }

  const naturalWidth = lines.reduce(
    (max, line) => Math.max(max, line.width),
    0
  );
  const width = Math.min(
    BUBBLE_MAX_WIDTH,
    Math.max(naturalWidth + BUBBLE_PADDING * 2, 80)
  );

  return { side: bubble.side, width, lines };
}

function buildAttachmentCard(
  bubble: TranscriptBubble,
  entry: MediaPlanEntry | undefined,
  media: FetchedMedia | undefined,
  input: PdfRenderInput,
  engine: TextEngine,
  innerWidth: number
): DrawLine[] {
  const { labels } = input;
  const attachment = bubble.attachment!;
  const cardInner = innerWidth - 12;

  const rows: string[] = [
    attachmentTypeLabel(
      attachment.contentType,
      labels,
      isWebpImage(media?.bytes ?? null)
    ),
    attachment.displayName,
  ];

  const statusLabel = mediaStatusLabel(media, labels);
  if (statusLabel) {
    rows.push(statusLabel);
  } else if (media) {
    // `byteLength` pode ser 0 num download bem-sucedido de um objeto
    // genuinamente vazio (nenhum dos três caminhos de fetch impõe um
    // piso mínimo) — sem este `else if` cobrindo status 'ok' inteiro, um
    // anexo de 0 byte não mostrava NENHUMA linha de tamanho, nem "0 B".
    rows.push(labels.formatBytes(media.byteLength));
  }

  if (input.includeZipReferences && entry && media?.status === 'ok') {
    rows.push(`${labels.inZip} ${entry.zipPath}`);
  }

  const wrapped = rows.flatMap((row, i) =>
    engine.layout(row, SIZE_META, cardInner).map((line) => ({ line, i }))
  );
  if (wrapped.length === 0) return [];

  const contentHeight = wrapped.length * lineHeight(SIZE_META);
  const cardHeight = contentHeight + 10;
  const cardWidth = Math.min(
    innerWidth,
    Math.max(
      120,
      wrapped.reduce(
        (max, { line }) => Math.max(max, engine.measure(line, SIZE_META)),
        0
      ) + 12
    )
  );

  return [
    {
      height: cardHeight + 4,
      width: cardWidth,
      draw: (page, x, top) => {
        page.drawRectangle({
          x,
          y: top - cardHeight,
          width: cardWidth,
          height: cardHeight,
          borderColor: COLOR_CARD_BORDER,
          borderWidth: 1,
        });
        let lineTop = top - 5;
        for (const { line, i } of wrapped) {
          engine.draw(
            page,
            line,
            x + 6,
            lineTop - SIZE_META * 1.05,
            SIZE_META,
            i === 0 ? COLOR_TEXT : COLOR_MUTED,
            i === 0
          );
          lineTop -= lineHeight(SIZE_META);
        }
      },
    },
  ];
}

/**
 * Desenha a bolha, fatiando-a entre páginas quando não couber inteira.
 * Cada segmento redesenha o próprio fundo — é o que faz uma mensagem
 * mais alta que a página continuar na seguinte em vez de vazar para
 * fora da margem.
 */
function drawBubble(cursor: PageCursor, layout: BubbleLayout): void {
  const { lines, width, side } = layout;
  if (lines.length === 0) return;

  const x = side === 'left' ? MARGIN : PAGE_WIDTH - MARGIN - width;
  const color = side === 'left' ? COLOR_BUBBLE_IN : COLOR_BUBBLE_OUT;

  let i = 0;
  while (i < lines.length) {
    const available = cursor.available - BUBBLE_PADDING * 2;

    let used = 0;
    let j = i;
    while (j < lines.length && used + lines[j].height <= available) {
      used += lines[j].height;
      j++;
    }

    if (j === i) {
      // Nem a primeira linha cabe. Numa página vazia isso significaria
      // uma linha mais alta que a página inteira (imagem gigante já é
      // limitada a 320pt, então não acontece) — o guard evita laço
      // infinito de qualquer forma.
      if (cursor.y >= PAGE_HEIGHT - MARGIN) {
        used = lines[i].height;
        j = i + 1;
      } else {
        cursor.newPage();
        continue;
      }
    }

    const boxTop = cursor.y;
    const boxHeight = used + BUBBLE_PADDING * 2;
    cursor.page.drawRectangle({
      x,
      y: boxTop - boxHeight,
      width,
      height: boxHeight,
      color,
    });

    let lineTop = boxTop - BUBBLE_PADDING;
    for (let k = i; k < j; k++) {
      lines[k].draw(cursor.page, x + BUBBLE_PADDING, lineTop);
      lineTop -= lines[k].height;
    }

    cursor.y = boxTop - boxHeight - BUBBLE_GAP;
    i = j;
    if (i < lines.length) cursor.newPage();
  }
}

/**
 * Rodapé em segunda passada: o total de páginas só é conhecido depois
 * de desenhar tudo.
 */
function drawFooters(
  cursor: PageCursor,
  exportId: string,
  labels: PdfLabels,
  fonts: LoadedFonts
): void {
  const total = cursor.pages.length;
  cursor.pages.forEach((page, i) => {
    const y = MARGIN / 2;
    try {
      page.drawText(exportId, {
        x: MARGIN,
        y,
        size: SIZE_FOOTER,
        font: fonts.text,
        color: COLOR_FAINT,
      });
      const pageLabel = labels.page(i + 1, total);
      const width = fonts.text.widthOfTextAtSize(pageLabel, SIZE_FOOTER);
      page.drawText(pageLabel, {
        x: PAGE_WIDTH - MARGIN - width,
        y,
        size: SIZE_FOOTER,
        font: fonts.text,
        color: COLOR_FAINT,
      });
    } catch {
      // Rodapé é diagnóstico, não conteúdo: nunca derrubar o documento.
    }
  });
}
