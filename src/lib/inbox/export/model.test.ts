import { describe, expect, it } from 'vitest';
import {
  buildTranscript,
  deriveMediaFilename,
  guessExtensionFromRef,
  sanitizeFilename,
  type FormatDateTime,
  type ThreadExportData,
  type TranscriptLabels,
} from './model';
import type { MediaRef } from '@/lib/storage/media-url';
import type { Contact, Conversation, Message, MessageReaction } from '@/types';

const labels: TranscriptLabels = {
  customerSender: (name) => `${name} (cliente)`,
  customerWord: 'cliente',
  bot: 'Bot (IA)',
  unknownAgent: 'Agente removido',
  statusSent: 'enviada',
  statusDelivered: 'entregue',
  statusRead: 'lida',
  statusFailed: 'falhou',
  favoriteBadge: '★ favorita',
  aiBadge: 'IA',
  campaignBadge: (name) => `Campanha: ${name}`,
  templateBadge: (name) => `Template: ${name}`,
  channelDeviationBadge: 'Enviado por outro canal',
  buttonReply: 'Resposta de botão',
  locationLabel: 'Localização',
};

const formatDateTime: FormatDateTime = (iso, style) => {
  const date = new Date(iso);
  if (style === 'day') return date.toISOString().slice(0, 10);
  return date.toISOString().slice(11, 16);
};

const contact: Contact = {
  id: 'contact-1',
  user_id: 'u1',
  account_id: 'acc-1',
  phone: '5511999999999',
  name: 'Maria',
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
};

const conversation: Conversation = {
  id: 'conv-1',
  user_id: 'u1',
  account_id: 'acc-1',
  contact_id: 'contact-1',
  status: 'open',
  unread_count: 0,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
  channel_id: 'channel-conv',
};

function baseMessage(overrides: Partial<Message>): Message {
  return {
    id: overrides.id ?? 'msg-1',
    conversation_id: 'conv-1',
    sender_type: 'customer',
    content_type: 'text',
    status: 'delivered',
    created_at: '2026-08-12T14:32:00.000Z',
    ...overrides,
  };
}

function buildData(
  overrides: Partial<ThreadExportData> = {}
): ThreadExportData {
  return {
    conversation,
    contact,
    channel: null,
    agentNames: new Map(),
    messages: [],
    reactions: [],
    truncated: false,
    total: 0,
    ...overrides,
  };
}

function firstBubble(blocks: ReturnType<typeof buildTranscript>) {
  const block = blocks.find((b) => b.kind === 'bubble');
  if (!block || block.kind !== 'bubble') throw new Error('no bubble found');
  return block.bubble;
}

describe('buildTranscript — mapeamento por content_type', () => {
  it('text vira bolha só com texto', () => {
    const data = buildData({
      messages: [
        baseMessage({ content_type: 'text', content_text: 'Oi\ntudo bem?' }),
      ],
    });
    const bubble = firstBubble(buildTranscript(data, labels, formatDateTime));
    expect(bubble.text).toEqual(['Oi', 'tudo bem?']);
    expect(bubble.attachment).toBeNull();
  });

  it('image/video/audio/document vira bolha com attachment; content_text vira caption', () => {
    const data = buildData({
      messages: [
        baseMessage({
          content_type: 'image',
          content_text: 'legenda da foto',
          media_path: 'acc-1/foo.jpg',
        }),
      ],
    });
    const bubble = firstBubble(buildTranscript(data, labels, formatDateTime));
    expect(bubble.text).toEqual([]);
    expect(bubble.attachment).not.toBeNull();
    expect(bubble.attachment?.caption).toBe('legenda da foto');
    expect(bubble.attachment?.contentType).toBe('image');
  });

  it('anexo de mídia RECEBIDA herda o canal da conversa (ingest.ts não grava channel_id)', () => {
    const data = buildData({
      messages: [
        baseMessage({
          content_type: 'image',
          media_url: '/api/whatsapp/media/xyz',
        }),
      ],
    });
    const bubble = firstBubble(buildTranscript(data, labels, formatDateTime));
    // Sem isto, o download `proxy` usaria o token do canal padrão da
    // conta e a Graph API devolveria 404 numa conta com dois números
    // oficiais (SPEC 064).
    expect(bubble.attachment?.channelId).toBe('channel-conv');
  });

  it('anexo carrega o created_at CRU, não o rótulo formatado', () => {
    const data = buildData({
      messages: [
        baseMessage({
          content_type: 'image',
          created_at: '2026-08-12T14:32:10.000Z',
          media_path: 'acc-1/foo.jpg',
        }),
      ],
    });
    const bubble = firstBubble(buildTranscript(data, labels, formatDateTime));
    // Vira o `mtime` da entrada no zip e a coluna `data_hora` do
    // manifesto — `timeLabel` ("14:32") não serviria para nenhum dos dois.
    expect(bubble.attachment?.createdAt).toBe('2026-08-12T14:32:10.000Z');
    expect(bubble.timeLabel).toBe('14:32');
  });

  it('anexo de SAÍDA com desvio de canal usa o channel_id da mensagem', () => {
    const data = buildData({
      messages: [
        baseMessage({
          sender_type: 'agent',
          content_type: 'document',
          channel_id: 'channel-qr',
          media_path: 'acc-1/contrato.pdf',
        }),
      ],
    });
    const bubble = firstBubble(buildTranscript(data, labels, formatDateTime));
    expect(bubble.attachment?.channelId).toBe('channel-qr');
  });

  it('template com template_preview vira header+body+footer como parágrafos e badge', () => {
    const data = buildData({
      messages: [
        baseMessage({
          content_type: 'template',
          template_name: 'boas_vindas',
          template_preview: {
            header: 'Bem-vindo',
            body: 'Obrigado por entrar em contato',
            footer: 'Equipe',
            buttons: [{ type: 'QUICK_REPLY', text: 'Falar com humano' }],
          },
        }),
      ],
    });
    const bubble = firstBubble(buildTranscript(data, labels, formatDateTime));
    expect(bubble.text).toEqual([
      'Bem-vindo',
      'Obrigado por entrar em contato',
      'Equipe',
    ]);
    expect(bubble.buttons).toEqual(['Falar com humano']);
    expect(bubble.badges).toContain('Template: boas_vindas');
  });

  it('template sem preview degrada para badge + content_text cru', () => {
    const data = buildData({
      messages: [
        baseMessage({
          content_type: 'template',
          template_name: 'antigo',
          content_text: 'texto cru do envio pré-037',
        }),
      ],
    });
    const bubble = firstBubble(buildTranscript(data, labels, formatDateTime));
    expect(bubble.text).toEqual(['texto cru do envio pré-037']);
    expect(bubble.badges).toContain('Template: antigo');
  });

  it('interactive de saída com payload vira corpo + buttons', () => {
    const data = buildData({
      messages: [
        baseMessage({
          sender_type: 'agent',
          content_type: 'interactive',
          interactive_payload: {
            kind: 'buttons',
            body: 'Escolha uma opção',
            buttons: [
              { id: 'a', title: 'Sim' },
              { id: 'b', title: 'Não' },
            ],
          },
        }),
      ],
    });
    const bubble = firstBubble(buildTranscript(data, labels, formatDateTime));
    expect(bubble.text).toEqual(['Escolha uma opção']);
    expect(bubble.buttons).toEqual(['Sim', 'Não']);
  });

  it('interactive de entrada prefixa com buttonReply e o interactive_reply_id entre parênteses', () => {
    const data = buildData({
      messages: [
        baseMessage({
          sender_type: 'customer',
          content_type: 'interactive',
          content_text: 'Sim',
          interactive_reply_id: 'opt-a',
        }),
      ],
    });
    const bubble = firstBubble(buildTranscript(data, labels, formatDateTime));
    expect(bubble.text).toEqual(['Resposta de botão: Sim (opt-a)']);
  });

  it('location vira bolha com rótulo location e as coordenadas do content_text', () => {
    const data = buildData({
      messages: [
        baseMessage({
          content_type: 'location',
          content_text: '-23.55,-46.63',
        }),
      ],
    });
    const bubble = firstBubble(buildTranscript(data, labels, formatDateTime));
    expect(bubble.text).toEqual(['Localização: -23.55,-46.63']);
  });

  it('status failed preenche statusLabel e errorText a partir de error_message', () => {
    const data = buildData({
      messages: [
        baseMessage({
          sender_type: 'agent',
          status: 'failed',
          error_message: '(#131) Recipient number not on WhatsApp',
        }),
      ],
    });
    const bubble = firstBubble(buildTranscript(data, labels, formatDateTime));
    expect(bubble.statusLabel).toBe('falhou');
    expect(bubble.errorText).toBe('(#131) Recipient number not on WhatsApp');
  });

  it('is_favorite gera badge genérico, nunca personalizado', () => {
    const data = buildData({
      messages: [baseMessage({ is_favorite: true })],
    });
    const bubble = firstBubble(buildTranscript(data, labels, formatDateTime));
    expect(bubble.badges).toEqual(['★ favorita']);
  });

  it('channel_id diferente do canal da conversa gera badge de desvio', () => {
    const data = buildData({
      messages: [
        baseMessage({ sender_type: 'agent', channel_id: 'channel-other' }),
      ],
    });
    const bubble = firstBubble(buildTranscript(data, labels, formatDateTime));
    expect(bubble.badges).toContain('Enviado por outro canal');
  });

  it('broadcast.name gera badge de campanha', () => {
    const data = buildData({
      messages: [
        baseMessage({
          sender_type: 'agent',
          broadcast: { name: 'Black Friday' },
        }),
      ],
    });
    const bubble = firstBubble(buildTranscript(data, labels, formatDateTime));
    expect(bubble.badges).toContain('Campanha: Black Friday');
  });

  it('ai_generated gera badge IA', () => {
    const data = buildData({
      messages: [baseMessage({ sender_type: 'bot', ai_generated: true })],
    });
    const bubble = firstBubble(buildTranscript(data, labels, formatDateTime));
    expect(bubble.badges).toContain('IA');
    expect(bubble.senderLabel).toBe('Bot (IA)');
  });
});

describe('buildTranscript — separador de dia', () => {
  it('aparece na virada e não aparece entre duas mensagens do mesmo dia', () => {
    const data = buildData({
      messages: [
        baseMessage({ id: 'm1', created_at: '2026-08-12T09:00:00.000Z' }),
        baseMessage({ id: 'm2', created_at: '2026-08-12T10:00:00.000Z' }),
        baseMessage({ id: 'm3', created_at: '2026-08-13T09:00:00.000Z' }),
      ],
    });
    const blocks = buildTranscript(data, labels, formatDateTime);
    const dayBlocks = blocks.filter((b) => b.kind === 'day');
    expect(dayBlocks).toHaveLength(2);
    // ordem: dia, bolha, bolha, dia, bolha
    expect(blocks.map((b) => b.kind)).toEqual([
      'day',
      'bubble',
      'bubble',
      'day',
      'bubble',
    ]);
  });
});

describe('buildTranscript — agente removido', () => {
  it('usa unknownAgent e nunca vaza o UUID', () => {
    const data = buildData({
      messages: [
        baseMessage({ sender_type: 'agent', sender_id: 'user-removido-123' }),
      ],
      agentNames: new Map(),
    });
    const bubble = firstBubble(buildTranscript(data, labels, formatDateTime));
    expect(bubble.senderLabel).toBe('Agente removido');
    expect(bubble.senderLabel).not.toContain('user-removido-123');
  });
});

describe('buildTranscript — citação (reply_to_message_id)', () => {
  it('aponta para dentro do período exportado e traz snippet + remetente', () => {
    const data = buildData({
      messages: [
        baseMessage({
          id: 'm1',
          content_text: 'Qual o horário de funcionamento?',
        }),
        baseMessage({
          id: 'm2',
          sender_type: 'agent',
          content_text: 'Das 9h às 18h',
          reply_to_message_id: 'm1',
        }),
      ],
    });
    const blocks = buildTranscript(data, labels, formatDateTime);
    const reply = blocks
      .filter((b) => b.kind === 'bubble')
      .map((b) => (b.kind === 'bubble' ? b.bubble : null))
      .find((b) => b?.messageId === 'm2');
    expect(reply?.quote).toEqual({
      senderLabel: 'Maria (cliente)',
      snippet: 'Qual o horário de funcionamento?',
    });
  });

  it('apontando para fora do período exportado devolve quote null sem estourar', () => {
    const data = buildData({
      messages: [
        baseMessage({
          id: 'm2',
          sender_type: 'agent',
          reply_to_message_id: 'fora-do-periodo',
        }),
      ],
    });
    const bubble = firstBubble(buildTranscript(data, labels, formatDateTime));
    expect(bubble.quote).toBeNull();
  });
});

describe('buildTranscript — reações', () => {
  it('mapeia actor_type para o rótulo correto', () => {
    const reactions: MessageReaction[] = [
      {
        id: 'r1',
        message_id: 'm1',
        conversation_id: 'conv-1',
        actor_type: 'customer',
        emoji: '👍',
        created_at: '2026-08-12T09:00:00.000Z',
      },
      {
        id: 'r2',
        message_id: 'm1',
        conversation_id: 'conv-1',
        actor_type: 'agent',
        actor_id: 'agent-1',
        emoji: '❤️',
        created_at: '2026-08-12T09:01:00.000Z',
      },
    ];
    const data = buildData({
      messages: [baseMessage({ id: 'm1' })],
      reactions,
      agentNames: new Map([['agent-1', 'João']]),
    });
    const bubble = firstBubble(buildTranscript(data, labels, formatDateTime));
    expect(bubble.reactions).toEqual(['👍 cliente', '❤️ João']);
  });
});

describe('deriveMediaFilename', () => {
  const noneRef: MediaRef = { kind: 'none' };
  const storageRef = (path: string): MediaRef => ({
    kind: 'storage',
    bucket: 'chat-media',
    path,
  });

  it('nome com extensão vence', () => {
    const name = deriveMediaFilename(
      'document',
      'fatura-2026.pdf',
      storageRef('acc-1/abcxyz.bin'),
      'msg-12345678-abcd'
    );
    expect(name).toBe('fatura-2026.pdf');
  });

  it('legenda de duas linhas não vira nome — cai no basename', () => {
    const name = deriveMediaFilename(
      'document',
      'Contrato assinado\nsegunda via.pdf',
      storageRef('acc-1/contrato-final.pdf'),
      'msg-12345678-abcd'
    );
    expect(name).toBe('contrato-final.pdf');
  });

  it('sem caption e sem basename cai no fallback tipo-hash.ext', () => {
    const name = deriveMediaFilename(
      'audio',
      null,
      noneRef,
      'abcdef1234567890'
    );
    expect(name).toBe('audio-abcdef12.bin');
  });

  it('basename com travessia de caminho é neutralizado', () => {
    const name = deriveMediaFilename(
      'document',
      null,
      storageRef('../../etc/passwd.pdf'),
      'msg-1'
    );
    expect(name).not.toContain('/');
    expect(name).not.toContain('..');
  });

  it('nome de 300 caracteres é truncado para 100', () => {
    const longCaption = `${'a'.repeat(295)}.pdf`;
    const name = deriveMediaFilename('document', longCaption, noneRef, 'msg-1');
    expect(name.length).toBeLessThanOrEqual(100);
  });
});

describe('sanitizeFilename', () => {
  it('remove caractere de controle, inclusive byte nulo', () => {
    const charCodes = [102, 111, 0, 116, 111, 7, 46, 106, 112, 103];
    const withControlChars = charCodes
      .map((code) => String.fromCharCode(code))
      .join('');
    expect(sanitizeFilename(withControlChars)).toBe('foto.jpg');
  });

  it('não deixa barra nem sequência de pontos sobrar', () => {
    const sanitized = sanitizeFilename('../../etc/passwd');
    expect(sanitized).not.toMatch(/\.\.+/);
    expect(sanitized).not.toContain('/');
    expect(sanitized).not.toContain('\\');
  });

  it('string vazia após sanitização vira "arquivo"', () => {
    expect(sanitizeFilename('')).toBe('arquivo');
  });
});

describe('guessExtensionFromRef', () => {
  it('extrai extensão do basename quando existe', () => {
    expect(
      guessExtensionFromRef({
        kind: 'storage',
        bucket: 'chat-media',
        path: 'a/b/c.MP4',
      })
    ).toBe('mp4');
  });

  it('bin quando não há extensão reconhecível', () => {
    expect(guessExtensionFromRef({ kind: 'none' })).toBe('bin');
  });
});
