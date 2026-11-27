import { describe, it, expect, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  diffLines,
  normalizePrompt,
  promptChanged,
  recordPromptVersion,
} from './prompt-versions';

describe('promptChanged', () => {
  it('treats null, empty and whitespace as the same "no prompt"', () => {
    expect(promptChanged(null, '')).toBe(false);
    expect(promptChanged(null, '   ')).toBe(false);
    expect(promptChanged('', null)).toBe(false);
  });

  it('ignores surrounding whitespace but sees real edits', () => {
    expect(promptChanged('Be kind.', '  Be kind.\n')).toBe(false);
    expect(promptChanged('Be kind.', 'Be kind!')).toBe(true);
    expect(promptChanged(null, 'First prompt')).toBe(true);
    expect(promptChanged('Something', null)).toBe(true);
  });
});

describe('recordPromptVersion', () => {
  function fakeDb(result: { error: unknown } | 'throw') {
    const insert = vi.fn(() =>
      result === 'throw'
        ? Promise.reject(new Error('boom'))
        : Promise.resolve(result)
    );
    const from = vi.fn(() => ({ insert }));
    return { db: { from } as unknown as SupabaseClient, insert, from };
  }

  it('appends a normalized row scoped to the account', async () => {
    const { db, insert, from } = fakeDb({ error: null });
    const ok = await recordPromptVersion(db, {
      accountId: 'acct-1',
      systemPrompt: '  Be kind.  ',
      note: '  restore:abc ',
      createdBy: 'user-1',
    });
    expect(ok).toBe(true);
    expect(from).toHaveBeenCalledWith('ai_prompt_versions');
    expect(insert).toHaveBeenCalledWith({
      account_id: 'acct-1',
      system_prompt: 'Be kind.',
      note: 'restore:abc',
      source: 'panel',
      created_by: 'user-1',
    });
  });

  it('stores a cleared prompt as an empty string and a blank note as null', async () => {
    const { db, insert } = fakeDb({ error: null });
    await recordPromptVersion(db, {
      accountId: 'a',
      systemPrompt: null,
      note: '  ',
      source: 'api',
      createdBy: null,
    });
    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({ system_prompt: '', note: null, source: 'api' })
    );
  });

  it('never throws: a failed or throwing insert returns false', async () => {
    const args = { accountId: 'a', systemPrompt: 'x', createdBy: null };
    expect(
      await recordPromptVersion(fakeDb({ error: { message: 'rls' } }).db, args)
    ).toBe(false);
    expect(await recordPromptVersion(fakeDb('throw').db, args)).toBe(false);
  });
});

describe('diffLines', () => {
  it('marks unchanged, added and removed lines in order', () => {
    expect(diffLines('a\nb\nc', 'a\nB\nc\nd')).toEqual([
      { type: 'same', text: 'a' },
      { type: 'removed', text: 'b' },
      { type: 'added', text: 'B' },
      { type: 'same', text: 'c' },
      { type: 'added', text: 'd' },
    ]);
  });

  it('handles empty sides', () => {
    expect(diffLines('', 'x')).toEqual([{ type: 'added', text: 'x' }]);
    expect(diffLines('x', '')).toEqual([{ type: 'removed', text: 'x' }]);
    expect(diffLines('', '')).toEqual([]);
  });

  it('reports no change for identical text', () => {
    const d = diffLines('one\ntwo', 'one\ntwo');
    expect(d.every((l) => l.type === 'same')).toBe(true);
  });
});

describe('normalizePrompt', () => {
  it('maps nullish to an empty string', () => {
    expect(normalizePrompt(undefined)).toBe('');
    expect(normalizePrompt(null)).toBe('');
  });
});
