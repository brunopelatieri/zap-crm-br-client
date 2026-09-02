import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

vi.mock('@/lib/whatsapp/cloud-channels', () => ({
  resolveCloudConfig: vi.fn(),
}));
vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: vi.fn((value: string) => `plain:${value}`),
}));
vi.mock('@/lib/whatsapp/meta-api', () => ({
  getMediaUrl: vi.fn(),
  downloadMedia: vi.fn(),
}));
vi.mock('@/lib/webhooks/ssrf', () => ({
  isDeliverableUrl: vi.fn(async () => true),
}));

import { ChannelNotConfiguredError } from '@/lib/channels/errors';
import { resolveCloudConfig } from '@/lib/whatsapp/cloud-channels';
import { downloadMedia, getMediaUrl } from '@/lib/whatsapp/meta-api';
import { isDeliverableUrl } from '@/lib/webhooks/ssrf';
import {
  DEFAULT_MEDIA_FETCH_LIMITS,
  fetchMediaBytes,
  type MediaFetchLimits,
} from './fetch-media';
import type { MediaPlanEntry } from './media-plan';

const ACCOUNT_ID = 'acc-1';

function planEntry(overrides: Partial<MediaPlanEntry> = {}): MediaPlanEntry {
  return {
    index: 1,
    messageId: 'm1',
    ref: { kind: 'storage', bucket: 'chat-media', path: 'acc-1/foo.jpg' },
    contentType: 'image',
    zipPath: 'midias/0001-image-aaaaaaaa.jpg',
    displayName: 'foo.jpg',
    createdAt: '2026-08-12T14:32:00.000Z',
    channelId: 'channel-a',
    duplicateOfIndex: null,
    ...overrides,
  };
}

/** Stub de Storage: `download(path)` resolve conforme o mapa. Um valor
 *  `Error` faz a promessa REJEITAR (o caso "um reject no meio"). */
function makeSupabase(
  downloads: Record<string, Blob | { error: string } | Error>
): SupabaseClient {
  return {
    storage: {
      from: () => ({
        download: (path: string) => {
          const entry = downloads[path];
          if (entry instanceof Error) return Promise.reject(entry);
          if (!entry || 'error' in entry) {
            return Promise.resolve({
              data: null,
              error: { message: entry?.error ?? 'Object not found' },
            });
          }
          return Promise.resolve({ data: entry, error: null });
        },
      }),
    },
  } as unknown as SupabaseClient;
}

function blobOf(size: number, type = 'image/jpeg'): Blob {
  return new Blob([new Uint8Array(size)], { type });
}

const limits: MediaFetchLimits = {
  ...DEFAULT_MEDIA_FETCH_LIMITS,
  concurrency: 2,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(isDeliverableUrl).mockResolvedValue(true);
});

describe('fetchMediaBytes — origem storage', () => {
  it('baixa do bucket privado e devolve os bytes', async () => {
    const supabase = makeSupabase({ 'acc-1/foo.jpg': blobOf(10) });

    const result = await fetchMediaBytes(
      supabase,
      ACCOUNT_ID,
      [planEntry()],
      limits
    );

    const media = result.get(1)!;
    expect(media.status).toBe('ok');
    expect(media.byteLength).toBe(10);
    expect(media.mimeType).toBe('image/jpeg');
    expect(media.bytes).toBeInstanceOf(Uint8Array);
  });

  it('objeto negado pela policy vira missing, não error', async () => {
    const supabase = makeSupabase({});

    const result = await fetchMediaBytes(
      supabase,
      ACCOUNT_ID,
      [planEntry()],
      limits
    );

    expect(result.get(1)?.status).toBe('missing');
    expect(result.get(1)?.bytes).toBeNull();
  });

  it('arquivo acima de maxFileBytes vira too_large e não consome o teto global', async () => {
    const supabase = makeSupabase({
      'acc-1/big.mp4': blobOf(50, 'video/mp4'),
      'acc-1/foo.jpg': blobOf(10),
    });

    const result = await fetchMediaBytes(
      supabase,
      ACCOUNT_ID,
      [
        planEntry({
          index: 1,
          ref: { kind: 'storage', bucket: 'chat-media', path: 'acc-1/big.mp4' },
        }),
        planEntry({ index: 2 }),
      ],
      { ...limits, maxFileBytes: 20, maxTotalBytes: 30, concurrency: 1 }
    );

    expect(result.get(1)?.status).toBe('too_large');
    expect(result.get(2)?.status).toBe('ok');
  });
});

describe('fetchMediaBytes — origem proxy (Meta)', () => {
  it('usa o token DO CANAL da mensagem, não o do canal padrão', async () => {
    vi.mocked(resolveCloudConfig).mockResolvedValue({
      channel: {} as never,
      config: { access_token: 'cipher-b' } as never,
    });
    vi.mocked(getMediaUrl).mockResolvedValue({
      url: 'https://lookaside.meta/x',
      mimeType: 'audio/ogg',
    });
    vi.mocked(downloadMedia).mockResolvedValue({
      buffer: Buffer.alloc(8),
      contentType: 'audio/ogg',
    });

    const result = await fetchMediaBytes(
      makeSupabase({}),
      ACCOUNT_ID,
      [
        planEntry({
          contentType: 'audio',
          channelId: 'channel-b',
          ref: {
            kind: 'proxy',
            url: '/api/whatsapp/media/xyz',
            mediaId: 'xyz',
          },
        }),
      ],
      limits
    );

    // Regressão da SPEC 064: "simplificar" para o canal padrão
    // (`undefined`) devolveria 404 da Graph API numa conta com dois
    // números oficiais.
    expect(resolveCloudConfig).toHaveBeenCalledWith(
      expect.anything(),
      ACCOUNT_ID,
      'channel-b'
    );
    expect(getMediaUrl).toHaveBeenCalledWith({
      mediaId: 'xyz',
      accessToken: 'plain:cipher-b',
    });
    expect(result.get(1)?.status).toBe('ok');
    expect(result.get(1)?.mimeType).toBe('audio/ogg');
  });

  it('ChannelNotConfiguredError vira missing, sem derrubar a exportação', async () => {
    vi.mocked(resolveCloudConfig).mockRejectedValue(
      new ChannelNotConfiguredError('sem credencial', 'no_credentials')
    );

    const result = await fetchMediaBytes(
      makeSupabase({}),
      ACCOUNT_ID,
      [
        planEntry({
          ref: { kind: 'proxy', url: '/api/whatsapp/media/x', mediaId: 'x' },
        }),
      ],
      limits
    );

    expect(result.get(1)?.status).toBe('missing');
    expect(getMediaUrl).not.toHaveBeenCalled();
  });

  it('mídia expirada na Meta vira missing (D-6), não error', async () => {
    vi.mocked(resolveCloudConfig).mockResolvedValue({
      channel: {} as never,
      config: { access_token: 'cipher' } as never,
    });
    vi.mocked(getMediaUrl).mockRejectedValue(
      new Error('Media fetch failed: 404')
    );

    const result = await fetchMediaBytes(
      makeSupabase({}),
      ACCOUNT_ID,
      [
        planEntry({
          ref: { kind: 'proxy', url: '/api/whatsapp/media/x', mediaId: 'x' },
        }),
      ],
      limits
    );

    expect(result.get(1)?.status).toBe('missing');
  });

  it('resolve a credencial uma vez por canal, mesmo com vários anexos', async () => {
    vi.mocked(resolveCloudConfig).mockResolvedValue({
      channel: {} as never,
      config: { access_token: 'cipher' } as never,
    });
    vi.mocked(getMediaUrl).mockResolvedValue({
      url: 'https://lookaside.meta/x',
      mimeType: 'image/jpeg',
    });
    vi.mocked(downloadMedia).mockResolvedValue({
      buffer: Buffer.alloc(4),
      contentType: 'image/jpeg',
    });

    const plan = Array.from({ length: 4 }, (_, i) =>
      planEntry({
        index: i + 1,
        messageId: `m${i + 1}`,
        channelId: 'channel-a',
        ref: {
          kind: 'proxy',
          url: `/api/whatsapp/media/x${i}`,
          mediaId: `x${i}`,
        },
      })
    );

    await fetchMediaBytes(makeSupabase({}), ACCOUNT_ID, plan, limits);

    expect(resolveCloudConfig).toHaveBeenCalledTimes(1);
  });
});

describe('fetchMediaBytes — origem external (SSRF)', () => {
  it('recusa URL que resolve para endereço privado, sem sequer buscar', async () => {
    vi.mocked(isDeliverableUrl).mockResolvedValue(false);
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const result = await fetchMediaBytes(
      makeSupabase({}),
      ACCOUNT_ID,
      [
        planEntry({
          ref: { kind: 'external', url: 'http://169.254.169.254/latest/meta' },
        }),
      ],
      limits
    );

    expect(result.get(1)?.status).toBe('error');
    expect(result.get(1)?.bytes).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('URL pública baixa os bytes sem seguir redirecionamento', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(new Uint8Array(6), {
        status: 200,
        headers: { 'content-type': 'image/png' },
      })
    );

    const result = await fetchMediaBytes(
      makeSupabase({}),
      ACCOUNT_ID,
      [
        planEntry({
          ref: { kind: 'external', url: 'https://cdn.exemplo.com/a.png' },
        }),
      ],
      limits
    );

    expect(result.get(1)?.status).toBe('ok');
    expect(result.get(1)?.byteLength).toBe(6);
    expect(fetchSpy.mock.calls[0][1]).toMatchObject({ redirect: 'manual' });
    fetchSpy.mockRestore();
  });
});

describe('fetchMediaBytes — tetos e resiliência', () => {
  it('ao cruzar o teto global os seguintes viram skipped e a promessa resolve', async () => {
    const supabase = makeSupabase({
      'acc-1/a.jpg': blobOf(30),
      'acc-1/b.jpg': blobOf(30),
      'acc-1/c.jpg': blobOf(30),
    });

    const plan = ['a', 'b', 'c'].map((name, i) =>
      planEntry({
        index: i + 1,
        messageId: `m${i + 1}`,
        ref: {
          kind: 'storage',
          bucket: 'chat-media',
          path: `acc-1/${name}.jpg`,
        },
      })
    );

    const result = await fetchMediaBytes(supabase, ACCOUNT_ID, plan, {
      ...limits,
      maxTotalBytes: 50,
      concurrency: 1,
    });

    expect(result.get(1)?.status).toBe('ok');
    expect(result.get(2)?.status).toBe('ok');
    expect(result.get(3)?.status).toBe('skipped');
  });

  it('acima de maxFiles as excedentes viram skipped sem baixar', async () => {
    const supabase = makeSupabase({
      'acc-1/a.jpg': blobOf(4),
      'acc-1/b.jpg': blobOf(4),
    });

    const plan = ['a', 'b'].map((name, i) =>
      planEntry({
        index: i + 1,
        messageId: `m${i + 1}`,
        ref: {
          kind: 'storage',
          bucket: 'chat-media',
          path: `acc-1/${name}.jpg`,
        },
      })
    );

    const result = await fetchMediaBytes(supabase, ACCOUNT_ID, plan, {
      ...limits,
      maxFiles: 1,
    });

    expect(result.get(1)?.status).toBe('ok');
    expect(result.get(2)?.status).toBe('skipped');
  });

  it('uma rejeição no meio não derruba o lote', async () => {
    const supabase = makeSupabase({
      'acc-1/a.jpg': new Error('conexão caiu'),
      'acc-1/b.jpg': blobOf(5),
    });

    const plan = ['a', 'b'].map((name, i) =>
      planEntry({
        index: i + 1,
        messageId: `m${i + 1}`,
        ref: {
          kind: 'storage',
          bucket: 'chat-media',
          path: `acc-1/${name}.jpg`,
        },
      })
    );

    const result = await fetchMediaBytes(supabase, ACCOUNT_ID, plan, limits);

    expect(result.get(1)?.status).toBe('error');
    expect(result.get(2)?.status).toBe('ok');
  });

  it('duplicata herda o resultado do original, sem baixar de novo', async () => {
    let downloads = 0;
    const supabase = {
      storage: {
        from: () => ({
          download: () => {
            downloads++;
            return Promise.resolve({ data: blobOf(7), error: null });
          },
        }),
      },
    } as unknown as SupabaseClient;

    const shared = {
      kind: 'storage' as const,
      bucket: 'chat-media' as const,
      path: 'acc-1/catalogo.pdf',
    };
    const plan = [
      planEntry({ index: 1, messageId: 'm1', ref: shared }),
      planEntry({
        index: 2,
        messageId: 'm2',
        ref: shared,
        duplicateOfIndex: 1,
      }),
    ];

    const result = await fetchMediaBytes(supabase, ACCOUNT_ID, plan, limits);

    expect(downloads).toBe(1);
    expect(result.get(2)?.status).toBe('ok');
    expect(result.get(2)?.index).toBe(2);
    expect(result.get(2)?.bytes).toBe(result.get(1)?.bytes);
  });

  it('plano vazio devolve mapa vazio sem tocar em nada', async () => {
    const result = await fetchMediaBytes(
      makeSupabase({}),
      ACCOUNT_ID,
      [],
      limits
    );
    expect(result.size).toBe(0);
  });
});
