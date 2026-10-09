import { beforeEach, describe, expect, it, vi } from 'vitest';

const requirePlatformOwner = vi.fn();
vi.mock('@/lib/platform/owner', () => ({
  requirePlatformOwner: () => requirePlatformOwner(),
  parseOwnerEmails: () => [],
}));

vi.mock('@/lib/supabase/admin', () => ({
  supabaseAdmin: () => ({ marker: 'admin-db' }),
}));

const editUserIdentity = vi.fn();
vi.mock('@/lib/platform/user-identity-console', () => ({
  editUserIdentity: (...args: unknown[]) => editUserIdentity(...args),
}));

import { PATCH } from './route';

const USER = '33333333-3333-4333-8333-333333333333';
const params = { params: Promise.resolve({ userId: USER }) };
const patch = (body: unknown) =>
  new Request('http://localhost/api/platform/users/x', {
    method: 'PATCH',
    body: JSON.stringify(body),
  });

beforeEach(() => {
  requirePlatformOwner.mockReset();
  editUserIdentity.mockReset();
});

describe('PATCH /api/platform/users/[userId]', () => {
  it('sem sessão de proprietário → 404, sem tocar no orquestrador', async () => {
    requirePlatformOwner.mockRejectedValue(new Error('No valid session'));
    const res = await PATCH(patch({ fullName: 'Nova' }), params);
    expect(res.status).toBe(404);
    expect(editUserIdentity).not.toHaveBeenCalled();
  });

  it('userId que não é UUID → 404', async () => {
    requirePlatformOwner.mockResolvedValue({ email: 'b@z.com', userId: 'o' });
    const res = await PATCH(patch({}), {
      params: Promise.resolve({ userId: 'abc' }),
    });
    expect(res.status).toBe(404);
    expect(editUserIdentity).not.toHaveBeenCalled();
  });

  it('repassa usuário, e-mail do proprietário e corpo; devolve o resultado', async () => {
    requirePlatformOwner.mockResolvedValue({ email: 'b@z.com', userId: 'o' });
    editUserIdentity.mockResolvedValue({
      ok: true,
      data: { fields: ['fullName'] },
    });
    const res = await PATCH(patch({ fullName: 'Nova' }), params);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ fields: ['fullName'] });
    expect(editUserIdentity).toHaveBeenCalledWith(
      { marker: 'admin-db' },
      { userId: USER, ownerEmail: 'b@z.com', body: { fullName: 'Nova' } }
    );
  });

  it('partial_update devolve emailUpdated no corpo', async () => {
    requirePlatformOwner.mockResolvedValue({ email: 'b@z.com', userId: 'o' });
    editUserIdentity.mockResolvedValue({
      ok: false,
      status: 500,
      code: 'partial_update',
      error: 'The e-mail was updated but the name was not',
      extra: { emailUpdated: true },
    });
    const res = await PATCH(patch({ email: 'a@b.co', fullName: 'X' }), params);
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({
      code: 'partial_update',
      emailUpdated: true,
    });
  });
});
