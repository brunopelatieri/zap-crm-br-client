import { describe, it, expect, vi } from 'vitest';
import { logAiUsage } from './usage';
import type { SupabaseClient } from '@supabase/supabase-js';

function fakeDb() {
  const insert = vi.fn().mockResolvedValue({ error: null });
  const db = { from: vi.fn(() => ({ insert })) };
  return { db: db as unknown as SupabaseClient, insert, from: db.from };
}

describe('logAiUsage', () => {
  it('inserts a row mapping normalized usage to the log columns', async () => {
    const { db, insert, from } = fakeDb();
    await logAiUsage(db, {
      accountId: 'acct-1',
      conversationId: 'conv-1',
      mode: 'auto_reply',
      provider: 'anthropic',
      model: 'claude-x',
      usage: { promptTokens: 30, completionTokens: 6, totalTokens: 36 },
    });
    expect(from).toHaveBeenCalledWith('ai_usage_log');
    expect(insert).toHaveBeenCalledWith({
      account_id: 'acct-1',
      conversation_id: 'conv-1',
      mode: 'auto_reply',
      provider: 'anthropic',
      model: 'claude-x',
      prompt_tokens: 30,
      completion_tokens: 6,
      total_tokens: 36,
    });
  });

  it('records the knowledge documents behind the turn (D-14), only when there are any', async () => {
    const { db, insert } = fakeDb();
    const base = {
      accountId: 'acct-1',
      conversationId: 'conv-1',
      mode: 'draft' as const,
      provider: 'openai' as const,
      model: 'gpt-x',
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    };
    await logAiUsage(db, { ...base, knowledgeDocumentIds: ['d1', 'd2'] });
    expect(insert.mock.calls[0][0].knowledge_document_ids).toEqual([
      'd1',
      'd2',
    ]);

    await logAiUsage(db, { ...base, knowledgeDocumentIds: [] });
    // Empty: the column is left out, so the insert is valid before 104.
    expect(insert.mock.calls[1][0]).not.toHaveProperty(
      'knowledge_document_ids'
    );
  });

  it('is a no-op when the provider reported no usage', async () => {
    const { db, from } = fakeDb();
    await logAiUsage(db, {
      accountId: 'acct-1',
      conversationId: null,
      mode: 'draft',
      provider: 'openai',
      model: 'gpt-x',
      usage: null,
    });
    expect(from).not.toHaveBeenCalled();
  });

  it('never throws when the insert errors', async () => {
    const insert = vi.fn().mockResolvedValue({ error: { message: 'boom' } });
    const db = { from: vi.fn(() => ({ insert })) } as unknown as SupabaseClient;
    await expect(
      logAiUsage(db, {
        accountId: 'acct-1',
        conversationId: 'conv-1',
        mode: 'draft',
        provider: 'openai',
        model: 'gpt-x',
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      })
    ).resolves.toBeUndefined();
  });
});

describe('logAiUsage — error log (LGPD review)', () => {
  it('logs only code and message of a database error, never its details', async () => {
    const insert = vi.fn().mockResolvedValue({
      error: {
        code: '23514',
        message: 'new row violates check constraint',
        details: 'Failing row contains (Maria da Silva, 11987654321)',
        hint: 'x',
      },
    });
    const db = { from: vi.fn(() => ({ insert })) } as unknown as SupabaseClient;
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await logAiUsage(db, {
        accountId: 'acct-1',
        conversationId: 'conv-1',
        mode: 'auto_reply',
        provider: 'anthropic',
        model: 'claude-x',
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      });
      expect(spy).toHaveBeenCalled();
      const logged = JSON.stringify(spy.mock.calls);
      expect(logged).toContain('23514');
      expect(logged).not.toMatch(/Maria|11987654321|Failing row/);
    } finally {
      spy.mockRestore();
    }
  });
});
