import { describe, it, expect, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

// decrypt is identity in tests so we don't depend on real ciphertext.
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

const ROW = {
  provider: 'openai',
  model: 'gpt-x',
  api_key: 'enc-key',
  system_prompt: null,
  is_active: false,
  auto_reply_enabled: false,
  auto_reply_max_per_conversation: 3,
  embeddings_api_key: null,
};

describe('loadAiConfig requireActive', () => {
  it('returns null for an inactive config by default', async () => {
    expect(await loadAiConfig(dbReturning(ROW), 'acct')).toBeNull();
  });

  it('returns the config when requireActive is false (Playground path)', async () => {
    const config = await loadAiConfig(dbReturning(ROW), 'acct', {
      requireActive: false,
    });
    expect(config).not.toBeNull();
    expect(config!.provider).toBe('openai');
    expect(config!.apiKey).toBe('plain:enc-key');
  });

  it('returns null when there is no row', async () => {
    expect(
      await loadAiConfig(dbReturning(null), 'acct', { requireActive: false })
    ).toBeNull();
  });
});

describe('loadAiConfig tools_config (SPEC 089 F4, migration 105)', () => {
  it('parses tools_config fail-closed', async () => {
    const config = await loadAiConfig(
      dbReturning({
        ...ROW,
        tools_config: {
          search_knowledge: { enabled: true },
          drop_all: { enabled: true },
        },
      }),
      'acct',
      { requireActive: false }
    );
    expect(config!.toolsConfig).toEqual({
      search_knowledge: { enabled: true },
    });
  });

  it('falls back to the old columns (tools off) when migration 105 is missing', async () => {
    const selects: string[] = [];
    const consoleErr = vi.spyOn(console, 'error').mockImplementation(() => {});
    const chain = {
      from: () => chain,
      select: (cols: string) => {
        selects.push(cols);
        return chain;
      },
      eq: () => chain,
      maybeSingle: () =>
        Promise.resolve(
          selects[selects.length - 1].includes('tools_config')
            ? {
                data: null,
                error: {
                  code: '42703',
                  message: 'column ai_configs.tools_config does not exist',
                },
              }
            : { data: ROW, error: null }
        ),
    };
    const config = await loadAiConfig(
      chain as unknown as SupabaseClient,
      'acct',
      { requireActive: false }
    );
    expect(selects).toHaveLength(2);
    expect(selects[1]).not.toContain('tools_config');
    expect(config!.toolsConfig).toEqual({});
    consoleErr.mockRestore();
  });

  it('other errors still throw', async () => {
    const chain = {
      from: () => chain,
      select: () => chain,
      eq: () => chain,
      maybeSingle: () =>
        Promise.resolve({
          data: null,
          error: { code: '42501', message: 'denied' },
        }),
    };
    await expect(
      loadAiConfig(chain as unknown as SupabaseClient, 'acct')
    ).rejects.toMatchObject({ code: '42501' });
  });
});

describe('loadEmbeddingsTarget with a client that cannot read the keys (P-14, migration 111)', () => {
  it('logs the error code instead of silently degrading to lexical search', async () => {
    const db = {
      from: () => ({
        select: () => ({
          eq: () => ({
            maybeSingle: () =>
              Promise.resolve({
                data: null,
                error: { code: '42501', message: 'permission denied' },
              }),
          }),
        }),
      }),
    } as unknown as SupabaseClient;
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const out = await loadEmbeddingsTarget(db, 'acct-9');
    expect(out).toEqual({ target: null, corrupt: false });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(String(spy.mock.calls[0][0])).toContain('42501');
    spy.mockRestore();
  });
});
