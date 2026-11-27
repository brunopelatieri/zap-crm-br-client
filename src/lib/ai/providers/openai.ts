import { AiError, type ProviderResult } from '../types';
import { MAX_OUTPUT_TOKENS } from '../defaults';
import {
  mergeConsecutive,
  normalizeUsage,
  parseOpenAiChoice,
  providerHttpError,
  toNetworkError,
  toOpenAiMessages,
  toOpenAiTools,
  type ProviderArgs,
} from './shared';

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';

interface OpenAiResponse {
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

/**
 * Call OpenAI's Chat Completions endpoint with the caller's own key.
 * Returns the raw assistant text + token usage (handoff parsing happens
 * in `generateReply`) and, when `tools` are offered, the tool calls the
 * model asked for (SPEC 089 F4). Without `tools` the request body is the
 * one that existed before tool calling.
 */
export async function generateOpenAi(
  args: ProviderArgs
): Promise<ProviderResult> {
  const { apiKey, model, systemPrompt, messages, timeoutMs, tools } = args;

  const body: Record<string, unknown> = {
    model,
    messages: toOpenAiMessages(systemPrompt, messages, mergeConsecutive),
    max_completion_tokens: MAX_OUTPUT_TOKENS,
  };
  if (tools && tools.length > 0) {
    body.tools = toOpenAiTools(tools);
    body.tool_choice = 'auto';
  }

  let res: Response;
  try {
    res = await fetch(OPENAI_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw toNetworkError(err);
  }

  if (!res.ok) {
    throw await providerHttpError('OpenAI', res);
  }

  const data = (await res.json().catch(() => null)) as OpenAiResponse | null;
  const { text, toolCalls, finishReason } = parseOpenAiChoice(data);
  // A pure tool step has no text; a step with neither is an error.
  if (toolCalls.length === 0 && !text.trim()) {
    throw new AiError('OpenAI returned an empty response.', {
      code: 'empty_response',
    });
  }
  const usage = normalizeUsage({
    prompt: data?.usage?.prompt_tokens,
    completion: data?.usage?.completion_tokens,
    total: data?.usage?.total_tokens,
  });
  return { text, usage, toolCalls, finishReason };
}
