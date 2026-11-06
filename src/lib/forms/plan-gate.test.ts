import { describe, expect, it, vi } from 'vitest';

import { ForbiddenError } from '@/lib/auth/account';
import { FEATURE_KEYS } from '@/lib/plans/types';

import {
  FEATURE_NOT_IN_PLAN,
  FORMS_FEATURE_KEY,
  hasFormsFeature,
  requireFormsFeature,
} from './plan-gate';

/** Cliente de mentira: devolve o que `plan_feature_strict` devolveria. */
function dbReturning(result: { data?: unknown; error?: unknown }) {
  const rpc = vi.fn().mockResolvedValue({
    data: result.data ?? null,
    error: result.error ?? null,
  });
  return { db: { rpc }, rpc };
}

describe('hasFormsFeature (SPEC 085 §5.3, PRD 084 D-10)', () => {
  it('a chave é a de FEATURE_KEYS e só ela', () => {
    expect(FEATURE_KEYS).toContain(FORMS_FEATURE_KEY);
    expect(FORMS_FEATURE_KEY).toBe('forms_enabled');
  });

  it('lê plan_feature_strict com a conta e a chave da porta', async () => {
    const { db, rpc } = dbReturning({ data: true });
    await hasFormsFeature('acc1', db);
    expect(rpc).toHaveBeenCalledWith('plan_feature_strict', {
      p_account_id: 'acc1',
      p_key: 'forms_enabled',
    });
    // Nunca a `plan_feature()` da 067, que libera chave ausente.
    expect(rpc).not.toHaveBeenCalledWith('plan_feature', expect.anything());
  });

  it.each([
    ['true', { data: true }, true],
    ['false', { data: false }, false],
    ['ausente (NULL)', { data: null }, false],
    ['lixo', { data: 'yes' }, false],
  ])('chave %s → %s', async (_c, r, expected) => {
    const { db } = dbReturning(r);
    expect(await hasFormsFeature('acc1', db)).toBe(expected);
  });

  it('falha da RPC → false, com log sem a conta e sem lançar', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { db } = dbReturning({ error: { code: '42883' } });
    expect(await hasFormsFeature('acc1', db)).toBe(false);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(spy.mock.calls)).not.toContain('acc1');
    spy.mockRestore();
  });
});

describe('requireFormsFeature', () => {
  it('com o item: segue em silêncio', async () => {
    const { db } = dbReturning({ data: true });
    await expect(requireFormsFeature('acc1', db)).resolves.toBeUndefined();
  });

  it.each([
    ['false', { data: false }],
    ['ausente', { data: null }],
  ])(
    'sem o item (%s): ForbiddenError FEATURE_NOT_IN_PLAN (403)',
    async (_c, r) => {
      const { db } = dbReturning(r);
      const err = await requireFormsFeature('acc1', db).catch((e) => e);
      expect(err).toBeInstanceOf(ForbiddenError);
      expect((err as Error).message).toBe(FEATURE_NOT_IN_PLAN);
      expect((err as ForbiddenError).status).toBe(403);
    }
  );
});
