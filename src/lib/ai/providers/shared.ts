import {
  AiError,
  type AgentMessage,
  type AiProviderOptions,
  type AiUsage,
  type ChatMessage,
  type FinishReason,
  type ToolCall,
  type ToolSpec,
} from '../types';

// ============================================================
// Bits shared by the OpenAI + Anthropic adapters.
// ============================================================

export interface ProviderArgs {
  apiKey: string;
  model: string;
  systemPrompt: string;
  /**
   * Transcript (plain user/assistant turns) optionally followed by the
   * engine's tool turns (SPEC 089 F4). A `ChatMessage[]` is a valid value.
   */
  messages: AgentMessage[];
  timeoutMs: number;
  /** Per-account provider options; only the OpenRouter adapter reads it. */
  providerOptions?: AiProviderOptions;
  /**
   * Tools offered on this call. Absent or empty = the request body is
   * exactly what it was before tool calling existed (no `tools` key).
   */
  tools?: ToolSpec[];
}

/**
 * Split the history into the plain transcript (`base`, every turn before
 * the first assistant turn that carries tool calls) and the engine's own
 * tool turns (`tail`). Adapters normalize `base` as they always did
 * (merge, turn order) and translate `tail` verbatim: merging or reordering
 * tool turns would break the call ↔ result pairing both APIs require.
 */
export function splitToolTail(messages: AgentMessage[]): {
  base: ChatMessage[];
  tail: AgentMessage[];
} {
  const idx = messages.findIndex(
    (m) => m.role === 'assistant' && (m.toolCalls?.length ?? 0) > 0
  );
  const head = idx === -1 ? messages : messages.slice(0, idx);
  const base: ChatMessage[] = [];
  for (const m of head) {
    // A stray tool turn before any tool call cannot be paired: drop it.
    if (m.role === 'user' || m.role === 'assistant') {
      base.push({ role: m.role, content: m.content });
    }
  }
  return { base, tail: idx === -1 ? [] : messages.slice(idx) };
}

/**
 * Coerce a provider's usage block into our normalized `AiUsage`, tolerant
 * of missing/partial fields (providers differ and older API versions may
 * omit counts). Returns null when there's nothing usable, so logging can
 * distinguish "no usage reported" from "zero tokens". `total` falls back
 * to prompt + completion when the provider doesn't send it (Anthropic).
 */
export function normalizeUsage(raw: {
  prompt?: unknown;
  completion?: unknown;
  total?: unknown;
  cost?: unknown;
}): AiUsage | null {
  const num = (v: unknown): number =>
    typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0;
  const promptTokens = num(raw.prompt);
  const completionTokens = num(raw.completion);
  const total = num(raw.total);
  const totalTokens = total > 0 ? total : promptTokens + completionTokens;
  if (promptTokens === 0 && completionTokens === 0 && totalTokens === 0) {
    return null;
  }
  const usage: AiUsage = { promptTokens, completionTokens, totalTokens };
  if (
    typeof raw.cost === 'number' &&
    Number.isFinite(raw.cost) &&
    raw.cost >= 0
  ) {
    usage.costUsd = raw.cost;
  }
  return usage;
}

/** Map a fetch rejection (timeout / DNS / offline) to a typed AiError. */
export function toNetworkError(err: unknown): AiError {
  if (err instanceof DOMException && err.name === 'TimeoutError') {
    return new AiError('The AI provider took too long to respond.', {
      code: 'timeout',
      status: 504,
    });
  }
  const msg = err instanceof Error ? err.message : String(err);
  return new AiError(`Could not reach the AI provider: ${msg}`, {
    code: 'network_error',
    status: 502,
  });
}

/** Which routing filter OpenRouter's 404 failed on (SPEC 089 F0 §1.4/§1.8). */
const TOOLS_STEP = 'Filter by Tool Compatibility';
const DATA_POLICY_STEP = 'Filter by Data Policy';

/**
 * Build a typed AiError from a non-2xx provider response, pulling the
 * provider's own error message out of the JSON body when present.
 *
 * Only the message and the routing step are read. The raw body is never
 * kept, logged or returned: OpenRouter's 402/429 bodies carry the owner's
 * `user_id` (F0 §1.9).
 */
export async function providerHttpError(
  provider: string,
  res: Response
): Promise<AiError> {
  let detail = '';
  let routingStep = '';
  try {
    const body = (await res.json()) as {
      error?:
        | { message?: string; metadata?: { failed_routing_step?: unknown } }
        | string;
    };
    detail =
      typeof body?.error === 'string'
        ? body.error
        : (body?.error?.message ?? '');
    // Provider messages can embed links with account/key identifiers
    // (OpenRouter's 402 links to the key's settings page): drop them.
    detail = detail.replace(/https?:\/\/\S+/g, '[link]').slice(0, 300);
    const step =
      typeof body?.error === 'object'
        ? body.error?.metadata?.failed_routing_step
        : undefined;
    if (typeof step === 'string') routingStep = step;
  } catch {
    // Non-JSON error body — fall back to the status line.
  }

  const { status } = res;
  const code =
    status === 401 || status === 403
      ? 'invalid_key'
      : status === 402
        ? 'insufficient_credits'
        : status === 429
          ? 'rate_limited'
          : status === 404 && routingStep === DATA_POLICY_STEP
            ? 'data_policy_no_endpoint'
            : status === 404 && routingStep === TOOLS_STEP
              ? 'tools_unsupported'
              : 'provider_error';
  const base =
    code === 'invalid_key'
      ? `${provider} rejected the API key`
      : code === 'insufficient_credits'
        ? `${provider} has no credits for this request`
        : code === 'rate_limited'
          ? `${provider} rate limit reached`
          : code === 'data_policy_no_endpoint'
            ? `${provider} has no endpoint matching the data-collection policy for this model`
            : code === 'tools_unsupported'
              ? `${provider} has no endpoint for this model that supports tools`
              : `${provider} API error (${status})`;

  return new AiError(detail ? `${base}: ${detail}` : base, {
    code,
    // Surface an auth failure as 401 so the settings "Test key" button
    // can show "invalid key"; everything else is an upstream 502.
    status: code === 'invalid_key' ? 401 : 502,
  });
}

/**
 * Collapse consecutive same-role turns into one (joined with blank
 * lines). Anthropic requires strictly alternating roles; merging is
 * also harmless for OpenAI and keeps the transcript compact.
 */
export function mergeConsecutive(messages: ChatMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const m of messages) {
    const last = out[out.length - 1];
    if (last && last.role === m.role) {
      last.content = `${last.content}\n\n${m.content}`;
    } else {
      out.push({ role: m.role, content: m.content });
    }
  }
  return out;
}

/** Placeholder turns for conversations that do not start / end on the customer. */
const NO_CUSTOMER_YET = '(The customer has not sent a message yet.)';
const WRITE_FOLLOW_UP =
  '(The customer has not replied yet. Write the next message the business should send.)';

/**
 * Shape a transcript for models behind OpenRouter. Claude models (the
 * suggested default) reject a transcript that starts with an assistant
 * turn, and the current ones reject a final assistant turn ("prefill")
 * with an opaque 400 "Provider returned error" — found in production in
 * the SPEC 089 F1 test: an inbox draft asked after the agent had the
 * last word. So: merge same-role turns, drop leading assistant turns,
 * and when the last turn is the business's, append a user nudge asking
 * for the next message. Harmless for models that do not care.
 */
export function normalizeTurnOrder(messages: ChatMessage[]): ChatMessage[] {
  const merged = mergeConsecutive(messages);
  while (merged.length > 0 && merged[0].role === 'assistant') {
    merged.shift();
  }
  if (merged.length === 0) {
    return [{ role: 'user', content: NO_CUSTOMER_YET }];
  }
  if (merged[merged.length - 1].role === 'assistant') {
    merged.push({ role: 'user', content: WRITE_FOLLOW_UP });
  }
  return merged;
}

// ============================================================
// OpenAI-compatible wire format (SPEC 089 F4, D-1/D-15): shared by the
// OpenAI and OpenRouter adapters. Measured against OpenRouter in F0
// (docs/spec-089-f0-fixtures/tool-*.json).
// ============================================================

export interface OpenAiToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export type OpenAiMessage =
  | { role: 'system' | 'user'; content: string }
  | {
      role: 'assistant';
      content: string | null;
      tool_calls?: OpenAiToolCall[];
      reasoning_details?: unknown[];
    }
  | { role: 'tool'; tool_call_id: string; content: string };

export interface OpenAiToolDef {
  type: 'function';
  function: { name: string; description: string; parameters: unknown };
}

/**
 * Build the `messages` array of an OpenAI-style request: the system prompt,
 * the plain transcript normalized by `normalizeBase` (each adapter keeps the
 * normalization it always had), and the engine's tool turns translated
 * verbatim (never merged or reordered: that would break the call/result
 * pairing).
 *
 * `echoReasoning` (OpenRouter only): put the `reasoning_details` the model
 * returned back on the assistant tool-call turn. The OpenRouter docs ask for
 * it when continuing after tool calls; it is NOT measured in F0 (the
 * captured second-step request does not carry it).
 */
export function toOpenAiMessages(
  systemPrompt: string,
  messages: AgentMessage[],
  normalizeBase: (base: ChatMessage[]) => ChatMessage[],
  opts: { echoReasoning?: boolean } = {}
): OpenAiMessage[] {
  const { base, tail } = splitToolTail(messages);
  const out: OpenAiMessage[] = [
    { role: 'system', content: systemPrompt },
    ...normalizeBase(base),
  ];
  for (const m of tail) {
    if (m.role === 'tool') {
      out.push({
        role: 'tool',
        tool_call_id: m.toolCallId,
        content: m.content,
      });
    } else if (m.role === 'assistant') {
      if (m.toolCalls && m.toolCalls.length > 0) {
        const msg: OpenAiMessage = {
          role: 'assistant',
          content: m.content || null,
          tool_calls: m.toolCalls.map((c) => ({
            id: c.id,
            type: 'function',
            function: { name: c.name, arguments: c.arguments },
          })),
        };
        if (opts.echoReasoning) {
          const details = (m.providerState as { reasoning_details?: unknown })
            ?.reasoning_details;
          if (Array.isArray(details) && details.length > 0) {
            msg.reasoning_details = details;
          }
        }
        out.push(msg);
      } else {
        out.push({ role: 'assistant', content: m.content });
      }
    } else {
      out.push({ role: 'user', content: m.content });
    }
  }
  return out;
}

/** Tools in the OpenAI/OpenRouter `tools` shape. */
export function toOpenAiTools(tools: ToolSpec[]): OpenAiToolDef[] {
  return tools.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));
}

/** What `parseOpenAiChoice` extracts from the first choice. */
export interface ParsedOpenAiChoice {
  /** Assistant text; '' when the message has none (a pure tool step). */
  text: string;
  toolCalls: ToolCall[];
  finishReason: FinishReason;
  /** The raw `choices[0].message` (null when absent), for adapter extras
   *  such as OpenRouter's `reasoning_details`. */
  rawMessage: Record<string, unknown> | null;
}

function mapFinishReason(raw: unknown): FinishReason {
  return raw === 'stop' || raw === 'tool_calls' || raw === 'length'
    ? raw
    : 'other';
}

/**
 * Read `choices[0]` of an OpenAI-style response. `arguments` stays a string
 * (an object is stringified, a missing one becomes '{}'); a call without an
 * `id` gets a synthetic `call_<index>`. Validation of the arguments is the
 * engine's job, not the adapter's.
 */
export function parseOpenAiChoice(data: unknown): ParsedOpenAiChoice {
  const choice = (data as { choices?: unknown[] } | null)?.choices?.[0] as
    { message?: unknown; finish_reason?: unknown } | undefined;
  const rawMessage =
    choice?.message && typeof choice.message === 'object'
      ? (choice.message as Record<string, unknown>)
      : null;

  const content = rawMessage?.content;
  const text = typeof content === 'string' ? content : '';

  const toolCalls: ToolCall[] = [];
  const rawCalls = rawMessage?.tool_calls;
  if (Array.isArray(rawCalls)) {
    rawCalls.forEach((raw, i) => {
      const call = raw as {
        id?: unknown;
        index?: unknown;
        function?: { name?: unknown; arguments?: unknown };
      } | null;
      const name = call?.function?.name;
      if (typeof name !== 'string' || !name) return;
      const args = call?.function?.arguments;
      const index = typeof call?.index === 'number' ? call.index : i;
      toolCalls.push({
        id: typeof call?.id === 'string' && call.id ? call.id : `call_${index}`,
        name,
        arguments:
          typeof args === 'string'
            ? args
            : args === undefined || args === null
              ? '{}'
              : JSON.stringify(args),
      });
    });
  }

  return {
    text,
    toolCalls,
    finishReason: mapFinishReason(choice?.finish_reason),
    rawMessage,
  };
}
