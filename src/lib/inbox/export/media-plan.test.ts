import { describe, expect, it } from 'vitest';
import { buildMediaPlan } from './media-plan';
import type {
  TranscriptAttachment,
  TranscriptBlock,
  TranscriptBubble,
} from './model';
import type { MediaRef } from '@/lib/storage/media-url';

function bubbleBlock(
  overrides: Partial<TranscriptBubble> = {}
): TranscriptBlock {
  const bubble: TranscriptBubble = {
    messageId: 'msg-1',
    side: 'left',
    senderLabel: 'Maria (cliente)',
    timeLabel: '10:00',
    statusLabel: null,
    text: [],
    badges: [],
    quote: null,
    reactions: [],
    buttons: [],
    attachment: null,
    errorText: null,
    ...overrides,
  };
  return { kind: 'bubble', bubble };
}

function attachment(
  overrides: Partial<TranscriptAttachment>
): TranscriptAttachment {
  return {
    messageId: 'msg-1',
    contentType: 'image',
    ref: { kind: 'storage', bucket: 'chat-media', path: 'acc-1/foo.jpg' },
    displayName: 'foo.jpg',
    caption: null,
    createdAt: '2026-08-12T14:32:00.000Z',
    channelId: 'channel-a',
    ...overrides,
  };
}

describe('buildMediaPlan', () => {
  it('gera índice 1-based com 4 dígitos, na ordem cronológica', () => {
    const blocks: TranscriptBlock[] = [
      bubbleBlock({
        messageId: 'm1',
        attachment: attachment({
          messageId: 'm1',
          ref: { kind: 'storage', bucket: 'chat-media', path: 'acc-1/a.jpg' },
        }),
      }),
      { kind: 'day', label: '13 de agosto' },
      bubbleBlock({
        messageId: 'm2',
        attachment: attachment({
          messageId: 'm2',
          ref: { kind: 'storage', bucket: 'chat-media', path: 'acc-1/b.mp4' },
          contentType: 'video',
        }),
      }),
    ];
    const plan = buildMediaPlan(blocks);
    expect(plan).toHaveLength(2);
    expect(plan[0].index).toBe(1);
    expect(plan[0].zipPath).toMatch(/^midias\/0001-image-[a-f0-9]{8}\.jpg$/);
    expect(plan[1].index).toBe(2);
    expect(plan[1].zipPath).toMatch(/^midias\/0002-video-[a-f0-9]{8}\.mp4$/);
  });

  it('deduplica duas mensagens que apontam para o mesmo objeto (encaminhamento)', () => {
    const sharedRef: MediaRef = {
      kind: 'storage',
      bucket: 'chat-media',
      path: 'acc-1/catalogo.pdf',
    };
    const blocks: TranscriptBlock[] = [
      bubbleBlock({
        messageId: 'm1',
        attachment: attachment({
          messageId: 'm1',
          contentType: 'document',
          ref: sharedRef,
        }),
      }),
      bubbleBlock({
        messageId: 'm2',
        attachment: attachment({
          messageId: 'm2',
          contentType: 'document',
          ref: sharedRef,
        }),
      }),
    ];
    const plan = buildMediaPlan(blocks);
    expect(plan).toHaveLength(2);
    expect(plan[0].duplicateOfIndex).toBeNull();
    expect(plan[1].duplicateOfIndex).toBe(1);
    expect(plan[1].zipPath).toBe(plan[0].zipPath);
  });

  it('não deduplica objetos diferentes mesmo com mesmo tipo/extensão', () => {
    const blocks: TranscriptBlock[] = [
      bubbleBlock({
        messageId: 'm1',
        attachment: attachment({
          messageId: 'm1',
          ref: { kind: 'storage', bucket: 'chat-media', path: 'acc-1/a.jpg' },
        }),
      }),
      bubbleBlock({
        messageId: 'm2',
        attachment: attachment({
          messageId: 'm2',
          ref: { kind: 'storage', bucket: 'chat-media', path: 'acc-1/b.jpg' },
        }),
      }),
    ];
    const plan = buildMediaPlan(blocks);
    expect(plan[1].duplicateOfIndex).toBeNull();
    expect(plan[1].zipPath).not.toBe(plan[0].zipPath);
  });

  it('zipPath nunca contém .. nem / fora do prefixo midias/, nem byte nulo', () => {
    const maliciousId = '../../etc/passwd';
    const blocks: TranscriptBlock[] = [
      bubbleBlock({
        messageId: maliciousId,
        attachment: attachment({
          messageId: maliciousId,
          ref: { kind: 'external', url: 'https://evil.example/x' },
        }),
      }),
    ];
    const plan = buildMediaPlan(blocks);
    const rest = plan[0].zipPath.slice('midias/'.length);
    expect(plan[0].zipPath.startsWith('midias/')).toBe(true);
    expect(rest).not.toContain('/');
    expect(rest).not.toContain('..');
    // Byte nulo montado por código: como caractere literal ele torna o
    // arquivo "binário" para grep/diff e some de qualquer cópia.
    expect(plan[0].zipPath).not.toContain(String.fromCharCode(0));
  });

  it('extensão vem do basename do objeto, com bin de último recurso', () => {
    const blocks: TranscriptBlock[] = [
      bubbleBlock({
        messageId: 'm1',
        attachment: attachment({
          messageId: 'm1',
          contentType: 'audio',
          ref: {
            kind: 'proxy',
            url: '/api/whatsapp/media/xyz',
            mediaId: 'xyz',
          },
        }),
      }),
    ];
    const plan = buildMediaPlan(blocks);
    expect(plan[0].zipPath.endsWith('.bin')).toBe(true);
  });

  it('ignora bolhas sem attachment e mensagens de texto', () => {
    const blocks: TranscriptBlock[] = [
      bubbleBlock({ attachment: null }),
      { kind: 'day', label: '12 de agosto' },
    ];
    expect(buildMediaPlan(blocks)).toEqual([]);
  });

  it('propaga o channelId do anexo — é dele que sai o token do download proxy', () => {
    const blocks: TranscriptBlock[] = [
      bubbleBlock({
        attachment: attachment({ channelId: 'channel-b' }),
      }),
    ];
    expect(buildMediaPlan(blocks)[0].channelId).toBe('channel-b');
  });

  it('displayName reaproveita o nome já calculado pelo modelo', () => {
    const blocks: TranscriptBlock[] = [
      bubbleBlock({
        attachment: attachment({
          displayName: 'comprovante.pdf',
          contentType: 'document',
        }),
      }),
    ];
    const plan = buildMediaPlan(blocks);
    expect(plan[0].displayName).toBe('comprovante.pdf');
  });
});
