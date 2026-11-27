import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { generateAnthropic } from './anthropic';
import { AiError, type AgentMessage, type ToolSpec } from '../types';

// Fixtures de tool use: payload REAL da API da Anthropic, capturado em
// 2026-11-27 por scripts/capture-tool-fixtures.mjs (SPEC 089 F4/F8) e
// guardado em docs/spec-089-f4-fixtures/ (sem a chave; cabeçalhos filtrados).
// Diferenças observadas em relação à documentação: o 1º passo veio só com
// blocos tool_use (sem bloco de texto) e cada tool_use traz `caller`, que o
// adaptador não ecoa no passo seguinte (a API aceita o bloco sem ele).

interface CapturedFixture {
  request: {
    system: string;
    tools: unknown[];
    messages: unknown[];
  };
  response: { status: number; body: Record<string, unknown> };
}

function loadCapturedFixture(name: string): CapturedFixture {
  const path = resolve(process.cwd(), 'docs/spec-089-f4-fixtures', name);
  return JSON.parse(readFileSync(path, 'utf8')) as CapturedFixture;
}

/** Removes the `caller` key the API adds to tool_use blocks (not echoed). */
function withoutCaller(messages: unknown[]): unknown[] {
  return JSON.parse(
    JSON.stringify(messages, (key, value) =>
      key === 'caller' ? undefined : value
    )
  ) as unknown[];
}

function fixtureResponse(f: CapturedFixture): Response {
  return new Response(JSON.stringify(f.response.body), {
    status: f.response.status,
    headers: { 'content-type': 'application/json' },
  });
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

function sentBody(): Record<string, unknown> {
  return JSON.parse(fetchMock.mock.calls[0][1].body as string);
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

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
  {
    name: 'add_contact_tags',
    description: 'Add tags to the contact.',
    parameters: {
      type: 'object',
      properties: { tags: { type: 'array', items: { type: 'string' } } },
      required: ['tags'],
    },
  },
];

function args(messages: AgentMessage[], tools?: ToolSpec[]) {
  return {
    apiKey: 'sk-ant-test',
    model: 'claude-haiku-5-5',
    systemPrompt: 'Be brief.',
    messages,
    timeoutMs: 5000,
    ...(tools ? { tools } : {}),
  };
}

describe('generateAnthropic — request body without tools', () => {
  it('is exactly the pre-tool-calling body when tools is absent or empty', async () => {
    fetchMock.mockImplementation(async () =>
      jsonResponse({
        content: [{ type: 'text', text: 'oi' }],
        stop_reason: 'end_turn',
      })
    );
    const messages: AgentMessage[] = [{ role: 'user', content: 'Oi' }];
    await generateAnthropic(args(messages));
    await generateAnthropic(args(messages, []));
    for (const call of fetchMock.mock.calls) {
      expect(JSON.parse(call[1].body as string)).toEqual({
        model: 'claude-haiku-5-5',
        system: 'Be brief.',
        max_tokens: expect.any(Number),
        messages: [{ role: 'user', content: 'Oi' }],
      });
    }
  });
});

describe('generateAnthropic — turn order (F1 final-assistant risk)', () => {
  beforeEach(() => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        content: [{ type: 'text', text: 'ok' }],
        stop_reason: 'end_turn',
      })
    );
  });

  it('drops a leading assistant turn and merges consecutive turns', async () => {
    await generateAnthropic(
      args([
        { role: 'assistant', content: 'Welcome!' },
        { role: 'user', content: 'Hi' },
        { role: 'user', content: 'Anyone?' },
      ])
    );
    expect(sentBody().messages).toEqual([
      { role: 'user', content: 'Hi\n\nAnyone?' },
    ]);
  });

  it('appends a user nudge when the transcript ends on the assistant', async () => {
    await generateAnthropic(
      args([
        { role: 'user', content: 'Hi' },
        { role: 'assistant', content: 'Hello! Anything else?' },
      ])
    );
    const msgs = sentBody().messages as { role: string; content: string }[];
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(msgs[2].content).toContain('has not replied yet');
  });

  it('sends a placeholder user turn for an empty transcript', async () => {
    await generateAnthropic(args([]));
    const msgs = sentBody().messages as { role: string }[];
    expect(msgs).toHaveLength(1);
    expect(msgs[0].role).toBe('user');
  });
});

describe('generateAnthropic — tools in the request', () => {
  it('maps ToolSpec to name/description/input_schema with no tool_choice', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ content: [{ type: 'text', text: 'ok' }] })
    );
    await generateAnthropic(args([{ role: 'user', content: 'Oi' }], TOOLS));
    const body = sentBody();
    expect(body.tools).toEqual([
      {
        name: 'search_knowledge',
        description: 'Search the knowledge base.',
        input_schema: TOOLS[0].parameters,
      },
      {
        name: 'add_contact_tags',
        description: 'Add tags to the contact.',
        input_schema: TOOLS[1].parameters,
      },
    ]);
    expect(body).not.toHaveProperty('tool_choice');
  });

  it('translates the tool tail: tool_use blocks, then ONE user message of tool_results', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ content: [{ type: 'text', text: 'ok' }] })
    );
    await generateAnthropic(
      args(
        [
          { role: 'user', content: 'Quanto custa?' },
          {
            role: 'assistant',
            content: 'Vou consultar.',
            toolCalls: [
              {
                id: 'toolu_1',
                name: 'search_knowledge',
                arguments: '{"query":"preço"}',
              },
              {
                id: 'toolu_2',
                name: 'add_contact_tags',
                arguments: 'not json',
              },
            ],
          },
          {
            role: 'tool',
            toolCallId: 'toolu_1',
            name: 'search_knowledge',
            content: 'R$ 129',
          },
          {
            role: 'tool',
            toolCallId: 'toolu_2',
            name: 'add_contact_tags',
            content: 'invalid arguments',
            isError: true,
          },
        ],
        TOOLS
      )
    );
    expect(sentBody().messages).toEqual([
      { role: 'user', content: 'Quanto custa?' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Vou consultar.' },
          {
            type: 'tool_use',
            id: 'toolu_1',
            name: 'search_knowledge',
            input: { query: 'preço' },
          },
          {
            type: 'tool_use',
            id: 'toolu_2',
            name: 'add_contact_tags',
            input: {},
          },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_1', content: 'R$ 129' },
          {
            type: 'tool_result',
            tool_use_id: 'toolu_2',
            content: 'invalid arguments',
            is_error: true,
          },
        ],
      },
    ]);
  });

  it('omits the text block when the assistant tool turn has no text, and does not merge tool turns', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ content: [{ type: 'text', text: 'ok' }] })
    );
    await generateAnthropic(
      args(
        [
          { role: 'user', content: 'a' },
          {
            role: 'assistant',
            content: '',
            toolCalls: [
              { id: 't1', name: 'search_knowledge', arguments: '{}' },
            ],
          },
          {
            role: 'tool',
            toolCallId: 't1',
            name: 'search_knowledge',
            content: 'r1',
          },
          {
            role: 'assistant',
            content: '',
            toolCalls: [
              { id: 't2', name: 'search_knowledge', arguments: '{}' },
            ],
          },
          {
            role: 'tool',
            toolCallId: 't2',
            name: 'search_knowledge',
            content: 'r2',
          },
        ],
        TOOLS
      )
    );
    const msgs = sentBody().messages as {
      role: string;
      content: { type: string }[];
    }[];
    expect(msgs.map((m) => m.role)).toEqual([
      'user',
      'assistant',
      'user',
      'assistant',
      'user',
    ]);
    expect(msgs[1].content.map((b) => b.type)).toEqual(['tool_use']);
  });
});

describe('generateAnthropic — response parsing', () => {
  it('parses a text-only answer', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        content: [
          { type: 'text', text: 'Olá ' },
          { type: 'text', text: 'mundo' },
        ],
        stop_reason: 'end_turn',
        usage: { input_tokens: 10, output_tokens: 4 },
      })
    );
    const res = await generateAnthropic(
      args([{ role: 'user', content: 'Oi' }])
    );
    expect(res).toEqual({
      text: 'Olá mundo',
      toolCalls: [],
      finishReason: 'stop',
      usage: { promptTokens: 10, completionTokens: 4, totalTokens: 14 },
    });
  });

  it.each([
    ['end_turn', 'stop'],
    ['stop_sequence', 'stop'],
    ['tool_use', 'tool_calls'],
    ['max_tokens', 'length'],
    ['refusal', 'other'],
    ['pause_turn', 'other'],
  ])('maps stop_reason %s to %s', async (stop, finish) => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        content: [{ type: 'text', text: 'x' }],
        stop_reason: stop,
      })
    );
    const res = await generateAnthropic(
      args([{ role: 'user', content: 'Oi' }])
    );
    expect(res.finishReason).toBe(finish);
  });

  it('accepts a pure tool step (empty text, tool calls present)', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        content: [
          {
            type: 'tool_use',
            id: 'toolu_9',
            name: 'search_knowledge',
            input: { query: 'x' },
          },
        ],
        stop_reason: 'tool_use',
      })
    );
    const res = await generateAnthropic(
      args([{ role: 'user', content: 'Oi' }], TOOLS)
    );
    expect(res.text).toBe('');
    expect(res.toolCalls).toEqual([
      { id: 'toolu_9', name: 'search_knowledge', arguments: '{"query":"x"}' },
    ]);
    expect(res.finishReason).toBe('tool_calls');
  });

  it('throws empty_response with neither text nor tool calls', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ content: [], stop_reason: 'end_turn' })
    );
    await expect(
      generateAnthropic(args([{ role: 'user', content: 'Oi' }]))
    ).rejects.toMatchObject({ code: 'empty_response' });
    fetchMock.mockResolvedValue(jsonResponse({ stop_reason: 'end_turn' }));
    await expect(
      generateAnthropic(args([{ role: 'user', content: 'Oi' }]))
    ).rejects.toBeInstanceOf(AiError);
  });
});

describe('generateAnthropic — real captured fixtures', () => {
  it('step 1: parses two parallel tool_use blocks with no text block', async () => {
    const f = loadCapturedFixture('anthropic-tool-calls.json');
    fetchMock.mockResolvedValue(fixtureResponse(f));
    const res = await generateAnthropic(
      args(
        [
          {
            role: 'user',
            content: String(
              (f.request.messages[0] as { content: string }).content
            ),
          },
        ],
        TOOLS
      )
    );
    expect(res.finishReason).toBe('tool_calls');
    expect(res.text).toBe('');
    expect(res.toolCalls).toEqual([
      {
        id: 'toolu_01Avh4vVJpi1z5kww7bE98ST',
        name: 'search_knowledge',
        arguments: '{"query":"preço plano Avançado"}',
      },
      {
        id: 'toolu_01PgSV53qs6kbD8MUDDww1ou',
        name: 'search_knowledge',
        arguments: '{"query":"prazo para devolução"}',
      },
    ]);
    expect(res.usage).toEqual({
      promptTokens: 597,
      completionTokens: 110,
      totalTokens: 707,
    });
  });

  it('step 2: our wire format matches the captured tool_result request and the final answer parses', async () => {
    const f = loadCapturedFixture('anthropic-tool-result-final.json');
    const step1 = loadCapturedFixture('anthropic-tool-calls.json');
    fetchMock.mockResolvedValue(fixtureResponse(f));

    const calls = (
      step1.response.body.content as {
        type: string;
        id?: string;
        name?: string;
        input?: unknown;
      }[]
    ).filter((b) => b.type === 'tool_use');
    const results = (
      f.request.messages[2] as {
        content: { tool_use_id: string; content: string }[];
      }
    ).content;

    const res = await generateAnthropic(
      args(
        [
          {
            role: 'user',
            content: (f.request.messages[0] as { content: string }).content,
          },
          {
            role: 'assistant',
            content: '',
            toolCalls: calls.map((c) => ({
              id: c.id as string,
              name: c.name as string,
              arguments: JSON.stringify(c.input),
            })),
          },
          ...results.map((r): AgentMessage => ({
            role: 'tool',
            toolCallId: r.tool_use_id,
            name: 'search_knowledge',
            content: r.content,
          })),
        ],
        TOOLS
      )
    );

    // What we send must equal the request the real API accepted (minus the
    // `caller` key it adds to tool_use blocks, which we do not echo).
    expect(sentBody().messages).toEqual(withoutCaller(f.request.messages));
    expect(res.finishReason).toBe('stop');
    expect(res.toolCalls).toEqual([]);
    expect(res.text).toContain('R$ 129,00');
    expect(res.usage).toEqual({
      promptTokens: 889,
      completionTokens: 123,
      totalTokens: 1012,
    });
  });
});
