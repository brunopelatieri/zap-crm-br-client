import { createHash } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { composeAgentTurn } from '../compose';
import { generateReply } from '../generate';
import { AiError, partialOf, type AiConfig, type ChatMessage } from '../types';
import { maskAndLimit } from './mask';
import {
  EVAL_CONCURRENCY,
  EVAL_CONVERSATION_MAX_CHARS,
  EVAL_MAX_CASES_PER_ACCOUNT,
  EVAL_MAX_CASES_PER_RUN,
  EVAL_MAX_TURNS,
  EVAL_NOTES_MAX_CHARS,
  EVAL_RUN_STALE_MS,
  EVAL_TITLE_MAX_CHARS,
  EVAL_TURN_MAX_CHARS,
  TuningError,
} from './types';

// ============================================================
// Evaluation (SPEC 089 F7): a set of reference conversations and what is
// expected of each, run against the account's CURRENT configuration, with
// the results of two runs side by side before a prompt or model is changed.
//
// Judgment is human (P-3: an LLM judge is out). The only automatic check is
// the hand-off one: the case says whether the agent should answer or hand
// off, and the run compares.
//
// A run is `eval` mode of `composeAgentTurn`: the same prompt, knowledge,
// examples and tools as a real turn, but tools are dry-run (they validate
// and describe, never write or call out) and NOTHING is sent. It spends the
// account's own provider key, so it is capped (cases per run, one run at a
// time) and its tokens and cost are recorded on the run.
//
// Run writes (`ai_eval_runs`, `ai_eval_results`) are service-role only: the
// functions that write them take the service-role client.
// ============================================================

export interface EvalTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface EvalCase {
  id: string;
  title: string;
  conversation: EvalTurn[];
  expectHandoff: boolean;
  expectedNotes: string | null;
  createdAt: string;
  updatedAt: string;
}

export type EvalRunStatus = 'running' | 'done' | 'error';

export interface EvalRun {
  id: string;
  status: EvalRunStatus;
  provider: string;
  model: string;
  promptHash: string;
  promptChars: number;
  caseCount: number;
  completedCount: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** Null when the provider reported no cost (OpenAI / Anthropic direct). */
  costUsd: number | null;
  errorCode: string | null;
  createdAt: string;
  finishedAt: string | null;
}

export interface EvalResult {
  id: string;
  runId: string;
  caseId: string | null;
  caseTitle: string;
  conversation: EvalTurn[];
  expectHandoff: boolean;
  expectedNotes: string | null;
  response: string | null;
  handoff: boolean;
  /** Hand-off expectation met; null when the case errored. */
  autoPass: boolean | null;
  errorCode: string | null;
  toolCalls: number;
  promptTokens: number;
  completionTokens: number;
  costUsd: number | null;
  verdict: 'pass' | 'fail' | null;
  judgedAt: string | null;
}

function dbError(error: unknown): TuningError {
  const code = (error as { code?: string } | null)?.code;
  const pending = code === '42P01' || code === 'PGRST205';
  console.error('[ai tuning] eval database error:', code ?? error);
  return new TuningError(
    'database_error',
    pending ? 'Migration 108 is not applied.' : 'Database error.'
  );
}

// ------------------------------------------------------------
// Cases
// ------------------------------------------------------------

/**
 * Validate and mask a reference conversation: user/assistant turns with
 * text, at most 20, each cut and masked; it must end with a customer turn
 * (the agent answers the customer). Throws `invalid_input`.
 */
export function parseConversation(raw: unknown): EvalTurn[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new TuningError(
      'invalid_input',
      'conversation must be a list of turns.'
    );
  }
  const turns: EvalTurn[] = [];
  for (const item of raw.slice(-EVAL_MAX_TURNS)) {
    if (!item || typeof item !== 'object') continue;
    const { role, content } = item as { role?: unknown; content?: unknown };
    if (
      (role !== 'user' && role !== 'assistant') ||
      typeof content !== 'string'
    ) {
      continue;
    }
    const text = maskAndLimit(content, EVAL_TURN_MAX_CHARS);
    if (text) turns.push({ role, content: text });
  }
  if (turns.length === 0) {
    throw new TuningError('invalid_input', 'conversation has no text.');
  }
  // Keep the NEWEST turns that fit the size budget (the column is capped in
  // bytes; an oversized case would otherwise fail at the insert).
  let total = turns.reduce((n, t) => n + t.content.length, 0);
  while (turns.length > 1 && total > EVAL_CONVERSATION_MAX_CHARS) {
    total -= turns[0].content.length;
    turns.shift();
  }
  // Leading assistant turns are noise to the model; the reply is to the
  // customer, so the last turn must be theirs.
  while (turns.length > 0 && turns[0].role === 'assistant') turns.shift();
  if (turns.length === 0 || turns[turns.length - 1].role !== 'user') {
    throw new TuningError(
      'invalid_input',
      'conversation must end with a customer message.'
    );
  }
  return turns;
}

interface DbCase {
  id: string;
  title: string;
  conversation: EvalTurn[];
  expect_handoff: boolean;
  expected_notes: string | null;
  created_at: string;
  updated_at: string;
}

const CASE_COLUMNS =
  'id, title, conversation, expect_handoff, expected_notes, created_at, updated_at';

function mapCase(r: DbCase): EvalCase {
  return {
    id: r.id,
    title: r.title,
    conversation: Array.isArray(r.conversation) ? r.conversation : [],
    expectHandoff: r.expect_handoff,
    expectedNotes: r.expected_notes,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export interface CaseInput {
  title?: unknown;
  conversation?: unknown;
  expectHandoff?: unknown;
  expectedNotes?: unknown;
}

function cleanTitle(raw: unknown): string {
  return typeof raw === 'string' ? maskAndLimit(raw, EVAL_TITLE_MAX_CHARS) : '';
}
function cleanNotes(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const notes = maskAndLimit(raw, EVAL_NOTES_MAX_CHARS);
  return notes || null;
}

export async function listCases(
  db: SupabaseClient,
  accountId: string
): Promise<EvalCase[]> {
  const { data, error } = await db
    .from('ai_eval_cases')
    .select(CASE_COLUMNS)
    .eq('account_id', accountId)
    .order('created_at', { ascending: false })
    .limit(EVAL_MAX_CASES_PER_ACCOUNT);
  if (error) throw dbError(error);
  return ((data ?? []) as unknown as DbCase[]).map(mapCase);
}

export async function createCase(
  db: SupabaseClient,
  ctx: { accountId: string; userId: string },
  input: CaseInput
): Promise<EvalCase> {
  const title = cleanTitle(input.title);
  if (!title) throw new TuningError('invalid_input', 'title is required.');
  const conversation = parseConversation(input.conversation);
  const { count, error: cErr } = await db
    .from('ai_eval_cases')
    .select('id', { count: 'exact', head: true })
    .eq('account_id', ctx.accountId);
  if (cErr) throw dbError(cErr);
  if ((count ?? 0) >= EVAL_MAX_CASES_PER_ACCOUNT) {
    throw new TuningError(
      'limit_reached',
      `An account keeps at most ${EVAL_MAX_CASES_PER_ACCOUNT} evaluation cases.`
    );
  }
  const { data, error } = await db
    .from('ai_eval_cases')
    .insert({
      account_id: ctx.accountId,
      title,
      conversation,
      expect_handoff: input.expectHandoff === true,
      expected_notes: cleanNotes(input.expectedNotes),
      created_by: ctx.userId,
    })
    .select(CASE_COLUMNS)
    .single();
  if (error) throw dbError(error);
  return mapCase(data as unknown as DbCase);
}

export async function updateCase(
  db: SupabaseClient,
  accountId: string,
  id: string,
  input: CaseInput
): Promise<EvalCase> {
  const update: Record<string, unknown> = {};
  if (input.title !== undefined) {
    const title = cleanTitle(input.title);
    if (!title) throw new TuningError('invalid_input', 'title is empty.');
    update.title = title;
  }
  if (input.conversation !== undefined) {
    update.conversation = parseConversation(input.conversation);
  }
  if (input.expectHandoff !== undefined) {
    update.expect_handoff = input.expectHandoff === true;
  }
  if (input.expectedNotes !== undefined) {
    update.expected_notes = cleanNotes(input.expectedNotes);
  }
  if (Object.keys(update).length === 0) {
    throw new TuningError('invalid_input', 'Nothing to update.');
  }
  update.updated_at = new Date().toISOString();
  const { data, error } = await db
    .from('ai_eval_cases')
    .update(update)
    .eq('id', id)
    .eq('account_id', accountId)
    .select(CASE_COLUMNS);
  if (error) throw dbError(error);
  const row = (data ?? [])[0] as unknown as DbCase | undefined;
  if (!row) throw new TuningError('not_found', 'Case not found.');
  return mapCase(row);
}

export async function deleteCase(
  db: SupabaseClient,
  accountId: string,
  id: string
): Promise<void> {
  const { data, error } = await db
    .from('ai_eval_cases')
    .delete()
    .eq('id', id)
    .eq('account_id', accountId)
    .select('id');
  if (error) throw dbError(error);
  if (!data || data.length === 0) {
    throw new TuningError('not_found', 'Case not found.');
  }
}

// ------------------------------------------------------------
// Runs
// ------------------------------------------------------------

interface DbRun {
  id: string;
  status: EvalRunStatus;
  provider: string;
  model: string;
  prompt_hash: string;
  prompt_chars: number;
  case_count: number;
  completed_count: number;
  prompt_tokens: number | string;
  completion_tokens: number | string;
  total_tokens: number | string;
  cost_usd: number | string | null;
  error_code: string | null;
  created_at: string;
  finished_at: string | null;
}

const RUN_COLUMNS =
  'id, status, provider, model, prompt_hash, prompt_chars, case_count, ' +
  'completed_count, prompt_tokens, completion_tokens, total_tokens, cost_usd, ' +
  'error_code, created_at, finished_at';

function mapRun(r: DbRun, now = Date.now()): EvalRun {
  // A run still "running" long after it started lost its worker (server
  // restart): show it as failed instead of spinning forever.
  const stale =
    r.status === 'running' &&
    now - new Date(r.created_at).getTime() > EVAL_RUN_STALE_MS;
  return {
    id: r.id,
    status: stale ? 'error' : r.status,
    provider: r.provider,
    model: r.model,
    promptHash: r.prompt_hash,
    promptChars: r.prompt_chars,
    caseCount: r.case_count,
    completedCount: r.completed_count,
    promptTokens: Number(r.prompt_tokens),
    completionTokens: Number(r.completion_tokens),
    totalTokens: Number(r.total_tokens),
    costUsd: r.cost_usd === null ? null : Number(r.cost_usd),
    errorCode: stale ? 'stale' : r.error_code,
    createdAt: r.created_at,
    finishedAt: r.finished_at,
  };
}

export function promptHashOf(prompt: string | null | undefined): string {
  return createHash('sha256')
    .update((prompt ?? '').trim())
    .digest('hex')
    .slice(0, 12);
}

export async function listRuns(
  db: SupabaseClient,
  accountId: string,
  limit = 20
): Promise<EvalRun[]> {
  const { data, error } = await db
    .from('ai_eval_runs')
    .select(RUN_COLUMNS)
    .eq('account_id', accountId)
    .order('created_at', { ascending: false })
    .limit(Math.min(Math.max(limit, 1), 50));
  if (error) throw dbError(error);
  return ((data ?? []) as unknown as DbRun[]).map((r) => mapRun(r));
}

interface DbResult {
  id: string;
  run_id: string;
  case_id: string | null;
  case_title: string;
  conversation: EvalTurn[];
  expect_handoff: boolean;
  expected_notes: string | null;
  response: string | null;
  handoff: boolean;
  auto_pass: boolean | null;
  error_code: string | null;
  tool_calls: number;
  prompt_tokens: number;
  completion_tokens: number;
  cost_usd: number | string | null;
  verdict: 'pass' | 'fail' | null;
  judged_at: string | null;
}

const RESULT_COLUMNS =
  'id, run_id, case_id, case_title, conversation, expect_handoff, ' +
  'expected_notes, response, handoff, auto_pass, error_code, tool_calls, ' +
  'prompt_tokens, completion_tokens, cost_usd, verdict, judged_at';

function mapResult(r: DbResult): EvalResult {
  return {
    id: r.id,
    runId: r.run_id,
    caseId: r.case_id,
    caseTitle: r.case_title,
    conversation: Array.isArray(r.conversation) ? r.conversation : [],
    expectHandoff: r.expect_handoff,
    expectedNotes: r.expected_notes,
    response: r.response,
    handoff: r.handoff,
    autoPass: r.auto_pass,
    errorCode: r.error_code,
    toolCalls: r.tool_calls,
    promptTokens: r.prompt_tokens,
    completionTokens: r.completion_tokens,
    costUsd: r.cost_usd === null ? null : Number(r.cost_usd),
    verdict: r.verdict,
    judgedAt: r.judged_at,
  };
}

export async function getRun(
  db: SupabaseClient,
  accountId: string,
  runId: string
): Promise<{ run: EvalRun; results: EvalResult[] }> {
  const { data, error } = await db
    .from('ai_eval_runs')
    .select(RUN_COLUMNS)
    .eq('id', runId)
    .eq('account_id', accountId)
    .maybeSingle();
  if (error) throw dbError(error);
  if (!data) throw new TuningError('not_found', 'Run not found.');
  const { data: rows, error: rErr } = await db
    .from('ai_eval_results')
    .select(RESULT_COLUMNS)
    .eq('run_id', runId)
    .eq('account_id', accountId)
    .order('created_at', { ascending: true });
  if (rErr) throw dbError(rErr);
  return {
    run: mapRun(data as unknown as DbRun),
    results: ((rows ?? []) as unknown as DbResult[]).map(mapResult),
  };
}

/** Human verdict for one result (null clears it). */
export async function setVerdict(
  db: SupabaseClient,
  ctx: { accountId: string; userId: string },
  resultId: string,
  verdict: unknown
): Promise<EvalResult> {
  if (verdict !== 'pass' && verdict !== 'fail' && verdict !== null) {
    throw new TuningError(
      'invalid_input',
      'verdict must be pass, fail or null.'
    );
  }
  const { data, error } = await db
    .from('ai_eval_results')
    .update({
      verdict,
      judged_by: verdict ? ctx.userId : null,
      judged_at: verdict ? new Date().toISOString() : null,
    })
    .eq('id', resultId)
    .eq('account_id', ctx.accountId)
    .select(RESULT_COLUMNS);
  if (error) throw dbError(error);
  const row = (data ?? [])[0] as unknown as DbResult | undefined;
  if (!row) throw new TuningError('not_found', 'Result not found.');
  return mapResult(row);
}

// ------------------------------------------------------------
// Starting and executing a run
// ------------------------------------------------------------

export interface StartedRun {
  run: EvalRun;
  cases: EvalCase[];
}

/**
 * Validate and open a run: the cases to run (`caseIds`, or all), at most
 * `EVAL_MAX_CASES_PER_RUN`, and no other run in progress. `db` must be the
 * service-role client. Returns the run row (status `running`) and the cases;
 * the caller then schedules `executeEvalRun` outside the request.
 */
export async function startEvalRun(
  db: SupabaseClient,
  ctx: { accountId: string; userId: string },
  config: Pick<AiConfig, 'provider' | 'model' | 'systemPrompt'>,
  caseIds?: string[]
): Promise<StartedRun> {
  let query = db
    .from('ai_eval_cases')
    .select(CASE_COLUMNS)
    .eq('account_id', ctx.accountId)
    .order('created_at', { ascending: true });
  if (caseIds && caseIds.length > 0) query = query.in('id', caseIds);
  const { data, error } = await query;
  if (error) throw dbError(error);
  const cases = ((data ?? []) as unknown as DbCase[]).map(mapCase);
  if (cases.length === 0) {
    throw new TuningError('no_cases', 'There are no evaluation cases to run.');
  }
  if (cases.length > EVAL_MAX_CASES_PER_RUN) {
    throw new TuningError(
      'too_many_cases',
      `A run takes at most ${EVAL_MAX_CASES_PER_RUN} cases; pick which ones to run.`
    );
  }

  // A run whose worker died would hold the one-running-run slot forever.
  const staleBefore = new Date(Date.now() - EVAL_RUN_STALE_MS).toISOString();
  await db
    .from('ai_eval_runs')
    .update({
      status: 'error',
      error_code: 'stale',
      finished_at: new Date().toISOString(),
    })
    .eq('account_id', ctx.accountId)
    .eq('status', 'running')
    .lt('created_at', staleBefore);

  const { data: run, error: insErr } = await db
    .from('ai_eval_runs')
    .insert({
      account_id: ctx.accountId,
      created_by: ctx.userId,
      status: 'running',
      completed_count: 0,
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
      provider: config.provider,
      model: config.model,
      prompt_hash: promptHashOf(config.systemPrompt),
      prompt_chars: (config.systemPrompt ?? '').length,
      case_count: cases.length,
    })
    .select(RUN_COLUMNS)
    .single();
  if (insErr) {
    // 23505: the partial unique index on (account_id) WHERE status='running'.
    if ((insErr as { code?: string }).code === '23505') {
      throw new TuningError(
        'run_in_progress',
        'Another evaluation run is still in progress.'
      );
    }
    throw dbError(insErr);
  }
  return { run: mapRun(run as unknown as DbRun), cases };
}

/** The hand-off check: did the agent do what the case expects? */
export function autoCheck(args: {
  expectHandoff: boolean;
  handoff: boolean;
  text: string;
}): boolean {
  if (args.expectHandoff) return args.handoff;
  return !args.handoff && args.text.trim().length > 0;
}

interface CaseOutcome {
  result: Record<string, unknown>;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costUsd: number | null;
  errorCode: string | null;
}

async function evaluateCase(
  db: SupabaseClient,
  accountId: string,
  config: AiConfig,
  testCase: EvalCase
): Promise<CaseOutcome> {
  const base = {
    case_id: testCase.id,
    case_title: testCase.title,
    conversation: testCase.conversation,
    expect_handoff: testCase.expectHandoff,
    expected_notes: testCase.expectedNotes,
  };
  try {
    const messages: ChatMessage[] = testCase.conversation.map((t) => ({
      role: t.role,
      content: t.content,
    }));
    // `eval` mode: tools only describe what they would do, nothing is sent.
    const turn = await composeAgentTurn({
      db,
      accountId,
      config,
      mode: 'eval',
      messages,
    });
    const result = await generateReply({
      config,
      systemPrompt: turn.systemPrompt,
      messages: turn.messages,
      tools: turn.tools,
      toolContext: turn.toolContext,
      fallbackSystemPrompt: turn.fallbackSystemPrompt,
    });
    const text = maskAndLimit(result.text ?? '', 3500);
    const usage = result.usage;
    return {
      result: {
        ...base,
        response: text || null,
        handoff: result.handoff,
        auto_pass: autoCheck({
          expectHandoff: testCase.expectHandoff,
          handoff: result.handoff,
          text,
        }),
        tool_calls: result.toolCalls?.length ?? 0,
        prompt_tokens: usage?.promptTokens ?? 0,
        completion_tokens: usage?.completionTokens ?? 0,
        cost_usd: usage?.costUsd ?? null,
      },
      promptTokens: usage?.promptTokens ?? 0,
      completionTokens: usage?.completionTokens ?? 0,
      totalTokens: usage?.totalTokens ?? 0,
      costUsd: usage?.costUsd ?? null,
      errorCode: null,
    };
  } catch (err) {
    const code =
      err instanceof AiError ? err.code?.toString().slice(0, 64) : 'unexpected';
    const partial = partialOf(err)?.usage ?? null;
    return {
      result: {
        ...base,
        response: null,
        handoff: false,
        auto_pass: null,
        error_code: code ?? 'unexpected',
        tool_calls: 0,
        prompt_tokens: partial?.promptTokens ?? 0,
        completion_tokens: partial?.completionTokens ?? 0,
        cost_usd: partial?.costUsd ?? null,
      },
      promptTokens: partial?.promptTokens ?? 0,
      completionTokens: partial?.completionTokens ?? 0,
      totalTokens: partial?.totalTokens ?? 0,
      costUsd: partial?.costUsd ?? null,
      errorCode: code ?? 'unexpected',
    };
  }
}

/**
 * Execute a started run: the cases `EVAL_CONCURRENCY` at a time, one result
 * row per case, the run's totals updated after each batch (so the screen
 * shows progress and cost while it runs). Never throws; any failure closes
 * the run as `error`. When two batches in a row fail on every case (bad
 * key, no credit) the rest is skipped instead of spending more calls.
 *
 * `db` must be the service-role client.
 */
export async function executeEvalRun(
  db: SupabaseClient,
  args: {
    accountId: string;
    runId: string;
    config: AiConfig;
    cases: EvalCase[];
  }
): Promise<void> {
  const { accountId, runId, config, cases } = args;
  let completed = 0;
  let promptTokens = 0;
  let completionTokens = 0;
  let totalTokens = 0;
  let cost: number | null = null;
  let failedBatches = 0;
  let abortCode: string | null = null;

  const close = async (status: 'done' | 'error', errorCode: string | null) => {
    await db
      .from('ai_eval_runs')
      .update({
        status,
        error_code: errorCode,
        finished_at: new Date().toISOString(),
        completed_count: completed,
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: totalTokens,
        cost_usd: cost,
      })
      .eq('id', runId)
      .eq('account_id', accountId);
  };

  try {
    for (let i = 0; i < cases.length; i += EVAL_CONCURRENCY) {
      const batch = cases.slice(i, i + EVAL_CONCURRENCY);
      const outcomes = await Promise.all(
        batch.map((c) => evaluateCase(db, accountId, config, c))
      );
      const rows = outcomes.map((o) => ({
        run_id: runId,
        account_id: accountId,
        ...o.result,
      }));
      const { error } = await db.from('ai_eval_results').insert(rows);
      if (error) throw error;
      for (const o of outcomes) {
        completed++;
        promptTokens += o.promptTokens;
        completionTokens += o.completionTokens;
        totalTokens += o.totalTokens;
        if (o.costUsd !== null) cost = (cost ?? 0) + o.costUsd;
      }
      await db
        .from('ai_eval_runs')
        .update({
          completed_count: completed,
          prompt_tokens: promptTokens,
          completion_tokens: completionTokens,
          total_tokens: totalTokens,
          cost_usd: cost,
        })
        .eq('id', runId)
        .eq('account_id', accountId);

      if (outcomes.every((o) => o.errorCode)) {
        failedBatches++;
        abortCode = outcomes[outcomes.length - 1].errorCode;
        if (failedBatches >= 2) break;
      } else {
        failedBatches = 0;
        abortCode = null;
      }
    }
    await close(
      failedBatches >= 2 ? 'error' : 'done',
      failedBatches >= 2 ? abortCode : null
    );
  } catch (err) {
    console.error('[ai tuning] eval run failed:', err);
    try {
      await close('error', 'run_failed');
    } catch {
      /* the stale sweep closes it */
    }
  }
}

// ------------------------------------------------------------
// Comparison
// ------------------------------------------------------------

export interface CompareRow {
  key: string;
  title: string;
  expectHandoff: boolean;
  expectedNotes: string | null;
  a: EvalResult | null;
  b: EvalResult | null;
}

export interface RunSummary {
  results: number;
  autoPass: number;
  autoFail: number;
  errors: number;
  verdictPass: number;
  verdictFail: number;
  unjudged: number;
}

export function summarizeResults(results: EvalResult[]): RunSummary {
  const s: RunSummary = {
    results: results.length,
    autoPass: 0,
    autoFail: 0,
    errors: 0,
    verdictPass: 0,
    verdictFail: 0,
    unjudged: 0,
  };
  for (const r of results) {
    if (r.autoPass === null) s.errors++;
    else if (r.autoPass) s.autoPass++;
    else s.autoFail++;
    if (r.verdict === 'pass') s.verdictPass++;
    else if (r.verdict === 'fail') s.verdictFail++;
    else s.unjudged++;
  }
  return s;
}

/**
 * Pair the results of two runs by case (the case id; a deleted case falls
 * back to its title) so the screen can show them side by side. Pure. Rows
 * follow run A's order, then the cases only B has.
 */
export function compareRuns(a: EvalResult[], b: EvalResult[]): CompareRow[] {
  const keyOf = (r: EvalResult) => r.caseId ?? `title:${r.caseTitle}`;
  const rows = new Map<string, CompareRow>();
  const ensure = (r: EvalResult): CompareRow => {
    const key = keyOf(r);
    let row = rows.get(key);
    if (!row) {
      row = {
        key,
        title: r.caseTitle,
        expectHandoff: r.expectHandoff,
        expectedNotes: r.expectedNotes,
        a: null,
        b: null,
      };
      rows.set(key, row);
    }
    return row;
  };
  for (const r of a) ensure(r).a = r;
  for (const r of b) ensure(r).b = r;
  return Array.from(rows.values());
}
