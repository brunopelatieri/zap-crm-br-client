import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

const h = vi.hoisted(() => ({
  retrieveKnowledge: vi.fn(),
  resolveChannel: vi.fn(),
  loadCustom: vi.fn(),
}));

// The draft audits through the service role; no real client in unit tests.
vi.mock('./admin-client', () => ({ supabaseAdmin: () => ({ rpc: vi.fn() }) }));
vi.mock('./tools/custom-tools', () => ({
  loadCustomToolsForTurn: h.loadCustom,
}));

vi.mock('./knowledge', () => ({ retrieveKnowledge: h.retrieveKnowledge }));
vi.mock('@/lib/channels/conversation-channel', () => ({
  resolveChannelTypeForConversation: h.resolveChannel,
}));

import { composeAgentTurn } from './compose';
import { buildSystemPrompt, HANDOFF_SENTINEL } from './defaults';

const db = {} as SupabaseClient;

const HIT = {
  chunkId: 'chunk-1',
  documentId: 'doc-1',
  title: 'Shipping policy',
  heading: 'Shipping',
  content: 'Shipping takes 3 days.',
  distance: 0.32,
  lexicalRank: 0.06,
  score: 2 / 61,
  origin: 'both' as const,
};
const config = { systemPrompt: 'We sell shoes.', embeddingsTarget: null };

beforeEach(() => {
  h.retrieveKnowledge.mockReset().mockResolvedValue([]);
  h.resolveChannel.mockReset().mockResolvedValue('whatsapp_cloud');
  h.loadCustom.mockReset().mockResolvedValue([]);
});

describe('composeAgentTurn', () => {
  it("queries the KB with the customer's last messages (D-13) and builds the same prompt the callers used to", async () => {
    h.retrieveKnowledge.mockResolvedValue([HIT]);
    const messages = [
      { role: 'user' as const, content: 'Hi' },
      { role: 'assistant' as const, content: 'Hello!' },
      { role: 'user' as const, content: 'How long is shipping?' },
    ];

    const turn = await composeAgentTurn({
      db,
      accountId: 'acct',
      config,
      mode: 'auto_reply',
      messages,
      conversationId: 'conv-1',
    });

    expect(h.retrieveKnowledge).toHaveBeenCalledWith(
      db,
      'acct',
      config,
      'Hi\nHow long is shipping?'
    );
    expect(h.resolveChannel).toHaveBeenCalledWith(db, 'acct', 'conv-1');
    expect(turn.systemPrompt).toBe(
      buildSystemPrompt({
        userPrompt: 'We sell shoes.',
        mode: 'auto_reply',
        knowledge: ['Shipping takes 3 days.'],
        channelType: 'whatsapp_cloud',
      })
    );
    expect(turn.messages).toBe(messages);
    expect(turn.knowledge).toEqual(['Shipping takes 3 days.']);
    // D-14: the sources ride beside the prompt, never inside the reply.
    expect(turn.sources).toEqual([
      {
        chunkId: 'chunk-1',
        documentId: 'doc-1',
        title: 'Shipping policy',
        score: 2 / 61,
      },
    ]);
    expect(turn.systemPrompt).not.toContain('Shipping policy');
  });

  it('draft mode gets the draft scaffold (no handoff protocol)', async () => {
    const turn = await composeAgentTurn({
      db,
      accountId: 'acct',
      config,
      mode: 'draft',
      messages: [{ role: 'user', content: 'Hi' }],
      conversationId: 'conv-1',
    });
    expect(turn.systemPrompt).not.toContain(HANDOFF_SENTINEL);
  });

  it('playground runs the auto-reply prompt, with no conversation and no channel lookup', async () => {
    const turn = await composeAgentTurn({
      db,
      accountId: 'acct',
      config,
      mode: 'playground',
      messages: [{ role: 'user', content: 'Hi' }],
    });
    expect(h.resolveChannel).not.toHaveBeenCalled();
    expect(turn.channelType).toBeUndefined();
    expect(turn.systemPrompt).toContain(HANDOFF_SENTINEL);
    expect(turn.systemPrompt).toBe(
      buildSystemPrompt({
        userPrompt: 'We sell shoes.',
        mode: 'auto_reply',
        knowledge: [],
        channelType: undefined,
      })
    );
  });

  it('a non-WhatsApp channel changes the prompt (SPEC 049 §5.6 behaviour kept)', async () => {
    h.resolveChannel.mockResolvedValue('whatsapp_qr');
    const turn = await composeAgentTurn({
      db,
      accountId: 'acct',
      config,
      mode: 'auto_reply',
      messages: [{ role: 'user', content: 'Hi' }],
      conversationId: 'conv-1',
    });
    expect(turn.channelType).toBe('whatsapp_qr');
    expect(turn.systemPrompt).toContain('plain text');
  });
});

describe('composeAgentTurn — tools (SPEC 089 F4)', () => {
  const ALL_ON = {
    search_knowledge: { enabled: true },
    get_contact_profile: { enabled: true },
    add_contact_tags: { enabled: true, tagIds: [] },
  };
  // A conversations table with one row of this account.
  function dbWithConversation(row: Record<string, unknown> | null) {
    const chain = {
      select: () => chain,
      eq: () => chain,
      maybeSingle: () => Promise.resolve({ data: row, error: null }),
    };
    return { from: vi.fn(() => chain) } as unknown as SupabaseClient & {
      from: ReturnType<typeof vi.fn>;
    };
  }

  it('no tool on = no tool query, unchanged prompt (the existing tests use a db that throws if touched)', async () => {
    const turn = await composeAgentTurn({
      db,
      accountId: 'acct',
      config: { ...config, toolsConfig: {} },
      mode: 'auto_reply',
      messages: [{ role: 'user', content: 'Hi' }],
      conversationId: 'conv-1',
    });
    expect(turn.tools).toEqual([]);
    expect(turn.toolContext).toBeNull();
    expect(turn.systemPrompt).not.toContain('tool_result');
  });

  it('draft: read tools only, bound to the contact of the conversation row', async () => {
    const tdb = dbWithConversation({
      id: 'conv-1',
      account_id: 'acct',
      contact_id: 'contact-9',
    });
    const turn = await composeAgentTurn({
      db: tdb,
      accountId: 'acct',
      config: { ...config, toolsConfig: ALL_ON },
      mode: 'draft',
      messages: [{ role: 'user', content: 'Hi' }],
      conversationId: 'conv-1',
    });
    expect(turn.tools.map((t) => t.key)).toEqual([
      'search_knowledge',
      'get_contact_profile',
    ]);
    expect(turn.toolContext).toMatchObject({
      contactId: 'contact-9',
      dryRun: true,
      mode: 'draft',
    });
    expect(turn.systemPrompt).toContain('<tool_result>');
    expect(turn.systemPrompt).toContain('internal record');
    // The retry prompt (model rejects tools) has no tools paragraph.
    expect(turn.fallbackSystemPrompt).toBeDefined();
    expect(turn.fallbackSystemPrompt).not.toContain('tool_result');
    // Only the embeddings target reaches the tools, never the chat key.
    expect(Object.keys(turn.toolContext!.aiConfig)).toEqual([
      'embeddingsTarget',
    ]);
  });

  it('playground: writes offered in simulation, no contact', async () => {
    const turn = await composeAgentTurn({
      db,
      accountId: 'acct',
      config: { ...config, toolsConfig: ALL_ON },
      mode: 'playground',
      messages: [{ role: 'user', content: 'Hi' }],
    });
    expect(turn.tools.map((t) => t.key)).toEqual([
      'search_knowledge',
      'get_contact_profile',
      'add_contact_tags',
    ]);
    expect(turn.toolContext).toMatchObject({
      contactId: null,
      conversationId: null,
      dryRun: true,
    });
  });

  it('a conversation that does not resolve for the account turns the tools off', async () => {
    const tdb = dbWithConversation(null);
    const turn = await composeAgentTurn({
      db: tdb,
      accountId: 'acct',
      config: { ...config, toolsConfig: ALL_ON },
      mode: 'auto_reply',
      messages: [{ role: 'user', content: 'Hi' }],
      conversationId: 'conv-other',
    });
    expect(turn.tools).toEqual([]);
    expect(turn.toolContext).toBeNull();
    expect(turn.systemPrompt).not.toContain('tool_result');
  });
});

describe('composeAgentTurn — the account HTTP tools (SPEC 089 F6)', () => {
  const custom = (key: string, risk: 'read' | 'write' = 'write') =>
    ({
      key,
      description: 'x',
      inputSchema: { type: 'object', properties: {} },
      risk,
      external: true,
      parse: () => ({ ok: true, value: {} }),
      handler: async () => ({ ok: true, data: {} }),
    }) as never;

  it('an account with only a custom tool (no built-in on) still gets tools and a context', async () => {
    h.loadCustom.mockResolvedValue([custom('check_stock')]);
    const turn = await composeAgentTurn({
      db,
      accountId: 'acct',
      config: { ...config, toolsConfig: {} },
      mode: 'playground',
      messages: [{ role: 'user', content: 'Hi' }],
    });
    expect(turn.tools.map((t) => t.key)).toEqual(['check_stock']);
    expect(turn.toolContext).toMatchObject({
      dryRun: true,
      mode: 'playground',
    });
    expect(turn.systemPrompt).toContain('tool_result');
    expect(h.loadCustom).toHaveBeenCalledWith({
      accountId: 'acct',
      mode: 'playground',
    });
  });

  it('a custom tool that collides with an enabled built-in is dropped (the built-in wins)', async () => {
    h.loadCustom.mockResolvedValue([
      custom('search_knowledge'),
      custom('check_stock'),
    ]);
    const turn = await composeAgentTurn({
      db,
      accountId: 'acct',
      config: {
        ...config,
        toolsConfig: { search_knowledge: { enabled: true } },
      },
      mode: 'playground',
      messages: [{ role: 'user', content: 'Hi' }],
    });
    expect(turn.tools.map((t) => t.key)).toEqual([
      'search_knowledge',
      'check_stock',
    ]);
    // The first one is the built-in, not the account's tool.
    expect(turn.tools[0].external).toBeUndefined();
  });

  it('write tools in the prompt flag follows the custom risk', async () => {
    h.loadCustom.mockResolvedValue([custom('lookup_order', 'read')]);
    const readOnly = await composeAgentTurn({
      db,
      accountId: 'acct',
      config,
      mode: 'playground',
      messages: [{ role: 'user', content: 'Hi' }],
    });
    h.loadCustom.mockResolvedValue([custom('lookup_order', 'write')]);
    const withWrite = await composeAgentTurn({
      db,
      accountId: 'acct',
      config,
      mode: 'playground',
      messages: [{ role: 'user', content: 'Hi' }],
    });
    expect(withWrite.systemPrompt).not.toBe(readOnly.systemPrompt);
  });
});
