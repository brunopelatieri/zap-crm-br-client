import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  __resetFramePolicyCacheForTests,
  FRAME_DENY_HEADERS,
  FRAME_EMBED_ORIGINS_MAX,
  frameHeadersFor,
  lookupEmbedOrigins,
  parseEmbedOrigins,
  slugFromFormPath,
} from './frame-policy';
import { EMBED_ORIGINS_MAX } from './validate';

beforeEach(() => {
  __resetFramePolicyCacheForTests();
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://sb.example');
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'service-key');
});
afterEach(() => vi.unstubAllEnvs());

describe('parseEmbedOrigins', () => {
  it('só https://host[:porta] sem caminho, minúsculo, sem repetição', () => {
    expect(
      parseEmbedOrigins({
        embed_origins: [
          'https://www.empresa.com.br',
          'HTTPS://Loja.Empresa.com.br:8443',
          'https://www.empresa.com.br',
          'http://inseguro.com',
          'https://site.com/caminho',
          'https://*.site.com',
          "https://x.com; script-src 'unsafe-inline'",
          'https://a b.com',
          42,
        ],
      })
    ).toEqual([
      'https://www.empresa.com.br',
      'https://loja.empresa.com.br:8443',
    ]);
  });

  it('formas inesperadas viram lista vazia', () => {
    expect(parseEmbedOrigins(null)).toEqual([]);
    expect(parseEmbedOrigins({})).toEqual([]);
    expect(parseEmbedOrigins({ embed_origins: 'https://a.com' })).toEqual([]);
  });

  it('respeita o teto, o mesmo do validador de publicação', () => {
    expect(FRAME_EMBED_ORIGINS_MAX).toBe(EMBED_ORIGINS_MAX);
    const many = Array.from({ length: 30 }, (_, i) => `https://s${i}.com`);
    expect(parseEmbedOrigins({ embed_origins: many })).toHaveLength(
      EMBED_ORIGINS_MAX
    );
  });
});

describe('frameHeadersFor', () => {
  it('sem origens: DENY nos dois cabeçalhos', () => {
    expect(frameHeadersFor([])).toEqual(FRAME_DENY_HEADERS);
    expect(frameHeadersFor([])['X-Frame-Options']).toBe('DENY');
  });

  it('com origens: só frame-ancestors, sem X-Frame-Options', () => {
    const headers = frameHeadersFor(['https://a.com', 'https://b.com:444']);
    expect(headers).toEqual({
      'Content-Security-Policy':
        'frame-ancestors https://a.com https://b.com:444',
    });
  });
});

describe('slugFromFormPath', () => {
  it('só /f/<slug> exato', () => {
    expect(slugFromFormPath('/f/captacao')).toBe('captacao');
    expect(slugFromFormPath('/f/captacao/')).toBe('captacao');
    expect(slugFromFormPath('/f/captacao/extra')).toBeNull();
    expect(slugFromFormPath('/f/')).toBeNull();
    expect(slugFromFormPath('/f/A_B')).toBeNull();
    expect(slugFromFormPath('/forms/captacao')).toBeNull();
  });
});

describe('lookupEmbedOrigins', () => {
  const ok = (origins: string[]) =>
    vi.fn(async () => ({
      ok: true,
      json: async () => [{ settings: { embed_origins: origins } }],
    }));

  it('consulta só formulário publicado do slug, com a chave de serviço', async () => {
    const fetchMock = ok(['https://a.com']);
    const origins = await lookupEmbedOrigins('captacao', 1000, fetchMock);
    expect(origins).toEqual(['https://a.com']);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      { headers: Record<string, string>; signal: AbortSignal },
    ];
    expect(url).toContain('/rest/v1/forms?select=settings');
    expect(url).toContain('slug=eq.captacao');
    expect(url).toContain('status=eq.published');
    expect(init.headers.apikey).toBe('service-key');
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('guarda 30 s em cache por slug', async () => {
    const fetchMock = ok(['https://a.com']);
    await lookupEmbedOrigins('captacao', 1000, fetchMock);
    await lookupEmbedOrigins('captacao', 20_000, fetchMock);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await lookupEmbedOrigins('captacao', 31_001, fetchMock);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('falha de rede, resposta ruim ou ambiente sem chave → [] (e portanto DENY)', async () => {
    expect(
      await lookupEmbedOrigins('a1', 0, async () => {
        throw new Error('rede');
      })
    ).toEqual([]);
    expect(
      await lookupEmbedOrigins('a2', 0, async () => ({
        ok: false,
        json: async () => [],
      }))
    ).toEqual([]);
    expect(
      await lookupEmbedOrigins('a3', 0, async () => ({
        ok: true,
        json: async () => {
          throw new Error('json');
        },
      }))
    ).toEqual([]);
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', '');
    const fetchMock = ok(['https://a.com']);
    expect(await lookupEmbedOrigins('a4', 0, fetchMock)).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('cache cheio descarta só o mais antigo: 500 slugs inventados não apagam os reais', async () => {
    const fetchMock = ok(['https://a.com']);
    await lookupEmbedOrigins('real-um', 1000, fetchMock);
    for (let i = 0; i < 499; i++) {
      await lookupEmbedOrigins(`robo-${i}`, 1000, fetchMock);
    }
    // O cache está no teto; mais um slug despeja só o mais antigo (`real-um`).
    await lookupEmbedOrigins('robo-499', 1000, fetchMock);
    const calls = fetchMock.mock.calls.length;
    await lookupEmbedOrigins('robo-499', 1000, fetchMock);
    await lookupEmbedOrigins('robo-300', 1000, fetchMock);
    expect(fetchMock.mock.calls.length).toBe(calls);
    await lookupEmbedOrigins('real-um', 1000, fetchMock);
    expect(fetchMock.mock.calls.length).toBe(calls + 1);
  });

  it('formulário inexistente ou despublicado (linha vazia) → []', async () => {
    expect(
      await lookupEmbedOrigins('zz', 0, async () => ({
        ok: true,
        json: async () => [],
      }))
    ).toEqual([]);
  });
});
