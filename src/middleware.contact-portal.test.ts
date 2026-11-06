// ============================================================
// Middleware × área do contato (SPEC 083 §6, F4).
//
// O isolamento depende de duas coisas que este teste prende:
//   1. A sessão da área (cookie opaco) NÃO é sessão do Supabase: com só
//      ela, a CRM manda para /login ou responde 401.
//   2. `/area` e `/area/api/*` passam reto, sem `createServerClient` —
//      o refresh do Supabase não tem nada a fazer ali.
// O Supabase de mentira só "vê" usuário quando há cookie `sb-*`, que é
// o que o `@supabase/ssr` de verdade lê.
// ============================================================

import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { createServerClient } = vi.hoisted(() => ({
  createServerClient: vi.fn(),
}));
vi.mock('@supabase/ssr', () => ({ createServerClient }));

import { middleware } from './middleware';
import { generateSessionToken } from './lib/contact-portal/session';

type CookieOpts = { cookies: { getAll(): { name: string }[] } };

beforeEach(() => {
  createServerClient.mockImplementation(
    (_url: string, _key: string, opts: CookieOpts) => ({
      auth: {
        getUser: async () => ({
          data: {
            user: opts.cookies.getAll().some((c) => c.name.startsWith('sb-'))
              ? { id: 'u1' }
              : null,
          },
        }),
      },
    })
  );
});

/** Requisição com o cookie da área, montado como o navegador mandaria. */
function withPortalCookie(path: string, extraCookie = '') {
  // O nome repetido aqui de propósito: o teste de isolamento só vale
  // para código de produção, e este arquivo precisa do cookie literal.
  const token = generateSessionToken();
  const cookie = [`zap_area_session=${token}`, extraCookie]
    .filter(Boolean)
    .join('; ');
  return new NextRequest(`https://dev.valenranch.com.br${path}`, {
    headers: { cookie },
  });
}

describe('sessão da área não abre a CRM', () => {
  it.each(['/dashboard', '/inbox', '/contacts', '/settings'])(
    '%s com só o cookie da área → /login',
    async (path) => {
      const res = await middleware(withPortalCookie(path));
      expect(res.status).toBe(307);
      expect(new URL(res.headers.get('location')!).pathname).toBe('/login');
    }
  );

  it('/api/whatsapp/* com só o cookie da área → 401', async () => {
    const res = await middleware(withPortalCookie('/api/whatsapp/send'));
    expect(res.status).toBe(401);
  });

  it('usuário da conta com os dois cookies continua entrando na CRM', async () => {
    const res = await middleware(
      withPortalCookie('/dashboard', 'sb-ref-auth-token=x')
    );
    expect(res.headers.get('location')).toBeNull();
  });
});

describe('/area passa reto', () => {
  it.each(['/area', '/area/painel', '/area/api/login', '/area/c/ABCD2345'])(
    '%s não toca no Supabase',
    async (path) => {
      const res = await middleware(withPortalCookie(path));
      expect(res.headers.get('location')).toBeNull();
      expect(createServerClient).not.toHaveBeenCalled();
    }
  );

  it('/areas (outro prefixo) não é a área', async () => {
    await middleware(withPortalCookie('/areas'));
    expect(createServerClient).toHaveBeenCalled();
  });
});
