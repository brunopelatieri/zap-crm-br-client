/**
 * Erro tipado → resposta HTTP, para as rotas de
 * `/api/channels/evolution/instances/*` (SPEC 048 §7). Um `catch` só,
 * em toda rota:
 *
 *   } catch (err) {
 *     return toEvolutionErrorResponse(err);
 *   }
 */

import { NextResponse } from 'next/server';

import {
  AccountBlockedError,
  ForbiddenError,
  UnauthorizedError,
} from '@/lib/auth/account';
import { EvolutionApiError } from './client';
import {
  EvolutionNotConfiguredError,
  InstanceLimitReachedError,
  InstanceNotFoundError,
} from './instances';

export function toEvolutionErrorResponse(err: unknown): NextResponse {
  // Achado de code review (SPEC 062 §4.1): `requireRole()` lança
  // `AccountBlockedError` para conta/usuário bloqueado, e sem este
  // check ela caía no branch genérico abaixo — 500 em vez de 403 — nas
  // 8 rotas de `/api/channels/evolution/instances/**`, que todas usam
  // este mapeador em vez de `toErrorResponse` (auth/account.ts), que já
  // tratava isto corretamente.
  if (err instanceof AccountBlockedError) {
    return NextResponse.json(
      { error: err.message, code: err.code },
      { status: err.status }
    );
  }
  if (err instanceof UnauthorizedError || err instanceof ForbiddenError) {
    return NextResponse.json({ error: err.message }, { status: err.status });
  }

  if (err instanceof EvolutionNotConfiguredError) {
    // 422, not 503 — see the EvolutionApiError branch below for why.
    return NextResponse.json({ error: err.message }, { status: 422 });
  }

  if (err instanceof InstanceLimitReachedError) {
    return NextResponse.json(
      { error: err.message, reason: err.decision.reason },
      { status: 409 }
    );
  }

  if (err instanceof InstanceNotFoundError) {
    return NextResponse.json({ error: err.message }, { status: 404 });
  }

  if (err instanceof EvolutionApiError) {
    // bad_request/not_found refletem o que FOI PEDIDO (ex.: telefone
    // inválido no pareamento) — repassados como estão. auth_failed e
    // channel_unavailable são falhas do LADO SERVIDOR (token rotacionado
    // na VPS, VPS fora do ar) — não é o pedido que está errado, mas
    // continuam sendo 422 (e não 502/503): esta é a resposta JSON do
    // NOSSO app, same-origin, e um 502/503 literal aqui é interceptado
    // por proxies reversos na frente de instalações self-hosted
    // (nginx/Traefik/Coolify trocam por página de erro genérica própria
    // nesses códigos), engolindo esta mensagem antes de chegar ao
    // browser — mesmo bug confirmado nas rotas de template WhatsApp.
    // `kind` no corpo continua distinguindo "erro do servidor" de
    // "erro do pedido" para quem precisar dessa granularidade.
    const status =
      err.kind === 'bad_request' ? 400 : err.kind === 'not_found' ? 404 : 422;
    return NextResponse.json(
      { error: `Evolution API error: ${err.message}`, kind: err.kind },
      { status }
    );
  }

  console.error('[evolution] unexpected error:', err);
  return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
}
