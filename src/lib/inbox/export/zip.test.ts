import { describe, expect, it } from 'vitest';
import { unzipSync, strFromU8 } from 'fflate';
import {
  MANIFEST_FILENAME,
  README_FILENAME,
  buildConversationZip,
  buildMediaManifestCsv,
  buildReadmeText,
  conversationExportFilename,
  type ManifestLabels,
  type ReadmeLabels,
} from './zip';
import type { FetchedMedia } from './fetch-media';
import type { MediaPlanEntry } from './media-plan';
import type { TranscriptBlock, TranscriptBubble } from './model';

const BOM = String.fromCharCode(0xfeff);

function planEntry(overrides: Partial<MediaPlanEntry> = {}): MediaPlanEntry {
  return {
    index: 1,
    messageId: 'm1',
    ref: { kind: 'storage', bucket: 'chat-media', path: 'acc/foto.jpg' },
    contentType: 'image',
    zipPath: 'midias/0001-image-3f2a1b9c.jpg',
    displayName: 'comprovante.jpg',
    createdAt: '2026-08-12T14:32:00.000Z',
    channelId: 'channel-a',
    duplicateOfIndex: null,
    ...overrides,
  };
}

function fetched(overrides: Partial<FetchedMedia> = {}): FetchedMedia {
  return {
    index: 1,
    status: 'ok',
    bytes: new Uint8Array([1, 2, 3, 4, 5]),
    mimeType: 'image/jpeg',
    byteLength: 5,
    ...overrides,
  };
}

function bubbleBlock(
  messageId: string,
  senderLabel = 'Maria Silva (cliente)'
): TranscriptBlock {
  const bubble: TranscriptBubble = {
    messageId,
    side: 'left',
    senderLabel,
    timeLabel: '14:32',
    statusLabel: null,
    text: [],
    badges: [],
    quote: null,
    reactions: [],
    buttons: [],
    attachment: null,
    errorText: null,
  };
  return { kind: 'bubble', bubble };
}

const manifestLabels: ManifestLabels = {
  columns: {
    file: 'arquivo',
    index: 'indice',
    dateTime: 'data_hora',
    sender: 'remetente',
    type: 'tipo',
    displayName: 'nome_exibido',
    byteSize: 'tamanho_bytes',
    status: 'status',
    messageId: 'mensagem_id',
  },
  types: {
    image: 'Imagem',
    video: 'Vídeo',
    audio: 'Áudio',
    document: 'Documento',
    sticker: 'Figurinha',
  },
  status: {
    ok: 'ok',
    missing: 'ausente',
    too_large: 'grande demais',
    skipped: 'não incluído',
    error: 'erro',
  },
  formatDateTime: (iso) => iso.replace('T', ' ').slice(0, 16),
  notIncluded: '',
};

const readmeLabels: ReadmeLabels = {
  title: 'Exportação de conversa — ZAP CRM BR',
  contactLine: (name) => `Contato: ${name}`,
  exportedByLine: (by) => `Gerado por: ${by}`,
  exportIdLine: (id) => `ID da exportação: ${id}`,
  pdfLine: (name) => `Conversa completa: ${name}`,
  mediaLine: (included, total) =>
    `Mídias na pasta midias/: ${included} de ${total}`,
  manifestLine: (name) => `Vínculo arquivo/mensagem: ${name}`,
  noteStickersAndVideos:
    '- Figurinhas e vídeos não aparecem como imagem no PDF; viram cartão.',
  noteMissingMedia:
    '- Itens com status diferente de "ok" no manifesto não estão na pasta.',
  noteMonochromeEmoji: '- Emojis saem em preto e branco.',
  notePersonalData: '- Este pacote contém dados pessoais. Guarde com cuidado.',
};

/**
 * Lê o `mtime` de uma entrada direto do local file header do ZIP —
 * `unzipSync` só devolve os bytes, então é o único jeito de provar o
 * requisito de cronologia da SPEC §8.
 *
 * Formato (APPNOTE 4.3.7): assinatura PK\x03\x04, hora DOS em +10,
 * data DOS em +12, tamanho do nome em +26, extra em +28, nome em +30.
 */
function readZipEntryMtime(zip: Uint8Array, name: string): Date | null {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const decoder = new TextDecoder();
  let offset = 0;

  while (offset + 30 <= zip.length) {
    if (view.getUint32(offset, true) !== 0x04034b50) break;
    const nameLength = view.getUint16(offset + 26, true);
    const extraLength = view.getUint16(offset + 28, true);
    const entryName = decoder.decode(
      zip.subarray(offset + 30, offset + 30 + nameLength)
    );

    if (entryName === name) {
      const time = view.getUint16(offset + 10, true);
      const date = view.getUint16(offset + 12, true);
      return new Date(
        1980 + ((date >> 9) & 0x7f),
        ((date >> 5) & 0x0f) - 1,
        date & 0x1f,
        (time >> 11) & 0x1f,
        (time >> 5) & 0x3f,
        (time & 0x1f) * 2
      );
    }

    const compressedSize = view.getUint32(offset + 18, true);
    offset += 30 + nameLength + extraLength + compressedSize;
  }
  return null;
}

describe('buildConversationZip', () => {
  const baseInput = () => ({
    pdfBytes: new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]),
    pdfName: 'conversa-maria-silva-2026-09-02.pdf',
    plan: [planEntry()],
    media: new Map([[1, fetched()]]),
    manifest: `${BOM}"a"\r\n"b"`,
    readme: 'leia-me',
    now: new Date('2026-09-02T10:00:00.000Z'),
  });

  it('descompacta e contém exatamente as entradas planejadas', () => {
    const zip = buildConversationZip(baseInput());
    const entries = Object.keys(unzipSync(zip)).sort();

    expect(entries).toEqual(
      [
        'conversa-maria-silva-2026-09-02.pdf',
        README_FILENAME,
        MANIFEST_FILENAME,
        'midias/0001-image-3f2a1b9c.jpg',
      ].sort()
    );
  });

  it('preserva os bytes de cada arquivo', () => {
    const input = baseInput();
    const unzipped = unzipSync(buildConversationZip(input));

    expect(Array.from(unzipped['midias/0001-image-3f2a1b9c.jpg'])).toEqual([
      1, 2, 3, 4, 5,
    ]);
    expect(strFromU8(unzipped[README_FILENAME])).toBe('leia-me');
    // O BOM é conferido nos BYTES, não na string: `TextDecoder` (e
    // portanto `strFromU8`) descarta o BOM inicial ao decodificar, o que
    // faria um teste em string concluir que ele se perdeu. Quem precisa
    // dele é o Excel, que lê os bytes.
    expect(Array.from(unzipped[MANIFEST_FILENAME].slice(0, 3))).toEqual([
      0xef, 0xbb, 0xbf,
    ]);
  });

  it('mídia com status diferente de ok NÃO vira arquivo', () => {
    const input = {
      ...baseInput(),
      plan: [
        planEntry({ index: 1 }),
        planEntry({
          index: 2,
          messageId: 'm2',
          zipPath: 'midias/0002-video-aaaaaaaa.mp4',
          contentType: 'video',
        }),
        planEntry({
          index: 3,
          messageId: 'm3',
          zipPath: 'midias/0003-audio-bbbbbbbb.ogg',
          contentType: 'audio',
        }),
      ],
      media: new Map<number, FetchedMedia>([
        [1, fetched()],
        [
          2,
          fetched({ index: 2, status: 'missing', bytes: null, byteLength: 0 }),
        ],
        [
          3,
          fetched({
            index: 3,
            status: 'too_large',
            bytes: null,
            byteLength: 0,
          }),
        ],
      ]),
    };

    const entries = Object.keys(unzipSync(buildConversationZip(input)));
    expect(entries).toContain('midias/0001-image-3f2a1b9c.jpg');
    expect(entries).not.toContain('midias/0002-video-aaaaaaaa.mp4');
    expect(entries).not.toContain('midias/0003-audio-bbbbbbbb.ogg');
  });

  it('duplicata não gera segunda entrada — o objeto é o mesmo', () => {
    const shared = fetched();
    const input = {
      ...baseInput(),
      plan: [
        planEntry({ index: 1, messageId: 'm1' }),
        planEntry({ index: 2, messageId: 'm2', duplicateOfIndex: 1 }),
      ],
      media: new Map<number, FetchedMedia>([
        [1, shared],
        [2, { ...shared, index: 2 }],
      ]),
    };

    const entries = Object.keys(unzipSync(buildConversationZip(input)));
    expect(entries.filter((e) => e.startsWith('midias/'))).toHaveLength(1);
  });

  it('mtime da mídia bate com o created_at da mensagem', () => {
    const createdAt = '2026-08-12T14:32:10.000Z';
    const input = {
      ...baseInput(),
      plan: [planEntry({ createdAt })],
    };

    const zip = buildConversationZip(input);
    const mtime = readZipEntryMtime(zip, 'midias/0001-image-3f2a1b9c.jpg');
    const expected = new Date(createdAt);

    expect(mtime).not.toBeNull();
    // A data DOS tem resolução de 2 segundos e não guarda fuso — a
    // comparação é contra a hora local do mesmo instante.
    expect(mtime!.getFullYear()).toBe(expected.getFullYear());
    expect(mtime!.getMonth()).toBe(expected.getMonth());
    expect(mtime!.getDate()).toBe(expected.getDate());
    expect(mtime!.getHours()).toBe(expected.getHours());
    expect(mtime!.getMinutes()).toBe(expected.getMinutes());
  });

  it('plano vazio ainda produz um pacote com PDF, manifesto e leia-me', () => {
    const zip = buildConversationZip({
      ...baseInput(),
      plan: [],
      media: new Map(),
    });
    expect(Object.keys(unzipSync(zip)).sort()).toEqual(
      [
        'conversa-maria-silva-2026-09-02.pdf',
        README_FILENAME,
        MANIFEST_FILENAME,
      ].sort()
    );
  });
});

describe('buildMediaManifestCsv', () => {
  it('tem BOM, CRLF e todas as células citadas', () => {
    const csv = buildMediaManifestCsv(
      [planEntry()],
      new Map([[1, fetched()]]),
      [bubbleBlock('m1')],
      manifestLabels
    );

    expect(csv.startsWith(BOM)).toBe(true);
    const [header, first] = csv.slice(BOM.length).split('\r\n');
    expect(header).toBe(
      '"arquivo","indice","data_hora","remetente","tipo","nome_exibido","tamanho_bytes","status","mensagem_id"'
    );
    expect(first).toBe(
      '"midias/0001-image-3f2a1b9c.jpg","1","2026-08-12 14:32","Maria Silva (cliente)","Imagem","comprovante.jpg","5","ok","m1"'
    );
  });

  it('mídia ausente aparece no manifesto com o status, sem nome de arquivo', () => {
    const csv = buildMediaManifestCsv(
      [planEntry({ index: 1 })],
      new Map([
        [1, fetched({ status: 'missing', bytes: null, byteLength: 0 })],
      ]),
      [bubbleBlock('m1')],
      manifestLabels
    );

    const row = csv.split('\r\n')[1];
    expect(row).toContain('"ausente"');
    expect(row).not.toContain('midias/');
    expect(row).toContain('"comprovante.jpg"');
  });

  it('duplicata aparece como linha própria, apontando para o mesmo arquivo', () => {
    const csv = buildMediaManifestCsv(
      [
        planEntry({ index: 1, messageId: 'm1' }),
        planEntry({ index: 2, messageId: 'm2', duplicateOfIndex: 1 }),
      ],
      new Map<number, FetchedMedia>([
        [1, fetched()],
        [2, fetched({ index: 2 })],
      ]),
      [bubbleBlock('m1'), bubbleBlock('m2', 'João Pereira')],
      manifestLabels
    );

    const rows = csv.split('\r\n');
    expect(rows).toHaveLength(3);
    expect(rows[1]).toContain('"m1"');
    expect(rows[2]).toContain('"m2"');
    expect(rows[2]).toContain('"João Pereira"');
    // Mesmo arquivo nas duas linhas — é esse vínculo que o manifesto
    // existe para registrar.
    expect(rows[1]).toContain('"midias/0001-image-3f2a1b9c.jpg"');
    expect(rows[2]).toContain('"midias/0001-image-3f2a1b9c.jpg"');
  });

  it('remetente vazio quando a mensagem não está nos blocos', () => {
    const csv = buildMediaManifestCsv(
      [planEntry({ messageId: 'fora' })],
      new Map([[1, fetched()]]),
      [],
      manifestLabels
    );
    expect(csv.split('\r\n')[1]).toContain('"",');
  });

  it('aspas no nome do arquivo são escapadas (RFC 4180)', () => {
    const csv = buildMediaManifestCsv(
      [planEntry({ displayName: 'nota "final".pdf' })],
      new Map([[1, fetched()]]),
      [bubbleBlock('m1')],
      manifestLabels
    );
    expect(csv).toContain('"nota ""final"".pdf"');
  });
});

describe('buildReadmeText', () => {
  it('traz identificação, conteúdo e as ressalvas', () => {
    const readme = buildReadmeText(
      {
        contactName: 'Maria Silva',
        exportedByLabel: 'João Pereira em 02/09/2026 às 14:31',
        exportId: '1111-2222',
        pdfName: 'conversa-maria-silva-2026-09-02.pdf',
        includedMediaCount: 2,
        totalMediaCount: 3,
      },
      readmeLabels
    );

    expect(readme).toContain('Contato: Maria Silva');
    expect(readme).toContain('ID da exportação: 1111-2222');
    expect(readme).toContain('Mídias na pasta midias/: 2 de 3');
    expect(readme).toContain(MANIFEST_FILENAME);
    expect(readme).toContain('Figurinhas e vídeos');
    expect(readme).toContain('dados pessoais');
    expect(readme.split('\r\n').length).toBeGreaterThanOrEqual(10);
  });
});

describe('conversationExportFilename', () => {
  const now = new Date('2026-09-02T23:59:00.000Z');

  it('monta <prefixo>-<slug>-<data>.<formato>', () => {
    expect(
      conversationExportFilename('conversa', 'Maria Silva', 'pdf', now)
    ).toBe('conversa-maria-silva-2026-09-02.pdf');
    expect(
      conversationExportFilename('conversa', 'Maria Silva', 'zip', now)
    ).toBe('conversa-maria-silva-2026-09-02.zip');
  });

  it('remove acentuação e pontuação do nome', () => {
    expect(
      conversationExportFilename('conversa', "José Antônio D'Ávila", 'pdf', now)
    ).toBe('conversa-jose-antonio-d-avila-2026-09-02.pdf');
  });

  it('nome vazio, só emoji ou não-latino cai em "contato"', () => {
    expect(conversationExportFilename('conversa', '', 'zip', now)).toBe(
      'conversa-contato-2026-09-02.zip'
    );
    expect(conversationExportFilename('conversa', '👍👍', 'zip', now)).toBe(
      'conversa-contato-2026-09-02.zip'
    );
  });

  it('nome muito longo é truncado sem deixar hífen solto', () => {
    const name = 'Maria '.repeat(30);
    const filename = conversationExportFilename('conversa', name, 'pdf', now);
    expect(filename.length).toBeLessThan(70);
    expect(filename).not.toContain('--');
    expect(filename.endsWith('-2026-09-02.pdf')).toBe(true);
  });
});
