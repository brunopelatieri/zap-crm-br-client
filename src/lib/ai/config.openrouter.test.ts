import { describe, it, expect, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

// decrypt is identity-with-prefix in tests (no real ciphertext needed).
vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: (v: string) => `plain:${v}`,
}));

import { loadAiConfig, loadEmbeddingsTarget } from './config';

function dbReturning(row: Record<string, unknown> | null): SupabaseClient {
  const chain = {
    from: () => chain,
    select: () => chain,
    eq: () => chain,
    maybeSingle: () => Promise.resolve({ data: row, error: null }),
  };
  return chain as unknown as SupabaseClient;
}

const OR_ROW = {
  provider: 'openrouter',
  model: 'anthropic/claude-haiku-5.5',
  api_key: 'enc-key',
  system_prompt: null,
  is_active: true,
  auto_reply_enabled: false,
  auto_reply_max_per_conversation: 3,
  handoff_agent_id: null,
  embeddings_api_key: null,
  embeddings_provider: 'openai',
  provider_options: {},
};

describe('loadAiConfig — OpenRouter and options (SPEC 089 F1)', () => {
  it('reuses the chat key for embeddings on OpenRouter without an own key', async () => {
    const config = await loadAiConfig(dbReturning(OR_ROW), 'acct');
    expect(config!.embeddingsTarget).toEqual({
      provider: 'openrouter',
      apiKey: 'plain:enc-key',
    });
  });

  it('uses the own embeddings key on the stored embeddings provider', async () => {
    const config = await loadAiConfig(
      dbReturning({ ...OR_ROW, embeddings_api_key: 'enc-emb' }),
      'acct'
    );
    expect(config!.embeddingsTarget).toEqual({
      provider: 'openai',
      apiKey: 'plain:enc-emb',
    });
  });

  it('keeps OpenAI chat without an embeddings key lexical-only', async () => {
    const config = await loadAiConfig(
      dbReturning({ ...OR_ROW, provider: 'openai' }),
      'acct'
    );
    expect(config!.embeddingsTarget).toBeNull();
  });

  it('privacy switch is off by default and read from provider_options', async () => {
    const off = await loadAiConfig(dbReturning(OR_ROW), 'acct');
    expect(off!.providerOptions).toEqual({ denyDataCollection: false });
    const on = await loadAiConfig(
      dbReturning({
        ...OR_ROW,
        provider_options: { deny_data_collection: true },
      }),
      'acct'
    );
    expect(on!.providerOptions).toEqual({ denyDataCollection: true });
  });

  it('tolerates a row from before migration 102 (no new columns)', async () => {
    const legacy: Record<string, unknown> = { ...OR_ROW, provider: 'openai' };
    delete legacy.embeddings_provider;
    delete legacy.provider_options;
    const config = await loadAiConfig(dbReturning(legacy), 'acct');
    expect(config!.providerOptions).toEqual({ denyDataCollection: false });
    expect(config!.embeddingsTarget).toBeNull();
  });
});

describe('loadEmbeddingsTarget', () => {
  it('resolves the OpenRouter chat-key reuse for the ingest routes', async () => {
    expect(await loadEmbeddingsTarget(dbReturning(OR_ROW), 'acct')).toEqual({
      target: { provider: 'openrouter', apiKey: 'plain:enc-key' },
      corrupt: false,
    });
  });

  it('returns no target when there is no row', async () => {
    expect(await loadEmbeddingsTarget(dbReturning(null), 'acct')).toEqual({
      target: null,
      corrupt: false,
    });
  });
});
