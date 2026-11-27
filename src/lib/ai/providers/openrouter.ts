import { AiError, type ProviderResult } from '../types';
import { MAX_OUTPUT_TOKENS } from '../defaults';
import {
  normalizeTurnOrder,
  normalizeUsage,
  parseOpenAiChoice,
  providerHttpError,
  toNetworkError,
  toOpenAiMessages,
  toOpenAiTools,
  type ProviderArgs,
} from './shared';

// ============================================================
// OpenRouter adapter (SPEC 089 D-1): its own adapter over the
// OpenAI-compatible endpoint, so `openai.ts` stays untouched.
// Measured against the real API in F0 (docs/spec-089-f0-medicoes.md).
// ============================================================

export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
export const OPENROUTER_CHAT_URL = `${OPENROUTER_BASE_URL}/chat/completions`;
export const OPENROUTER_KEY_URL = `${OPENROUTER_BASE_URL}/key`;

/** App name shown to OpenRouter (`X-OpenRouter-Title`). */
const APP_TITLE = 'ZAP CRM BR';
/** Fallback attribution URL when the deploy has no site URL configured. */
const FALLBACK_REFERER = 'https://github.com/brunopelatieri/zap-crm-br';

/**
 * Attribution headers (F0 §1.6): `HTTP-Referer` + `X-OpenRouter-Title`.
 * The referer is the deploy's own public URL when configured.
 */
export function openRouterHeaders(apiKey: string): Record<string, string> {
  const site = process.env.NEXT_PUBLIC_SITE_URL?.trim();
  return {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
    'HTTP-Referer': site || FALLBACK_REFERER,
    'X-OpenRouter-Title': APP_TITLE,
  };
}

interface OpenRouterResponse {
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    cost?: number;
  };
}

/**
 * Call OpenRouter's chat completions with the caller's own key. Returns
 * the raw assistant text + token usage + cost (`usage.cost`, USD).
 *
 * Reasoning is left at the model's default on purpose (F0 §1.7): forcing
 * `reasoning.enabled = false` is rejected by models that require it.
 */
export async function generateOpenRouter(
  args: ProviderArgs
): Promise<ProviderResult> {
  const {
    apiKey,
    model,
    systemPrompt,
    messages,
    timeoutMs,
    providerOptions,
    tools,
  } = args;

  const body: Record<string, unknown> = {
    model,
    messages: toOpenAiMessages(systemPrompt, messages, normalizeTurnOrder, {
      echoReasoning: true,
    }),
    max_tokens: MAX_OUTPUT_TOKENS,
  };
  if (providerOptions?.denyDataCollection) {
    body.provider = { data_collection: 'deny' };
  }
  if (tools && tools.length > 0) {
    body.tools = toOpenAiTools(tools);
    body.tool_choice = 'auto';
  }

  let res: Response;
  try {
    res = await fetch(OPENROUTER_CHAT_URL, {
      method: 'POST',
      headers: openRouterHeaders(apiKey),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw toNetworkError(err);
  }

  if (!res.ok) {
    throw await providerHttpError('OpenRouter', res);
  }

  const data = (await res
    .json()
    .catch(() => null)) as OpenRouterResponse | null;
  const { text, toolCalls, finishReason, rawMessage } = parseOpenAiChoice(data);
  // A pure tool step (tool_calls with null/empty content) is a valid answer.
  if (toolCalls.length === 0 && !text.trim()) {
    // Reasoning tokens share the output cap: a reasoning model can spend it
    // all and leave no text (finish_reason "length").
    if (finishReason === 'length') {
      throw new AiError(
        'OpenRouter hit the output limit before producing text (a reasoning model can spend it all thinking). Try a non-reasoning model.',
        { code: 'output_truncated' }
      );
    }
    throw new AiError('OpenRouter returned an empty response.', {
      code: 'empty_response',
    });
  }
  const usage = normalizeUsage({
    prompt: data?.usage?.prompt_tokens,
    completion: data?.usage?.completion_tokens,
    total: data?.usage?.total_tokens,
    cost: data?.usage?.cost,
  });
  const result: ProviderResult = { text, usage, toolCalls, finishReason };
  // OpenRouter docs: when continuing after tool calls, send the
  // `reasoning_details` of the assistant turn back unchanged. NOT measured
  // in F0 (the captured second-step request omits them and still worked), so
  // it is an echo per the docs, not a proven requirement.
  const details = rawMessage?.reasoning_details;
  if (Array.isArray(details) && details.length > 0) {
    result.providerState = { reasoning_details: details };
  }
  return result;
}

/**
 * Validate an OpenRouter key without spending credit: `GET /api/v1/key`
 * answers 200 for a valid key and 401 otherwise (F0 §1.8). Does not check
 * the model — a wrong model id surfaces on first use (400).
 */
export async function validateOpenRouterKey(
  apiKey: string,
  timeoutMs: number
): Promise<void> {
  let res: Response;
  try {
    res = await fetch(OPENROUTER_KEY_URL, {
      method: 'GET',
      headers: openRouterHeaders(apiKey),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw toNetworkError(err);
  }
  if (!res.ok) {
    throw await providerHttpError('OpenRouter', res);
  }
}
