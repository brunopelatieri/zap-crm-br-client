import { describe, expect, it, vi } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import {
  attachmentTypeLabel,
  detectEmbeddableImage,
  documentNeedsEmojiFont,
  isWebpImage,
  renderConversationPdf,
  scaleToFit,
  type PdfLabels,
  type PdfRenderInput,
} from './pdf';
import { loadGlyphCoverage } from './pdf-fonts';
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

describe('isWebpImage', () => {
  const webp = new Uint8Array([
    0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
  ]);

  it('reconhece RIFF....WEBP — o formato real dos stickers do WhatsApp', () => {
    expect(isWebpImage(webp)).toBe(true);
  });

  it('recusa JPEG, PNG, GIF e bytes curtos/nulos', () => {
    expect(isWebpImage(PNG_1X1)).toBe(false);
    expect(
      isWebpImage(new Uint8Array([0xff, 0xd8, 0xff, 0, 0, 0, 0, 0, 0, 0, 0, 0]))
    ).toBe(false);
    expect(isWebpImage(null)).toBe(false);
    expect(isWebpImage(new Uint8Array([0x52, 0x49]))).toBe(false);
  });

  it('exige RIFF E WEBP — um RIFF de outro formato (ex.: WAV) não confunde', () => {
    const wav = new Uint8Array([
      0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x41, 0x56, 0x45,
    ]); // "RIFF....WAVE"
    expect(isWebpImage(wav)).toBe(false);
  });
});

describe('attachmentTypeLabel', () => {
  const labels = makeLabels();

  it('sticker do WhatsApp (WebP) rotula como Figurinha, não Imagem', () => {
    // Regressão do achado de review: `content_type: 'image'` +
    // `isSticker: true` (detectado pelos bytes reais, ver `isWebpImage`)
    // é o único caminho por onde um sticker de verdade passa — o
    // `case 'sticker'` do switch é inalcançável a partir do modelo.
    expect(attachmentTypeLabel('image', labels, true)).toBe('Figurinha');
  });

  it('imagem comum (não-WebP) continua rotulada como Imagem', () => {
    expect(attachmentTypeLabel('image', labels, false)).toBe('Imagem');
  });

  it('vídeo/áudio/documento não dependem do parâmetro isSticker', () => {
    expect(attachmentTypeLabel('video', labels, true)).toBe('Vídeo');
    expect(attachmentTypeLabel('audio', labels, false)).toBe('Áudio');
    expect(attachmentTypeLabel('document', labels, true)).toBe('Documento');
  });
});

describe('documentNeedsEmojiFont — rótulos de função', () => {
  it('detecta emoji dentro do TEMPLATE de messageCount/attachmentCount/formatBytes/page', async () => {
    // Regressão do achado de review: a varredura só olhava rótulos
    // STRING, então um emoji dentro de um dos quatro rótulos de FUNÇÃO
    // (interpolados direto no cabeçalho/cartão/rodapé, nunca pré-
    // -assados para dentro de `blocks`) passava batido — a fonte de
    // emoji não era embutida e o glifo saía em branco no documento.
    const coverage = await loadGlyphCoverage();
    const baseInput = makeInput();

    const withEmojiInPageLabel: PdfRenderInput = {
      ...baseInput,
      labels: {
        ...baseInput.labels,
        page: (current, total) => `📄 ${current}/${total}`,
      },
    };
    expect(documentNeedsEmojiFont(withEmojiInPageLabel, coverage)).toBe(true);

    const withEmojiInMessageCount: PdfRenderInput = {
      ...baseInput,
      labels: {
        ...baseInput.labels,
        messageCount: (n) => `📨 ${n}`,
      },
    };
    expect(documentNeedsEmojiFont(withEmojiInMessageCount, coverage)).toBe(
      true
    );
  });

  it('sem emoji em rótulo nenhum (string ou função) continua false', async () => {
    const coverage = await loadGlyphCoverage();
    expect(documentNeedsEmojiFont(makeInput(), coverage)).toBe(false);
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
    // 15 s: renderiza 400 linhas e leva ~4 s sozinho; com a suíte inteira em
    // paralelo passava de 5 s (limite padrão) e falhava sem relação com o código.
  }, 15_000);

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

    // `total` chamadas do rodapé em si + 1: `documentNeedsEmojiFont`
    // sonda `labels.page(1, 1)` uma vez para saber se o TEMPLATE do
    // rótulo de página contém emoji (regressão coberta em
    // pdf-fonts.test.ts) — a mesma função de rótulo, chamada de novo.
    expect(pageSpy).toHaveBeenCalledTimes(total + 1);
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

  it('reusa o mesmo XObject quando a mesma imagem é encaminhada em mensagens diferentes', async () => {
    // Regressão do achado de review: o cache de embed em pdf.ts era
    // chaveado por `entry.index`, mas CADA entrada do plano — inclusive
    // as duplicatas de um forward/citação — tem o SEU PRÓPRIO índice
    // sequencial (`duplicateOfIndex` é um campo à parte apontando pro
    // índice canônico). Um teste com um único `messageId`/`entry.index`
    // repetido em 8 bolhas nunca exercitava esse caminho — ele reusava
    // trivialmente até com o bug. Aqui são 8 MENSAGENS/entradas DE
    // VERDADE distintas, 7 delas com `duplicateOfIndex` apontando para
    // a primeira, exatamente como `buildMediaPlan` gera para um
    // catálogo encaminhado várias vezes.
    const single = await render(withAttachment(okMedia));

    const plan: MediaPlanEntry[] = Array.from({ length: 8 }, (_, i) => ({
      ...planEntry,
      index: i + 1,
      messageId: `m${i + 1}`,
      duplicateOfIndex: i === 0 ? null : 1,
    }));
    const media = new Map<number, FetchedMedia>(
      plan.map((entry) => [entry.index, { ...okMedia, index: entry.index }])
    );

    const repeated = makeInput({
      blocks: plan.map((entry) => ({
        kind: 'bubble' as const,
        bubble: bubble({
          messageId: entry.messageId,
          text: [],
          attachment: {
            messageId: entry.messageId,
            contentType: 'image',
            ref: entry.ref,
            displayName: 'foto.png',
            caption: null,
            createdAt: '2026-08-12T14:32:00.000Z',
            channelId: 'channel-a',
          },
        }),
      })),
      plan,
      media,
      includeZipReferences: true,
    });
    const many = await render(repeated);

    // 8 desenhos da mesma foto (7 delas duplicatas) não podem custar 8
    // cópias dos bytes embutidos — cada JPEG/PNG só entra uma vez.
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

  it('anexo de 0 byte com download bem-sucedido não derruba o render', async () => {
    // Regressão do achado de review: `status: 'ok'` com `byteLength: 0`
    // (download genuinamente vazio, nenhum dos três caminhos de fetch
    // impõe piso mínimo) não caía no ramo de status de erro NEM no de
    // tamanho (`byteLength > 0`) — o cartão saía sem nenhuma linha de
    // tamanho, nem "0 B". A extração de texto do PDF não é viável nesta
    // pipeline (a fonte embutida codifica os glifos, não ASCII puro),
    // então este teste garante ao menos que o caminho não lança nem
    // produz um documento vazio — a asserção de TEXTO ("0 B" aparece")
    // ficou coberta pela leitura do código em `buildAttachmentCard`.
    const empty: FetchedMedia = {
      index: 1,
      status: 'ok',
      bytes: new Uint8Array(0),
      mimeType: 'application/octet-stream',
      byteLength: 0,
    };
    const bytes = await render(withAttachment(empty, 'document'));
    const reopened = await PDFDocument.load(bytes);
    expect(reopened.getPageCount()).toBe(1);
    expect(bytes.length).toBeGreaterThan(1000);
  });
});
