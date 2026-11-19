// ============================================================
// Casca comum das rotas PÚBLICAS `/api/forms/public/[slug]/**`
// (SPEC 085 §7.2, §8 itens 6, 8 e 9).
//
// O visitante não tem sessão. Cada rota, nesta ordem:
//   1. `Origin` obrigatório e igual ao do app (403) — como `guardWrite`
//      da área do contato, que fornece a regra (`isSameOriginWrite`);
//   2. limite por IP em `RATE_LIMITS` (429);
//   3. corpo JSON com teto de tamanho (413/400).
// Mensagens em inglês com `code` estável (AGENTS.md › i18n): a página
// traduz pelo `code`. NUNCA vaza a causa de uma indisponibilidade: todo
// "não existe / não está no ar / plano / quota" vira o mesmo 404.
// ============================================================

import { NextResponse } from 'next/server';

import { getClientIp, isSameOriginWrite } from '@/lib/contact-portal/request';
import {
  checkRateLimit,
  RATE_LIMITS,
  rateLimitResponse,
} from '@/lib/rate-limit';

// As rotas públicas não importam `contact-portal` (isolation.test.ts): o IP
// e a regra de `Origin` passam por aqui.
export { getClientIp };

export type PublicRateBucket =
  'formStart' | 'formAutosave' | 'formUpload' | 'formSubmit';

/** Teto do corpo das rotas públicas (as respostas de um formulário cabem folgadas). */
export const PUBLIC_BODY_MAX_CHARS = 256 * 1024;

/** Erro com status e código estáveis; as rotas o convertem em JSON. */
export class PublicApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly extra: Record<string, unknown> = {}
  ) {
    super(message);
    this.name = 'PublicApiError';
  }
}

export function publicJsonError(
  code: string,
  message: string,
  status: number,
  extra: Record<string, unknown> = {}
): NextResponse {
  return NextResponse.json({ error: message, code, ...extra }, { status });
}

/** O 404 único de "este formulário não existe ou não está disponível". */
export function unavailableError(): PublicApiError {
  return new PublicApiError(404, 'unavailable', 'Form not available.');
}

/** Erro conhecido → resposta; qualquer outro → 500 genérico, log só com o nome. */
export function publicErrorResponse(route: string, err: unknown): NextResponse {
  if (err instanceof PublicApiError) {
    return publicJsonError(err.code, err.message, err.status, err.extra);
  }
  const name = err instanceof Error ? err.name : typeof err;
  console.error(`[forms/public] ${route} failed (${name})`);
  return publicJsonError('unexpected', 'Something went wrong. Try again.', 500);
}

/** Origin e limite por IP. `null` quando pode seguir. */
export function guardPublicRequest(
  request: Request,
  bucket: PublicRateBucket
): NextResponse | null {
  if (!isSameOriginWrite(request)) {
    return publicJsonError(
      'forbidden_origin',
      'Cross-origin request refused.',
      403
    );
  }
  const result = checkRateLimit(
    `${bucket}:${getClientIp(request)}`,
    RATE_LIMITS[bucket]
  );
  return result.success ? null : rateLimitResponse(result);
}

/** Corpo JSON como objeto. Lança `PublicApiError` (400/413) em vez de devolver `null`. */
export async function readPublicBody(
  request: Request
): Promise<Record<string, unknown>> {
  const declared = Number(request.headers.get('content-length') ?? 0);
  if (Number.isFinite(declared) && declared > PUBLIC_BODY_MAX_CHARS) {
    throw new PublicApiError(413, 'payload_too_large', 'Payload too large.');
  }
  let text: string;
  try {
    text = await request.text();
  } catch {
    throw new PublicApiError(400, 'invalid_request', 'Invalid request body.');
  }
  if (text.length > PUBLIC_BODY_MAX_CHARS) {
    throw new PublicApiError(413, 'payload_too_large', 'Payload too large.');
  }
  try {
    const body: unknown = JSON.parse(text);
    if (body && typeof body === 'object' && !Array.isArray(body)) {
      return body as Record<string, unknown>;
    }
  } catch {
    /* cai no erro abaixo */
  }
  throw new PublicApiError(400, 'invalid_request', 'Invalid request body.');
}

const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{1,58}[a-z0-9]$/;

/** Forma do slug (a mesma do CHECK da 097); qualquer outra coisa é "indisponível". */
export function isSlugShape(slug: unknown): slug is string {
  return typeof slug === 'string' && SLUG_PATTERN.test(slug);
}

/** Corpo → string ≤ `max` ou `null`. */
export function bodyString(
  body: Record<string, unknown>,
  key: string,
  max = 256
): string | null {
  const v = body[key];
  return typeof v === 'string' && v.length <= max ? v : null;
}
