import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  generateOpenRouter,
  validateOpenRouterKey,
  OPENROUTER_CHAT_URL,
  OPENROUTER_KEY_URL,
} from './openrouter';
import { providerHttpError } from './shared';
import {
  AiError,
  type AgentMessage,
  type ToolCall,
  type ToolSpec,
} from '../types';
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

  it('never ends on an assistant turn (Claude via OpenRouter answers 400 to a prefill)', async () => {
    fetchMock.mockResolvedValue(fixtureResponse('chat-completion.json'));
    await generateOpenRouter({
      ...ARGS,
      messages: [
        { role: 'user', content: 'Oi' },
        { role: 'assistant', content: 'Ola!' },
      ],
    });
    const msgs = sentBody().messages as { role: string; content: string }[];
    expect(msgs.map((m) => m.role)).toEqual([
      'system',
      'user',
      'assistant',
      'user',
    ]);
    expect(msgs[msgs.length - 1].content).toContain('Write the next message');
  });

  it('drops leading assistant turns and survives an assistant-only transcript', async () => {
    fetchMock.mockResolvedValue(fixtureResponse('chat-completion.json'));
    await generateOpenRouter({
      ...ARGS,
      messages: [
        { role: 'assistant', content: 'Bem-vindo!' },
        { role: 'user', content: 'Oi' },
      ],
    });
    expect(
      (sentBody().messages as { role: string }[]).map((m) => m.role)
    ).toEqual(['system', 'user']);

    fetchMock.mockClear();
    fetchMock.mockResolvedValue(fixtureResponse('chat-completion.json'));
    await generateOpenRouter({
      ...ARGS,
      messages: [{ role: 'assistant', content: 'Bem-vindo!' }],
    });
    const only = sentBody().messages as { role: string; content: string }[];
    expect(only.map((m) => m.role)).toEqual(['system', 'user']);
    expect(only[1].content).toContain('has not sent a message yet');
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

// ------------------------------------------------------------
// Tool calling (SPEC 089 F4). Every payload below is a REAL OpenRouter
// capture from F0 (docs/spec-089-f0-fixtures/): nothing is invented.
// ------------------------------------------------------------

interface RealToolRequest {
  messages: Record<string, unknown>[];
  tool_choice?: string;
  tools: {
    type: 'function';
    function: { name: string; description: string; parameters: unknown };
  }[];
}

interface RealToolResponse {
  choices: {
    message: {
      content: string | null;
      tool_calls: { id: string; function: Record<string, string> }[];
      reasoning_details: unknown[];
    };
  }[];
  usage: { cost: number; total_tokens: number };
}

function realRequest(name: string): RealToolRequest {
  return loadFixture(name).request as unknown as RealToolRequest;
}

function realResponse(name: string): RealToolResponse {
  return loadFixture(name).response.body as RealToolResponse;
}

/** The tool catalog of the captures, as the neutral `ToolSpec[]`. */
function realTools(): ToolSpec[] {
  return realRequest('tool-calls-parallel.json').tools.map((t) => ({
    name: t.function.name,
    description: t.function.description,
    parameters: t.function.parameters as ToolSpec['parameters'],
  }));
}

const TOOL_ARGS = {
  ...ARGS,
  systemPrompt: realRequest('tool-calls-parallel.json').messages[0]
    .content as string,
  messages: [
    {
      role: 'user' as const,
      content:
        'Oi! Quanto custa o plano Avançado e qual o prazo para devolução?',
    },
  ],
  tools: realTools(),
};

function realCalls(): ToolCall[] {
  return realResponse(
    'tool-calls-parallel.json'
  ).choices[0].message.tool_calls.map((c) => ({
    id: c.id,
    name: c.function.name,
    arguments: c.function.arguments,
  }));
}

describe('generateOpenRouter with tools', () => {
  it('sends tools + tool_choice auto, identical to the real captured request', async () => {
    fetchMock.mockResolvedValue(fixtureResponse('tool-calls-parallel.json'));
    await generateOpenRouter(TOOL_ARGS);

    const real = realRequest('tool-calls-parallel.json');
    const body = sentBody();
    expect(body.tools).toEqual(real.tools);
    expect(body.tool_choice).toBe(real.tool_choice);
    expect(body.messages).toEqual(real.messages);
  });

  it('omits tools and tool_choice when tools is absent or empty', async () => {
    // A Response body can be read once: build a fresh one per call.
    fetchMock.mockImplementation(async () =>
      fixtureResponse('chat-completion.json')
    );
    await generateOpenRouter(ARGS);
    await generateOpenRouter({ ...ARGS, tools: [] });
    expect(fetchMock.mock.calls).toHaveLength(2);
    for (const call of fetchMock.mock.calls) {
      const body = JSON.parse(call[1].body as string);
      expect(body).not.toHaveProperty('tools');
      expect(body).not.toHaveProperty('tool_choice');
    }
  });

  it('parses two parallel tool calls with null content (real capture)', async () => {
    fetchMock.mockResolvedValue(fixtureResponse('tool-calls-parallel.json'));
    const real = realResponse('tool-calls-parallel.json');

    const out = await generateOpenRouter(TOOL_ARGS);

    expect(out.text).toBe('');
    expect(out.finishReason).toBe('tool_calls');
    expect(out.toolCalls).toEqual(realCalls());
    expect(out.toolCalls).toHaveLength(2);
    expect(out.toolCalls![0].id).toMatch(/^toolu_/);
    expect(out.usage!.totalTokens).toBe(real.usage.total_tokens);
    expect(out.usage!.costUsd).toBe(real.usage.cost);
    // reasoning_details is carried for the echo on the next step.
    expect(out.providerState).toEqual({
      reasoning_details: real.choices[0].message.reasoning_details,
    });
  });

  it('keeps the text that comes with the tool calls (real deepseek capture)', async () => {
    fetchMock.mockResolvedValue(
      fixtureResponse('tool-calls-with-content.json')
    );
    const real = realResponse('tool-calls-with-content.json');

    const out = await generateOpenRouter(TOOL_ARGS);

    expect(out.text).toBe(real.choices[0].message.content);
    expect(out.toolCalls).toHaveLength(2);
    expect(out.toolCalls![0].id).toMatch(/^call_/);
    expect(out.finishReason).toBe('tool_calls');
  });

  it('a final answer has no tool calls and finishReason stop (real capture)', async () => {
    fetchMock.mockResolvedValue(
      fixtureResponse('tool-result-final-answer.json')
    );
    const out = await generateOpenRouter(TOOL_ARGS);
    expect(out.toolCalls).toEqual([]);
    expect(out.finishReason).toBe('stop');
    expect(out.text).toContain('R$ 129,00');
    expect(out.providerState).toBeUndefined();
  });

  it('second step: tool turns go out exactly like the real captured request', async () => {
    fetchMock.mockResolvedValue(
      fixtureResponse('tool-result-final-answer.json')
    );
    const realReq = realRequest('tool-result-final-answer.json');
    const toolTurns = realReq.messages.filter((m) => m.role === 'tool');

    const history: AgentMessage[] = [
      ...TOOL_ARGS.messages,
      { role: 'assistant', content: '', toolCalls: realCalls() },
      ...toolTurns.map((m): AgentMessage => ({
        role: 'tool',
        toolCallId: m.tool_call_id as string,
        name: 'search_knowledge',
        content: m.content as string,
      })),
    ];

    await generateOpenRouter({ ...TOOL_ARGS, messages: history });

    const body = sentBody();
    expect(body.messages).toEqual(realReq.messages);
    expect(body.tools).toEqual(realReq.tools);
  });

  // The echo follows the OpenRouter docs; F0 did NOT measure it (the real
  // second-step request above carries no reasoning_details and worked).
  it('echoes reasoning_details on the assistant tool-call turn (per the docs, NOT measured in F0)', async () => {
    fetchMock.mockResolvedValue(
      fixtureResponse('tool-result-final-answer.json')
    );
    const msg = realResponse('tool-calls-parallel.json').choices[0].message;
    const history: AgentMessage[] = [
      ...TOOL_ARGS.messages,
      {
        role: 'assistant',
        content: '',
        toolCalls: realCalls(),
        providerState: { reasoning_details: msg.reasoning_details },
      },
      {
        role: 'tool',
        toolCallId: msg.tool_calls[0].id,
        name: 'search_knowledge',
        content: 'x',
      },
    ];

    await generateOpenRouter({ ...TOOL_ARGS, messages: history });

    const sent = (sentBody().messages as Record<string, unknown>[])[2];
    expect(sent.role).toBe('assistant');
    expect(sent.content).toBeNull();
    expect(sent.reasoning_details).toEqual(msg.reasoning_details);
  });

  it('maps the real 404 "no endpoint supports tools" to tools_unsupported', async () => {
    fetchMock.mockResolvedValue(
      fixtureResponse('error-404-tools-unsupported.json')
    );
    const err = await rejection(generateOpenRouter(TOOL_ARGS));
    expect(err.code).toBe('tools_unsupported');
  });

  it('still rejects a response with neither text nor tool calls', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: null, tool_calls: [] } }],
        }),
        { status: 200 }
      )
    );
    expect((await rejection(generateOpenRouter(TOOL_ARGS))).code).toBe(
      'empty_response'
    );
  });
});
