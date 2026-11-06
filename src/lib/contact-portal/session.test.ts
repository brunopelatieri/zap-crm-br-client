import { describe, expect, it } from 'vitest';

import { PORTAL_SESSION_TTL_S } from './limits';
import {
  PORTAL_COOKIE_PATH,
  PORTAL_SESSION_COOKIE,
  clearedCookieOptions,
  generateSessionToken,
  hashSessionToken,
  isWellFormedSessionToken,
  readSessionToken,
  sessionCookieOptions,
  shouldUseSecureCookie,
  toPgBytea,
} from './session';

function store(value?: string) {
  return {
    get: (name: string) =>
      name === PORTAL_SESSION_COOKIE && value !== undefined
        ? { value }
        : undefined,
  };
}

describe('token de sessão', () => {
  it('32 bytes em base64url, sempre bem formado e diferente', () => {
    const a = generateSessionToken();
    const b = generateSessionToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(isWellFormedSessionToken(a)).toBe(true);
    expect(a).not.toBe(b);
  });

  it('o banco recebe só o sha256 (64 hex), estável para o mesmo token', () => {
    const t = generateSessionToken();
    expect(hashSessionToken(t)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashSessionToken(t)).toBe(hashSessionToken(t));
    expect(hashSessionToken(t)).not.toContain(t);
  });

  it('toPgBytea monta o literal \\x e recusa o que não é digest', () => {
    const hex = hashSessionToken(generateSessionToken());
    expect(toPgBytea(hex)).toBe(`\\x${hex}`);
    expect(() => toPgBytea('abc')).toThrow();
    expect(() => toPgBytea(hex.toUpperCase())).toThrow();
  });
});

describe('cookie', () => {
  it('não é cookie do Supabase: o @supabase/ssr nunca o lê', () => {
    expect(PORTAL_SESSION_COOKIE.startsWith('sb-')).toBe(false);
  });

  it('HttpOnly, SameSite=Lax, Path=/area, 30 dias', () => {
    expect(sessionCookieOptions('https://dev.valenranch.com.br')).toEqual({
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      path: PORTAL_COOKIE_PATH,
      maxAge: PORTAL_SESSION_TTL_S,
    });
    expect(PORTAL_COOKIE_PATH).toBe('/area');
  });

  it('Secure fora de localhost; sem Secure só em http://localhost', () => {
    expect(shouldUseSecureCookie('https://dev.valenranch.com.br')).toBe(true);
    expect(shouldUseSecureCookie('http://dev.valenranch.com.br')).toBe(true);
    expect(shouldUseSecureCookie('http://localhost:4000')).toBe(false);
    expect(shouldUseSecureCookie('http://127.0.0.1:4000')).toBe(false);
    expect(shouldUseSecureCookie('https://localhost:4000')).toBe(true);
    expect(shouldUseSecureCookie('lixo')).toBe(true);
  });

  it('sair = mesmo cookie com maxAge 0', () => {
    expect(clearedCookieOptions('http://localhost:4000')).toMatchObject({
      path: '/area',
      maxAge: 0,
      secure: false,
    });
  });

  it('readSessionToken: ausente ou malformado nem chega ao banco', () => {
    const t = generateSessionToken();
    expect(readSessionToken(store(t))).toBe(t);
    expect(readSessionToken(store())).toBeNull();
    expect(readSessionToken(store(''))).toBeNull();
    expect(readSessionToken(store('curto'))).toBeNull();
    expect(readSessionToken(store(`${t}x`))).toBeNull();
    expect(readSessionToken(store(t.slice(0, 42) + '='))).toBeNull();
  });
});
