import {
  AiError,
  type AgentMessage,
  type AiConfig,
  type AiUsage,
  type ChatMessage,
  type GenerateResult,
  type ProviderResult,
  type ToolSpec,
} from './types';
import { HANDOFF_SENTINEL, aiRequestTimeoutMs } from './defaults';
import { generateOpenAi } from './providers/openai';
import { generateAnthropic } from './providers/anthropic';
import { generateOpenRouter } from './providers/openrouter';
import { DEFAULT_AGENT_LIMITS, runAgentTurn } from './agent-loop';
import type { AgentTool, ToolContext } from './tools/types';

export interface GenerateArgs {
  config: AiConfig;
  /** Fully-built system prompt (see `buildSystemPrompt`). */
  systemPrompt: string;
  /** Recent conversation turns, oldest first. */
  messages: ChatMessage[];
  /**
   * Tools offered this turn (SPEC 089 F4), from `composeAgentTurn`. Absent
   * or empty = a single model call, exactly as before tool calling.
   */
  tools?: AgentTool[];
  /** Required with `tools`; built by `buildToolContext`. */
  toolContext?: ToolContext | null;
  /** The prompt without the tools paragraph, for the "model rejects
   *  tools" retry (`ComposedTurn.fallbackSystemPrompt`). */
  fallbackSystemPrompt?: string;
}

/** One call to the account's provider (the adapter switch). */
export async function callProvider(
  config: AiConfig,
  args: {
    systemPrompt: string;
    messages: AgentMessage[];
    tools?: ToolSpec[];
    timeoutMs: number;
  }
): Promise<ProviderResult> {
  const providerArgs = {
    apiKey: config.apiKey,
    model: config.model,
    systemPrompt: args.systemPrompt,
    messages: args.messages,
    timeoutMs: args.timeoutMs,
    providerOptions: config.providerOptions,
    ...(args.tools && args.tools.length > 0 ? { tools: args.tools } : {}),
  };
  switch (config.provider) {
    case 'openai':
      return generateOpenAi(providerArgs);
    case 'anthropic':
      return generateAnthropic(providerArgs);
    case 'openrouter':
      return generateOpenRouter(providerArgs);
    default:
      throw new AiError(`Unsupported AI provider: ${config.provider}`, {
        code: 'unsupported_provider',
        status: 400,
      });
  }
}

/**
 * Generate the next reply from the account's configured provider.
 * Without tools: one adapter call, then the handoff sentinel is parsed out
 * of the raw text. With tools: the agent loop (`agent-loop.ts`), and the
 * sentinel is parsed out of its final text only. Throws `AiError` on any
 * provider/network failure (and on the loop's deadline).
 */
export async function generateReply(
  args: GenerateArgs
): Promise<GenerateResult> {
  const { config, systemPrompt, messages, tools, toolContext } = args;
  const timeoutMs = aiRequestTimeoutMs();

  if (!tools || tools.length === 0 || !toolContext) {
    const result = await callProvider(config, {
      systemPrompt,
      messages,
      timeoutMs,
    });
    return parseGeneration(result.text, result.usage);
  }

  const turn = await runAgentTurn({
    callModel: (call) => callProvider(config, call),
    systemPrompt,
    ...(args.fallbackSystemPrompt
      ? { fallbackSystemPrompt: args.fallbackSystemPrompt }
      : {}),
    messages,
    tools,
    ctx: toolContext,
    limits: { ...DEFAULT_AGENT_LIMITS, callTimeoutMs: timeoutMs },
  });
  const parsed = parseGeneration(turn.text, turn.usage);
  return {
    ...parsed,
    // A turn that used its 4 steps without answering, or in which the model
    // called `handoff_to_human`, is handed to a human.
    handoff:
      parsed.handoff ||
      turn.stopReason === 'step_limit' ||
      turn.stopReason === 'handoff',
    ...(turn.stopReason === 'handoff' && toolContext.turnState.handoff
      ? { handoffRequest: toolContext.turnState.handoff }
      : {}),
    steps: turn.steps,
    toolCalls: turn.toolCalls,
    toolSources: turn.sources,
    stopReason: turn.stopReason,
    ...(turn.toolsDisabled ? { toolsDisabled: turn.toolsDisabled } : {}),
  };
}

/**
 * Split the raw model output into `{ text, handoff, usage }`. The
 * sentinel can appear alone or trailing a partial reply; either way we
 * treat the turn as a handoff and strip the marker from any remaining
 * text. `usage` is passed straight through (null when the provider
 * didn't report it).
 */
export function parseGeneration(
  raw: string,
  usage: AiUsage | null = null
): GenerateResult {
  const handoff = raw.includes(HANDOFF_SENTINEL);
  const text = raw.split(HANDOFF_SENTINEL).join('').trim();
  return { text, handoff, usage };
}
