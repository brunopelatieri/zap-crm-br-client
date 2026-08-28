import { describe, expect, it } from 'vitest';

import { AccountBlockedError } from '@/lib/platform/blocked';
import { ForbiddenError, UnauthorizedError } from '@/lib/auth/account';
import { toEvolutionErrorResponse } from './respond';

async function bodyOf(res: Response): Promise<unknown> {
  return res.json();
}

// Achado de code review (SPEC 062 §4.1): `requireRole()` lança
// `AccountBlockedError` para conta/usuário bloqueado; sem este case, o
// erro caía no branch genérico e virava 500 em vez de 403 nas 8 rotas
// de `/api/channels/evolution/instances/**`.
describe('toEvolutionErrorResponse — conta bloqueada (SPEC 062 §4.1)', () => {
  it('mapeia AccountBlockedError para 403 com o code estável, não para 500', async () => {
    const res = toEvolutionErrorResponse(
      new AccountBlockedError('account_blocked', 'This account is blocked')
    );
    expect(res.status).toBe(403);
    expect(await bodyOf(res)).toEqual({
      error: 'This account is blocked',
      code: 'account_blocked',
    });
  });

  it('preserva a distinção user_blocked vs account_blocked no code', async () => {
    const res = toEvolutionErrorResponse(
      new AccountBlockedError('user_blocked', 'This user is blocked')
    );
    expect(res.status).toBe(403);
    expect(await bodyOf(res)).toMatchObject({ code: 'user_blocked' });
  });
});

describe('toEvolutionErrorResponse — outros casos não regrediram', () => {
  it('UnauthorizedError/ForbiddenError continuam mapeados pelo status próprio', async () => {
    const unauthorized = toEvolutionErrorResponse(new UnauthorizedError());
    expect(unauthorized.status).toBe(401);

    const forbidden = toEvolutionErrorResponse(new ForbiddenError('nope'));
    expect(forbidden.status).toBe(403);
  });

  it('erro não classificado continua caindo no genérico 500', async () => {
    const res = toEvolutionErrorResponse(new Error('boom'));
    expect(res.status).toBe(500);
    expect(await bodyOf(res)).toEqual({ error: 'Internal server error' });
  });
});
