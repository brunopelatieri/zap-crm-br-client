// ============================================================
// Token do link com contato (PRD 084 D-3, SPEC 085 E-4, §8 item 4).
//
//   token = base64url(payload JSON) . base64url(HMAC-SHA256(key, payload))
//   payload = { f: formId, c: contactId, e: expSeconds, s: source }
//   key = HKDF-SHA256(FORM_LINK_SECRET, info = 'form-link', 32 bytes)
//
// Sem estado: um disparo para 5.000 contatos não grava 5.000 linhas, e
// validar é uma comparação em tempo constante (`timingSafeEqual`). O
// `formId` vai no payload E na verificação: um token não serve em outro
// formulário. Revogar é despublicar/arquivar o formulário ou bloquear o
// contato (D-3). Sem `FORM_LINK_SECRET` (ou com segredo curto demais),
// `signFormLink` devolve `null` e os chamadores avisam "não configurado";
// o link genérico continua funcionando.
//
// Só servidor (`node:crypto`). O segredo é lido A CADA chamada — não no
// carregamento do módulo — para o teste poder trocá-lo e para um deploy
// que ganhe a variável depois não precisar reiniciar o processo.
// ============================================================

import { createHash, createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';

import type { ResponseSource } from './types';

export const FORM_LINK_SECRET_ENV = 'FORM_LINK_SECRET';
/** Mínimo aceito para o segredo (bytes UTF-8), SPEC E-4. */
export const FORM_LINK_SECRET_MIN_BYTES = 32;
/** PRD R-4: expiração padrão de 30 dias. */
export const FORM_LINK_DEFAULT_TTL_DAYS = 30;
export const FORM_LINK_MAX_TTL_DAYS = 365;

const HKDF_INFO_LINK = 'form-link';
const HKDF_INFO_IP = 'form-ip';
const KEY_BYTES = 32;

const SOURCES: ReadonlySet<string> = new Set<ResponseSource>([
  'link',
  'inbox',
  'broadcast',
  'automation',
  'flow',
  'portal',
  'ai',
  'api',
  'embed',
]);

function readSecret(): string | null {
  const raw = process.env[FORM_LINK_SECRET_ENV];
  if (!raw) return null;
  if (Buffer.byteLength(raw, 'utf8') < FORM_LINK_SECRET_MIN_BYTES) return null;
  return raw;
}

/** `true` quando o deploy tem um segredo utilizável (para a tela de Configurações). */
export function isFormLinkConfigured(): boolean {
  return readSecret() !== null;
}

const keyCache = new Map<string, Buffer>();

function deriveKey(info: string): Buffer | null {
  const secret = readSecret();
  if (!secret) return null;
  const cacheKey = `${info}:${secret}`;
  let key = keyCache.get(cacheKey);
  if (!key) {
    // Sal vazio de propósito: o segredo já é aleatório e de alta entropia;
    // `info` separa os usos (link × hash de IP).
    key = Buffer.from(hkdfSync('sha256', secret, '', info, KEY_BYTES));
    keyCache.clear();
    keyCache.set(cacheKey, key);
  }
  return key;
}

function b64url(buf: Buffer): string {
  return buf.toString('base64url');
}

function sign(key: Buffer, body: string): string {
  return b64url(createHmac('sha256', key).update(body).digest());
}

export interface SignFormLinkInput {
  formId: string;
  contactId: string;
  source: ResponseSource;
  /** Padrão 30; máximo 365; valores inválidos caem no padrão. */
  ttlDays?: number | null;
  /** Injetável para teste. */
  now?: Date;
}

export interface FormLinkClaims {
  formId: string;
  contactId: string;
  source: ResponseSource;
  expiresAt: Date;
}

/** Token assinado, ou `null` sem segredo configurado. */
export function signFormLink(input: SignFormLinkInput): string | null {
  const key = deriveKey(HKDF_INFO_LINK);
  if (!key) return null;

  const ttl =
    Number.isFinite(input.ttlDays) && (input.ttlDays as number) > 0
      ? Math.min(Math.floor(input.ttlDays as number), FORM_LINK_MAX_TTL_DAYS)
      : FORM_LINK_DEFAULT_TTL_DAYS;
  const nowMs = (input.now ?? new Date()).getTime();
  const exp = Math.floor(nowMs / 1000) + ttl * 86_400;

  const payload = JSON.stringify({
    f: input.formId,
    c: input.contactId,
    e: exp,
    s: input.source,
  });
  const body = b64url(Buffer.from(payload, 'utf8'));
  return `${body}.${sign(key, body)}`;
}

/**
 * Verifica assinatura, expiração e vínculo ao formulário. Devolve `null`
 * para QUALQUER problema (sem segredo, formato, assinatura, expirado,
 * outro formulário): a página degrada para pedir o telefone (D-2), nunca
 * mostra erro.
 */
export function verifyFormLink(
  token: string | null | undefined,
  formId: string,
  now: Date = new Date()
): FormLinkClaims | null {
  if (!token || typeof token !== 'string' || token.length > 1024) return null;
  const key = deriveKey(HKDF_INFO_LINK);
  if (!key) return null;

  const dot = token.indexOf('.');
  if (dot <= 0 || dot === token.length - 1) return null;
  const body = token.slice(0, dot);
  const given = token.slice(dot + 1);
  if (!/^[A-Za-z0-9_-]+$/.test(body) || !/^[A-Za-z0-9_-]+$/.test(given)) {
    return null;
  }

  const expected = sign(key, body);
  const a = Buffer.from(given, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  let claims: { f?: unknown; c?: unknown; e?: unknown; s?: unknown };
  try {
    claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (
    typeof claims.f !== 'string' ||
    typeof claims.c !== 'string' ||
    typeof claims.e !== 'number' ||
    typeof claims.s !== 'string' ||
    !SOURCES.has(claims.s)
  ) {
    return null;
  }
  if (claims.f !== formId) return null;
  if (claims.e * 1000 <= now.getTime()) return null;

  return {
    formId: claims.f,
    contactId: claims.c,
    source: claims.s as ResponseSource,
    expiresAt: new Date(claims.e * 1000),
  };
}

/**
 * URL pública do formulário. `origin` vem de `resolveRequestOrigin` /
 * `NEXT_PUBLIC_SITE_URL` (na SPEC 087, do domínio verificado); barra
 * final da origem é tolerada. O token vai em `?t=`.
 */
export function formPublicUrl(
  slug: string,
  origin: string,
  token?: string | null
): string {
  const base = origin.replace(/\/+$/, '');
  const url = `${base}/f/${encodeURIComponent(slug)}`;
  return token ? `${url}?t=${encodeURIComponent(token)}` : url;
}

/**
 * `ip_hash` de `form_responses` (§7.2): sha256 do IP com chave derivada
 * do segredo; sem segredo, sal fixo do processo — sem valor forense,
 * aceito. Nunca o IP em claro.
 */
const processSalt = globalThis.crypto.randomUUID();

export function hashClientIp(ip: string | null | undefined): string | null {
  if (!ip) return null;
  const key = deriveKey(HKDF_INFO_IP);
  const h = key
    ? createHmac('sha256', key).update(ip).digest('hex')
    : createHash('sha256').update(`${processSalt}:${ip}`).digest('hex');
  return h.slice(0, 32);
}
