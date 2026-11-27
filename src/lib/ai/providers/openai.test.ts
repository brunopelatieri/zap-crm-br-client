import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { generateOpenAi } from './openai';
import { MAX_OUTPUT_TOKENS } from '../defaults';
import { AiError, type ToolSpec } from '../types';

// ATENÇÃO — BASEADO NA DOCUMENTAÇÃO, NÃO É CAPTURA REAL (SPEC 089 F8).
// Não há captura da OpenAI direta com ferramentas (a F0 mediu só o
// OpenRouter; a Anthropic foi capturada na F4). As respostas abaixo são
// mínimas, montadas pela documentação da OpenAI; o parsing é o mesmo helper
// que os testes do OpenRouter cobrem com payload real. Estes testes só
// conferem o que o NOSSO adaptador envia. Para trocar por payload real:
//   node scripts/capture-tool-fixtures.mjs --provider openai --model <modelo>
// (grava em docs/spec-089-f4-fixtures/; a chave vem de variável de ambiente).

const TOOLS: ToolSpec[] = [
  {
    name: 'search_knowledge',
    description: 'Search the knowledge base.',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
    },
  },
];

const ARGS = {
  apiKey: 'sk-test',
  model: 'gpt-test',
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

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

describe('generateOpenAi', () => {
  // formato da documentação oficial da OpenAI, payload real não capturado
  it('posts to chat/completions with max_completion_tokens and no tools key by default', async () => {
    fetchMock.mockResolvedValue(
      json({
        choices: [{ message: { content: 'Olá' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
      })
    );

    const out = await generateOpenAi(ARGS);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.openai.com/v1/chat/completions');
    expect(init.headers.Authorization).toBe('Bearer sk-test');
    expect(sentBody()).toEqual({
      model: 'gpt-test',
      messages: [
        { role: 'system', content: 'Be brief.' },
        { role: 'user', content: 'Oi' },
      ],
      max_completion_tokens: MAX_OUTPUT_TOKENS,
    });
    expect(out).toEqual({
      text: 'Olá',
      usage: { promptTokens: 3, completionTokens: 1, totalTokens: 4 },
      toolCalls: [],
      finishReason: 'stop',
    });
  });

  // formato da documentação oficial da OpenAI, payload real não capturado
  it('sends tools + tool_choice auto and returns the tool calls', async () => {
    fetchMock.mockResolvedValue(
      json({
        choices: [
          {
            finish_reason: 'tool_calls',
            message: {
              content: null,
              tool_calls: [
                {
                  id: 'call_abc',
                  type: 'function',
                  function: {
                    name: 'search_knowledge',
                    arguments: '{"query":"preço"}',
                  },
                },
              ],
            },
          },
        ],
      })
    );

    const out = await generateOpenAi({ ...ARGS, tools: TOOLS });

    const body = sentBody();
    expect(body.tool_choice).toBe('auto');
    expect(body.tools).toEqual([
      {
        type: 'function',
        function: {
          name: 'search_knowledge',
          description: 'Search the knowledge base.',
          parameters: TOOLS[0].parameters,
        },
      },
    ]);
    expect(body).toHaveProperty('max_completion_tokens');
    expect(body).not.toHaveProperty('max_tokens');
    expect(out.text).toBe('');
    expect(out.finishReason).toBe('tool_calls');
    expect(out.toolCalls).toEqual([
      {
        id: 'call_abc',
        name: 'search_knowledge',
        arguments: '{"query":"preço"}',
      },
    ]);
    // reasoning_details is an OpenRouter-only echo.
    expect(out.providerState).toBeUndefined();
  });

  it('omits tools when the list is empty', async () => {
    fetchMock.mockResolvedValue(
      json({ choices: [{ message: { content: 'ok' } }] })
    );
    await generateOpenAi({ ...ARGS, tools: [] });
    expect(sentBody()).not.toHaveProperty('tools');
    expect(sentBody()).not.toHaveProperty('tool_choice');
  });

  it('rejects a response with neither text nor tool calls as empty_response', async () => {
    fetchMock.mockImplementation(async () =>
      json({ choices: [{ message: { content: '  ' } }] })
    );
    await expect(generateOpenAi(ARGS)).rejects.toMatchObject({
      code: 'empty_response',
    });
    await expect(generateOpenAi(ARGS)).rejects.toBeInstanceOf(AiError);
  });
});
