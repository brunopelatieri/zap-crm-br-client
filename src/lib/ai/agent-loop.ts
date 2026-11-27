import {
  AiError,
  type AgentMessage,
  type AiUsage,
  type KnowledgeSource,
  type PartialTurn,
  type ProviderResult,
  type ToolCall,
  type ToolCallTrace,
  type ToolSpec,
} from './types';
import { isWriteSwitchedOff } from './tools/kill-switch';
import { summarizeForAudit, summarizeShape } from './tools/mask';
import { toToolSpecs, getTool } from './tools/registry';
import type {
  AgentTool,
  AuditFinish,
  ToolActivity,
  ToolContext,
  ToolResult,
} from './tools/types';
import { truncateUtf8, wrapToolResult } from './tools/wrap';

// ============================================================
// agent-loop.ts — the tool-calling engine (SPEC 089 D-15), provider-neutral
// and SDK-free.
//
//   model call → tool calls? → run each (bound to ToolContext) → results
//   back as wrapped data → model call … until a text answer.
//
// Limits (P-6): 4 model calls per reply and 60 s for the whole turn. Tool
// errors never abort the turn: the model gets `{ error: <code> }` and may
// recover. Only provider errors and the deadline throw (AiError), and the
// callers already handle those as "no reply".
// ============================================================

export interface AgentLimits {
  /** Model calls per reply (P-6: 4). */
  maxSteps: number;
  /** Whole-turn deadline in ms (P-6: 60 s). */
  deadlineMs: number;
  /** Tool calls executed per model call; the rest get `too_many_calls`. */
  maxCallsPerStep: number;
  /**
   * Tool calls executed in the whole turn (every step together); the rest
   * get `too_many_calls`. Default `MAX_CALLS_PER_TURN` (8). Each executed
   * call counts in the plan's `ai_tool_calls_month`.
   */
  maxCallsPerTurn?: number;
  /** Ceiling for one tool handler, also bounded by the deadline. */
  toolTimeoutMs: number;
  /** Ceiling for one model call, also bounded by the deadline. */
  callTimeoutMs: number;
  /**
   * A REAL write is refused (`not_enough_time`) when less than this much of
   * the turn's budget is left. Default `MIN_WRITE_BUDGET_MS` (3 s).
   */
  minWriteBudgetMs?: number;
}

export const DEFAULT_AGENT_LIMITS: Omit<AgentLimits, 'callTimeoutMs'> = {
  maxSteps: 4,
  deadlineMs: 60_000,
  maxCallsPerStep: 8,
  toolTimeoutMs: 10_000,
};

export type CallModel = (args: {
  systemPrompt: string;
  messages: AgentMessage[];
  tools: ToolSpec[];
  timeoutMs: number;
}) => Promise<ProviderResult>;

export interface RunAgentTurnArgs {
  callModel: CallModel;
  systemPrompt: string;
  /**
   * The same prompt built without the tools paragraph, for the retry when
   * the model rejects tools (§5.3 rule 5): the tool-advertising prompt would
   * make a tool-less model promise to "check" and stop. Defaults to
   * `systemPrompt`.
   */
  fallbackSystemPrompt?: string;
  /** Conversation transcript, oldest first. */
  messages: AgentMessage[];
  /** Tools offered this turn (already narrowed by account config and mode). */
  tools: AgentTool[];
  ctx: ToolContext;
  limits: AgentLimits;
  /** Injectable clock (tests). */
  now?: () => number;
}

export interface AgentTurnResult {
  /** Raw final text (the handoff sentinel is parsed by the caller). Empty
   *  when the turn ended without an answer. */
  text: string;
  usage: AiUsage | null;
  steps: number;
  toolCalls: ToolCallTrace[];
  sources: KnowledgeSource[];
  /** `handoff`: the model called `handoff_to_human` (F5); the turn ends there. */
  stopReason: 'answer' | 'step_limit' | 'handoff';
  toolsDisabled?: 'unsupported';
}

/** Sum token usage over the turn's model calls; null if none reported. */
export function addUsage(a: AiUsage | null, b: AiUsage | null): AiUsage | null {
  if (!b) return a;
  if (!a) return { ...b };
  const out: AiUsage = {
    promptTokens: a.promptTokens + b.promptTokens,
    completionTokens: a.completionTokens + b.completionTokens,
    totalTokens: a.totalTokens + b.totalTokens,
  };
  if (a.costUsd !== undefined || b.costUsd !== undefined) {
    out.costUsd = (a.costUsd ?? 0) + (b.costUsd ?? 0);
  }
  return out;
}

function timeoutError(): AiError {
  return new AiError('The AI agent took too long to answer.', {
    code: 'agent_timeout',
    status: 504,
  });
}

class ToolTimeout extends Error {}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ToolTimeout()), Math.max(0, ms));
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

const MAX_TRACE_RAW = 500;

/**
 * A REAL write needs this much of the turn's budget left. `withTimeout`
 * cannot cancel a handler, so a write that starts with only milliseconds
 * left would be closed as a timeout and still land afterwards, without its
 * activity line.
 */
const MIN_WRITE_BUDGET_MS = 3_000;

/**
 * Tool calls one turn may execute (SPEC 089 F8). Without it a single
 * customer message could make 3 steps × 8 calls = 24 calls, each one
 * spending the account's `ai_tool_calls_month` quota.
 */
export const MAX_CALLS_PER_TURN = 8;

interface CallOutcome {
  payload: unknown;
  isError: boolean;
  trace: Omit<ToolCallTrace, 'step'>;
  sources: KnowledgeSource[];
  endTurn?: 'handoff';
}

/** Canonical text of a write call: the same tool with the same arguments. */
function writeSignature(key: string, value: unknown): string {
  return `${key}:${JSON.stringify(value) ?? ''}`;
}

/**
 * Run one tool call. Never throws: every failure becomes `{ error }` for
 * the model. Only tools OFFERED this turn can run — a call to a catalog
 * tool that is off, or a write tool in a read-only mode, is refused before
 * its handler is reached.
 */
async function executeCall(
  call: ToolCall,
  offered: Map<string, AgentTool>,
  ctx: ToolContext,
  budgetMs: number,
  writesSeen: Set<string>,
  minWriteBudgetMs: number
): Promise<CallOutcome> {
  const started = Date.now();
  const fail = (
    error: string,
    args: unknown,
    detail?: Record<string, unknown>
  ): CallOutcome => ({
    payload: { error, ...(detail ?? {}) },
    isError: true,
    trace: {
      name: call.name,
      arguments: args,
      status: 'error',
      error,
      durationMs: Date.now() - started,
    },
    sources: [],
  });

  const rawArgs = truncateUtf8(call.arguments ?? '', MAX_TRACE_RAW).text;
  const tool = offered.get(call.name);
  if (!tool) {
    return fail(
      getTool(call.name) ? 'tool_not_available' : 'unknown_tool',
      rawArgs
    );
  }

  let json: unknown;
  try {
    json =
      call.arguments && call.arguments.trim() ? JSON.parse(call.arguments) : {};
  } catch {
    return fail('invalid_json', rawArgs);
  }
  const parsed = tool.parse(json);
  // The trace keeps the cut raw text, not the whole object the model sent.
  if (!parsed.ok) return fail(parsed.error, rawArgs);

  // Second layer of the global kill switch (`toolsForTurn` and compose drop
  // these tools first): a real write never runs while it is off.
  if (tool.risk === 'write' && !ctx.dryRun && isWriteSwitchedOff(tool.key)) {
    return fail('writes_disabled', parsed.value);
  }

  if (tool.risk === 'write' && !ctx.dryRun && budgetMs < minWriteBudgetMs) {
    return fail('not_enough_time', parsed.value);
  }

  // A write the model repeats inside one turn (the same tool, the same
  // arguments — a retry after a timeout, say) is NOT run twice. The
  // signature is taken BEFORE the handler runs, so a handler that outlives
  // its timeout (`withTimeout` cannot cancel it) is still not repeated.
  let signature: string | null = null;
  if (tool.risk === 'write') {
    signature = writeSignature(tool.key, parsed.value);
    if (writesSeen.has(signature)) {
      return {
        payload: { status: 'already_done' },
        isError: false,
        trace: {
          name: call.name,
          arguments: parsed.value,
          status: ctx.dryRun ? 'simulated' : 'ok',
          durationMs: Date.now() - started,
        },
        sources: [],
      };
    }
    writesSeen.add(signature);
  }

  // Real calls are audited BEFORE they run; the database decides the write
  // cap per conversation and the plan quota (SPEC 089 F5).
  let auditId: string | null = null;
  // A tool that leaves the app (F6) is audited in a draft too; the built-in
  // tools only in the live auto-reply.
  const audit = !ctx.dryRun || tool.external ? ctx.audit : undefined;
  if (audit) {
    const claim = await audit.begin({
      tool: tool.key,
      risk: tool.risk,
      callId: call.id,
      input: parsed.value,
      ...(tool.external ? { external: true } : {}),
    });
    if (!claim.ok) {
      if (signature) writesSeen.delete(signature);
      return fail(claim.error, parsed.value);
    }
    auditId = claim.id;
  }
  const close = (outcome: AuditFinish): Promise<void> | undefined =>
    audit?.finish(auditId, outcome);

  let result: ToolResult;
  try {
    result = await withTimeout(
      tool.handler(ctx, parsed.value, { budgetMs }),
      budgetMs
    );
  } catch (err) {
    const timedOut = err instanceof ToolTimeout;
    await close({
      status: timedOut ? 'timeout' : 'error',
      errorCode: timedOut ? 'tool_timeout' : 'tool_failed',
      outputSummary: '',
      durationMs: Date.now() - started,
    });
    if (timedOut) return fail('tool_timeout', parsed.value);
    // The detail stays in the server log; the model only sees a code (a DB
    // message could leak schema or another tenant's data).
    console.error(`[ai agent] tool ${tool.key} failed:`, err);
    return fail('tool_failed', parsed.value);
  }
  if (!result.ok) {
    // A refusal that changed nothing may be retried with other arguments;
    // one that may have taken effect elsewhere (an HTTP request that was
    // sent) may not.
    if (signature && !result.outcomeUnknown) writesSeen.delete(signature);
    await close({
      status: 'error',
      errorCode: result.error,
      outputSummary:
        result.auditSummary ??
        summarizeForAudit({
          error: result.error,
          ...result.detail,
        }),
      durationMs: Date.now() - started,
    });
    const failed = fail(result.error, parsed.value, result.detail);
    return result.outcomeUnknown
      ? { ...failed, trace: { ...failed.trace, outcomeUnknown: true } }
      : failed;
  }

  const activity: ToolActivity | undefined = ctx.dryRun
    ? undefined
    : result.activity;
  await close({
    status: 'ok',
    // A READ result is the customer's data (profile, deals, excerpts):
    // only its shape is audited. A write result is a status, names of the
    // admin's own lists and ids.
    // An HTTP tool (F6) sets `auditSummary` itself: the endpoint's answer is
    // a third party's text and stays out of the audit.
    outputSummary:
      result.auditSummary ??
      (tool.risk === 'read' || tool.external
        ? summarizeShape(result.data)
        : summarizeForAudit(result.data)),
    durationMs: Date.now() - started,
    ...(activity ? { activity } : {}),
  });

  return {
    payload: result.data,
    isError: false,
    trace: {
      name: call.name,
      arguments: parsed.value,
      status: result.simulated ? 'simulated' : 'ok',
      durationMs: Date.now() - started,
    },
    sources: result.sources ?? [],
    ...(result.endTurn ? { endTurn: result.endTurn } : {}),
  };
}

function mergeSources(into: KnowledgeSource[], more: KnowledgeSource[]): void {
  for (const s of more) {
    if (!into.some((x) => x.chunkId === s.chunkId)) into.push(s);
  }
}

/**
 * Run one agent turn with tools. Throws AiError on a provider failure or
 * when the deadline passes; everything else ends in a result.
 */
export async function runAgentTurn(
  args: RunAgentTurnArgs
): Promise<AgentTurnResult> {
  const { callModel, systemPrompt, ctx, limits } = args;
  const now = args.now ?? Date.now;
  const deadline = now() + limits.deadlineMs;
  const remaining = () => deadline - now();

  const history: AgentMessage[] = [...args.messages];
  let offered = args.tools;
  let prompt = systemPrompt;
  /** Call ids already in the history (they must be unique across steps). */
  const seenIds = new Set<string>();
  let toolsDisabled: 'unsupported' | undefined;
  let usage: AiUsage | null = null;
  const traces: ToolCallTrace[] = [];
  const sources: KnowledgeSource[] = [];
  /** Write calls already made this turn (see `executeCall`). */
  const writesSeen = new Set<string>();
  /** Calls that reached `executeCall` this turn (`maxCallsPerTurn`). */
  let executedCalls = 0;
  let stepsDone = 0;

  const finish = (
    text: string,
    steps: number,
    stopReason: AgentTurnResult['stopReason']
  ): AgentTurnResult => ({
    text,
    usage,
    steps,
    toolCalls: traces,
    sources,
    stopReason,
    ...(toolsDisabled ? { toolsDisabled } : {}),
  });

  try {
    for (let step = 1; step <= limits.maxSteps; step++) {
      if (remaining() <= 0) throw timeoutError();
      const call = (tools: AgentTool[]) =>
        callModel({
          systemPrompt: prompt,
          messages: history,
          tools: toToolSpecs(tools),
          timeoutMs: Math.max(1, Math.min(limits.callTimeoutMs, remaining())),
        });

      let res: ProviderResult;
      try {
        res = await call(offered);
      } catch (err) {
        // §5.3 rule 5: a model without tool support (OpenRouter's measured
        // 404 `Filter by Tool Compatibility`, F0 §1.4) gets the turn again
        // without tools. Only on the first call: later the history already
        // holds tool turns that a tool-less request could not carry.
        if (
          step === 1 &&
          offered.length > 0 &&
          err instanceof AiError &&
          err.code === 'tools_unsupported'
        ) {
          offered = [];
          toolsDisabled = 'unsupported';
          prompt = args.fallbackSystemPrompt ?? systemPrompt;
          if (remaining() <= 0) throw timeoutError();
          res = await call(offered);
        } else {
          throw err;
        }
      }
      usage = addUsage(usage, res.usage);
      stepsDone = step;

      // Ids must be unique across the whole history: an adapter synthesizes
      // `call_<index>` for an id-less call, which would repeat at the next
      // step (Claude rejects duplicate tool_use ids). Rename repeats.
      const calls = (res.toolCalls ?? []).map((c, i) => {
        const id = seenIds.has(c.id) ? `${c.id}_s${step}_${i}` : c.id;
        seenIds.add(id);
        return id === c.id ? c : { ...c, id };
      });
      // No tool calls, or calls although no tool was offered: the text is the
      // answer (an unrequested call is never executed).
      if (calls.length === 0 || offered.length === 0) {
        return finish(res.text ?? '', step, 'answer');
      }
      // The last allowed call still wants tools: stop without executing them.
      // Under-reply rather than run an open-ended loop (the auto-reply hands
      // the conversation to a human).
      if (step === limits.maxSteps) {
        return finish('', step, 'step_limit');
      }

      // Text sent alongside tool calls ("let me check…", F0 deepseek fixture)
      // stays in the history and never reaches the customer.
      history.push({
        role: 'assistant',
        content: res.text ?? '',
        toolCalls: calls,
        ...(res.providerState !== undefined
          ? { providerState: res.providerState }
          : {}),
      });

      const offeredByKey = new Map(offered.map((t) => [t.key as string, t]));
      let endTurn: 'handoff' | undefined;
      for (let i = 0; i < calls.length; i++) {
        const c = calls[i];
        let outcome: CallOutcome;
        if (endTurn) {
          // The handoff already ended the turn: whatever the model asked
          // for after it does not run.
          outcome = {
            payload: { error: 'turn_ended' },
            isError: true,
            trace: {
              name: c.name,
              arguments: null,
              status: 'error',
              error: 'turn_ended',
              durationMs: 0,
            },
            sources: [],
          };
        } else if (
          i >= limits.maxCallsPerStep ||
          executedCalls >= (limits.maxCallsPerTurn ?? MAX_CALLS_PER_TURN)
        ) {
          // Per step AND per turn: one inbound message must not spend dozens
          // of the account's monthly tool calls (SPEC 089 F8).
          outcome = {
            payload: { error: 'too_many_calls' },
            isError: true,
            trace: {
              name: c.name,
              arguments: null,
              status: 'error',
              error: 'too_many_calls',
              durationMs: 0,
            },
            sources: [],
          };
        } else {
          if (remaining() <= 0) throw timeoutError();
          executedCalls += 1;
          outcome = await executeCall(
            c,
            offeredByKey,
            ctx,
            Math.min(limits.toolTimeoutMs, remaining()),
            writesSeen,
            limits.minWriteBudgetMs ?? MIN_WRITE_BUDGET_MS
          );
        }
        if (outcome.endTurn) endTurn = outcome.endTurn;
        const offeredRisk = offeredByKey.get(c.name)?.risk;
        traces.push({
          step,
          ...outcome.trace,
          ...(offeredRisk ? { risk: offeredRisk } : {}),
        });
        mergeSources(sources, outcome.sources);
        // Every call gets a result: both APIs reject an unanswered call id.
        history.push({
          role: 'tool',
          toolCallId: c.id,
          name: c.name,
          content: wrapToolResult(c.name, outcome.payload),
          ...(outcome.isError ? { isError: true } : {}),
        });
      }
      // `handoff_to_human` ends the turn: no further model call (F5). The
      // caller performs the handoff and sends nothing to the customer.
      if (endTurn) return finish('', step, endTurn);
    }
    // Unreachable: the last step always returns above.
    return finish('', limits.maxSteps, 'step_limit');
  } catch (err) {
    // What the turn already spent is not lost: the caller records the usage
    // (the quota of tool calls depends on it) before it handles the error.
    if (err !== null && typeof err === 'object') {
      (err as { partial?: PartialTurn }).partial = {
        usage,
        steps: stepsDone,
        toolCalls: traces,
      };
    }
    throw err;
  }
}
