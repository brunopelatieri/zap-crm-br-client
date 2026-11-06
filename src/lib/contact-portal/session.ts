// ============================================================
// Sessão da área do contato — token e cookie (SPEC 083 §8.1, PRD 082 D-7).
//
// A sessão é opaca: 32 bytes aleatórios no cookie, só o sha256 no banco
// (`contact_portal.sessions.token_hash`). Não é cookie do Supabase — o
// nome não começa com `sb-`, então `@supabase/ssr` nunca o lê, e o
// middleware e as rotas da CRM simplesmente não veem sessão nenhuma.
// É isso que deixa usuário da conta e contato conviverem no mesmo
// navegador sem um derrubar o outro.
//
// `Path=/area`: o cookie só viaja para as páginas da área e para as
// rotas do contato, que por isso moram em `/area/api/**` (não em
// `/api/area/**`, onde o navegador não mandaria o cookie).
//
// Este arquivo é puro (sem `next/headers`); quem lê o cookie da
// requisição e resolve no banco é `current.ts`.
// ============================================================

import { createHash, randomBytes } from 'node:crypto';

import { PORTAL_SESSION_TTL_S } from './limits';

export const PORTAL_SESSION_COOKIE = 'zap_area_session';
export const PORTAL_COOKIE_PATH = '/area';

const TOKEN_BYTES = 32;
/** base64url de 32 bytes, sem padding. */
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function generateSessionToken(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url');
}

export function isWellFormedSessionToken(token: string): boolean {
  return TOKEN_PATTERN.test(token);
}

/** sha256 do token, em hex (64 caracteres). */
export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** Hex → literal `bytea` que o PostgREST aceita num parâmetro de RPC. */
export function toPgBytea(hex: string): string {
  if (!/^[0-9a-f]{64}$/.test(hex)) {
    throw new Error('toPgBytea: expected a 32-byte hex digest');
  }
  return `\\x${hex}`;
}

/**
 * `Secure` em todo lugar menos em `http://localhost`/`127.0.0.1`, onde o
 * navegador recusaria gravar o cookie e o desenvolvimento local quebraria.
 */
export function shouldUseSecureCookie(origin: string): boolean {
  try {
    const url = new URL(origin);
    if (url.protocol === 'https:') return true;
    return !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  } catch {
    return true;
  }
}

export interface PortalCookieOptions {
  httpOnly: true;
  secure: boolean;
  sameSite: 'lax';
  path: string;
  maxAge: number;
}

export function sessionCookieOptions(origin: string): PortalCookieOptions {
  return {
    httpOnly: true,
    secure: shouldUseSecureCookie(origin),
    sameSite: 'lax',
    path: PORTAL_COOKIE_PATH,
    maxAge: PORTAL_SESSION_TTL_S,
  };
}

/** O mesmo cookie, vencido — para "sair". */
export function clearedCookieOptions(origin: string): PortalCookieOptions {
  return { ...sessionCookieOptions(origin), maxAge: 0 };
}

export interface CookieReader {
  get(name: string): { value: string } | undefined;
}

/** Token do cookie, ou `null` se ausente ou malformado (nem chega ao banco). */
export function readSessionToken(cookies: CookieReader): string | null {
  const value = cookies.get(PORTAL_SESSION_COOKIE)?.value;
  return value && isWellFormedSessionToken(value) ? value : null;
}

export interface CookieWriter {
  set(name: string, value: string, options: PortalCookieOptions): unknown;
}

/**
 * Grava o cookie da área na resposta. As rotas usam isto em vez de
 * citar o nome do cookie — o teste de isolamento exige que ele só
 * apareça neste arquivo.
 */
export function setSessionCookie(
  res: { cookies: CookieWriter },
  token: string,
  origin: string
): void {
  res.cookies.set(PORTAL_SESSION_COOKIE, token, sessionCookieOptions(origin));
}

export function clearSessionCookie(
  res: { cookies: CookieWriter },
  origin: string
): void {
  res.cookies.set(PORTAL_SESSION_COOKIE, '', clearedCookieOptions(origin));
}
