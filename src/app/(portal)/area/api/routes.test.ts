import { beforeEach, describe, expect, it, vi } from 'vitest';

const { after, holdUntil, journeys, getPortalSession, cookieStore } =
  vi.hoisted(() => ({
    after: vi.fn(),
    holdUntil: vi.fn<(startedAt: number, minMs: number) => Promise<void>>(
      async () => undefined
    ),
    journeys: {
      requestAccessCode: vi.fn(),
      completeAccessCode: vi.fn(),
      signIn: vi.fn(),
      signOut: vi.fn(),
      changePortalPassword: vi.fn(),
    },
    getPortalSession: vi.fn(),
    cookieStore: { get: vi.fn() },
  }));

vi.mock('next/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/server')>()),
  after: (fn: () => unknown) => after(fn),
}));
vi.mock('@/lib/contact-portal/journeys', () => journeys);
vi.mock('@/lib/contact-portal/request', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/contact-portal/request')>()),
  holdUntil: (startedAt: number, minMs: number) => holdUntil(startedAt, minMs),
}));
vi.mock('@/lib/contact-portal/current', () => ({
  getPortalSession: () => getPortalSession(),
}));
vi.mock('next/headers', () => ({ cookies: async () => cookieStore }));

import { PORTAL_REQUEST_CODE_MIN_MS } from '@/lib/contact-portal/limits';

import { POST as completeCode } from './complete-code/route';
import { POST as login } from './login/route';
import { POST as logout } from './logout/route';
import { POST as requestCode } from './request-code/route';
import { POST as changePassword } from './change-password/route';

const ORIGIN = 'https://dev.valenranch.com.br';

function post(path: string, body: unknown, origin: string | null = ORIGIN) {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
  };
  if (origin) headers.origin = origin;
  return new Request(`${ORIGIN}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_SITE_URL', ORIGIN);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('toda escrita confere a origem', () => {
  it('outra origem ou sem Origin → 403, sem chegar à jornada', async () => {
    for (const origin of ['https://evil.example', null]) {
      const res = await login(
        post('/area/api/login', { phone: 'x', password: 'y' }, origin)
      );
      expect(res.status).toBe(403);
      expect((await res.json()).code).toBe('forbidden_origin');
    }
    expect(journeys.signIn).not.toHaveBeenCalled();
  });
});

describe('POST /area/api/request-code', () => {
  it('resposta idêntica com e sem código emitido; o envio vai para after()', async () => {
    const deliver = vi.fn();
    journeys.requestAccessCode.mockResolvedValueOnce({ deliver });
    const sent = await requestCode(
      post('/area/api/request-code', { phone: '19991234567' })
    );

    journeys.requestAccessCode.mockResolvedValueOnce({ deliver: null });
    const none = await requestCode(
      post('/area/api/request-code', { phone: '11888887777' })
    );

    journeys.requestAccessCode.mockRejectedValueOnce(new Error('db down'));
    const broken = await requestCode(
      post('/area/api/request-code', { phone: '11888887777' })
    );

    for (const res of [sent, none, broken]) {
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
    }
    expect(after).toHaveBeenCalledTimes(1);
    expect(after).toHaveBeenCalledWith(deliver);
    // Os três caminhos esperam o mesmo piso (F6 A-3), inclusive o erro.
    expect(holdUntil).toHaveBeenCalledTimes(3);
    for (const call of holdUntil.mock.calls) {
      expect(call[1]).toBe(PORTAL_REQUEST_CODE_MIN_MS);
    }
  });

  it('o link usa só a origem configurada, nunca o host forjado (F6 A-2)', async () => {
    journeys.requestAccessCode.mockResolvedValue({ deliver: null });
    const forged = () =>
      new Request(`${ORIGIN}/area/api/request-code`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: 'https://evil.example',
          host: 'evil.example',
          'x-forwarded-host': 'evil.example',
        },
        body: JSON.stringify({ phone: '19991234567' }),
      });
    // Origin = host forjado passa no `isSameOriginWrite` (o navegador da
    // vítima nunca manda isso; um script manda) — o link não pode segui-lo.
    const res = await requestCode(forged());
    expect(res.status).toBe(200);
    expect(journeys.requestAccessCode).toHaveBeenCalledWith(
      expect.objectContaining({ siteOrigin: ORIGIN })
    );

    vi.stubEnv('NEXT_PUBLIC_SITE_URL', '');
    await requestCode(forged());
    expect(journeys.requestAccessCode).toHaveBeenLastCalledWith(
      expect.objectContaining({ siteOrigin: null })
    );
  });

  it('propósito desconhecido vira reset; publicCode segue', async () => {
    journeys.requestAccessCode.mockResolvedValue({ deliver: null });
    await requestCode(
      post('/area/api/request-code', {
        phone: '19991234567',
        purpose: 'qualquer',
        publicCode: 'ABCD2345',
      })
    );
    expect(journeys.requestAccessCode).toHaveBeenCalledWith(
      expect.objectContaining({ purpose: 'reset', publicCode: 'ABCD2345' })
    );
  });
});

describe('POST /area/api/login', () => {
  it('ok grava o cookie da área (HttpOnly, Path=/area) e escolhe o destino', async () => {
    journeys.signIn.mockResolvedValue({
      status: 'ok',
      token: 'T'.repeat(43),
      accessCount: 2,
    });
    const res = await login(
      post('/area/api/login', { phone: '19991234567', password: 'x' })
    );
    expect(res.status).toBe(200);
    expect((await res.json()).next).toBe('/area/escolher-conta');
    const cookie = res.headers.get('set-cookie') ?? '';
    expect(cookie).toContain('T'.repeat(43));
    expect(cookie).toContain('Path=/area');
    expect(cookie.toLowerCase()).toContain('httponly');
    expect(cookie.toLowerCase()).toContain('samesite=lax');
    expect(cookie).toContain('Secure');
  });

  it('senha errada → 401 sem cookie; limite → 429', async () => {
    journeys.signIn.mockResolvedValueOnce({ status: 'invalid' });
    const bad = await login(
      post('/area/api/login', { phone: '1', password: 'x' })
    );
    expect(bad.status).toBe(401);
    expect(bad.headers.get('set-cookie')).toBeNull();

    journeys.signIn.mockResolvedValueOnce({ status: 'throttled' });
    expect(
      (await login(post('/area/api/login', { phone: '1', password: 'x' })))
        .status
    ).toBe(429);
  });
});

describe('POST /area/api/complete-code', () => {
  it('ok abre a sessão; erros viram código estável', async () => {
    journeys.completeAccessCode.mockResolvedValueOnce({
      status: 'ok',
      token: 'K'.repeat(43),
    });
    const body = {
      phone: '19991234567',
      code: '123456',
      password: 'x',
      confirmPassword: 'x',
      termsAccepted: true,
    };
    const ok = await completeCode(post('/area/api/complete-code', body));
    expect(ok.status).toBe(200);
    expect(ok.headers.get('set-cookie')).toContain('K'.repeat(43));

    journeys.completeAccessCode.mockResolvedValueOnce({
      status: 'invalid_code',
    });
    const bad = await completeCode(post('/area/api/complete-code', body));
    expect(bad.status).toBe(400);
    expect((await bad.json()).code).toBe('invalid_code');
  });

  it('campos faltando → 400 sem chamar a jornada', async () => {
    const res = await completeCode(
      post('/area/api/complete-code', { phone: '1' })
    );
    expect(res.status).toBe(400);
    expect(journeys.completeAccessCode).not.toHaveBeenCalled();
  });
});

describe('POST /area/api/logout', () => {
  it('apaga o cookie mesmo se o banco falhar', async () => {
    cookieStore.get.mockReturnValue({ value: 'A'.repeat(43) });
    journeys.signOut.mockRejectedValue(new Error('db down'));
    const res = await logout(post('/area/api/logout', { everywhere: true }));
    expect(res.status).toBe(200);
    expect(journeys.signOut).toHaveBeenCalledWith('A'.repeat(43), true);
    expect(res.headers.get('set-cookie')).toContain('Max-Age=0');
  });
});

describe('rotas de sessão aberta', () => {
  it('sem sessão → 401', async () => {
    getPortalSession.mockResolvedValue(null);
    const res = await changePassword(
      post('/area/api/change-password', {
        current: 'a',
        next: 'b',
        confirmNext: 'b',
      })
    );
    expect(res.status).toBe(401);
    expect(journeys.changePortalPassword).not.toHaveBeenCalled();
  });
});
