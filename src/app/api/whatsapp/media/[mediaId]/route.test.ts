import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// GET /api/whatsapp/media/[mediaId] — proxy de mídia RECEBIDA.
//
// Foco: qual `channelId` chega a `resolveCloudConfig`. `messages.channel_id`
// só é gravado no desvio de canal de SAÍDA (migração 063) — `ingest.ts`
// NUNCA o grava em mídia recebida — então para ela quem carrega o canal é a
// CONVERSA (SPEC 067, mesma ordem que `src/lib/inbox/export/model.ts`
// aplica). Usar o canal padrão da conta nesse caso devolve 404 da Graph API
// numa conta com dois números oficiais (SPEC 064).
// ---------------------------------------------------------------------------

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

const supabaseState: {
  message: {
    id: string;
    channel_id: string | null;
    conversation: { channel_id: string | null } | null;
  } | null;
  messageError: { message: string } | null;
  accountId: string | null;
} = {
  message: null,
  messageError: null,
  accountId: 'acct-1',
};

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: {
      getUser: async () => ({
        data: { user: { id: 'user-1' } },
        error: null,
      }),
    },
    from: (table: string) => {
      const chain = {
        select: () => chain,
        eq: () => chain,
        limit: () => chain,
        maybeSingle: async () => {
          if (table === 'messages') {
            return {
              data: supabaseState.message,
              error: supabaseState.messageError,
            };
          }
          if (table === 'profiles') {
            return {
              data: supabaseState.accountId
                ? { account_id: supabaseState.accountId }
                : null,
              error: null,
            };
          }
          return { data: null, error: null };
        },
      };
      return chain;
    },
  }),
}));

import { resolveCloudConfig } from '@/lib/whatsapp/cloud-channels';
import { downloadMedia, getMediaUrl } from '@/lib/whatsapp/meta-api';
import { GET } from './route';

function makeRequest(mediaId: string) {
  return {
    request: new Request(`https://app.test/api/whatsapp/media/${mediaId}`),
    params: Promise.resolve({ mediaId }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  supabaseState.message = null;
  supabaseState.messageError = null;
  supabaseState.accountId = 'acct-1';
  vi.mocked(resolveCloudConfig).mockResolvedValue({
    channel: {} as never,
    config: { access_token: 'cipher-default' } as never,
  });
  vi.mocked(getMediaUrl).mockResolvedValue({
    url: 'https://lookaside.meta/x',
    mimeType: 'image/jpeg',
  });
  vi.mocked(downloadMedia).mockResolvedValue({
    buffer: Buffer.alloc(4),
    contentType: 'image/jpeg',
  });
});

describe('GET /api/whatsapp/media/[mediaId]', () => {
  it('mídia recebida (channel_id nulo) usa o canal da CONVERSA, não o padrão da conta', async () => {
    supabaseState.message = {
      id: 'msg-1',
      channel_id: null,
      conversation: { channel_id: 'channel-b' },
    };

    const { request, params } = makeRequest('media-xyz');
    const res = await GET(request, { params });

    expect(res.status).toBe(200);
    // Regressão: "simplificar" para o canal padrão (`undefined`) devolveria
    // 404 da Graph API numa conta com dois números oficiais (SPEC 064).
    expect(resolveCloudConfig).toHaveBeenCalledWith(
      expect.anything(),
      'acct-1',
      'channel-b'
    );
  });

  it('mensagem de SAÍDA com desvio de canal usa o channel_id da própria mensagem', async () => {
    supabaseState.message = {
      id: 'msg-2',
      channel_id: 'channel-qr',
      conversation: { channel_id: 'channel-a' },
    };

    const { request, params } = makeRequest('media-abc');
    await GET(request, { params });

    expect(resolveCloudConfig).toHaveBeenCalledWith(
      expect.anything(),
      'acct-1',
      'channel-qr'
    );
  });

  it('mensagem e conversa sem canal explícito cai no canal padrão (undefined)', async () => {
    supabaseState.message = {
      id: 'msg-3',
      channel_id: null,
      conversation: { channel_id: null },
    };

    const { request, params } = makeRequest('media-def');
    await GET(request, { params });

    expect(resolveCloudConfig).toHaveBeenCalledWith(
      expect.anything(),
      'acct-1',
      undefined
    );
  });

  it('media_id sem mensagem correspondente devolve 404 genérico', async () => {
    supabaseState.message = null;

    const { request, params } = makeRequest('media-ghost');
    const res = await GET(request, { params });

    expect(res.status).toBe(404);
    expect(resolveCloudConfig).not.toHaveBeenCalled();
  });
});
