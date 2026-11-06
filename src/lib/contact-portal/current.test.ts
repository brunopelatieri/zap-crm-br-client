import { describe, expect, it, vi } from 'vitest';

import { resolvePortalSession } from './current';
import {
  PORTAL_SESSION_COOKIE,
  generateSessionToken,
  hashSessionToken,
} from './session';

function store(value?: string) {
  return {
    get: (name: string) =>
      name === PORTAL_SESSION_COOKIE && value !== undefined
        ? { value }
        : undefined,
  };
}

describe('resolvePortalSession', () => {
  it('sem cookie ou com cookie malformado não consulta o banco', async () => {
    const service = { resolveSession: vi.fn() };
    expect(await resolvePortalSession(store(), service)).toBeNull();
    expect(await resolvePortalSession(store('lixo'), service)).toBeNull();
    expect(service.resolveSession).not.toHaveBeenCalled();
  });

  it('resolve pelo sha256 do token, nunca pelo token', async () => {
    const token = generateSessionToken();
    const service = { resolveSession: vi.fn().mockResolvedValue(null) };
    await resolvePortalSession(store(token), service);
    expect(service.resolveSession).toHaveBeenCalledWith(
      hashSessionToken(token)
    );
  });
});
