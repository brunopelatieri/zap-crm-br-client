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

import { describe, expect, it } from 'vitest';

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
