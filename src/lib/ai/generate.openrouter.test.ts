import { describe, it, expect, vi, afterEach } from 'vitest';
import { generateReply } from './generate';
import type { AiConfig } from './types';
import { fixtureResponse, loadFixture } from './providers/openrouter-fixtures';

function config(overrides: Partial<AiConfig> = {}): AiConfig {
  return {
    provider: 'openrouter',
    model: 'anthropic/claude-haiku-5.5',
    apiKey: 'sk-or-test',
    systemPrompt: null,
    isActive: true,
    autoReplyEnabled: false,
    autoReplyMaxPerConversation: 3,
    handoffAgentId: null,
    embeddingsTarget: null,
    providerOptions: { denyDataCollection: false },
    ...overrides,
  };
}

const ARGS = {
  systemPrompt: 'sys',
  messages: [{ role: 'user' as const, content: 'oi' }],
};

afterEach(() => vi.unstubAllGlobals());

describe('generateReply — OpenRouter', () => {
  it('dispatches to OpenRouter and carries the cost into usage', async () => {
    const real = loadFixture('chat-completion.json').response.body as {
      usage: { cost: number };
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValue(fixtureResponse('chat-completion.json'));
    vi.stubGlobal('fetch', fetchMock);

    const out = await generateReply({ config: config(), ...ARGS });

    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://openrouter.ai/api/v1/chat/completions'
    );
    expect(out.handoff).toBe(false);
    expect(out.usage?.costUsd).toBe(real.usage.cost);
  });

  it('parses the handoff sentinel out of an OpenRouter reply', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            choices: [{ message: { content: '[[HANDOFF]]' } }],
          }),
          { status: 200 }
        )
      )
    );
    const out = await generateReply({ config: config(), ...ARGS });
    expect(out).toMatchObject({ text: '', handoff: true });
  });

  it('passes the privacy option from the account config to the request', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(fixtureResponse('chat-completion.json'));
    vi.stubGlobal('fetch', fetchMock);
    await generateReply({
      config: config({ providerOptions: { denyDataCollection: true } }),
      ...ARGS,
    });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).provider).toEqual({
      data_collection: 'deny',
    });
  });

  it('never adds the OpenRouter provider block to an OpenAI request', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ choices: [{ message: { content: 'hi' } }] }),
          { status: 200 }
        )
      );
    vi.stubGlobal('fetch', fetchMock);
    await generateReply({
      config: config({
        provider: 'openai',
        model: 'gpt-test',
        providerOptions: { denyDataCollection: true },
      }),
      ...ARGS,
    });
    expect(fetchMock.mock.calls[0][0]).toContain('api.openai.com');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).not.toHaveProperty(
      'provider'
    );
  });
});
