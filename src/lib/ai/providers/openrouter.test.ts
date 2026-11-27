import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  generateOpenRouter,
  validateOpenRouterKey,
  OPENROUTER_CHAT_URL,
  OPENROUTER_KEY_URL,
} from './openrouter';
import { providerHttpError } from './shared';
import { AiError } from '../types';
import { fixtureResponse, loadFixture } from './openrouter-fixtures';

const ARGS = {
  apiKey: 'sk-or-test',
  model: 'anthropic/claude-haiku-5.5',
  systemPrompt: 'Be brief.',
  messages: [{ role: 'user' as const, content: 'Oi' }],
  timeoutMs: 5000,
};

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

function sentBody(): Record<string, unknown> {
  return JSON.parse(fetchMock.mock.calls[0][1].body as string);
}

async function rejection(p: Promise<unknown>): Promise<AiError> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(AiError);
    return err as AiError;
  }
  throw new Error('expected a rejection');
}

describe('generateOpenRouter', () => {
  it('parses the real chat completion: text, tokens and usage.cost', async () => {
    fetchMock.mockResolvedValue(fixtureResponse('chat-completion.json'));
    const real = loadFixture('chat-completion.json').response.body as {
      choices: { message: { content: string } }[];
      usage: {
        prompt_tokens: number;
        completion_tokens: number;
        total_tokens: number;
        cost: number;
      };
    };

    const out = await generateOpenRouter(ARGS);

    expect(out.text).toBe(real.choices[0].message.content);
    expect(out.usage).toEqual({
      promptTokens: real.usage.prompt_tokens,
      completionTokens: real.usage.completion_tokens,
      totalTokens: real.usage.total_tokens,
      costUsd: real.usage.cost,
    });
    expect(out.usage!.costUsd).toBeGreaterThan(0);
  });

  it('posts to the OpenRouter endpoint with key and attribution headers', async () => {
    fetchMock.mockResolvedValue(fixtureResponse('chat-completion.json'));
    await generateOpenRouter(ARGS);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(OPENROUTER_CHAT_URL);
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer sk-or-test');
    expect(init.headers['HTTP-Referer']).toBeTruthy();
    expect(init.headers['X-OpenRouter-Title']).toBe('ZAP CRM BR');
  });

  it('sends system + merged turns, max_tokens, and no provider block by default', async () => {
    fetchMock.mockResolvedValue(fixtureResponse('chat-completion.json'));
    await generateOpenRouter({
      ...ARGS,
      messages: [
        { role: 'user', content: 'a' },
        { role: 'user', content: 'b' },
      ],
    });
    const body = sentBody();
    expect(body.model).toBe('anthropic/claude-haiku-5.5');
    expect(body.messages).toEqual([
      { role: 'system', content: 'Be brief.' },
      { role: 'user', content: 'a\n\nb' },
    ]);
    expect(body.max_tokens).toBe(1024);
    expect(body).not.toHaveProperty('provider');
    expect(body).not.toHaveProperty('reasoning');
  });

  it('asks for data_collection deny only when the privacy switch is on (D-5)', async () => {
    fetchMock.mockResolvedValue(fixtureResponse('chat-completion.json'));
    await generateOpenRouter({
      ...ARGS,
      providerOptions: { denyDataCollection: true },
    });
    // Same shape the F0 call used (error-404-data-policy.json request).
    const real = loadFixture('error-404-data-policy.json').request!;
    expect(sentBody().provider).toEqual(real.provider);
    expect(sentBody().provider).toEqual({ data_collection: 'deny' });

    fetchMock.mockClear();
    fetchMock.mockResolvedValue(fixtureResponse('chat-completion.json'));
    await generateOpenRouter({
      ...ARGS,
      providerOptions: { denyDataCollection: false },
    });
    expect(sentBody()).not.toHaveProperty('provider');
  });

  it('maps 402 to insufficient_credits without leaking user_id or links', async () => {
    fetchMock.mockResolvedValue(
      fixtureResponse('error-402-insufficient-credits.json')
    );
    const err = await rejection(generateOpenRouter(ARGS));
    expect(err.code).toBe('insufficient_credits');
    expect(err.status).toBe(502);
    expect(err.message).toContain('OpenRouter');
    expect(err.message).not.toContain('user_');
    expect(err.message).not.toMatch(/https?:\/\//);
    expect(err.message).not.toContain('REDACTED');
  });

  it('tells a data-policy 404 from a tools 404 by failed_routing_step', async () => {
    fetchMock.mockResolvedValueOnce(
      fixtureResponse('error-404-data-policy.json')
    );
    expect((await rejection(generateOpenRouter(ARGS))).code).toBe(
      'data_policy_no_endpoint'
    );
    fetchMock.mockResolvedValueOnce(
      fixtureResponse('error-404-tools-unsupported.json')
    );
    expect((await rejection(generateOpenRouter(ARGS))).code).toBe(
      'tools_unsupported'
    );
  });

  it('keeps a 404 without a routing step as a plain provider_error', async () => {
    const res = new Response(JSON.stringify({ error: { message: 'nope' } }), {
      status: 404,
    });
    expect((await providerHttpError('OpenRouter', res)).code).toBe(
      'provider_error'
    );
  });

  it('maps the real 502 empty response, 400 invalid model, 401, and 429', async () => {
    const cases: [string, string][] = [
      ['error-502-empty-response.json', 'provider_error'],
      ['error-400-invalid-model.json', 'provider_error'],
      ['error-401-invalid-key.json', 'invalid_key'],
      ['error-429-upstream-rate-limit.json', 'rate_limited'],
    ];
    for (const [file, code] of cases) {
      fetchMock.mockResolvedValueOnce(fixtureResponse(file));
      const err = await rejection(generateOpenRouter(ARGS));
      expect(err.code, file).toBe(code);
      expect(err.message, file).not.toContain('user_REDACTED');
    }
  });

  it('surfaces a 401 as status 401 (the "Test key" button shows invalid key)', async () => {
    fetchMock.mockResolvedValue(fixtureResponse('error-401-invalid-key.json'));
    expect((await rejection(generateOpenRouter(ARGS))).status).toBe(401);
  });

  it('rejects a 200 with empty content as empty_response', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({ choices: [{ message: { content: '  ' } }] }),
        { status: 200 }
      )
    );
    expect((await rejection(generateOpenRouter(ARGS))).code).toBe(
      'empty_response'
    );
  });

  it('says so when reasoning ate the output budget (finish_reason length)', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: '' }, finish_reason: 'length' }],
        }),
        { status: 200 }
      )
    );
    expect((await rejection(generateOpenRouter(ARGS))).code).toBe(
      'output_truncated'
    );
  });

  it('maps a network failure to network_error', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNRESET'));
    expect((await rejection(generateOpenRouter(ARGS))).code).toBe(
      'network_error'
    );
  });

  it('leaves costUsd out when the response has no usage.cost', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: 'ok' } }],
          usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
        }),
        { status: 200 }
      )
    );
    const out = await generateOpenRouter(ARGS);
    expect(out.usage).toEqual({
      promptTokens: 3,
      completionTokens: 2,
      totalTokens: 5,
    });
  });
});

describe('validateOpenRouterKey', () => {
  it('GETs /key (no credit spent) and resolves on the real 200', async () => {
    fetchMock.mockResolvedValue(fixtureResponse('key-info.json'));
    await expect(validateOpenRouterKey('sk-or-test', 5000)).resolves.toBe(
      undefined
    );
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(OPENROUTER_KEY_URL);
    expect(init.method).toBe('GET');
    expect(init.body).toBeUndefined();
  });

  it('rejects an invalid key with invalid_key', async () => {
    fetchMock.mockResolvedValue(fixtureResponse('error-401-invalid-key.json'));
    const err = await rejection(validateOpenRouterKey('bad', 5000));
    expect(err.code).toBe('invalid_key');
  });
});
