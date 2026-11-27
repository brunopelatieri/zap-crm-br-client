import { describe, it, expect, vi } from 'vitest';

vi.mock('./admin-client', () => ({ supabaseAdmin: () => ({}) }));

import { ForbiddenError } from '@/lib/auth/account';
import { hasAiFeature, requireAiFeature } from './plan-gate';

function dbRpc(result: { data: unknown; error: unknown }) {
  const rpc = vi.fn().mockResolvedValue(result);
  return { db: { rpc }, rpc };
}

describe('hasAiFeature (SPEC 089 D-20, strict mode)', () => {
  it('asks plan_feature_strict for ai_enabled of the account', async () => {
    const { db, rpc } = dbRpc({ data: true, error: null });
    expect(await hasAiFeature('acct-1', db)).toBe(true);
    expect(rpc).toHaveBeenCalledWith('plan_feature_strict', {
      p_account_id: 'acct-1',
      p_key: 'ai_enabled',
    });
  });

  it('a missing key (strict function answers false) blocks the AI', async () => {
    const { db } = dbRpc({ data: false, error: null });
    expect(await hasAiFeature('acct-1', db)).toBe(false);
  });

  it('fails closed on an RPC error or an unexpected value', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(
      await hasAiFeature(
        'a',
        dbRpc({ data: null, error: { code: '42883' } }).db
      )
    ).toBe(false);
    expect(
      await hasAiFeature('a', dbRpc({ data: 'true', error: null }).db)
    ).toBe(false);
    expect(await hasAiFeature('a', dbRpc({ data: null, error: null }).db)).toBe(
      false
    );
    spy.mockRestore();
  });

  it('does not put the account id in the error log', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await hasAiFeature(
      'secret-acct-id',
      dbRpc({ data: null, error: { code: 'X' } }).db
    );
    expect(JSON.stringify(spy.mock.calls)).not.toContain('secret-acct-id');
    spy.mockRestore();
  });
});

describe('requireAiFeature', () => {
  it('throws ForbiddenError FEATURE_NOT_IN_PLAN when the plan lacks the key', async () => {
    const { db } = dbRpc({ data: false, error: null });
    await expect(requireAiFeature('a', db)).rejects.toMatchObject({
      message: 'FEATURE_NOT_IN_PLAN',
    });
    await expect(requireAiFeature('a', db)).rejects.toBeInstanceOf(
      ForbiddenError
    );
  });

  it('resolves when the plan has it', async () => {
    const { db } = dbRpc({ data: true, error: null });
    await expect(requireAiFeature('a', db)).resolves.toBeUndefined();
  });
});
