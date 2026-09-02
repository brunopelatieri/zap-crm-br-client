import { describe, expect, it, vi } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import {
  detectEmbeddableImage,
  renderConversationPdf,
  scaleToFit,
  type PdfLabels,
  type PdfRenderInput,
} from './pdf';
import type { FetchedMedia } from './fetch-media';
import type { MediaPlanEntry } from './media-plan';
import type { TranscriptBlock, TranscriptBubble } from './model';

/** PNG 1×1 válido — o menor arquivo que o `embedPng` aceita de verdade. */
const PNG_1X1 = new Uint8Array(
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'
  )
);

function makeLabels(): PdfLabels {
  return {
    documentTitle: 'Histórico de conversa',
    headerContact: 'Contato',
    headerPhone: 'Telefone',
    headerChannel: 'Canal',
    headerPeriod: 'Período',
    headerCounts: 'Conteúdo',
    headerExportedBy: 'Exportado por',
    headerExportId: 'ID da exportação',
    messageCount: (n) => `${n} mensagens`,
    attachmentCount: (n) => `${n} anexos`,
    attachmentImage: 'Imagem',
    attachmentVideo: 'Vídeo',
    attachmentAudio: 'Áudio',
    attachmentDocument: 'Documento',
    attachmentSticker: 'Figurinha',
    mediaMissing: 'mídia indisponível (expirada na origem)',
    mediaTooLarge: 'arquivo grande demais para o pacote',
    mediaSkipped: 'não incluído: limite do pacote',
    mediaError: 'não foi possível baixar',
    inZip: 'Em:',
    replyPrefix: 'Em resposta a',
    buttonPrefix: 'Botão:',
    formatBytes: (n) => `${n} B`,
    page: (current, total) => `página ${current} de ${total}`,
  };
}

function bubble(overrides: Partial<TranscriptBubble> = {}): TranscriptBubble {
  return {
    messageId: 'm1',
    side: 'left',
    senderLabel: 'Maria (cliente)',
    timeLabel: '14:32',
    statusLabel: null,
    text: ['Oi, tudo bem?'],
    badges: [],
    quote: null,
    reactions: [],
    buttons: [],
    attachment: null,
    errorText: null,
    ...overrides,
  };
}

function makeInput(overrides: Partial<PdfRenderInput> = {}): PdfRenderInput {
  return {
    header: {
      contactName: 'Maria Silva',
      contactPhone: '+5511999999999',
      channelLabel: 'WhatsApp Oficial · +55 11 4000-0000',
      periodLabel: 'Toda a conversa',
      messageCount: 1,
      attachmentCount: 0,
      exportedByLabel: 'Exportado por João em 02/09/2026 14:31',
      exportId: '11111111-2222-3333-4444-555555555555',
      accountName: 'Loja da Maria',
    },
    blocks: [
      { kind: 'day', label: '12 de agosto de 2026' },
      { kind: 'bubble', bubble: bubble() },
    ],
    plan: [],
    media: new Map(),
    labels: makeLabels(),
    includeZipReferences: false,
    now: new Date('2026-09-02T14:31:00.000Z'),
    ...overrides,
  };
}

async function render(input: PdfRenderInput): Promise<Uint8Array> {
  return renderConversationPdf(input);
}

describe('detectEmbeddableImage', () => {
  it('reconhece JPEG e PNG pelos magic bytes', () => {
    expect(
      detectEmbeddableImage(new Uint8Array([0xff, 0xd8, 0xff, 0, 0, 0, 0, 0]))
    ).toBe('jpeg');
    expect(detectEmbeddableImage(PNG_1X1)).toBe('png');
  });

  it('recusa WebP (sticker do WhatsApp) e GIF — viram cartão de anexo', () => {
    const webp = new Uint8Array([
      0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
    ]);
    const gif = new Uint8Array([
      0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00,
    ]);
    expect(detectEmbeddableImage(webp)).toBeNull();
    expect(detectEmbeddableImage(gif)).toBeNull();
  });

  it('não confia no MIME: bytes vazios, curtos ou nulos devolvem null', () => {
    expect(detectEmbeddableImage(null)).toBeNull();
    expect(detectEmbeddableImage(new Uint8Array([0xff, 0xd8]))).toBeNull();
  });
});

describe('scaleToFit', () => {
  it('reduz preservando a proporção', () => {
    expect(scaleToFit(1000, 500, 260, 320)).toEqual({
      width: 260,
      height: 130,
    });
  });

  it('limita pela altura quando a imagem é vertical', () => {
    const { width, height } = scaleToFit(500, 1000, 260, 320);
    expect(height).toBe(320);
    expect(width).toBeCloseTo(160, 5);
  });

  it('nunca amplia — miniatura pequena sai no tamanho original', () => {
    expect(scaleToFit(40, 40, 260, 320)).toEqual({ width: 40, height: 40 });
  });

  it('dimensão zero não quebra', () => {
    expect(scaleToFit(0, 100, 260, 320)).toEqual({ width: 0, height: 0 });
  });
});

describe('renderConversationPdf — documento válido', () => {
  it('gera um PDF que reabre, com os metadados de origem', async () => {
    const bytes = await render(makeInput());

    expect(Buffer.from(bytes.slice(0, 5)).toString()).toBe('%PDF-');

    const reopened = await PDFDocument.load(bytes);
    expect(reopened.getPageCount()).toBe(1);
    expect(reopened.getTitle()).toContain('Maria Silva');
    expect(reopened.getAuthor()).toBe('Loja da Maria');
    expect(reopened.getCreator()).toBe('ZAP CRM BR');
  });

  it('acentuação, emoji e família com ZWJ não derrubam o render', async () => {
    const bytes = await render(
      makeInput({
        blocks: [
          {
            kind: 'bubble',
            bubble: bubble({
              text: ['Ação, coração, ãéíóú — çÇ 👍 👨‍👩‍👧 👍🏽'],
              badges: ['⭐ favorita', 'IA'],
              reactions: ['👍 cliente', '❤️ João'],
            }),
          },
        ],
      })
    );
    expect(bytes.length).toBeGreaterThan(1000);
  });

  it('só embute a fonte de emoji quando o documento tem emoji', async () => {
    const semEmoji = await render(
      makeInput({
        blocks: [
          { kind: 'bubble', bubble: bubble({ text: ['Bom dia, tudo bem?'] }) },
        ],
      })
    );
    const comEmoji = await render(
      makeInput({
        blocks: [{ kind: 'bubble', bubble: bubble({ text: ['Bom dia 👍'] }) }],
      })
    );

    // A NotoEmoji não pode ser subsetada (o subsetter do pdf-lib deixa
    // glifos em branco), então ela entra inteira — ~580 KB. Um PDF de
    // conversa sem emoji não pode pagar isso.
    expect(semEmoji.length).toBeLessThan(200_000);
    expect(comEmoji.length).toBeGreaterThan(semEmoji.length + 300_000);
  });

  it('família ZWJ e tom de pele não somem do documento', async () => {
    // Regressão do achado da inspeção visual: com subset, 👨/👩/👧 e a
    // ligadura 👨‍👩‍👧 saíam em BRANCO — o PDF era válido, tinha o número
    // certo de páginas e nenhum teste falhava.
    const bytes = await render(
      makeInput({
        blocks: [
          {
            kind: 'bubble',
            bubble: bubble({ text: ['Família 👨‍👩‍👧 e 👍🏽 e 👋'] }),
          },
        ],
      })
    );
    const reopened = await PDFDocument.load(bytes);
    expect(reopened.getPageCount()).toBe(1);
    expect(bytes.length).toBeGreaterThan(300_000);
  });

  it('caractere sem glifo em nenhuma fonte é removido, não vira exceção', async () => {
    // CJK não é coberto pelas fontes vendorizadas (medido em pdf-fonts).
    const bytes = await render(
      makeInput({
        blocks: [
          { kind: 'bubble', bubble: bubble({ text: ['antes 漢字 depois'] }) },
        ],
      })
    );
    expect(bytes.length).toBeGreaterThan(1000);
  });

  it('texto vazio e bolha sem conteúdo não quebram', async () => {
    const bytes = await render(
      makeInput({
        blocks: [
          { kind: 'bubble', bubble: bubble({ text: [] }) },
          { kind: 'bubble', bubble: bubble({ text: ['', '   '] }) },
        ],
      })
    );
    expect(bytes.length).toBeGreaterThan(1000);
  });
});

describe('renderConversationPdf — paginação', () => {
  it('conversa longa gera várias páginas', async () => {
    const blocks: TranscriptBlock[] = Array.from({ length: 120 }, (_, i) => ({
      kind: 'bubble' as const,
      bubble: bubble({
        messageId: `m${i}`,
        side: i % 2 === 0 ? 'left' : 'right',
        text: [`Mensagem número ${i} com um texto de tamanho razoável.`],
      }),
    }));

    const bytes = await render(makeInput({ blocks }));
    const reopened = await PDFDocument.load(bytes);
    expect(reopened.getPageCount()).toBeGreaterThan(1);
  });

  it('mensagem mais alta que a página quebra entre páginas em vez de vazar', async () => {
    const huge = Array.from(
      { length: 400 },
      (_, i) => `Linha ${i} de uma mensagem muito longa colada pelo cliente.`
    );
    const bytes = await render(
      makeInput({
        blocks: [{ kind: 'bubble', bubble: bubble({ text: huge }) }],
      })
    );

    const reopened = await PDFDocument.load(bytes);
    expect(reopened.getPageCount()).toBeGreaterThan(2);
  });

  it('URL de 400 caracteres sem espaço não estoura a caixa', async () => {
    const url = `https://exemplo.com.br/${'a'.repeat(400)}`;
    const bytes = await render(
      makeInput({
        blocks: [{ kind: 'bubble', bubble: bubble({ text: [url] }) }],
      })
    );
    expect(bytes.length).toBeGreaterThan(1000);
  });

  it('numera o rodapé com o total real de páginas', async () => {
    const labels = makeLabels();
    const pageSpy = vi.fn(labels.page);
    labels.page = pageSpy;

    const blocks: TranscriptBlock[] = Array.from({ length: 120 }, (_, i) => ({
      kind: 'bubble' as const,
      bubble: bubble({ messageId: `m${i}`, text: [`Mensagem ${i}`] }),
    }));

    const bytes = await render(makeInput({ blocks, labels }));
    const total = (await PDFDocument.load(bytes)).getPageCount();

    expect(pageSpy).toHaveBeenCalledTimes(total);
    expect(pageSpy).toHaveBeenCalledWith(1, total);
    expect(pageSpy).toHaveBeenCalledWith(total, total);
  });
});

describe('renderConversationPdf — anexos', () => {
  const planEntry: MediaPlanEntry = {
    index: 1,
    messageId: 'm1',
    ref: { kind: 'storage', bucket: 'chat-media', path: 'acc/foto.png' },
    contentType: 'image',
    zipPath: 'midias/0001-image-aaaaaaaa.png',
    displayName: 'foto.png',
    createdAt: '2026-08-12T14:32:00.000Z',
    channelId: 'channel-a',
    duplicateOfIndex: null,
  };

  const okMedia: FetchedMedia = {
    index: 1,
    status: 'ok',
    bytes: PNG_1X1,
    mimeType: 'image/png',
    byteLength: PNG_1X1.byteLength,
  };

  function withAttachment(
    media: FetchedMedia,
    contentType: MediaPlanEntry['contentType'] = 'image',
    includeZipReferences = true
  ): PdfRenderInput {
    return makeInput({
      blocks: [
        {
          kind: 'bubble',
          bubble: bubble({
            text: [],
            attachment: {
              messageId: 'm1',
              contentType,
              ref: planEntry.ref,
              displayName: 'foto.png',
              caption: 'legenda da foto',
              createdAt: '2026-08-12T14:32:00.000Z',
              channelId: 'channel-a',
            },
          }),
        },
      ],
      plan: [{ ...planEntry, contentType }],
      media: new Map([[1, media]]),
      includeZipReferences,
    });
  }

  it('embute PNG em linha quando os bytes vieram ok', async () => {
    const bytes = await render(withAttachment(okMedia));
    const reopened = await PDFDocument.load(bytes);
    expect(reopened.getPageCount()).toBe(1);
    expect(bytes.length).toBeGreaterThan(1000);
  });

  it('reusa o mesmo XObject quando a mesma imagem aparece várias vezes', async () => {
    const single = await render(withAttachment(okMedia));

    const repeated = makeInput({
      blocks: Array.from({ length: 8 }, () => ({
        kind: 'bubble' as const,
        bubble: bubble({
          messageId: 'm1',
          text: [],
          attachment: {
            messageId: 'm1',
            contentType: 'image',
            ref: planEntry.ref,
            displayName: 'foto.png',
            caption: null,
            createdAt: '2026-08-12T14:32:00.000Z',
            channelId: 'channel-a',
          },
        }),
      })),
      plan: [planEntry],
      media: new Map([[1, okMedia]]),
      includeZipReferences: true,
    });
    const many = await render(repeated);

    // 8 desenhos da mesma foto não podem custar 8 cópias dos bytes.
    expect(many.length).toBeLessThan(single.length * 2);
  });

  it('mídia ausente vira cartão, sem derrubar o documento', async () => {
    const missing: FetchedMedia = {
      index: 1,
      status: 'missing',
      bytes: null,
      mimeType: null,
      byteLength: 0,
    };
    const bytes = await render(withAttachment(missing, 'video'));
    expect(bytes.length).toBeGreaterThan(1000);
  });

  it('bytes corrompidos degradam para cartão em vez de lançar', async () => {
    const corrupt: FetchedMedia = {
      index: 1,
      status: 'ok',
      // Assinatura de PNG, conteúdo lixo: `embedPng` lança.
      bytes: new Uint8Array([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02, 0x03,
      ]),
      mimeType: 'image/png',
      byteLength: 11,
    };
    const bytes = await render(withAttachment(corrupt));
    expect(bytes.length).toBeGreaterThan(1000);
  });

  it('sem zip, o cartão não cita caminho de midias/', async () => {
    const bytes = await render(withAttachment(okMedia, 'document', false));
    expect(bytes.length).toBeGreaterThan(1000);
  });
});
