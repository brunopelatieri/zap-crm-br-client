/**
 * Guarda do operador para `/api/admin/**` (SPEC 059 D-9).
 *
 * Não existe conceito de "usuário da plataforma" no schema — todo
 * usuário pertence a exatamente uma conta (017). Criar esse conceito
 * seria um projeto próprio com superfície de segurança dele mesmo (um
 * bug ali vaza dados entre clientes). Por isso o operador age por
 * segredo de servidor, no MESMO formato de `AUTOMATION_CRON_SECRET`
 * (`/api/broadcasts/cron`, `/api/automations/cron`, `/api/flows/cron`):
 * sem a variável no servidor, a rota responde 503 — falha alto, nunca
 * abre. Um painel de super-admin com login é SPEC futura (§11).
 */

import { timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';

/**
 * `null` quando autorizado. Caller devolve a resposta diretamente:
 *
 *   const denied = requirePlatformAdminSecret(request);
 *   if (denied) return denied;
 */
export function requirePlatformAdminSecret(
  request: Request
): NextResponse | null {
  const expected = process.env.PLATFORM_ADMIN_SECRET;
  if (!expected) {
    return NextResponse.json(
      { error: 'platform admin not configured' },
      { status: 503 }
    );
  }

  // Comparação de tempo constante — sem ela, um atacante que alcança o
  // endpoint recupera o segredo byte a byte pelos deltas de resposta.
  const supplied = request.headers.get('x-admin-secret') ?? '';
  const suppliedBuf = Buffer.from(supplied);
  const expectedBuf = Buffer.from(expected);
  if (
    suppliedBuf.length !== expectedBuf.length ||
    !timingSafeEqual(suppliedBuf, expectedBuf)
  ) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  return null;
}
