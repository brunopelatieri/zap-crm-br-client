import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

const h = vi.hoisted(() => ({
  retrieveKnowledge: vi.fn(),
  resolveChannel: vi.fn(),
}));

vi.mock('./knowledge', () => ({ retrieveKnowledge: h.retrieveKnowledge }));
vi.mock('@/lib/channels/conversation-channel', () => ({
  resolveChannelTypeForConversation: h.resolveChannel,
}));

import { composeAgentTurn } from './compose';
import { buildSystemPrompt, HANDOFF_SENTINEL } from './defaults';

const db = {} as SupabaseClient;
const config = { systemPrompt: 'We sell shoes.', embeddingsTarget: null };

beforeEach(() => {
  h.retrieveKnowledge.mockReset().mockResolvedValue([]);
  h.resolveChannel.mockReset().mockResolvedValue('whatsapp_cloud');
});

describe('composeAgentTurn', () => {
  it('queries the KB with the latest customer message and builds the same prompt the callers used to', async () => {
    h.retrieveKnowledge.mockResolvedValue(['Shipping takes 3 days.']);
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
      'How long is shipping?'
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
