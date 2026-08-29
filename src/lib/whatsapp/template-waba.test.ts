import { describe, it, expect, vi } from 'vitest';
import {
  createSupabaseMock,
  type MockResult,
  type QueryOp,
} from '@/lib/audience/supabase-mock';
import { findTemplateRowForWaba } from './template-waba';

const ACCOUNT = 'acct-1';

function makeDb(candidates: Record<string, unknown>[]) {
  const handler = (table: string, _ops: QueryOp[]): MockResult | undefined => {
    if (table === 'message_templates') return { data: candidates };
    return undefined;
  };
  return createSupabaseMock(handler).db;
}

function makeErrorDb(message: string) {
  const handler = (table: string, _ops: QueryOp[]): MockResult | undefined => {
    if (table === 'message_templates') {
      return { data: null, error: { message } };
    }
    return undefined;
  };
  return createSupabaseMock(handler).db;
}

describe('findTemplateRowForWaba (SPEC 064 D-2)', () => {
  it('returns null when there are no candidates at all', async () => {
    const db = makeDb([]);
    await expect(
      findTemplateRowForWaba(db, {
        accountId: ACCOUNT,
        name: 'promo',
        language: 'en_US',
        wabaId: 'waba-a',
      })
    ).resolves.toBeNull();
  });

  it('picks the row belonging to the requested WABA over a legacy (null) one', async () => {
    const rowA = { id: 't-a', waba_id: 'waba-a' };
    const rowLegacy = { id: 't-legacy', waba_id: null };
    const db = makeDb([rowLegacy, rowA]);

    const found = await findTemplateRowForWaba(db, {
      accountId: ACCOUNT,
      name: 'promo',
      language: 'en_US',
      wabaId: 'waba-a',
    });
    expect(found).toBe(rowA);
  });

  it('never returns a row from a DIFFERENT WABA — the same name legitimately exists twice', async () => {
    const rowB = { id: 't-b', waba_id: 'waba-b' };
    const db = makeDb([rowB]);

    const found = await findTemplateRowForWaba(db, {
      accountId: ACCOUNT,
      name: 'promo',
      language: 'en_US',
      wabaId: 'waba-a',
    });
    expect(found).toBeNull();
  });

  it('adopts a legacy (waba_id NULL) row when no row matches the requested WABA', async () => {
    const rowLegacy = { id: 't-legacy', waba_id: null };
    const db = makeDb([rowLegacy]);

    const found = await findTemplateRowForWaba(db, {
      accountId: ACCOUNT,
      name: 'promo',
      language: 'en_US',
      wabaId: 'waba-a',
    });
    expect(found).toBe(rowLegacy);
  });

  it('treats a row missing the waba_id key as legacy (undefined normalizes to null)', async () => {
    const rowNoKey = { id: 't-no-key' }; // no `waba_id` at all
    const db = makeDb([rowNoKey]);

    const found = await findTemplateRowForWaba(db, {
      accountId: ACCOUNT,
      name: 'promo',
      language: 'en_US',
      wabaId: null,
    });
    expect(found).toBe(rowNoKey);
  });

  it('resolving for wabaId=null matches only the legacy row, not a real-WABA one', async () => {
    const rowA = { id: 't-a', waba_id: 'waba-a' };
    const db = makeDb([rowA]);

    const found = await findTemplateRowForWaba(db, {
      accountId: ACCOUNT,
      name: 'promo',
      language: 'en_US',
      wabaId: null,
    });
    expect(found).toBeNull();
  });

  // SPEC 064 code review — a leitura falhando não pode derrubar o
  // disparo inteiro: todo chamador que esta função substituiu lia com
  // `.maybeSingle()` sem checar `error`, e uma falha transitória
  // degradava para "sem template local" em vez de propagar.
  it('degrades to null (does not throw) on a transient read error', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const db = makeErrorDb('connection reset');

    await expect(
      findTemplateRowForWaba(db, {
        accountId: ACCOUNT,
        name: 'promo',
        language: 'en_US',
        wabaId: 'waba-a',
      })
    ).resolves.toBeNull();

    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});
