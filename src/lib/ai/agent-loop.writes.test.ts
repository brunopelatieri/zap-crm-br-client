import { describe, it, expect, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { runAgentTurn, type AgentLimits, type CallModel } from './agent-loop';
import {
  AiError,
  partialOf,
  type AgentMessage,
  type ProviderResult,
  type ToolCall,
} from './types';
import type {
  AgentTool,
  AuditFinish,
  ToolAudit,
  ToolContext,
} from './tools/types';

// SPEC 089 F5: what the ENGINE adds around a tool call in a real turn —
// the audit row before the handler runs, the database refusals, a write
// that is never repeated, the end of the turn on a handoff, and the spend
// that survives an error.

const LIMITS: AgentLimits = {
  maxSteps: 4,
  deadlineMs: 60_000,
  maxCallsPerStep: 8,
  toolTimeoutMs: 10_000,
  callTimeoutMs: 30_000,
};

function audit(
  claims: (
    { ok: true; id: string | null } | { ok: false; error: string }
  )[] = []
) {
  const begun: { tool: string; callId: string; input: unknown }[] = [];
  const finished: { id: string | null; outcome: AuditFinish }[] = [];
  const a: ToolAudit = {
    begin: async ({ tool, callId, input }) => {
      begun.push({ tool, callId, input });
      return claims.shift() ?? { ok: true, id: `row-${begun.length}` };
    },
    finish: async (id, outcome) => {
      finished.push({ id, outcome });
    },
  };
  return { a, begun, finished };
}

function ctx(over: Partial<ToolContext> = {}): ToolContext {
  return {
    db: {} as SupabaseClient,
    accountId: 'acct-a',
    conversationId: 'conv-a',
    contactId: 'contact-a',
    mode: 'auto_reply',
    dryRun: false,
    toolsConfig: {},
    aiConfig: { embeddingsTarget: null },
    turnId: 'turn-1',
    turnState: {},
    ...over,
  };
}

function tool(
  key: AgentTool['key'],
  handler: AgentTool['handler'],
  risk: AgentTool['risk'] = 'write'
): AgentTool {
  return {
    key,
    description: `fake ${key}`,
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    risk,
    parse: (input) => ({ ok: true, value: input ?? {} }),
    handler,
  };
}

const call = (id: string, name: string, args: unknown = {}): ToolCall => ({
  id,
  name,
  arguments: JSON.stringify(args),
});
const step = (calls: ToolCall[]): ProviderResult => ({
  text: '',
  usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
  toolCalls: calls,
  finishReason: 'tool_calls',
});
const answer = (text: string): ProviderResult => ({
  text,
  usage: { promptTokens: 20, completionTokens: 7, totalTokens: 27 },
  toolCalls: [],
  finishReason: 'stop',
});

function scripted(steps: (ProviderResult | Error)[]) {
  const seen: AgentMessage[][] = [];
  const fn: CallModel = async (args) => {
    seen.push(structuredClone(args.messages));
    const next = steps.shift();
    if (!next) throw new Error('model called more times than scripted');
    if (next instanceof Error) throw next;
    return next;
  };
  return { fn, seen };
}

const USER: AgentMessage[] = [{ role: 'user', content: 'oi' }];

const lastToolResult = (messages: AgentMessage[]) =>
  [...messages].reverse().find((m) => m.role === 'tool') as
    Extract<AgentMessage, { role: 'tool' }> | undefined;

describe('audit around a real call', () => {
  it('claims the row BEFORE the handler runs and closes it after, with the activity of a write', async () => {
    const order: string[] = [];
    const { a, begun, finished } = audit();
    const wrapped: ToolAudit = {
      begin: async (x) => {
        order.push('begin');
        return a.begin(x);
      },
      finish: async (id, o) => {
        order.push('finish');
        return a.finish(id, o);
      },
    };
    const handler = vi.fn(async () => {
      order.push('handler');
      return {
        ok: true as const,
        data: { status: 'ok' },
        activity: { action: 'ai.tool_note_added' as const },
      };
    });
    const m = scripted([
      step([call('c1', 'add_internal_note', { note: 'x' })]),
      answer('ok'),
    ]);
    await runAgentTurn({
      callModel: m.fn,
      systemPrompt: 's',
      messages: USER,
      tools: [tool('add_internal_note', handler)],
      ctx: ctx({ audit: wrapped }),
      limits: LIMITS,
    });
    expect(order).toEqual(['begin', 'handler', 'finish']);
    expect(begun[0]).toMatchObject({
      tool: 'add_internal_note',
      callId: 'c1',
      input: { note: 'x' },
    });
    expect(finished[0].outcome).toMatchObject({
      status: 'ok',
      activity: { action: 'ai.tool_note_added' },
    });
  });

  it('a database refusal (write cap, quota) never reaches the handler and the model gets the code', async () => {
    const handler = vi.fn();
    const { a, finished } = audit([
      { ok: false, error: 'write_limit_reached' },
    ]);
    const m = scripted([step([call('c1', 'add_internal_note')]), answer('ok')]);
    const out = await runAgentTurn({
      callModel: m.fn,
      systemPrompt: 's',
      messages: USER,
      tools: [tool('add_internal_note', handler)],
      ctx: ctx({ audit: a }),
      limits: LIMITS,
    });
    expect(handler).not.toHaveBeenCalled();
    expect(finished).toHaveLength(0);
    expect(out.toolCalls[0]).toMatchObject({
      status: 'error',
      error: 'write_limit_reached',
    });
    expect(lastToolResult(m.seen[1])?.content).toContain('write_limit_reached');
  });

  it('a handler error closes the row as error with the code, and the activity is not recorded', async () => {
    const { a, finished } = audit();
    const m = scripted([step([call('c1', 'add_contact_tags')]), answer('ok')]);
    await runAgentTurn({
      callModel: m.fn,
      systemPrompt: 's',
      messages: USER,
      tools: [
        tool('add_contact_tags', async () => ({
          ok: false,
          error: 'tag_not_allowed',
          detail: { allowed_tags: ['VIP'] },
        })),
      ],
      ctx: ctx({ audit: a }),
      limits: LIMITS,
    });
    expect(finished[0].outcome).toMatchObject({
      status: 'error',
      errorCode: 'tag_not_allowed',
    });
    expect(finished[0].outcome.activity).toBeUndefined();
  });

  it('the typed error detail reaches the model as data (so it can recover)', async () => {
    const m = scripted([step([call('c1', 'add_contact_tags')]), answer('ok')]);
    await runAgentTurn({
      callModel: m.fn,
      systemPrompt: 's',
      messages: USER,
      tools: [
        tool('add_contact_tags', async () => ({
          ok: false,
          error: 'tag_not_allowed',
          detail: { allowed_tags: ['VIP'] },
        })),
      ],
      ctx: ctx({ dryRun: true, mode: 'playground' }),
      limits: LIMITS,
    });
    const content = lastToolResult(m.seen[1])?.content ?? '';
    expect(content).toContain('tag_not_allowed');
    expect(content).toContain('allowed_tags');
    expect(content.startsWith('<tool_result')).toBe(true);
  });

  it('a timeout closes the row as timeout', async () => {
    const { a, finished } = audit();
    const m = scripted([step([call('c1', 'add_internal_note')]), answer('ok')]);
    await runAgentTurn({
      callModel: m.fn,
      systemPrompt: 's',
      messages: USER,
      tools: [tool('add_internal_note', () => new Promise(() => {}))],
      ctx: ctx({ audit: a }),
      limits: { ...LIMITS, toolTimeoutMs: 20, minWriteBudgetMs: 0 },
    });
    expect(finished[0].outcome).toMatchObject({
      status: 'timeout',
      errorCode: 'tool_timeout',
    });
  });

  it('a dry run is never audited and never records an activity', async () => {
    const { a, begun, finished } = audit();
    const m = scripted([step([call('c1', 'add_internal_note')]), answer('ok')]);
    await runAgentTurn({
      callModel: m.fn,
      systemPrompt: 's',
      messages: USER,
      tools: [
        tool('add_internal_note', async () => ({
          ok: true,
          simulated: true,
          data: { status: 'simulated' },
          activity: { action: 'ai.tool_note_added' },
        })),
      ],
      ctx: ctx({ audit: a, dryRun: true, mode: 'playground' }),
      limits: LIMITS,
    });
    expect(begun).toHaveLength(0);
    expect(finished).toHaveLength(0);
  });
});

describe('a write is never repeated inside one turn', () => {
  it('the same tool with the same arguments (a retry after a timeout) runs once', async () => {
    const handler = vi.fn(() => new Promise<never>(() => {})); // never settles
    const { a } = audit();
    const m = scripted([
      step([call('c1', 'add_internal_note', { note: 'a' })]),
      step([call('c2', 'add_internal_note', { note: 'a' })]),
      answer('done'),
    ]);
    const out = await runAgentTurn({
      callModel: m.fn,
      systemPrompt: 's',
      messages: USER,
      tools: [tool('add_internal_note', handler)],
      ctx: ctx({ audit: a }),
      limits: { ...LIMITS, toolTimeoutMs: 20, minWriteBudgetMs: 0 },
    });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(out.toolCalls.map((t) => t.status)).toEqual(['error', 'ok']);
    expect(lastToolResult(m.seen[2])?.content).toContain('already_done');
  });

  it('different arguments are a different write', async () => {
    const handler = vi.fn(async () => ({ ok: true as const, data: {} }));
    const { a, begun } = audit();
    const m = scripted([
      step([
        call('c1', 'add_internal_note', { note: 'a' }),
        call('c2', 'add_internal_note', { note: 'b' }),
        call('c3', 'add_internal_note', { note: 'a' }),
      ]),
      answer('ok'),
    ]);
    await runAgentTurn({
      callModel: m.fn,
      systemPrompt: 's',
      messages: USER,
      tools: [tool('add_internal_note', handler)],
      ctx: ctx({ audit: a }),
      limits: LIMITS,
    });
    expect(handler).toHaveBeenCalledTimes(2);
    expect(begun.map((b) => b.callId)).toEqual(['c1', 'c2']);
  });

  it('a refused write may be retried with the same arguments (it changed nothing)', async () => {
    const handler = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, error: 'update_failed' })
      .mockResolvedValueOnce({ ok: true, data: { status: 'ok' } });
    const m = scripted([
      step([call('c1', 'add_internal_note', { note: 'a' })]),
      step([call('c2', 'add_internal_note', { note: 'a' })]),
      answer('ok'),
    ]);
    await runAgentTurn({
      callModel: m.fn,
      systemPrompt: 's',
      messages: USER,
      tools: [tool('add_internal_note', handler)],
      ctx: ctx({ audit: audit().a }),
      limits: LIMITS,
    });
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('reads are not deduplicated', async () => {
    const handler = vi.fn(async () => ({ ok: true as const, data: {} }));
    const m = scripted([
      step([call('c1', 'search_knowledge'), call('c2', 'search_knowledge')]),
      answer('ok'),
    ]);
    await runAgentTurn({
      callModel: m.fn,
      systemPrompt: 's',
      messages: USER,
      tools: [tool('search_knowledge', handler, 'read')],
      ctx: ctx(),
      limits: LIMITS,
    });
    expect(handler).toHaveBeenCalledTimes(2);
  });
});

describe('handoff_to_human ends the turn', () => {
  it('no further model call, stopReason handoff, and the text is empty', async () => {
    const m = scripted([
      step([call('c1', 'handoff_to_human', { reason: 'r' })]),
      // A second model call would throw: "called more times than scripted".
    ]);
    const out = await runAgentTurn({
      callModel: m.fn,
      systemPrompt: 's',
      messages: USER,
      tools: [
        tool('handoff_to_human', async () => ({
          ok: true,
          data: { status: 'ok' },
          endTurn: 'handoff',
        })),
      ],
      ctx: ctx(),
      limits: LIMITS,
    });
    expect(m.seen).toHaveLength(1);
    expect(out).toMatchObject({ text: '', stopReason: 'handoff', steps: 1 });
    expect(out.toolCalls[0].status).toBe('ok');
  });
});

describe('spend that survives an error', () => {
  it('a provider failure after a tool step carries the usage, steps and calls on the error', async () => {
    const boom = new AiError('provider down', { code: 'provider_error' });
    const m = scripted([step([call('c1', 'search_knowledge')]), boom]);
    const err = await runAgentTurn({
      callModel: m.fn,
      systemPrompt: 's',
      messages: USER,
      tools: [
        tool('search_knowledge', async () => ({ ok: true, data: {} }), 'read'),
      ],
      ctx: ctx(),
      limits: LIMITS,
    }).catch((e) => e);
    expect(err).toBe(boom);
    expect((err as AiError).partial).toMatchObject({
      usage: { totalTokens: 15 },
      steps: 1,
      toolCalls: [{ name: 'search_knowledge', status: 'ok' }],
    });
  });

  it('a deadline error carries the partial spend too', async () => {
    let t = 0;
    const m = scripted([step([call('c1', 'search_knowledge')])]);
    const err = await runAgentTurn({
      callModel: m.fn,
      systemPrompt: 's',
      messages: USER,
      tools: [
        tool(
          'search_knowledge',
          async () => {
            t += 100_000;
            return { ok: true, data: {} };
          },
          'read'
        ),
      ],
      ctx: ctx(),
      limits: LIMITS,
      now: () => t,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(AiError);
    expect((err as AiError).code).toBe('agent_timeout');
    expect((err as AiError).partial?.steps).toBe(1);
  });
});

describe('review fixes (adversarial review of F5)', () => {
  it('whatever the model asks for AFTER handoff_to_human in the same step does not run', async () => {
    const note = vi.fn(async () => ({ ok: true as const, data: {} }));
    const m = scripted([
      step([
        call('c1', 'handoff_to_human', { reason: 'r' }),
        call('c2', 'add_internal_note', { note: 'forged' }),
      ]),
    ]);
    const out = await runAgentTurn({
      callModel: m.fn,
      systemPrompt: 's',
      messages: USER,
      tools: [
        tool('handoff_to_human', async () => ({
          ok: true,
          data: {},
          endTurn: 'handoff',
        })),
        tool('add_internal_note', note),
      ],
      ctx: ctx({ audit: audit().a }),
      limits: LIMITS,
    });
    expect(note).not.toHaveBeenCalled();
    expect(out.stopReason).toBe('handoff');
    expect(out.toolCalls.map((t) => t.error ?? t.status)).toEqual([
      'ok',
      'turn_ended',
    ]);
  });

  it('a REAL write with almost no budget left is refused before the claim (it could not be cancelled)', async () => {
    const handler = vi.fn();
    const { a, begun } = audit();
    const m = scripted([
      step([call('c1', 'add_internal_note', { note: 'x' })]),
      answer('ok'),
    ]);
    const out = await runAgentTurn({
      callModel: m.fn,
      systemPrompt: 's',
      messages: USER,
      tools: [tool('add_internal_note', handler)],
      ctx: ctx({ audit: a }),
      // Only 2 s of turn left when the write starts.
      limits: { ...LIMITS, deadlineMs: 2_000 },
    });
    expect(handler).not.toHaveBeenCalled();
    expect(begun).toHaveLength(0);
    expect(out.toolCalls[0]).toMatchObject({
      status: 'error',
      error: 'not_enough_time',
    });
  });

  it('a READ is audited by SHAPE only: no value of the customer data reaches output_summary', async () => {
    const { a, finished } = audit();
    const m = scripted([
      step([call('c1', 'get_contact_profile')]),
      answer('ok'),
    ]);
    await runAgentTurn({
      callModel: m.fn,
      systemPrompt: 's',
      messages: USER,
      tools: [
        tool(
          'get_contact_profile',
          async () => ({
            ok: true,
            data: {
              name: 'João Pedro Silva',
              tags: ['gestante'],
              custom_fields: { Diagnostico: 'HIV positivo' },
            },
          }),
          'read'
        ),
      ],
      ctx: ctx({ audit: a }),
      limits: LIMITS,
    });
    const summary = finished[0].outcome.outputSummary;
    expect(summary).not.toMatch(/João|gestante|HIV|Silva/);
    expect(summary).toContain('name: text(16)');
    expect(summary).toContain('tags: list(1)');
  });
});

describe('spend survives ANY error (adversarial review of F5)', () => {
  it('a plain TypeError from a provider adapter still carries the partial spend', async () => {
    const m = scripted([
      step([call('c1', 'search_knowledge')]),
      new TypeError('x is undefined'),
    ]);
    const err = await runAgentTurn({
      callModel: m.fn,
      systemPrompt: 's',
      messages: USER,
      tools: [
        tool('search_knowledge', async () => ({ ok: true, data: {} }), 'read'),
      ],
      ctx: ctx(),
      limits: LIMITS,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(TypeError);
    expect(partialOf(err)).toMatchObject({
      steps: 1,
      toolCalls: [{ name: 'search_knowledge' }],
    });
  });
});
