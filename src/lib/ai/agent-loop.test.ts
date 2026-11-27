import { describe, it, expect, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  MAX_CALLS_PER_TURN,
  addUsage,
  runAgentTurn,
  type AgentLimits,
  type CallModel,
} from './agent-loop';
import {
  AiError,
  type AgentMessage,
  type ProviderResult,
  type ToolCall,
} from './types';
import type { AgentTool, ToolContext } from './tools/types';

// The engine with fake tools and a scripted model. Provider wire formats
// are covered by the adapters' tests (real F0 fixtures); the end-to-end
// path through the OpenRouter adapter is in generate.tools.test.ts.

const LIMITS: AgentLimits = {
  maxSteps: 4,
  deadlineMs: 60_000,
  maxCallsPerStep: 8,
  toolTimeoutMs: 10_000,
  callTimeoutMs: 30_000,
};

const CTX: ToolContext = {
  db: {} as SupabaseClient,
  accountId: 'acct-a',
  conversationId: 'conv-a',
  contactId: 'contact-a',
  mode: 'auto_reply',
  dryRun: false,
  toolsConfig: {},
  aiConfig: { embeddingsTarget: null },
  turnId: 'turn-test',
  turnState: {},
};

function tool(
  key: AgentTool['key'],
  handler: AgentTool['handler'],
  risk: AgentTool['risk'] = 'read'
): AgentTool {
  return {
    key,
    description: `fake ${key}`,
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string' } },
      additionalProperties: false,
    },
    risk,
    parse: (input) => {
      const q = (input as { query?: unknown } | null)?.query;
      if (q !== undefined && typeof q !== 'string')
        return { ok: false, error: 'invalid_query' };
      return { ok: true, value: { query: q } };
    },
    handler,
  };
}

const call = (
  id: string,
  name: string,
  args: unknown = { query: 'x' }
): ToolCall => ({
  id,
  name,
  arguments: typeof args === 'string' ? args : JSON.stringify(args),
});

const toolStep = (
  calls: ToolCall[],
  text = '',
  usage = {
    promptTokens: 10,
    completionTokens: 5,
    totalTokens: 15,
    costUsd: 0.001,
  }
): ProviderResult => ({
  text,
  usage,
  toolCalls: calls,
  finishReason: 'tool_calls',
});
const answer = (
  text: string,
  usage = {
    promptTokens: 20,
    completionTokens: 7,
    totalTokens: 27,
    costUsd: 0.002,
  }
): ProviderResult => ({
  text,
  usage,
  toolCalls: [],
  finishReason: 'stop',
});

function scripted(steps: (ProviderResult | Error)[]) {
  const seen: {
    systemPrompt: string;
    messages: AgentMessage[];
    tools: string[];
    timeoutMs: number;
  }[] = [];
  const fn: CallModel = async (args) => {
    seen.push({
      systemPrompt: args.systemPrompt,
      messages: structuredClone(args.messages),
      tools: args.tools.map((t) => t.name),
      timeoutMs: args.timeoutMs,
    });
    const next = steps.shift();
    if (!next) throw new Error('model called more times than scripted');
    if (next instanceof Error) throw next;
    return next;
  };
  return { fn, seen };
}

const USER: AgentMessage[] = [
  { role: 'user', content: 'Quanto custa o plano?' },
];

describe('runAgentTurn', () => {
  it('without tool calls: one model call, the text is the answer', async () => {
    const m = scripted([answer('Custa R$ 129.')]);
    const out = await runAgentTurn({
      callModel: m.fn,
      systemPrompt: 's',
      messages: USER,
      tools: [tool('search_knowledge', vi.fn())],
      ctx: CTX,
      limits: LIMITS,
    });
    expect(out).toMatchObject({
      text: 'Custa R$ 129.',
      steps: 1,
      stopReason: 'answer',
      toolCalls: [],
    });
    expect(m.seen[0].tools).toEqual(['search_knowledge']);
  });

  it('runs a tool bound to the context and feeds the wrapped result back', async () => {
    const handler = vi.fn().mockResolvedValue({
      ok: true,
      data: { results: ['R$ 129'] },
      sources: [
        { chunkId: 'c1', documentId: 'd1', title: 'Preços', score: 0.1 },
      ],
    });
    const m = scripted([
      toolStep(
        [
          call('toolu_1', 'search_knowledge', {
            query: 'preço',
            contact_id: 'other',
          }),
        ],
        'Deixe-me ver…'
      ),
      answer('Custa R$ 129.'),
    ]);
    const out = await runAgentTurn({
      callModel: m.fn,
      systemPrompt: 's',
      messages: USER,
      tools: [tool('search_knowledge', handler)],
      ctx: CTX,
      limits: LIMITS,
    });

    // The handler gets the engine's context, never anything from the model.
    expect(handler).toHaveBeenCalledWith(
      CTX,
      { query: 'preço' },
      { budgetMs: expect.any(Number) }
    );
    const second = m.seen[1].messages;
    expect(second.slice(1)).toEqual([
      {
        role: 'assistant',
        content: 'Deixe-me ver…',
        toolCalls: [
          call('toolu_1', 'search_knowledge', {
            query: 'preço',
            contact_id: 'other',
          }),
        ],
      },
      {
        role: 'tool',
        toolCallId: 'toolu_1',
        name: 'search_knowledge',
        content:
          '<tool_result name="search_knowledge">{"results":["R$ 129"]}</tool_result>',
      },
    ]);
    // The intermediate "let me check" text never becomes the answer.
    expect(out.text).toBe('Custa R$ 129.');
    expect(out.steps).toBe(2);
    expect(out.toolCalls).toEqual([
      expect.objectContaining({
        step: 1,
        name: 'search_knowledge',
        arguments: { query: 'preço' },
        status: 'ok',
      }),
    ]);
    expect(out.sources).toEqual([
      { chunkId: 'c1', documentId: 'd1', title: 'Preços', score: 0.1 },
    ]);
    expect(out.usage).toEqual({
      promptTokens: 30,
      completionTokens: 12,
      totalTokens: 42,
      costUsd: 0.003,
    });
  });

  it('answers every parallel call, in order, with its own id', async () => {
    const handler = vi.fn(async (_c, i: { query: string }) => ({
      ok: true as const,
      data: i.query,
    }));
    const m = scripted([
      toolStep([
        call('a', 'search_knowledge', { query: 'preço' }),
        call('b', 'search_knowledge', { query: 'prazo' }),
      ]),
      answer('ok'),
    ]);
    await runAgentTurn({
      callModel: m.fn,
      systemPrompt: 's',
      messages: USER,
      tools: [tool('search_knowledge', handler)],
      ctx: CTX,
      limits: LIMITS,
    });
    const tools = m.seen[1].messages.filter((x) => x.role === 'tool');
    expect(tools.map((t) => (t as { toolCallId: string }).toolCallId)).toEqual([
      'a',
      'b',
    ]);
    expect(tools.map((t) => (t as { content: string }).content)).toEqual([
      '<tool_result name="search_knowledge">preço</tool_result>',
      '<tool_result name="search_knowledge">prazo</tool_result>',
    ]);
  });

  it('stops after 4 model calls without executing the last request (handoff)', async () => {
    const handler = vi.fn().mockResolvedValue({ ok: true, data: 1 });
    const m = scripted(
      [1, 2, 3, 4].map((i) => toolStep([call(`c${i}`, 'search_knowledge')]))
    );
    const out = await runAgentTurn({
      callModel: m.fn,
      systemPrompt: 's',
      messages: USER,
      tools: [tool('search_knowledge', handler)],
      ctx: CTX,
      limits: LIMITS,
    });
    expect(m.seen).toHaveLength(4);
    expect(handler).toHaveBeenCalledTimes(3);
    expect(out).toMatchObject({ text: '', steps: 4, stopReason: 'step_limit' });
  });

  it('refuses a tool that exists but is not offered, and an unknown one, without running them', async () => {
    const offered = vi.fn().mockResolvedValue({ ok: true, data: 1 });
    const m = scripted([
      toolStep([
        call('1', 'add_contact_tags', { tags: ['vip'] }), // catalog write tool, not offered
        call('2', 'drop_database'), // not in the catalog
      ]),
      answer('ok'),
    ]);
    const out = await runAgentTurn({
      callModel: m.fn,
      systemPrompt: 's',
      messages: USER,
      tools: [tool('search_knowledge', offered)],
      ctx: CTX,
      limits: LIMITS,
    });
    expect(offered).not.toHaveBeenCalled();
    expect(out.toolCalls.map((t) => [t.name, t.status, t.error])).toEqual([
      ['add_contact_tags', 'error', 'tool_not_available'],
      ['drop_database', 'error', 'unknown_tool'],
    ]);
    const results = m.seen[1].messages.filter((x) => x.role === 'tool') as {
      content: string;
      isError?: boolean;
    }[];
    expect(results.every((r) => r.isError)).toBe(true);
    expect(results[0].content).toContain('"error":"tool_not_available"');
  });

  it('bad JSON, bad input, a throwing handler and a slow one become error codes', async () => {
    const consoleErr = vi.spyOn(console, 'error').mockImplementation(() => {});
    const throwing = tool('get_contact_profile', async () => {
      throw new Error('relation "secret_table" does not exist');
    });
    const slow = tool('list_contact_deals', () => new Promise(() => {}));
    const fine = tool('search_knowledge', vi.fn());
    const m = scripted([
      toolStep([
        call('1', 'search_knowledge', '{not json'),
        call('2', 'search_knowledge', { query: 42 }),
        call('3', 'get_contact_profile'),
        call('4', 'list_contact_deals'),
      ]),
      answer('ok'),
    ]);
    const out = await runAgentTurn({
      callModel: m.fn,
      systemPrompt: 's',
      messages: USER,
      tools: [fine, throwing, slow],
      ctx: CTX,
      limits: { ...LIMITS, toolTimeoutMs: 20 },
    });
    expect(out.toolCalls.map((t) => t.error)).toEqual([
      'invalid_json',
      'invalid_query',
      'tool_failed',
      'tool_timeout',
    ]);
    // The database message stays in the server log, never in the model's input.
    expect(JSON.stringify(m.seen[1].messages)).not.toContain('secret_table');
    expect(out.text).toBe('ok');
    consoleErr.mockRestore();
  });

  it('caps the calls executed per step', async () => {
    const handler = vi.fn().mockResolvedValue({ ok: true, data: 1 });
    const calls = Array.from({ length: 10 }, (_, i) =>
      call(`c${i}`, 'search_knowledge')
    );
    const m = scripted([toolStep(calls), answer('ok')]);
    const out = await runAgentTurn({
      callModel: m.fn,
      systemPrompt: 's',
      messages: USER,
      tools: [tool('search_knowledge', handler)],
      ctx: CTX,
      limits: LIMITS,
    });
    expect(handler).toHaveBeenCalledTimes(8);
    expect(
      out.toolCalls.filter((t) => t.error === 'too_many_calls')
    ).toHaveLength(2);
    expect(m.seen[1].messages.filter((x) => x.role === 'tool')).toHaveLength(
      10
    );
  });

  // SPEC 089 F8: per step was not enough — 3 steps × 8 calls let one
  // customer message spend 24 of the account's monthly tool calls.
  it('caps the calls executed in the whole turn (every step together)', async () => {
    const handler = vi.fn().mockResolvedValue({ ok: true, data: 1 });
    const batch = (s: string) =>
      Array.from({ length: 5 }, (_, i) =>
        call(`${s}${i}`, 'search_knowledge', { query: `${s}${i}` })
      );
    const m = scripted([
      toolStep(batch('a')),
      toolStep(batch('b')),
      toolStep(batch('c')),
      answer('ok'),
    ]);
    const out = await runAgentTurn({
      callModel: m.fn,
      systemPrompt: 's',
      messages: USER,
      tools: [tool('search_knowledge', handler)],
      ctx: CTX,
      limits: LIMITS,
    });
    expect(handler).toHaveBeenCalledTimes(MAX_CALLS_PER_TURN);
    expect(
      out.toolCalls.filter((t) => t.error === 'too_many_calls')
    ).toHaveLength(15 - MAX_CALLS_PER_TURN);
  });

  it('records the risk of the offered tool in every trace', async () => {
    const m = scripted([
      toolStep([call('c1', 'abrir_chamado'), call('c2', 'unknown_x')]),
      answer('ok'),
    ]);
    const out = await runAgentTurn({
      callModel: m.fn,
      systemPrompt: 's',
      messages: USER,
      tools: [
        tool(
          'abrir_chamado',
          vi.fn().mockResolvedValue({ ok: true, data: 1 }),
          'write'
        ),
      ],
      ctx: { ...CTX, dryRun: true, mode: 'playground' },
      limits: LIMITS,
    });
    expect(out.toolCalls[0]).toMatchObject({
      name: 'abrir_chamado',
      risk: 'write',
    });
    expect(out.toolCalls[1]).not.toHaveProperty('risk');
  });

  it('AI_TOOL_WRITES=off: a real write never runs (handoff_to_human still does)', async () => {
    const prev = process.env.AI_TOOL_WRITES;
    process.env.AI_TOOL_WRITES = 'off';
    try {
      const write = vi.fn().mockResolvedValue({ ok: true, data: 1 });
      const handoff = vi.fn().mockResolvedValue({ ok: true, data: 1 });
      const m = scripted([
        toolStep([
          call('c1', 'add_contact_tags'),
          call('c2', 'handoff_to_human'),
        ]),
        answer('ok'),
      ]);
      const out = await runAgentTurn({
        callModel: m.fn,
        systemPrompt: 's',
        messages: USER,
        tools: [
          tool('add_contact_tags', write, 'write'),
          tool('handoff_to_human', handoff, 'write'),
        ],
        ctx: CTX,
        limits: LIMITS,
      });
      expect(write).not.toHaveBeenCalled();
      expect(out.toolCalls[0].error).toBe('writes_disabled');
      expect(handoff).toHaveBeenCalledTimes(1);
    } finally {
      if (prev === undefined) delete process.env.AI_TOOL_WRITES;
      else process.env.AI_TOOL_WRITES = prev;
    }
  });

  it('retries the first call without tools when the model does not support them (§5.3 rule 5)', async () => {
    const m = scripted([
      new AiError('no tools', { code: 'tools_unsupported' }),
      answer('Oi!'),
    ]);
    const out = await runAgentTurn({
      callModel: m.fn,
      systemPrompt: 's',
      messages: USER,
      tools: [tool('search_knowledge', vi.fn())],
      ctx: CTX,
      limits: LIMITS,
    });
    expect(m.seen.map((s) => s.tools)).toEqual([['search_knowledge'], []]);
    expect(out).toMatchObject({
      text: 'Oi!',
      toolsDisabled: 'unsupported',
      steps: 1,
    });
  });

  it('the retry uses the prompt without the tools paragraph', async () => {
    const m = scripted([
      new AiError('no tools', { code: 'tools_unsupported' }),
      answer('Oi!'),
    ]);
    await runAgentTurn({
      callModel: m.fn,
      systemPrompt: 'with tools',
      fallbackSystemPrompt: 'without tools',
      messages: USER,
      tools: [tool('search_knowledge', vi.fn())],
      ctx: CTX,
      limits: LIMITS,
    });
    expect(m.seen.map((x) => x.systemPrompt)).toEqual([
      'with tools',
      'without tools',
    ]);
  });

  it('renames a call id that repeats across steps (adapters synthesize call_<index>)', async () => {
    const handler = vi.fn().mockResolvedValue({ ok: true, data: 1 });
    const m = scripted([
      toolStep([call('call_0', 'search_knowledge')]),
      toolStep([call('call_0', 'search_knowledge')]),
      answer('ok'),
    ]);
    await runAgentTurn({
      callModel: m.fn,
      systemPrompt: 's',
      messages: USER,
      tools: [tool('search_knowledge', handler)],
      ctx: CTX,
      limits: LIMITS,
    });
    const last = m.seen[2].messages;
    const ids = last.flatMap((x) =>
      x.role === 'assistant' ? (x.toolCalls ?? []).map((c) => c.id) : []
    );
    expect(ids).toEqual(['call_0', 'call_0_s2_0']);
    const results = last.flatMap((x) =>
      x.role === 'tool' ? [x.toolCallId] : []
    );
    expect(results).toEqual(ids);
  });

  it('does not retry on other errors, nor on tools_unsupported after the first step', async () => {
    const m1 = scripted([new AiError('nope', { code: 'rate_limited' })]);
    await expect(
      runAgentTurn({
        callModel: m1.fn,
        systemPrompt: 's',
        messages: USER,
        tools: [tool('search_knowledge', vi.fn())],
        ctx: CTX,
        limits: LIMITS,
      })
    ).rejects.toMatchObject({ code: 'rate_limited' });

    const handler = vi.fn().mockResolvedValue({ ok: true, data: 1 });
    const m2 = scripted([
      toolStep([call('1', 'search_knowledge')]),
      new AiError('x', { code: 'tools_unsupported' }),
    ]);
    await expect(
      runAgentTurn({
        callModel: m2.fn,
        systemPrompt: 's',
        messages: USER,
        tools: [tool('search_knowledge', handler)],
        ctx: CTX,
        limits: LIMITS,
      })
    ).rejects.toMatchObject({ code: 'tools_unsupported' });
  });

  it('ignores tool calls when no tool was offered (never executes them)', async () => {
    const m = scripted([toolStep([call('1', 'search_knowledge')], 'Resposta')]);
    const out = await runAgentTurn({
      callModel: m.fn,
      systemPrompt: 's',
      messages: USER,
      tools: [],
      ctx: CTX,
      limits: LIMITS,
    });
    expect(out).toMatchObject({
      text: 'Resposta',
      toolCalls: [],
      stopReason: 'answer',
    });
  });

  it('enforces the whole-turn deadline and bounds each call by what is left', async () => {
    let clock = 0;
    const handler = vi.fn().mockResolvedValue({ ok: true, data: 1 });
    const seen: number[] = [];
    const callModel: CallModel = async (args) => {
      seen.push(args.timeoutMs);
      clock += 40_000; // each model call takes 40 s
      return toolStep([call('1', 'search_knowledge')]);
    };
    await expect(
      runAgentTurn({
        callModel,
        systemPrompt: 's',
        messages: USER,
        tools: [tool('search_knowledge', handler)],
        ctx: CTX,
        limits: LIMITS,
        now: () => clock,
      })
    ).rejects.toMatchObject({ code: 'agent_timeout', status: 504 });
    expect(seen).toEqual([30_000, 20_000]);
  });

  it('marks simulated writes in the trace', async () => {
    const sim = tool(
      'add_contact_tags',
      async () => ({
        ok: true,
        simulated: true,
        data: { status: 'simulated' },
      }),
      'write'
    );
    const m = scripted([
      toolStep([call('1', 'add_contact_tags', {})]),
      answer('Pronto'),
    ]);
    const out = await runAgentTurn({
      callModel: m.fn,
      systemPrompt: 's',
      messages: USER,
      tools: [sim],
      ctx: { ...CTX, dryRun: true, mode: 'playground' },
      limits: LIMITS,
    });
    expect(out.toolCalls[0].status).toBe('simulated');
  });

  it('echoes the provider state on the assistant tool turn', async () => {
    const step = {
      ...toolStep([call('1', 'search_knowledge')]),
      providerState: { reasoning_details: [{ type: 'reasoning.text' }] },
    };
    const m = scripted([step, answer('ok')]);
    await runAgentTurn({
      callModel: m.fn,
      systemPrompt: 's',
      messages: USER,
      tools: [
        tool(
          'search_knowledge',
          vi.fn().mockResolvedValue({ ok: true, data: 1 })
        ),
      ],
      ctx: CTX,
      limits: LIMITS,
    });
    expect(m.seen[1].messages[1]).toMatchObject({
      role: 'assistant',
      providerState: { reasoning_details: [{ type: 'reasoning.text' }] },
    });
  });
});

describe('addUsage', () => {
  it('sums tokens and cost; null when nothing was reported', () => {
    expect(addUsage(null, null)).toBeNull();
    expect(
      addUsage(null, { promptTokens: 1, completionTokens: 2, totalTokens: 3 })
    ).toEqual({ promptTokens: 1, completionTokens: 2, totalTokens: 3 });
    expect(
      addUsage(
        { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        { promptTokens: 1, completionTokens: 1, totalTokens: 2, costUsd: 0.5 }
      )
    ).toEqual({
      promptTokens: 2,
      completionTokens: 2,
      totalTokens: 4,
      costUsd: 0.5,
    });
  });
});
