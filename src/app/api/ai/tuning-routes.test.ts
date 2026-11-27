import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// SPEC 089 F7 — rotas de exemplos e de avaliação. As rotas e a camada de
// serviço são as reais; o banco é o fake em memória de `tuning/test-db.ts`.
// `requireRole` é simulado só para variar o papel; `after()` guarda o
// callback (a rodada em si tem teste em `tuning/eval.test.ts`).
// ---------------------------------------------------------------------------

const h = vi.hoisted(() => ({
  role: 'admin' as 'admin' | 'agent',
  inPlan: true,
  afters: [] as (() => Promise<void> | void)[],
  db: null as unknown,
  target: { target: null as unknown, corrupt: false },
  config: null as unknown,
  startEvalRun: vi.fn(),
  executeEvalRun: vi.fn(),
}));

vi.mock('next/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/server')>()),
  after: (cb: () => Promise<void> | void) => {
    h.afters.push(cb);
  },
}));

vi.mock('@/lib/auth/account', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/account')>();
  return {
    ...actual,
    requireRole: async () => {
      if (h.role === 'agent') throw new actual.ForbiddenError('Forbidden');
      return { supabase: h.db, accountId: 'acct-a', userId: 'u1' };
    },
  };
});

vi.mock('@/lib/ai/plan-gate', async () => {
  const { ForbiddenError } = await import('@/lib/auth/account');
  return {
    requireAiFeature: async () => {
      if (!h.inPlan) throw new ForbiddenError('FEATURE_NOT_IN_PLAN');
    },
  };
});

vi.mock('@/lib/ai/config', () => ({
  loadEmbeddingsTarget: async () => h.target,
  loadAiConfig: async () => h.config,
}));
vi.mock('@/lib/ai/admin-client', () => ({ supabaseAdmin: () => h.db }));
vi.mock('@/lib/ai/tuning/eval', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ai/tuning/eval')>()),
  startEvalRun: h.startEvalRun,
  executeEvalRun: h.executeEvalRun,
}));

import { tuningDb, type Row } from '@/lib/ai/tuning/test-db';
import * as examples from './examples/route';
import * as exampleById from './examples/[id]/route';
import * as exportRoute from './examples/export/route';
import * as reindexRoute from './examples/reindex/route';
import * as searchRoute from './examples/search/route';
import * as casesRoute from './eval/cases/route';
import * as runsRoute from './eval/runs/route';
import * as verdictRoute from './eval/results/[id]/route';

const UUID = '11111111-1111-4111-8111-111111111111';
const json = (body: unknown) =>
  new Request('http://x/api', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
const params = (id: string) => ({ params: Promise.resolve({ id }) });

function seed(tables: Record<string, Row[]> = {}) {
  const t = tuningDb({
    ai_examples: [],
    ai_eval_cases: [],
    ai_eval_results: [],
    ...tables,
  });
  h.db = t.db;
  return t;
}

beforeEach(() => {
  h.role = 'admin';
  h.inPlan = true;
  h.afters.length = 0;
  h.target = {
    target: { provider: 'openrouter', apiKey: 'k' },
    corrupt: false,
  };
  h.config = {
    provider: 'openrouter',
    model: 'm',
    systemPrompt: 'Loja de tênis.',
  };
  h.startEvalRun.mockReset();
  h.executeEvalRun.mockReset();
  seed();
});

describe('who can use the tuning routes', () => {
  it('an agent gets 403 on every route (admin+ only)', async () => {
    h.role = 'agent';
    const calls: (() => Promise<Response>)[] = [
      () => examples.GET(new Request('http://x/api')),
      () => examples.POST(json({})),
      () => exampleById.PATCH(json({}), params(UUID)),
      () => exampleById.DELETE(new Request('http://x'), params(UUID)),
      () => exportRoute.GET(new Request('http://x')),
      () => reindexRoute.POST(),
      () => searchRoute.POST(json({ query: 'q' })),
      () => casesRoute.GET(),
      () => casesRoute.POST(json({})),
      () => runsRoute.GET(),
      () => runsRoute.POST(json({ confirm: true })),
      () => verdictRoute.PATCH(json({ verdict: 'pass' }), params(UUID)),
    ];
    for (const call of calls) {
      expect((await call()).status).toBe(403);
    }
  });

  it('a plan without ai_enabled gets 403 FEATURE_NOT_IN_PLAN', async () => {
    h.inPlan = false;
    const res = await examples.GET(new Request('http://x/api'));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('FEATURE_NOT_IN_PLAN');
  });
});

describe('examples routes', () => {
  it('POST creates an approved, masked example and answers 201', async () => {
    const { tables } = seed();
    const res = await examples.POST(
      json({ customer_message: 'meu zap 11 98765-4321', ideal_response: 'ok' })
    );
    expect(res.status).toBe(201);
    expect(tables.ai_examples[0].customer_message).toBe('meu zap [telefone]');
    expect(tables.ai_examples[0].account_id).toBe('acct-a');
  });

  it('POST rejects an invalid body with a stable code', async () => {
    const res = await examples.POST(json({ customer_message: '' }));
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('invalid_input');
  });

  it('GET validates the filters and reports whether embeddings are available', async () => {
    const bad = await examples.GET(new Request('http://x/api?status=bogus'));
    expect(bad.status).toBe(400);
    const ok = await examples.GET(new Request('http://x/api?status=candidate'));
    const body = await ok.json();
    expect(body).toMatchObject({
      examples: [],
      counts: { candidate: 0, approved: 0, rejected: 0 },
      embeddings_available: true,
    });
  });

  it('PATCH and DELETE refuse a malformed id and another account row', async () => {
    seed({
      ai_examples: [
        {
          id: UUID,
          account_id: 'acct-b',
          status: 'candidate',
          customer_message: 'x',
          ideal_response: 'y',
        },
      ],
    });
    expect(
      (
        await exampleById.PATCH(
          json({ status: 'approved' }),
          params('not-a-uuid')
        )
      ).status
    ).toBe(400);
    expect(
      (await exampleById.PATCH(json({ status: 'approved' }), params(UUID)))
        .status
    ).toBe(404);
    expect(
      (await exampleById.DELETE(new Request('http://x'), params(UUID))).status
    ).toBe(404);
  });

  it('search masks the query and refuses a bad distance', async () => {
    const bad = await searchRoute.POST(json({ query: 'q', max_distance: 5 }));
    expect(bad.status).toBe(400);
    const none = await searchRoute.POST(json({ query: '' }));
    expect(none.status).toBe(400);
  });

  it('reindex without a decryptable key stops with a clear code', async () => {
    h.target = { target: null, corrupt: true };
    const res = await reindexRoute.POST();
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('key_decrypt_failed');
  });
});

describe('export route', () => {
  it('serves only approved masked lines as a JSONL attachment', async () => {
    seed({
      ai_examples: [
        {
          id: '1',
          account_id: 'acct-a',
          status: 'approved',
          customer_message: 'fale com a@b.com',
          ideal_response: 'ok',
          created_at: '2026-11-01T00:00:00Z',
        },
        {
          id: '2',
          account_id: 'acct-a',
          status: 'candidate',
          customer_message: 'nope',
          ideal_response: 'nope',
          created_at: '2026-11-02T00:00:00Z',
        },
        {
          id: '3',
          account_id: 'acct-b',
          status: 'approved',
          customer_message: 'other',
          ideal_response: 'other',
          created_at: '2026-11-03T00:00:00Z',
        },
      ],
    });
    const res = await exportRoute.GET(
      new Request('http://x/api?include_system=1')
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('ndjson');
    expect(res.headers.get('Content-Disposition')).toMatch(
      /attachment; filename="agent-examples-/
    );
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    const text = await res.text();
    const lines = text.trim().split('\n');
    expect(lines).toHaveLength(1);
    const line = JSON.parse(lines[0]);
    expect(line.messages.map((m: { role: string }) => m.role)).toEqual([
      'system',
      'user',
      'assistant',
    ]);
    expect(text).not.toContain('a@b.com');
    expect(text).not.toContain('other');
    expect(text).not.toContain('nope');
  });

  it('without include_system the system prompt stays out', async () => {
    seed({
      ai_examples: [
        {
          id: '1',
          account_id: 'acct-a',
          status: 'approved',
          customer_message: 'q',
          ideal_response: 'a',
          created_at: '2026-11-01T00:00:00Z',
        },
      ],
    });
    const res = await exportRoute.GET(new Request('http://x/api'));
    const line = JSON.parse((await res.text()).trim());
    expect(line.messages).toHaveLength(2);
  });
});

describe('evaluation routes', () => {
  it('a run needs confirm:true (it spends the account key) and starts nothing without it', async () => {
    for (const body of [{}, { confirm: false }, { confirm: 'yes' }]) {
      const res = await runsRoute.POST(json(body));
      expect(res.status).toBe(400);
      expect((await res.json()).code).toBe('confirmation_required');
    }
    expect(h.startEvalRun).not.toHaveBeenCalled();
    expect(h.afters).toHaveLength(0);
  });

  it('a confirmed run answers 202 at once and executes AFTER the response', async () => {
    const cases = [{ id: 'k1' }];
    h.startEvalRun.mockResolvedValue({
      run: { id: 'run1', status: 'running' },
      cases,
    });
    const res = await runsRoute.POST(json({ confirm: true, case_ids: [UUID] }));
    expect(res.status).toBe(202);
    expect((await res.json()).run.id).toBe('run1');
    // Not executed inside the request:
    expect(h.executeEvalRun).not.toHaveBeenCalled();
    expect(h.afters).toHaveLength(1);
    await h.afters[0]();
    expect(h.executeEvalRun).toHaveBeenCalledTimes(1);
    expect(h.executeEvalRun.mock.calls[0][1]).toMatchObject({
      accountId: 'acct-a',
      runId: 'run1',
      cases,
    });
    expect(h.startEvalRun.mock.calls[0][3]).toEqual([UUID]);
  });

  it('refuses malformed case ids and an unconfigured agent', async () => {
    expect(
      (await runsRoute.POST(json({ confirm: true, case_ids: ['x'] }))).status
    ).toBe(400);
    expect(
      (await runsRoute.POST(json({ confirm: true, case_ids: [] }))).status
    ).toBe(400);
    h.config = null;
    const res = await runsRoute.POST(json({ confirm: true }));
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('ai_not_configured');
    expect(h.startEvalRun).not.toHaveBeenCalled();
  });

  it('a TuningError of the service keeps its status and code', async () => {
    const { TuningError } = await import('@/lib/ai/tuning/types');
    h.startEvalRun.mockRejectedValue(
      new TuningError('run_in_progress', 'busy')
    );
    const res = await runsRoute.POST(json({ confirm: true }));
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('run_in_progress');
    expect(h.afters).toHaveLength(0);
  });

  it('cases: create masks, invalid body is 400, verdict is validated', async () => {
    const { tables } = seed();
    const ok = await casesRoute.POST(
      json({
        title: 'Cliente com cpf 529.982.247-25',
        conversation: [{ role: 'user', content: 'oi' }],
        expect_handoff: true,
      })
    );
    expect(ok.status).toBe(201);
    expect(JSON.stringify(tables.ai_eval_cases[0])).not.toContain('529.982');
    const bad = await casesRoute.POST(json({ title: 'x', conversation: [] }));
    expect(bad.status).toBe(400);
    const verdict = await verdictRoute.PATCH(
      json({ verdict: 'maybe' }),
      params(UUID)
    );
    expect(verdict.status).toBe(400);
    const missing = await verdictRoute.PATCH(json({}), params(UUID));
    expect(missing.status).toBe(400);
  });
});
