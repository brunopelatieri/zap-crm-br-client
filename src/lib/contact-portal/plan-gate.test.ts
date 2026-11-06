import { describe, expect, it, vi } from 'vitest';

import { ForbiddenError } from '@/lib/auth/account';
import { FEATURE_KEYS } from '@/lib/plans/types';

import {
  CONTACT_PORTAL_FEATURE_KEY,
  FEATURE_NOT_IN_PLAN,
  hasContactPortalFeature,
  requireContactPortalFeature,
} from './plan-gate';

/** Cliente de mentira: devolve o que `plan_feature_strict` devolveria. */
function dbReturning(result: { data?: unknown; error?: unknown }) {
  const rpc = vi.fn().mockResolvedValue({
    data: result.data ?? null,
    error: result.error ?? null,
  });
  return { db: { rpc }, rpc };
}

describe('hasContactPortalFeature (SPEC 083 §8.4, PRD 082 D-2)', () => {
  it('a chave é a de FEATURE_KEYS e só ela', () => {
    expect(FEATURE_KEYS).toContain(CONTACT_PORTAL_FEATURE_KEY);
    expect(CONTACT_PORTAL_FEATURE_KEY).toBe('contact_portal_enabled');
  });

  it('lê plan_feature_strict com a conta e a chave da porta', async () => {
    const { db, rpc } = dbReturning({ data: true });
    await hasContactPortalFeature('acc1', db);
    expect(rpc).toHaveBeenCalledWith('plan_feature_strict', {
      p_account_id: 'acc1',
      p_key: 'contact_portal_enabled',
    });
    // Nunca a `plan_feature()` da 067, que libera chave ausente.
    expect(rpc).not.toHaveBeenCalledWith('plan_feature', expect.anything());
  });

  it('chave true no plano (ou na exceção por conta) → true', async () => {
    const { db } = dbReturning({ data: true });
    expect(await hasContactPortalFeature('acc1', db)).toBe(true);
  });

  it('chave false → false', async () => {
    const { db } = dbReturning({ data: false });
    expect(await hasContactPortalFeature('acc1', db)).toBe(false);
  });

  it('chave ausente (NULL da função) → false, nunca "ilimitado"', async () => {
    const { db } = dbReturning({ data: null });
    expect(await hasContactPortalFeature('acc1', db)).toBe(false);
  });

  it('falha da RPC (096 não aplicada, por exemplo) → false, com log e sem lançar', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { db } = dbReturning({ error: { code: '42883' } });
    expect(await hasContactPortalFeature('acc1', db)).toBe(false);
    expect(spy).toHaveBeenCalledTimes(1);
    // O log não repete a conta nem nada que entrou.
    expect(JSON.stringify(spy.mock.calls)).not.toContain('acc1');
    spy.mockRestore();
  });
});

describe('requireContactPortalFeature', () => {
  it('com o item: segue em silêncio', async () => {
    const { db } = dbReturning({ data: true });
    await expect(
      requireContactPortalFeature('acc1', db)
    ).resolves.toBeUndefined();
  });

  it.each([
    ['false', { data: false }],
    ['ausente', { data: null }],
  ])('sem o item (%s): ForbiddenError FEATURE_NOT_IN_PLAN', async (_c, r) => {
    const { db } = dbReturning(r);
    const err = await requireContactPortalFeature('acc1', db).catch((e) => e);
    expect(err).toBeInstanceOf(ForbiddenError);
    expect((err as Error).message).toBe(FEATURE_NOT_IN_PLAN);
    expect((err as ForbiddenError).status).toBe(403);
  });
});
