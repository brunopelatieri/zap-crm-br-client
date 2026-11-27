import { describe, it, expect, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { logAiUsage } from './usage';

function fakeDb() {
  const insert = vi.fn().mockResolvedValue({ error: null });
  const db = { from: vi.fn(() => ({ insert })) };
  return { db: db as unknown as SupabaseClient, insert };
}

describe('logAiUsage — cost_usd (SPEC 089 D-6)', () => {
  it('writes cost_usd when the provider reported a cost', async () => {
    const { db, insert } = fakeDb();
    await logAiUsage(db, {
      accountId: 'acct-1',
      conversationId: null,
      mode: 'draft',
      provider: 'openrouter',
      model: 'anthropic/claude-haiku-5.5',
      usage: {
        promptTokens: 82,
        completionTokens: 206,
        totalTokens: 288,
        costUsd: 0.0001112,
      },
    });
    expect(insert.mock.calls[0][0]).toMatchObject({
      provider: 'openrouter',
      total_tokens: 288,
      cost_usd: 0.0001112,
    });
  });

  it('leaves cost_usd out for providers that do not report it (and zero is a real cost)', async () => {
    const { db, insert } = fakeDb();
    await logAiUsage(db, {
      accountId: 'acct-1',
      conversationId: null,
      mode: 'draft',
      provider: 'openai',
      model: 'gpt-x',
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    });
    expect(insert.mock.calls[0][0]).not.toHaveProperty('cost_usd');

    insert.mockClear();
    await logAiUsage(db, {
      accountId: 'acct-1',
      conversationId: null,
      mode: 'draft',
      provider: 'openrouter',
      model: 'some/free:free',
      usage: {
        promptTokens: 1,
        completionTokens: 1,
        totalTokens: 2,
        costUsd: 0,
      },
    });
    expect(insert.mock.calls[0][0]).toMatchObject({ cost_usd: 0 });
  });
});
