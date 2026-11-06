// ============================================================
// Casca comum das rotas `/area/api/**` (SPEC 083 §8.2).
//
// Mensagens em inglês com `code` estável, como o resto de `/api/**`
// (AGENTS.md › i18n): a tela traduz pelo `code`, nunca pela frase.
// ============================================================

import { NextResponse } from 'next/server';

import { isSameOriginWrite, requestOrigin } from './request';

export function portalError(
  code: string,
  message: string,
  status: number
): NextResponse {
  return NextResponse.json({ error: message, code }, { status });
}

/** 403 quando o `Origin` não é o do app; `null` quando pode seguir. */
export function guardWrite(request: Request): NextResponse | null {
  return isSameOriginWrite(request)
    ? null
    : portalError('forbidden_origin', 'Cross-origin request refused.', 403);
}

/** Origem que o navegador está usando — para o `Secure` do cookie. */
export function cookieOrigin(request: Request): string {
  return requestOrigin(request);
}

/** Erro inesperado: log só com o nome, resposta genérica. */
export function unexpected(route: string, err: unknown): NextResponse {
  const name = err instanceof Error ? err.name : typeof err;
  console.error(`[contact-portal] ${route} failed (${name})`);
  return portalError('unexpected', 'Something went wrong. Try again.', 500);
}
