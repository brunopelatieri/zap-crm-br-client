import { describe, it, expect } from 'vitest';
import {
  mergeConsecutive,
  normalizeTurnOrder,
  parseOpenAiChoice,
  toOpenAiMessages,
  toOpenAiTools,
} from './shared';
import type { AgentMessage, ToolSpec } from '../types';
import { loadFixture } from './openrouter-fixtures';

// The OpenAI-compatible wire format helpers. Response shapes come from the
// REAL OpenRouter captures of SPEC 089 F0 (docs/spec-089-f0-fixtures/); the
// edge cases without a capture (missing id, object arguments) are small
// transformations of those, marked as such.

function body(name: string): unknown {
  return loadFixture(name).response.body;
}

describe('parseOpenAiChoice', () => {
  it('reads two parallel calls, null content and finish_reason (real capture)', () => {
    const out = parseOpenAiChoice(body('tool-calls-parallel.json'));
    expect(out.text).toBe('');
    expect(out.finishReason).toBe('tool_calls');
    expect(out.toolCalls).toEqual([
      {
        id: 'toolu_01DWEqRDVEAWhhwiGMSVS8EG',
        name: 'search_knowledge',
        arguments: '{"query": "preço plano Avançado"}',
      },
      {
        id: 'toolu_01PXWPLDAbi5gZ4tSUF4Q4Jy',
        name: 'search_knowledge',
        arguments: '{"query": "prazo para devolução"}',
      },
    ]);
    expect(Array.isArray(out.rawMessage?.reasoning_details)).toBe(true);
  });

  it('keeps the text next to the tool calls (real deepseek capture)', () => {
    const out = parseOpenAiChoice(body('tool-calls-with-content.json'));
    expect(out.text).toMatch(/^Olá! Tudo bem\?/);
    expect(out.toolCalls).toHaveLength(2);
    expect(out.toolCalls[0].id).toBe('call_0694f0fd4f88405f81d3256f');
  });

  it('reads a plain final answer (real capture)', () => {
    const out = parseOpenAiChoice(body('tool-result-final-answer.json'));
    expect(out.toolCalls).toEqual([]);
    expect(out.finishReason).toBe('stop');
    expect(out.text).toContain('7 dias corridos');
  });

  it('keeps arguments as the raw string, never parsing them', () => {
    const real = body('tool-calls-parallel.json') as {
      choices: {
        message: { tool_calls: { function: { arguments: string } }[] };
      }[];
    };
    const out = parseOpenAiChoice(real);
    expect(out.toolCalls[0].arguments).toBe(
      real.choices[0].message.tool_calls[0].function.arguments
    );
    expect(typeof out.toolCalls[0].arguments).toBe('string');
  });

  // Derived from the real capture above by removing/altering one field.
  it('stringifies object arguments, defaults missing ones to {} and synthesizes a missing id', () => {
    const out = parseOpenAiChoice({
      choices: [
        {
          finish_reason: 'tool_calls',
          message: {
            content: null,
            tool_calls: [
              { function: { name: 'a', arguments: { q: 'x' } } },
              { id: 'call_z', function: { name: 'b' } },
              { index: 5, function: { name: 'c', arguments: '{}' } },
            ],
          },
        },
      ],
    });
    expect(out.toolCalls).toEqual([
      { id: 'call_0', name: 'a', arguments: '{"q":"x"}' },
      { id: 'call_z', name: 'b', arguments: '{}' },
      { id: 'call_5', name: 'c', arguments: '{}' },
    ]);
  });

  it('skips calls without a function name', () => {
    const out = parseOpenAiChoice({
      choices: [{ message: { tool_calls: [{ id: 'x', function: {} }] } }],
    });
    expect(out.toolCalls).toEqual([]);
  });

  it('normalizes finish_reason', () => {
    const fr = (finish_reason: unknown) =>
      parseOpenAiChoice({ choices: [{ finish_reason, message: {} }] })
        .finishReason;
    expect(fr('stop')).toBe('stop');
    expect(fr('tool_calls')).toBe('tool_calls');
    expect(fr('length')).toBe('length');
    expect(fr('content_filter')).toBe('other');
    expect(fr(undefined)).toBe('other');
  });

  it('tolerates a null / empty response', () => {
    for (const data of [null, {}, { choices: [] }]) {
      const out = parseOpenAiChoice(data);
      expect(out.text).toBe('');
      expect(out.toolCalls).toEqual([]);
      expect(out.rawMessage).toBeNull();
    }
  });
});

describe('toOpenAiTools', () => {
  it('wraps each spec in the function-tool shape of the real request', () => {
    const real = (
      loadFixture('tool-calls-parallel.json').request as unknown as {
        tools: {
          function: {
            name: string;
            description: string;
            parameters: ToolSpec['parameters'];
          };
        }[];
      }
    ).tools;
    const specs: ToolSpec[] = real.map((t) => ({
      name: t.function.name,
      description: t.function.description,
      parameters: t.function.parameters,
    }));
    expect(toOpenAiTools(specs)).toEqual(
      real.map((t) => ({ type: 'function', function: t.function }))
    );
  });
});

describe('toOpenAiMessages', () => {
  const call = { id: 'toolu_1', name: 'search_knowledge', arguments: '{}' };

  it('without tool turns it equals the old shape: system + normalized base', () => {
    const history: AgentMessage[] = [
      { role: 'user', content: 'a' },
      { role: 'user', content: 'b' },
      { role: 'assistant', content: 'c' },
    ];
    expect(toOpenAiMessages('SYS', history, mergeConsecutive)).toEqual([
      { role: 'system', content: 'SYS' },
      { role: 'user', content: 'a\n\nb' },
      { role: 'assistant', content: 'c' },
    ]);
    // OpenRouter keeps its turn-order fix on the base.
    const or = toOpenAiMessages('SYS', history, normalizeTurnOrder);
    expect(or[or.length - 1].role).toBe('user');
  });

  it('translates tool turns and leaves them unmerged and in order', () => {
    const history: AgentMessage[] = [
      { role: 'user', content: 'oi' },
      { role: 'assistant', content: '', toolCalls: [call] },
      { role: 'tool', toolCallId: 'toolu_1', name: 'x', content: 'r1' },
      {
        role: 'assistant',
        content: 'texto',
        toolCalls: [{ ...call, id: 't2' }],
      },
      { role: 'tool', toolCallId: 't2', name: 'x', content: 'r2' },
    ];
    expect(toOpenAiMessages('SYS', history, normalizeTurnOrder)).toEqual([
      { role: 'system', content: 'SYS' },
      { role: 'user', content: 'oi' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'toolu_1',
            type: 'function',
            function: { name: 'search_knowledge', arguments: '{}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'toolu_1', content: 'r1' },
      {
        role: 'assistant',
        content: 'texto',
        tool_calls: [
          {
            id: 't2',
            type: 'function',
            function: { name: 'search_knowledge', arguments: '{}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 't2', content: 'r2' },
    ]);
  });

  it('echoes reasoning_details only when asked (OpenRouter), never for openai', () => {
    const details = [{ type: 'reasoning.text', text: 't', index: 0 }];
    const history: AgentMessage[] = [
      { role: 'user', content: 'oi' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [call],
        providerState: { reasoning_details: details },
      },
    ];
    const withEcho = toOpenAiMessages('S', history, mergeConsecutive, {
      echoReasoning: true,
    });
    expect(withEcho[2]).toMatchObject({ reasoning_details: details });
    const without = toOpenAiMessages('S', history, mergeConsecutive);
    expect(without[2]).not.toHaveProperty('reasoning_details');
  });

  it('ignores an unrelated providerState', () => {
    const history: AgentMessage[] = [
      { role: 'user', content: 'oi' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [call],
        providerState: { something: 1 },
      },
    ];
    const out = toOpenAiMessages('S', history, mergeConsecutive, {
      echoReasoning: true,
    });
    expect(out[2]).not.toHaveProperty('reasoning_details');
  });
});
