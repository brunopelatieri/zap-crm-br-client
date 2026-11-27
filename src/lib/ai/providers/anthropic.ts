import {
  AiError,
  type AgentMessage,
  type FinishReason,
  type ProviderResult,
  type ToolCall,
} from '../types';
import { MAX_OUTPUT_TOKENS } from '../defaults';
import {
  normalizeTurnOrder,
  normalizeUsage,
  providerHttpError,
  splitToolTail,
  toNetworkError,
  type ProviderArgs,
} from './shared';

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';

interface AnthropicResponseBlock {
  type?: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
}

interface AnthropicResponse {
  content?: AnthropicResponseBlock[];
  stop_reason?: string | null;
  usage?: { input_tokens?: number; output_tokens?: number };
}

type AnthropicRequestBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | {
      type: 'tool_result';
      tool_use_id: string;
      content: string;
      is_error?: true;
    };

interface AnthropicRequestMessage {
  role: 'user' | 'assistant';
  content: string | AnthropicRequestBlock[];
}

/** The model's arguments are raw JSON text; Anthropic wants the object. */
function parseToolInput(raw: string): unknown {
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed !== null && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Translate the engine's tool turns (SPEC 089 F4) to Anthropic's wire format.
 * An assistant turn with tool calls becomes `text?` + `tool_use` blocks; the
 * consecutive `tool` turns that answer it become ONE user message of
 * `tool_result` blocks (all results in a single message, results first).
 */
function tailToAnthropic(tail: AgentMessage[]): AnthropicRequestMessage[] {
  const out: AnthropicRequestMessage[] = [];
  let results: AnthropicRequestBlock[] = [];
  const flush = () => {
    if (results.length > 0) {
      out.push({ role: 'user', content: results });
      results = [];
    }
  };

  for (const m of tail) {
    if (m.role === 'tool') {
      results.push({
        type: 'tool_result',
        tool_use_id: m.toolCallId,
        content: m.content,
        ...(m.isError ? { is_error: true as const } : {}),
      });
      continue;
    }
    if (m.role === 'user') {
      // Text after tool results rides in the same user message, results first.
      if (results.length > 0) {
        results.push({ type: 'text', text: m.content });
        flush();
      } else {
        out.push({ role: 'user', content: m.content });
      }
      continue;
    }
    flush();
    const calls: ToolCall[] = m.toolCalls ?? [];
    if (calls.length === 0) {
      if (m.content) out.push({ role: 'assistant', content: m.content });
      continue;
    }
    const blocks: AnthropicRequestBlock[] = [];
    if (m.content) blocks.push({ type: 'text', text: m.content });
    for (const c of calls) {
      blocks.push({
        type: 'tool_use',
        id: c.id,
        name: c.name,
        input: parseToolInput(c.arguments),
      });
    }
    out.push({ role: 'assistant', content: blocks });
  }
  flush();
  return out;
}

/**
 * Anthropic's Messages API requires strictly alternating roles that begin
 * with `user`. The plain transcript is normalized (merge, drop leading
 * assistant turns, and when the business had the last word append a user
 * nudge — current Claude models reject a final assistant turn "prefill").
 * The tool tail is translated verbatim: merging or reordering it would break
 * the `tool_use` ↔ `tool_result` pairing.
 */
function toAnthropicMessages(
  messages: AgentMessage[]
): AnthropicRequestMessage[] {
  const { base, tail } = splitToolTail(messages);
  return [...normalizeTurnOrder(base), ...tailToAnthropic(tail)];
}

function mapStopReason(reason: string | null | undefined): FinishReason {
  switch (reason) {
    case 'end_turn':
    case 'stop_sequence':
      return 'stop';
    case 'tool_use':
      return 'tool_calls';
    case 'max_tokens':
      return 'length';
    default:
      return 'other';
  }
}

/**
 * Call Anthropic's Messages endpoint with the caller's own key.
 * Returns the raw assistant text, tool calls + token usage (handoff parsing
 * happens in `generateReply`).
 */
export async function generateAnthropic(
  args: ProviderArgs
): Promise<ProviderResult> {
  const { apiKey, model, systemPrompt, messages, timeoutMs, tools } = args;

  const body: Record<string, unknown> = {
    model,
    system: systemPrompt,
    max_tokens: MAX_OUTPUT_TOKENS,
    messages: toAnthropicMessages(messages),
  };
  if (tools && tools.length > 0) {
    // No `tool_choice`: the default is auto.
    body.tools = tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters,
    }));
  }

  let res: Response;
  try {
    res = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw toNetworkError(err);
  }

  if (!res.ok) {
    throw await providerHttpError('Anthropic', res);
  }

  const data = (await res.json().catch(() => null)) as AnthropicResponse | null;
  const blocks = data?.content ?? [];
  const text = blocks
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('')
    .trim();
  const toolCalls: ToolCall[] = blocks
    .filter(
      (b) =>
        b.type === 'tool_use' &&
        typeof b.id === 'string' &&
        typeof b.name === 'string'
    )
    .map((b) => ({
      id: b.id as string,
      name: b.name as string,
      arguments: JSON.stringify(b.input ?? {}),
    }));
  if (!text && toolCalls.length === 0) {
    throw new AiError('Anthropic returned an empty response.', {
      code: 'empty_response',
    });
  }
  // Anthropic reports input/output but no total — normalizeUsage sums.
  const usage = normalizeUsage({
    prompt: data?.usage?.input_tokens,
    completion: data?.usage?.output_tokens,
  });
  return {
    text,
    usage,
    toolCalls,
    finishReason: mapStopReason(data?.stop_reason),
  };
}
