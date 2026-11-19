// ============================================================
// Cabeçalhos do `next.config.ts` que a segurança depende (SPEC 083,
// SPEC 083 §9).
//
// O Next aplica as regras de `headers()` em ordem e, para a mesma chave,
// vale a ÚLTIMA que casa. O padrão de toda página é `private, no-store`;
// só os arquivos soltos de `public/` e os diretórios vendorizados saem
// públicos. Uma página com `public, s-maxage` vence o `private` que o
// Next põe nas dinâmicas e vaza por um cache compartilhado (achado A-1
// da SPEC 083, P-7 → SPEC 083 §9).
// ============================================================

import { afterEach, describe, expect, it, vi } from 'vitest';

import nextConfig from '../next.config';

/** `:path*` / `:path(...)` → regex, o bastante para as regras deste arquivo. */
function matches(source: string, pathname: string): boolean {
  const pattern = source
    .replace(/\/:path\*$/, '(?:/.*)?')
    .replace(/\/:path\((.*)\)$/, '/$1');
  return new RegExp(`^${pattern}$`).test(pathname);
}

async function cacheControlFor(pathname: string): Promise<string | null> {
  const rules = (await nextConfig.headers?.()) ?? [];
  let value: string | null = null;
  for (const rule of rules) {
    if (!matches(rule.source, pathname)) continue;
    for (const h of rule.headers) {
      if (h.key.toLowerCase() === 'cache-control') value = h.value;
    }
  }
  return value;
}

async function headerFor(pathname: string, key: string) {
  const rules = (await nextConfig.headers?.()) ?? [];
  let value: string | null = null;
  for (const rule of rules) {
    if (!matches(rule.source, pathname)) continue;
    for (const h of rule.headers) {
      if (h.key.toLowerCase() === key.toLowerCase()) value = h.value;
    }
  }
  return value;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('CSP aplicada na área do contato (SPEC 083 F5-06)', () => {
  it.each([
    '/area',
    '/area/painel',
    '/area/c/KRCFRZDW/codigo',
    '/area/api/login',
  ])('%s sai com Content-Security-Policy aplicada', async (path) => {
    vi.stubEnv('NODE_ENV', 'production');
    const csp = await headerFor(path, 'Content-Security-Policy');
    expect(csp).not.toBeNull();
    const directives = csp!.split('; ');
    expect(directives).toEqual(
      expect.arrayContaining([
        "default-src 'self'",
        "script-src 'self' 'unsafe-inline'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data:",
        "connect-src 'self'",
        "object-src 'none'",
        "frame-ancestors 'none'",
        "form-action 'self'",
        "base-uri 'self'",
      ])
    );
    // Nenhum host de fora e nada de eval em produção.
    expect(csp).not.toMatch(/https?:|wss?:|unsafe-eval|\*/);
  });

  it('em desenvolvimento o script-src aceita eval (HMR do Next)', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    expect(await headerFor('/area', 'Content-Security-Policy')).toContain(
      "script-src 'self' 'unsafe-inline' 'unsafe-eval'"
    );
  });

  it.each([
    '/',
    '/dashboard',
    '/inbox',
    '/login',
    '/areas',
    '/api/contacts',
    '/api/contact-portal/settings',
  ])('%s (fora da área) não ganha a política aplicada', async (path) => {
    vi.stubEnv('NODE_ENV', 'production');
    expect(await headerFor(path, 'Content-Security-Policy')).toBeNull();
  });

  it('o catch-all segue Report-Only, e também vale em /area', async () => {
    for (const path of ['/dashboard', '/area']) {
      const ro = await headerFor(path, 'Content-Security-Policy-Report-Only');
      expect(ro).toContain("script-src 'self' 'unsafe-inline' 'unsafe-eval'");
    }
  });
});

describe('Cache-Control da área do contato', () => {
  it.each([
    '/area',
    '/area/painel',
    '/area/minha-conta',
    '/area/c/KRCFRZDW/codigo',
    '/area/api/login',
  ])('%s é private, no-store', async (path) => {
    expect(await cacheControlFor(path)).toBe('private, no-store');
  });
});

describe('Cache-Control das páginas da CRM (SPEC 083 §9)', () => {
  it.each([
    '/',
    '/dashboard',
    '/inbox',
    '/contacts',
    '/pipelines',
    '/broadcasts',
    '/broadcasts/new/abc/triage',
    '/automations/123/edit',
    '/flows/123/runs',
    '/agents',
    '/notifications',
    '/activity',
    '/plan',
    '/settings',
    '/admin',
    '/admin/accounts/123',
    '/login',
    '/signup',
    '/forgot-password',
    '/reset-password',
    '/join/abc123',
    '/auth/callback',
    '/auth/confirm',
    '/blocked',
    '/areas',
    '/rota-que-ainda-nao-existe',
  ])('%s é private, no-store', async (path) => {
    expect(await cacheControlFor(path)).toBe('private, no-store');
  });

  it('API continua no-store', async () => {
    expect(await cacheControlFor('/api/contacts')).toBe('no-store');
    expect(await cacheControlFor('/api/v1/contacts')).toBe('no-store');
  });

  it.each([
    '/og-image.webp',
    '/favicon.ico',
    '/openapi.json',
    '/openapi.pt-BR.json',
    '/inbox-doodle.svg',
  ])('%s (arquivo solto de public/) segue público e curto', async (path) => {
    expect(await cacheControlFor(path)).toBe(
      'public, max-age=0, s-maxage=300, stale-while-revalidate=86400'
    );
  });

  it('arquivo com extensão fora da raiz não fica público', async () => {
    expect(await cacheControlFor('/area/painel.json')).toBe(
      'private, no-store'
    );
  });

  it.each(['/emojibase/pt/data.json', '/opus/encoderWorker.min.js'])(
    '%s segue imutável',
    async (path) => {
      expect(await cacheControlFor(path)).toBe(
        'public, max-age=31536000, immutable'
      );
    }
  );

  it('nenhuma regra fala de /_next/static (fica com o Next)', async () => {
    expect(await cacheControlFor('/_next/static/chunks/main.js')).toBeNull();
    expect(await cacheControlFor('/_next/image')).toBeNull();
  });
});

describe('cabeçalhos da página pública dos formulários (SPEC 085 E-12)', () => {
  it.each(['/f/captacao', '/f/captacao/'])(
    '%s NÃO sai com X-Frame-Options (o middleware decide por formulário)',
    async (path) => {
      expect(await headerFor(path, 'X-Frame-Options')).toBeNull();
    }
  );

  it('nem o CSP Report-Only de /f/** manda frame-ancestors fixo', async () => {
    const ro = await headerFor(
      '/f/captacao',
      'Content-Security-Policy-Report-Only'
    );
    expect(ro).not.toBeNull();
    expect(ro).not.toContain('frame-ancestors');
    // O que a página de fato carrega.
    expect(ro).toContain('https://challenges.cloudflare.com');
    expect(ro).toContain('https://www.youtube-nocookie.com');
    expect(ro).toContain('https://*.supabase.co');
  });

  it.each([
    '/',
    '/dashboard',
    '/forms',
    '/forms/abc',
    '/fx',
    '/api/forms/public/captacao/start',
    '/api/forms',
    '/area',
    '/login',
  ])('%s (fora de /f/) segue com X-Frame-Options: DENY', async (path) => {
    expect(await headerFor(path, 'X-Frame-Options')).toBe('DENY');
  });

  it('o restante dos cabeçalhos de segurança continua valendo em /f/**', async () => {
    expect(await headerFor('/f/captacao', 'X-Content-Type-Options')).toBe(
      'nosniff'
    );
    expect(
      await headerFor('/f/captacao', 'Strict-Transport-Security')
    ).toContain('max-age=');
    expect(await headerFor('/f/captacao', 'Referrer-Policy')).toBe(
      'strict-origin-when-cross-origin'
    );
  });

  it('a página e a API pública são privadas, sem cache compartilhado', async () => {
    expect(await cacheControlFor('/f/captacao')).toBe('private, no-store');
    expect(await cacheControlFor('/api/forms/public/captacao/submit')).toBe(
      'no-store'
    );
  });
});
