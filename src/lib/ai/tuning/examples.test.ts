import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  embedTexts: vi.fn(),
  admin: null as unknown,
}));

vi.mock('../admin-client', () => ({
  supabaseAdmin: () => {
    if (!h.admin) throw new Error('service role not configured');
    return h.admin;
  },
}));

vi.mock('../embeddings', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../embeddings')>()),
  embedTexts: h.embedTexts,
}));

import {
  approveExample,
  countExamples,
  createManualExample,
  deleteExample,
  embedPendingExamples,
  listExamples,
  rejectExample,
  retrieveExamples,
  searchExamples,
  updateExample,
} from './examples';
import { tuningDb, type Row } from './test-db';
import { TuningError } from './types';

const A = 'acct-a';
const B = 'acct-b';
const target = { provider: 'openrouter' as const, apiKey: 'k' };
const ctx = (
  accountId = A,
  embeddingsTarget: typeof target | null = target
) => ({
  accountId,
  userId: 'user-1',
  embeddingsTarget,
});

const ex = (id: string, accountId: string, over: Row = {}): Row => ({
  id,
  account_id: accountId,
  customer_message: `message ${id}`,
  ideal_response: `reply ${id}`,
  ai_draft: null,
  tags: [],
  status: 'candidate',
  source: 'draft_edit',
  conversation_id: null,
  embedding: null,
  embedding_model: null,
  created_at: '2026-11-01T10:00:00Z',
  updated_at: '2026-11-01T10:00:00Z',
  reviewed_at: null,
  ...over,
});

beforeEach(() => {
  h.embedTexts.mockReset().mockResolvedValue([[0.1, 0.2]]);
  h.admin = null;
});

describe('examples — masking on every write', () => {
  it('a manual example is masked, approved and embedded', async () => {
    const { db, tables } = tuningDb({ ai_examples: [] });
    const row = await createManualExample(db, ctx(), {
      customerMessage: 'meu zap é (11) 98765-4321, cpf 529.982.247-25',
      idealResponse: 'Oi! Escreva para ana@loja.com.br',
      tags: ['preço', ' preço ', 'troca'],
    });
    expect(row.status).toBe('approved');
    expect(row.source).toBe('manual');
    expect(row.embedded).toBe(true);
    expect(row.tags).toEqual(['preço', 'troca']);
    const stored = tables.ai_examples[0];
    expect(stored.customer_message).toBe('meu zap é [telefone], cpf [cpf]');
    expect(stored.ideal_response).toBe('Oi! Escreva para [e-mail]');
    expect(stored.embedding).toBe('[0.1,0.2]');
    // What was embedded is the MASKED message, never the raw one.
    expect(h.embedTexts).toHaveBeenCalledWith(target, [
      'meu zap é [telefone], cpf [cpf]',
    ]);
  });

  it('editing re-masks the new text', async () => {
    const { db, tables } = tuningDb({ ai_examples: [ex('e1', A)] });
    await updateExample(db, ctx(), 'e1', {
      idealResponse: 'ligue 11 98765-4321',
    });
    expect(tables.ai_examples[0].ideal_response).toBe('ligue [telefone]');
  });

  it('text an admin writes that is too long is an error, never silently cut', async () => {
    const { db, tables } = tuningDb({ ai_examples: [ex('e1', A)] });
    await expect(
      createManualExample(db, ctx(), {
        customerMessage: 'q',
        idealResponse: 'a'.repeat(2001),
      })
    ).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(
      updateExample(db, ctx(), 'e1', { customerMessage: 'q'.repeat(1001) })
    ).rejects.toMatchObject({ code: 'invalid_input' });
    expect(tables.ai_examples[0].customer_message).toBe('message e1');
    // At the limit is fine.
    await expect(
      createManualExample(db, ctx(), {
        customerMessage: 'q',
        idealResponse: 'a'.repeat(2000),
      })
    ).resolves.toMatchObject({ status: 'approved' });
  });

  it('rejects empty or missing text', async () => {
    const { db } = tuningDb({ ai_examples: [ex('e1', A)] });
    await expect(
      createManualExample(db, ctx(), {
        customerMessage: ' ',
        idealResponse: 'x',
      })
    ).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(
      updateExample(db, ctx(), 'e1', { customerMessage: '   ' })
    ).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(
      updateExample(db, ctx(), 'e1', { status: 'bogus' })
    ).rejects.toMatchObject({ code: 'invalid_input' });
  });
});

describe('examples — review', () => {
  it('approving embeds the customer message and stamps the reviewer', async () => {
    const { db, tables } = tuningDb({ ai_examples: [ex('e1', A)] });
    const row = await approveExample(db, ctx(), 'e1');
    expect(row.status).toBe('approved');
    expect(row.embedded).toBe(true);
    expect(tables.ai_examples[0].embedding_model).toBe(
      'openai/text-embedding-3-small'
    );
    expect(tables.ai_examples[0].reviewed_by).toBe('user-1');
  });

  it('approving without an embeddings target still approves, but not embedded', async () => {
    const { db } = tuningDb({ ai_examples: [ex('e1', A)] });
    const row = await approveExample(db, ctx(A, null), 'e1');
    expect(row.status).toBe('approved');
    expect(row.embedded).toBe(false);
    expect(h.embedTexts).not.toHaveBeenCalled();
  });

  it('an embedding failure never blocks the approval', async () => {
    h.embedTexts.mockRejectedValue(new Error('provider down'));
    const { db } = tuningDb({ ai_examples: [ex('e1', A)] });
    const row = await approveExample(db, ctx(), 'e1');
    expect(row.status).toBe('approved');
    expect(row.embedded).toBe(false);
  });

  it('rejecting drops the vector: only approved examples are searched', async () => {
    const { db, tables } = tuningDb({
      ai_examples: [
        ex('e1', A, {
          status: 'approved',
          embedding: '[1,2]',
          embedding_model: 'text-embedding-3-small',
        }),
      ],
    });
    const row = await rejectExample(db, ctx(), 'e1');
    expect(row.status).toBe('rejected');
    expect(tables.ai_examples[0].embedding).toBeNull();
    expect(tables.ai_examples[0].embedding_model).toBeNull();
  });

  it('editing the message of an approved example re-embeds it', async () => {
    const { db } = tuningDb({
      ai_examples: [
        ex('e1', A, {
          status: 'approved',
          embedding: '[9,9]',
          embedding_model: 'text-embedding-3-small',
        }),
      ],
    });
    await updateExample(db, ctx(), 'e1', { customerMessage: 'new question' });
    expect(h.embedTexts).toHaveBeenCalledWith(target, ['new question']);
  });

  it('editing only the reply of an approved example does not re-embed', async () => {
    const { db } = tuningDb({
      ai_examples: [
        ex('e1', A, {
          status: 'approved',
          embedding: '[9,9]',
          embedding_model: 'text-embedding-3-small',
        }),
      ],
    });
    await updateExample(db, ctx(), 'e1', { idealResponse: 'better reply' });
    expect(h.embedTexts).not.toHaveBeenCalled();
  });

  it('caps the approved examples per account', async () => {
    const approved = Array.from({ length: 500 }, (_, i) =>
      ex(`a${i}`, A, { status: 'approved' })
    );
    const { db } = tuningDb({ ai_examples: [...approved, ex('c1', A)] });
    await expect(approveExample(db, ctx(), 'c1')).rejects.toMatchObject({
      code: 'limit_reached',
    });
    await expect(
      createManualExample(db, ctx(), {
        customerMessage: 'x',
        idealResponse: 'y',
      })
    ).rejects.toMatchObject({ code: 'limit_reached' });
  });
});

describe('examples — isolation between accounts', () => {
  const seed = () => ({
    ai_examples: [ex('mine', A), ex('theirs', B, { status: 'approved' })],
  });

  it('cannot read, approve, edit or delete another account example', async () => {
    const { db, tables } = tuningDb(seed());
    await expect(approveExample(db, ctx(A), 'theirs')).rejects.toBeInstanceOf(
      TuningError
    );
    await expect(
      updateExample(db, ctx(A), 'theirs', { idealResponse: 'hacked' })
    ).rejects.toMatchObject({ code: 'not_found' });
    await expect(deleteExample(db, A, 'theirs')).rejects.toMatchObject({
      code: 'not_found',
    });
    expect(tables.ai_examples.find((r) => r.id === 'theirs')).toMatchObject({
      ideal_response: 'reply theirs',
      status: 'approved',
    });
  });

  it('list and counts only see the account own rows', async () => {
    const { db } = tuningDb(seed());
    const list = await listExamples(db, A);
    expect(list.examples.map((e) => e.id)).toEqual(['mine']);
    expect(await countExamples(db, A)).toEqual({
      candidate: 1,
      approved: 0,
      rejected: 0,
    });
  });
});

describe('examples — pending embeddings', () => {
  it('embeds approved examples that have none or another model, skips the rest', async () => {
    const { db, tables } = tuningDb({
      ai_examples: [
        ex('none', A, { status: 'approved' }),
        ex('old', A, { status: 'approved', embedding_model: 'other-model' }),
        ex('ok', A, {
          status: 'approved',
          embedding: '[1]',
          embedding_model: 'text-embedding-3-small',
        }),
        ex('cand', A),
        ex('other-account', B, { status: 'approved' }),
      ],
    });
    const result = await embedPendingExamples(db, ctx());
    expect(result).toEqual({ embedded: 2, failed: 0 });
    expect(h.embedTexts).toHaveBeenCalledTimes(2);
    expect(
      tables.ai_examples.find((r) => r.id === 'other-account')!.embedding
    ).toBeNull();
    expect(
      tables.ai_examples.find((r) => r.id === 'cand')!.embedding
    ).toBeNull();
  });

  it('refuses without a target', async () => {
    const { db } = tuningDb({ ai_examples: [] });
    await expect(embedPendingExamples(db, ctx(A, null))).rejects.toMatchObject({
      code: 'ai_not_configured',
    });
  });
});

describe('searchExamples — what reaches the prompt', () => {
  const approvedRow = (id: string, over: Row = {}) =>
    ex(id, A, {
      status: 'approved',
      embedding: '[0.1,0.2]',
      embedding_model: 'openai/text-embedding-3-small',
      ...over,
    });

  // A stand-in for `match_ai_examples` with the SAME rules as the SQL
  // (the SQL itself is checked by scripts/verify-108-ai-tuning.sql):
  // approved only, same model, within the distance ceiling, closest first.
  const rpcOver = (rows: Row[]) => ({
    match_ai_examples: (args: Record<string, unknown>) => {
      const q = [0.1, 0.2];
      const dist = (e: Row) => {
        const v = JSON.parse(e.embedding as string) as number[];
        const dot = v[0] * q[0] + v[1] * q[1];
        const n = Math.hypot(...v) * Math.hypot(...q);
        return 1 - dot / n;
      };
      const data = rows
        .filter(
          (e) =>
            e.account_id === args.p_account_id &&
            e.status === 'approved' &&
            e.embedding &&
            String(e.embedding_model).replace(/^openai\//, '') ===
              String(args.p_embedding_model).replace(/^openai\//, '') &&
            dist(e) <= (args.p_max_distance as number)
        )
        .sort((a, b) => dist(a) - dist(b))
        .slice(0, args.p_match_count as number)
        .map((e) => ({
          id: e.id,
          customer_message: e.customer_message,
          ideal_response: e.ideal_response,
          distance: dist(e),
        }));
      return { data, error: null };
    },
  });

  it('asks for the 3 closest approved examples with the distance ceiling', async () => {
    const rows = [approvedRow('e1')];
    const { db, rpcCalls } = tuningDb(
      { ai_examples: rows },
      { rpc: rpcOver(rows) }
    );
    await searchExamples(db, A, { embeddingsTarget: target }, 'how much?');
    expect(rpcCalls).toHaveLength(1);
    expect(rpcCalls[0].args).toMatchObject({
      p_account_id: A,
      p_match_count: 3,
      p_max_distance: 0.55,
      p_embedding_model: 'openai/text-embedding-3-small',
    });
  });

  it('returns at most 3, closest first, and never a candidate or rejected one', async () => {
    const mk = (id: string, vec: string, status = 'approved') =>
      approvedRow(id, { embedding: vec, status });
    const rows = [
      mk('far', '[0,1]'),
      mk('c1', '[0.1,0.2]', 'candidate'),
      mk('r1', '[0.1,0.2]', 'rejected'),
      mk('best', '[0.1,0.2]'),
      mk('near2', '[0.11,0.2]'),
      mk('near3', '[0.1,0.21]'),
      mk('near4', '[0.12,0.19]'),
    ];
    const { db } = tuningDb({ ai_examples: rows }, { rpc: rpcOver(rows) });
    const hits = await retrieveExamples(
      db,
      A,
      { embeddingsTarget: target },
      'how much?'
    );
    expect(hits).toHaveLength(3);
    expect(hits[0].id).toBe('best');
    const ids = hits.map((h2) => h2.id);
    expect(ids).not.toContain('c1');
    expect(ids).not.toContain('r1');
    expect(ids).not.toContain('far'); // beyond the distance ceiling
  });

  it('never returns another account example', async () => {
    const rows = [
      approvedRow('mine'),
      { ...approvedRow('theirs'), account_id: B },
    ];
    const { db } = tuningDb({ ai_examples: rows }, { rpc: rpcOver(rows) });
    const hits = await retrieveExamples(
      db,
      A,
      { embeddingsTarget: target },
      'q'
    );
    expect(hits.map((e) => e.id)).toEqual(['mine']);
  });

  it('an account without approved examples pays no embedding and no RPC', async () => {
    const { db, rpcCalls } = tuningDb({ ai_examples: [ex('c', A)] });
    const result = await searchExamples(
      db,
      A,
      { embeddingsTarget: target },
      'q'
    );
    expect(result).toMatchObject({ none: true, failed: false, examples: [] });
    expect(h.embedTexts).not.toHaveBeenCalled();
    expect(rpcCalls).toHaveLength(0);
  });

  it('without an embeddings target: zero examples, flagged as failed, no throw', async () => {
    const { db } = tuningDb({ ai_examples: [approvedRow('e1')] });
    const result = await searchExamples(db, A, { embeddingsTarget: null }, 'q');
    expect(result).toMatchObject({ examples: [], failed: true });
  });

  it('every failure gives zero examples and never throws', async () => {
    // embedding failure
    h.embedTexts.mockRejectedValue(new Error('down'));
    const rows = [approvedRow('e1')];
    const t1 = tuningDb({ ai_examples: rows }, { rpc: rpcOver(rows) });
    expect(
      await retrieveExamples(t1.db, A, { embeddingsTarget: target }, 'q')
    ).toEqual([]);
    // RPC error
    h.embedTexts.mockResolvedValue([[0.1, 0.2]]);
    const t2 = tuningDb(
      { ai_examples: rows },
      {
        rpc: {
          match_ai_examples: () => ({ data: null, error: { message: 'x' } }),
        },
      }
    );
    expect(
      await retrieveExamples(t2.db, A, { embeddingsTarget: target }, 'q')
    ).toEqual([]);
    // table missing / database failure on the count
    const t3 = tuningDb({}, { failOn: ['ai_examples'] });
    expect(
      await retrieveExamples(t3.db, A, { embeddingsTarget: target }, 'q')
    ).toEqual([]);
    // client that throws
    const throwing = {
      from: () => {
        throw new Error('boom');
      },
    } as never;
    expect(
      await retrieveExamples(throwing, A, { embeddingsTarget: target }, 'q')
    ).toEqual([]);
  });

  it('an empty query searches nothing', async () => {
    const { db, rpcCalls } = tuningDb({ ai_examples: [approvedRow('e1')] });
    const r = await searchExamples(db, A, { embeddingsTarget: target }, '   ');
    expect(r.none).toBe(true);
    expect(rpcCalls).toHaveLength(0);
  });
});

describe('searchExamples — a member whose RLS hides ai_examples (agent role)', () => {
  it('still finds the account examples: the existence check uses the service role', async () => {
    // The agent's RLS client sees no row of ai_examples (admin+ only)...
    const rpcRows = [
      {
        id: 'e1',
        customer_message: 'how much?',
        ideal_response: 'R$ 129,00',
        distance: 0.1,
      },
    ];
    const agent = tuningDb(
      { ai_examples: [] },
      { rpc: { match_ai_examples: () => ({ data: [], error: null }) } }
    );
    // ...while the service role sees the account's approved example. Since
    // SPEC 089 F8 (migration 110) the RPC answers an admin SESSION only, so
    // the engine calls it with the service role too.
    const admin = tuningDb(
      {
        ai_examples: [
          {
            id: 'e1',
            account_id: A,
            status: 'approved',
            embedding_model: 'openai/text-embedding-3-small',
          },
        ],
      },
      { rpc: { match_ai_examples: () => ({ data: rpcRows, error: null }) } }
    );
    h.admin = admin.db;
    const hits = await retrieveExamples(
      agent.db,
      A,
      { embeddingsTarget: target },
      'how much?'
    );
    expect(hits.map((e) => e.id)).toEqual(['e1']);
    // The RPC runs on the service role (the agent's session would be refused
    // by the admin guard of migration 110), scoped to the account id the
    // engine passes.
    expect(admin.rpcCalls).toHaveLength(1);
    expect(agent.rpcCalls).toHaveLength(0);
  });

  it('the existence check is still scoped to the account', async () => {
    const admin = tuningDb({
      ai_examples: [
        {
          id: 'x',
          account_id: B,
          status: 'approved',
          embedding_model: 'text-embedding-3-small',
        },
      ],
    });
    h.admin = admin.db;
    const agent = tuningDb({ ai_examples: [] });
    const r = await searchExamples(
      agent.db,
      A,
      { embeddingsTarget: target },
      'q'
    );
    expect(r.none).toBe(true);
    expect(agent.rpcCalls).toHaveLength(0);
  });
});
