import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  composeAgentTurn: vi.fn(),
  generateReply: vi.fn(),
}));

vi.mock('../compose', () => ({ composeAgentTurn: h.composeAgentTurn }));
vi.mock('../generate', () => ({ generateReply: h.generateReply }));

import { AiError, type AiConfig } from '../types';
import {
  autoCheck,
  compareRuns,
  createCase,
  deleteCase,
  executeEvalRun,
  getRun,
  listCases,
  parseConversation,
  promptHashOf,
  setVerdict,
  startEvalRun,
  summarizeResults,
  updateCase,
  type EvalCase,
  type EvalResult,
} from './eval';
import { tuningDb, type Row } from './test-db';

const A = 'acct-a';
const B = 'acct-b';
const ctx = { accountId: A, userId: 'u1' };
const config = {
  provider: 'openrouter',
  model: 'anthropic/claude-haiku-5.5',
  systemPrompt: 'We sell shoes.',
  toolsConfig: {},
  embeddingsTarget: null,
} as unknown as AiConfig;

const caseRow = (id: string, accountId = A, over: Row = {}): Row => ({
  id,
  account_id: accountId,
  title: `case ${id}`,
  conversation: [{ role: 'user', content: `question ${id}` }],
  expect_handoff: false,
  expected_notes: null,
  created_at: `2026-11-0${id.length}T10:00:00Z`,
  updated_at: '2026-11-01T10:00:00Z',
  ...over,
});

const evalCase = (id: string, expectHandoff = false): EvalCase => ({
  id,
  title: `case ${id}`,
  conversation: [{ role: 'user', content: `question ${id}` }],
  expectHandoff,
  expectedNotes: null,
  createdAt: '2026-11-01T10:00:00Z',
  updatedAt: '2026-11-01T10:00:00Z',
});

beforeEach(() => {
  h.composeAgentTurn.mockReset().mockResolvedValue({
    systemPrompt: 'sys',
    messages: [],
    tools: [],
    toolContext: null,
  });
  h.generateReply.mockReset().mockResolvedValue({
    text: 'An answer',
    handoff: false,
    usage: {
      promptTokens: 100,
      completionTokens: 20,
      totalTokens: 120,
      costUsd: 0.001,
    },
  });
});

describe('parseConversation', () => {
  it('masks each turn, trims leading assistant turns and requires a final customer turn', () => {
    expect(
      parseConversation([
        { role: 'assistant', content: 'Olá!' },
        { role: 'user', content: 'meu zap 11 98765-4321' },
        { role: 'assistant', content: 'Qual o e-mail?' },
        { role: 'user', content: 'a@b.com' },
      ])
    ).toEqual([
      { role: 'user', content: 'meu zap [telefone]' },
      { role: 'assistant', content: 'Qual o e-mail?' },
      { role: 'user', content: '[e-mail]' },
    ]);
  });

  it('rejects empty, malformed or business-last conversations', () => {
    for (const bad of [
      null,
      [],
      [{ role: 'x', content: 'y' }],
      [{ role: 'user', content: '  ' }],
      [
        { role: 'user', content: 'oi' },
        { role: 'assistant', content: 'olá' },
      ],
    ]) {
      expect(() => parseConversation(bad)).toThrowError(/conversation/);
    }
  });

  it('keeps the newest turns that fit the size budget (the column is capped in bytes)', () => {
    const turns = Array.from({ length: 20 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `${i}:` + 'x'.repeat(990),
    }));
    turns.push({ role: 'user', content: 'final question' });
    const out = parseConversation(turns);
    const total = out.reduce((n, t) => n + t.content.length, 0);
    expect(total).toBeLessThanOrEqual(8000);
    expect(out[out.length - 1].content).toBe('final question');
    // What survives is what the DB CHECK (12000 bytes of JSON) accepts.
    expect(JSON.stringify(out).length).toBeLessThan(12000);
    expect(out[0].role).toBe('user');
  });

  it('keeps the last 20 turns', () => {
    const turns = Array.from({ length: 30 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `m${i}`,
    }));
    turns.push({ role: 'user', content: 'last' });
    const out = parseConversation(turns);
    expect(out.length).toBeLessThanOrEqual(20);
    expect(out[out.length - 1].content).toBe('last');
  });
});

describe('cases', () => {
  it('creates a masked case, caps the account and isolates tenants', async () => {
    const { db, tables } = tuningDb({ ai_eval_cases: [caseRow('x', B)] });
    const created = await createCase(db, ctx, {
      title: 'Cliente passa o cpf 529.982.247-25',
      conversation: [{ role: 'user', content: 'meu cpf 529.982.247-25' }],
      expectHandoff: true,
      expectedNotes: 'fale em ana@x.com',
    });
    expect(created.expectHandoff).toBe(true);
    const stored = tables.ai_eval_cases.find((r) => r.id === created.id)!;
    expect(JSON.stringify(stored)).not.toMatch(/529|ana@/);

    // another account's case is invisible and untouchable
    expect((await listCases(db, A)).map((c) => c.id)).toEqual([created.id]);
    await expect(
      updateCase(db, A, 'x', { title: 'hacked' })
    ).rejects.toMatchObject({ code: 'not_found' });
    await expect(deleteCase(db, A, 'x')).rejects.toMatchObject({
      code: 'not_found',
    });
    expect(tables.ai_eval_cases.find((r) => r.id === 'x')!.title).toBe(
      'case x'
    );
  });

  it('refuses the 51st case', async () => {
    const full = Array.from({ length: 50 }, (_, i) => caseRow(`c${i}`));
    const { db } = tuningDb({ ai_eval_cases: full });
    await expect(
      createCase(db, ctx, {
        title: 't',
        conversation: [{ role: 'user', content: 'q' }],
      })
    ).rejects.toMatchObject({ code: 'limit_reached' });
  });
});

describe('startEvalRun', () => {
  it('needs cases, caps a run at 10 and opens a running run with the config snapshot', async () => {
    const none = tuningDb({ ai_eval_cases: [], ai_eval_runs: [] });
    await expect(startEvalRun(none.db, ctx, config)).rejects.toMatchObject({
      code: 'no_cases',
    });

    const many = tuningDb({
      ai_eval_cases: Array.from({ length: 11 }, (_, i) => caseRow(`c${i}`)),
      ai_eval_runs: [],
    });
    await expect(startEvalRun(many.db, ctx, config)).rejects.toMatchObject({
      code: 'too_many_cases',
    });

    const ok = tuningDb({
      ai_eval_cases: [caseRow('a'), caseRow('bb'), caseRow('ccc', B)],
      ai_eval_runs: [],
    });
    const started = await startEvalRun(ok.db, ctx, config);
    expect(started.cases.map((c) => c.id).sort()).toEqual(['a', 'bb']);
    expect(started.run.status).toBe('running');
    expect(ok.tables.ai_eval_runs[0]).toMatchObject({
      account_id: A,
      created_by: 'u1',
      provider: 'openrouter',
      model: 'anthropic/claude-haiku-5.5',
      prompt_hash: promptHashOf('We sell shoes.'),
      case_count: 2,
    });
  });

  it('a case id of another account is never run', async () => {
    const { db } = tuningDb({
      ai_eval_cases: [caseRow('a'), caseRow('theirs', B)],
      ai_eval_runs: [],
    });
    // `theirs` is filtered out by account → nothing matches the selection.
    await expect(
      startEvalRun(db, ctx, config, ['theirs'])
    ).rejects.toMatchObject({ code: 'no_cases' });
  });

  it('only one run at a time (the partial unique index → run_in_progress)', async () => {
    const { db } = tuningDb(
      { ai_eval_cases: [caseRow('a')], ai_eval_runs: [] },
      { unique: { ai_eval_runs: [['account_id']] } }
    );
    await startEvalRun(db, ctx, config);
    await expect(startEvalRun(db, ctx, config)).rejects.toMatchObject({
      code: 'run_in_progress',
    });
  });

  it('a stale running run is closed so it cannot block forever', async () => {
    const old = new Date(Date.now() - 20 * 60 * 1000).toISOString();
    const { db, tables } = tuningDb({
      ai_eval_cases: [caseRow('a')],
      ai_eval_runs: [
        { id: 'old', account_id: A, status: 'running', created_at: old },
      ],
    });
    await startEvalRun(db, ctx, config);
    expect(tables.ai_eval_runs.find((r) => r.id === 'old')).toMatchObject({
      status: 'error',
      error_code: 'stale',
    });
  });
});

describe('executeEvalRun — `eval` mode, nothing written or sent', () => {
  const setup = (n = 3) => {
    const cases = Array.from({ length: n }, (_, i) =>
      evalCase(`k${i}`, i === 1)
    );
    const t = tuningDb({
      ai_eval_runs: [{ id: 'run1', account_id: A, status: 'running' }],
      ai_eval_results: [],
    });
    return { cases, ...t };
  };

  it('composes every case in `eval` mode and writes only the run and its results', async () => {
    const { cases, db, writes, tables } = setup();
    h.generateReply
      .mockResolvedValueOnce({
        text: 'Answer 0',
        handoff: false,
        usage: {
          promptTokens: 10,
          completionTokens: 2,
          totalTokens: 12,
          costUsd: 0.001,
        },
      })
      .mockResolvedValueOnce({
        text: '',
        handoff: true,
        usage: {
          promptTokens: 10,
          completionTokens: 2,
          totalTokens: 12,
          costUsd: 0.002,
        },
      })
      .mockResolvedValueOnce({
        text: 'Answer 2',
        handoff: false,
        usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12 },
        toolCalls: [{}, {}],
      });

    await executeEvalRun(db, { accountId: A, runId: 'run1', config, cases });

    for (const call of h.composeAgentTurn.mock.calls) {
      expect(call[0].mode).toBe('eval');
      expect(call[0].accountId).toBe(A);
      expect(call[0].conversationId).toBeUndefined();
    }
    // Only the run and its results are written: no conversation, message,
    // contact, tool-call or usage table is touched.
    expect(new Set(writes.map((w) => w.table))).toEqual(
      new Set(['ai_eval_runs', 'ai_eval_results'])
    );
    const rows = tables.ai_eval_results;
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.run_id === 'run1' && r.account_id === A)).toBe(
      true
    );
    expect(rows.map((r) => r.auto_pass)).toEqual([true, true, true]);
    expect(rows[1]).toMatchObject({ handoff: true, expect_handoff: true });
    expect(rows[2].tool_calls).toBe(2);
    expect(tables.ai_eval_runs[0]).toMatchObject({
      status: 'done',
      completed_count: 3,
      prompt_tokens: 30,
      completion_tokens: 6,
      total_tokens: 36,
    });
    expect(tables.ai_eval_runs[0].cost_usd).toBeCloseTo(0.003);
    expect(tables.ai_eval_runs[0].finished_at).toBeTruthy();
  });

  it('flags an unexpected hand-off or a missing one', async () => {
    const { db, tables } = setup(2);
    h.generateReply
      .mockResolvedValueOnce({ text: '', handoff: true, usage: null })
      .mockResolvedValueOnce({
        text: 'I answered',
        handoff: false,
        usage: null,
      });
    await executeEvalRun(db, {
      accountId: A,
      runId: 'run1',
      config,
      cases: [evalCase('answer', false), evalCase('handoff', true)],
    });
    expect(tables.ai_eval_results.map((r) => r.auto_pass)).toEqual([
      false,
      false,
    ]);
    // Cost stays null when no provider reported one.
    expect(tables.ai_eval_runs[0].cost_usd).toBeNull();
  });

  it('masks what the model wrote before storing it', async () => {
    const { db, tables, cases } = setup(1);
    h.generateReply.mockResolvedValueOnce({
      text: 'Escreva para vendas@loja.com ou (11) 98765-4321',
      handoff: false,
      usage: null,
    });
    await executeEvalRun(db, { accountId: A, runId: 'run1', config, cases });
    expect(tables.ai_eval_results[0].response).toBe(
      'Escreva para [e-mail] ou [telefone]'
    );
  });

  it('a provider error on one case becomes that case result and the run goes on', async () => {
    const { db, tables, cases } = setup(3);
    h.generateReply
      .mockResolvedValueOnce({ text: 'ok', handoff: false, usage: null })
      .mockRejectedValueOnce(new AiError('boom', { code: 'timeout' }))
      .mockResolvedValueOnce({ text: 'ok', handoff: false, usage: null });
    await executeEvalRun(db, { accountId: A, runId: 'run1', config, cases });
    expect(tables.ai_eval_results.map((r) => r.error_code ?? null)).toEqual([
      null,
      'timeout',
      null,
    ]);
    expect(tables.ai_eval_results[1].auto_pass).toBeNull();
    expect(tables.ai_eval_runs[0]).toMatchObject({
      status: 'done',
      completed_count: 3,
    });
  });

  it('stops spending after two batches that fail on every case (bad key, no credit)', async () => {
    const { db, tables, cases } = setup(8);
    h.generateReply.mockRejectedValue(
      new AiError('no credit', { code: 'insufficient_credits' })
    );
    await executeEvalRun(db, { accountId: A, runId: 'run1', config, cases });
    // 2 batches of 2 cases, then it stops: 4 calls, not 8.
    expect(h.generateReply).toHaveBeenCalledTimes(4);
    expect(tables.ai_eval_runs[0]).toMatchObject({
      status: 'error',
      error_code: 'insufficient_credits',
      completed_count: 4,
    });
  });

  it('a database failure closes the run as error and never throws', async () => {
    const { db, tables, cases } = setup(2);
    const broken = tuningDb(
      {
        ai_eval_runs: tables.ai_eval_runs,
        ai_eval_results: [],
      },
      { failOn: ['ai_eval_results'] }
    );
    await expect(
      executeEvalRun(broken.db, { accountId: A, runId: 'run1', config, cases })
    ).resolves.toBeUndefined();
    expect(broken.tables.ai_eval_runs[0]).toMatchObject({
      status: 'error',
      error_code: 'run_failed',
    });
    void db;
  });
});

describe('verdicts and reading runs', () => {
  const result = (over: Row = {}): Row => ({
    id: 'r1',
    run_id: 'run1',
    account_id: A,
    case_id: 'k1',
    case_title: 'T',
    conversation: [],
    expect_handoff: false,
    expected_notes: null,
    response: 'x',
    handoff: false,
    auto_pass: true,
    error_code: null,
    tool_calls: 0,
    prompt_tokens: 1,
    completion_tokens: 1,
    cost_usd: null,
    verdict: null,
    judged_at: null,
    ...over,
  });

  it('sets and clears a verdict, stamping who judged', async () => {
    const { db, tables } = tuningDb({ ai_eval_results: [result()] });
    const r = await setVerdict(db, ctx, 'r1', 'pass');
    expect(r.verdict).toBe('pass');
    expect(tables.ai_eval_results[0].judged_by).toBe('u1');
    const cleared = await setVerdict(db, ctx, 'r1', null);
    expect(cleared.verdict).toBeNull();
    expect(tables.ai_eval_results[0].judged_by).toBeNull();
  });

  it('rejects an invalid verdict and another account result', async () => {
    const { db } = tuningDb({
      ai_eval_results: [
        result({ id: 'mine' }),
        result({ id: 'theirs', account_id: B }),
      ],
    });
    await expect(setVerdict(db, ctx, 'mine', 'maybe')).rejects.toMatchObject({
      code: 'invalid_input',
    });
    await expect(setVerdict(db, ctx, 'theirs', 'pass')).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it('getRun does not return another account run or its results', async () => {
    const { db } = tuningDb({
      ai_eval_runs: [
        {
          id: 'run1',
          account_id: B,
          status: 'done',
          provider: 'openai',
          model: 'm',
          prompt_hash: 'h',
          prompt_chars: 1,
          case_count: 1,
          completed_count: 1,
          prompt_tokens: 0,
          completion_tokens: 0,
          total_tokens: 0,
          cost_usd: null,
          error_code: null,
          created_at: '2026-11-01T10:00:00Z',
          finished_at: null,
        },
      ],
      ai_eval_results: [result({ account_id: B })],
    });
    await expect(getRun(db, A, 'run1')).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it('a run stuck in `running` is shown as failed', async () => {
    const old = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    const { db } = tuningDb({
      ai_eval_runs: [
        {
          id: 'run1',
          account_id: A,
          status: 'running',
          provider: 'openai',
          model: 'm',
          prompt_hash: 'h',
          prompt_chars: 1,
          case_count: 2,
          completed_count: 1,
          prompt_tokens: 0,
          completion_tokens: 0,
          total_tokens: 0,
          cost_usd: null,
          error_code: null,
          created_at: old,
          finished_at: null,
        },
      ],
      ai_eval_results: [],
    });
    const { run } = await getRun(db, A, 'run1');
    expect(run).toMatchObject({ status: 'error', errorCode: 'stale' });
  });
});

describe('pure helpers', () => {
  it('autoCheck', () => {
    expect(autoCheck({ expectHandoff: true, handoff: true, text: '' })).toBe(
      true
    );
    expect(autoCheck({ expectHandoff: true, handoff: false, text: 'hi' })).toBe(
      false
    );
    expect(
      autoCheck({ expectHandoff: false, handoff: false, text: 'hi' })
    ).toBe(true);
    expect(autoCheck({ expectHandoff: false, handoff: true, text: '' })).toBe(
      false
    );
    expect(
      autoCheck({ expectHandoff: false, handoff: false, text: '  ' })
    ).toBe(false);
  });

  it('promptHashOf is stable and trims', () => {
    expect(promptHashOf(' a ')).toBe(promptHashOf('a'));
    expect(promptHashOf('a')).not.toBe(promptHashOf('b'));
    expect(promptHashOf(null)).toBe(promptHashOf(''));
  });

  const res = (
    id: string,
    caseId: string | null,
    title: string,
    over: Partial<EvalResult> = {}
  ): EvalResult => ({
    id,
    runId: 'r',
    caseId,
    caseTitle: title,
    conversation: [],
    expectHandoff: false,
    expectedNotes: null,
    response: 'x',
    handoff: false,
    autoPass: true,
    errorCode: null,
    toolCalls: 0,
    promptTokens: 0,
    completionTokens: 0,
    costUsd: null,
    verdict: null,
    judgedAt: null,
    ...over,
  });

  it('compareRuns pairs by case id, falls back to the title, keeps the order of A', () => {
    const rows = compareRuns(
      [res('a1', 'k1', 'One'), res('a2', null, 'Deleted case')],
      [
        res('b2', null, 'Deleted case'),
        res('b3', 'k3', 'Only B'),
        res('b1', 'k1', 'One'),
      ]
    );
    expect(
      rows.map((r) => [r.title, r.a?.id ?? null, r.b?.id ?? null])
    ).toEqual([
      ['One', 'a1', 'b1'],
      ['Deleted case', 'a2', 'b2'],
      ['Only B', null, 'b3'],
    ]);
  });

  it('summarizeResults', () => {
    const s = summarizeResults([
      res('1', 'a', 'a', { autoPass: true, verdict: 'pass' }),
      res('2', 'b', 'b', { autoPass: false, verdict: 'fail' }),
      res('3', 'c', 'c', { autoPass: null }),
    ]);
    expect(s).toEqual({
      results: 3,
      autoPass: 1,
      autoFail: 1,
      errors: 1,
      verdictPass: 1,
      verdictFail: 1,
      unjudged: 1,
    });
  });
});
