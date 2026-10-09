/**
 * Resultado das ações do console (SPEC 078 §8) — o formato comum entre
 * os orquestradores de `billing-console.ts` / `user-identity-console.ts`
 * e as rotas `/api/platform/**`, que só o traduzem em `NextResponse`.
 *
 * Mensagens de erro em **inglês** com `code` estável (AGENTS.md: rotas
 * de `/api/**` falam inglês); a UI traduz pelo `code`.
 */

import { NextResponse } from 'next/server';

export interface ConsoleFailure {
  ok: false;
  status: number;
  error: string;
  code: string;
  /** Campos extras no corpo (ex.: `emailUpdated` em `partial_update`). */
  extra?: Record<string, unknown>;
}

export type ConsoleResult<T> = { ok: true; data: T } | ConsoleFailure;

export function fail(
  status: number,
  code: string,
  error: string,
  extra?: Record<string, unknown>
): ConsoleFailure {
  return { ok: false, status, code, error, extra };
}

export function toResponse<T>(result: ConsoleResult<T>): NextResponse {
  if (result.ok) return NextResponse.json(result.data);
  return NextResponse.json(
    { error: result.error, code: result.code, ...result.extra },
    { status: result.status }
  );
}

/**
 * 404 genérico das rotas do console (não autorizado / id malformado).
 * Uma `Response` nova a cada chamada: o corpo é um stream de leitura
 * única, então uma constante de módulo só serve a primeira requisição.
 */
export function notFoundResponse(): NextResponse {
  return NextResponse.json({ error: 'Not found' }, { status: 404 });
}

/** Motivo livre do operador: aparado, vazio vira `null`, teto de 500. */
export function parseReason(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed.slice(0, 500);
}
