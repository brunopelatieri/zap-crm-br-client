// ============================================================
// Middleware × formulários públicos (SPEC 085 E-11, E-12; PRD 084 D-13).
//
//   1. `/f/**` e `/api/forms/public/**` saem cedo, sem `createServerClient`
//      nem `getUser()` (o visitante não tem sessão; um refresh de cookie de
//      um usuário logado no mesmo navegador não tem o que fazer ali);
//   2. quem pode embutir `/f/<slug>` é decidido por formulário: origens
//      cadastradas → `frame-ancestors <origens>`; sem origens, formulário
//      inexistente ou falha da consulta → `X-Frame-Options: DENY`;
//   3. `/forms` (a área da equipe) continua protegida — o prefixo não é
//      `/f/`.
// ============================================================

import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { createServerClient, getUser } = vi.hoisted(() => ({
  createServerClient: vi.fn(),
  getUser: vi.fn(),
}));
vi.mock('@supabase/ssr', () => ({ createServerClient }));

import { __resetFramePolicyCacheForTests } from './lib/forms/frame-policy';
import { middleware } from './middleware';

const get = (path: string, headers: Record<string, string> = {}) =>
  new NextRequest(`https://app.example.com${path}`, { headers });

function stubForms(rows: unknown, ok = true) {
  const fetchMock = vi.fn(async () => ({ ok, json: async () => rows }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

beforeEach(() => {
  __resetFramePolicyCacheForTests();
  getUser.mockReset().mockResolvedValue({ data: { user: null } });
  createServerClient.mockReset().mockReturnValue({ auth: { getUser } });
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://sb.example');
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'service-key');
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('sai cedo, sem sessão', () => {
  it.each([
    '/f/captacao',
    '/f/captacao?t=abc.def',
    '/api/forms/public/captacao/start',
    '/api/forms/public/captacao/responses/4444',
  ])('%s não cria client do Supabase nem chama getUser()', async (path) => {
    stubForms([]);
    const res = await middleware(get(path, { cookie: 'sb-xyz-auth-token=1' }));
    expect(res.status).toBe(200);
    expect(createServerClient).not.toHaveBeenCalled();
    expect(getUser).not.toHaveBeenCalled();
  });

  it('a área da equipe `/forms` continua exigindo login', async () => {
    const res = await middleware(get('/forms'));
    expect(res.status).toBe(307);
    expect(new URL(res.headers.get('location')!).pathname).toBe('/login');
    expect(getUser).toHaveBeenCalled();
  });
});

describe('quem pode embutir /f/<slug> (E-12)', () => {
  it('sem origens cadastradas: DENY nos dois cabeçalhos', async () => {
    stubForms([{ settings: {} }]);
    const res = await middleware(get('/f/captacao'));
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('content-security-policy')).toBe(
      "frame-ancestors 'none'"
    );
  });

  it('com origens: só frame-ancestors, sem X-Frame-Options', async () => {
    stubForms([
      {
        settings: {
          embed_origins: ['https://www.empresa.com.br', 'http://inseguro.com'],
        },
      },
    ]);
    const res = await middleware(get('/f/captacao'));
    expect(res.headers.get('x-frame-options')).toBeNull();
    expect(res.headers.get('content-security-policy')).toBe(
      'frame-ancestors https://www.empresa.com.br'
    );
  });

  it('formulário inexistente/despublicado, erro da consulta ou rede caída → DENY', async () => {
    stubForms([]);
    expect(
      (await middleware(get('/f/nao-existe'))).headers.get('x-frame-options')
    ).toBe('DENY');

    __resetFramePolicyCacheForTests();
    stubForms([], false);
    expect(
      (await middleware(get('/f/captacao'))).headers.get('x-frame-options')
    ).toBe('DENY');

    __resetFramePolicyCacheForTests();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('rede');
      })
    );
    expect(
      (await middleware(get('/f/captacao'))).headers.get('x-frame-options')
    ).toBe('DENY');
  });

  it('caminhos de /f/ que não são /f/<slug> nunca embutem e nem consultam o banco', async () => {
    const fetchMock = stubForms([
      { settings: { embed_origins: ['https://a.com'] } },
    ]);
    const res = await middleware(get('/f/captacao/extra'));
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a lista vem do formulário PUBLICADO do slug, consultada com a chave de serviço', async () => {
    const fetchMock = stubForms([{ settings: {} }]);
    await middleware(get('/f/captacao'));
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      { headers: Record<string, string> },
    ];
    expect(url).toContain('slug=eq.captacao');
    expect(url).toContain('status=eq.published');
    expect(init.headers.Authorization).toBe('Bearer service-key');
  });
});
