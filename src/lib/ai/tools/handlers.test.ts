import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

const h = vi.hoisted(() => ({ searchKnowledge: vi.fn() }));
vi.mock('../knowledge', () => ({ searchKnowledge: h.searchKnowledge }));

import { getContactProfileTool } from './contact';
import { listContactDealsTool } from './deals';
import { searchKnowledgeTool } from './knowledge';
import { buildToolContext } from './context';
import { fakeDb, untouchableDb, type Row } from './test-fake-db';
import type { ToolContext, ToolsConfig } from './types';

// SPEC 089 D-16: every tool is bound to the conversation's account and
// contact. These tests seed TWO accounts and prove the handlers never
// return the other tenant's rows, even when the context is pointed at a
// contact of the other account (defense in depth on top of
// `buildToolContext`).

const ACCT_A = 'aaaaaaaa-0000-4000-8000-000000000001';
const ACCT_B = 'bbbbbbbb-0000-4000-8000-000000000002';
const CONTACT_A = 'aaaaaaaa-1111-4000-8000-000000000001';
const CONTACT_B = 'bbbbbbbb-1111-4000-8000-000000000002';
const CONV_A = 'aaaaaaaa-2222-4000-8000-000000000001';
const CONV_B = 'bbbbbbbb-2222-4000-8000-000000000002';
const FIELD_A_CPF = 'aaaaaaaa-3333-4000-8000-000000000001';
const FIELD_A_PLAN = 'aaaaaaaa-3333-4000-8000-000000000002';
const FIELD_B_SECRET = 'bbbbbbbb-3333-4000-8000-000000000003';
const PIPE_A_SALES = 'aaaaaaaa-4444-4000-8000-000000000001';
const PIPE_A_OTHER = 'aaaaaaaa-4444-4000-8000-000000000002';
const PIPE_B = 'bbbbbbbb-4444-4000-8000-000000000003';

function seed(): Record<string, Row[]> {
  return {
    conversations: [
      { id: CONV_A, account_id: ACCT_A, contact_id: CONTACT_A },
      { id: CONV_B, account_id: ACCT_B, contact_id: CONTACT_B },
    ],
    contacts: [
      {
        id: CONTACT_A,
        account_id: ACCT_A,
        name: 'Ana',
        email: 'ana@a.test',
        company: 'A Ltda',
        phone: '5511999990001',
      },
      {
        id: CONTACT_B,
        account_id: ACCT_B,
        name: 'Bruno B',
        email: 'b@b.test',
        company: 'B SA',
        phone: '5511999990002',
      },
    ],
    contact_tags: [
      { contact_id: CONTACT_A, tags: { name: 'vip', account_id: ACCT_A } },
      // A tag row of another account wired to contact A must not leak.
      { contact_id: CONTACT_A, tags: { name: 'leaked-b', account_id: ACCT_B } },
      { contact_id: CONTACT_B, tags: { name: 'b-only', account_id: ACCT_B } },
    ],
    custom_fields: [
      { id: FIELD_A_CPF, account_id: ACCT_A, field_name: 'CPF' },
      { id: FIELD_A_PLAN, account_id: ACCT_A, field_name: 'Plano' },
      { id: FIELD_B_SECRET, account_id: ACCT_B, field_name: 'Segredo' },
    ],
    contact_custom_values: [
      { contact_id: CONTACT_A, custom_field_id: FIELD_A_CPF, value: '123' },
      { contact_id: CONTACT_A, custom_field_id: FIELD_A_PLAN, value: 'Pro' },
      { contact_id: CONTACT_A, custom_field_id: FIELD_B_SECRET, value: 'x' },
    ],
    deals: [
      {
        id: 'deal-a1',
        account_id: ACCT_A,
        contact_id: CONTACT_A,
        pipeline_id: PIPE_A_SALES,
        title: 'Plano Pro',
        value: '129.00',
        currency: 'BRL',
        status: 'active',
        expected_close_date: null,
        pipelines: { name: 'Vendas' },
        pipeline_stages: { name: 'Proposta' },
      },
      {
        id: 'deal-a2',
        account_id: ACCT_A,
        contact_id: CONTACT_A,
        pipeline_id: PIPE_A_OTHER,
        title: 'Outro funil',
        value: 1,
        currency: 'BRL',
        status: 'active',
        expected_close_date: null,
        pipelines: { name: 'Suporte' },
        pipeline_stages: { name: 'Aberto' },
      },
      {
        id: 'deal-b1',
        account_id: ACCT_B,
        contact_id: CONTACT_B,
        pipeline_id: PIPE_B,
        title: 'Do B',
        value: 9,
        currency: 'BRL',
        status: 'active',
        expected_close_date: null,
        pipelines: { name: 'B' },
        pipeline_stages: { name: 'B' },
      },
      // Same contact id under another account: still not ours.
      {
        id: 'deal-b-cross',
        account_id: ACCT_B,
        contact_id: CONTACT_A,
        pipeline_id: PIPE_A_SALES,
        title: 'Cruzado',
        value: 9,
        currency: 'BRL',
        status: 'active',
        expected_close_date: null,
        pipelines: { name: 'X' },
        pipeline_stages: { name: 'X' },
      },
    ],
  };
}

function ctxFor(
  db: SupabaseClient,
  over: Partial<ToolContext> = {},
  toolsConfig: ToolsConfig = {}
): ToolContext {
  return {
    db,
    accountId: ACCT_A,
    conversationId: CONV_A,
    contactId: CONTACT_A,
    mode: 'auto_reply',
    dryRun: false,
    toolsConfig,
    aiConfig: { embeddingsTarget: null },
    turnId: 'turn-1',
    turnState: {},
    ...over,
  };
}

describe('buildToolContext — the contact comes from the conversation row', () => {
  it('takes the contact of a conversation of the account', async () => {
    const { db, calls } = fakeDb(seed());
    const ctx = await buildToolContext({
      db,
      accountId: ACCT_A,
      conversationId: CONV_A,
      mode: 'auto_reply',
      toolsConfig: {},
      aiConfig: { embeddingsTarget: null },
    });
    expect(ctx).toMatchObject({
      accountId: ACCT_A,
      conversationId: CONV_A,
      contactId: CONTACT_A,
      dryRun: false,
    });
    expect(calls[0].filters).toEqual(
      expect.arrayContaining([
        { op: 'eq', column: 'id', value: CONV_A },
        { op: 'eq', column: 'account_id', value: ACCT_A },
      ])
    );
  });

  it("refuses another account's conversation (no tools, never its contact)", async () => {
    const { db } = fakeDb(seed());
    const ctx = await buildToolContext({
      db,
      accountId: ACCT_A,
      conversationId: CONV_B,
      mode: 'draft',
      toolsConfig: {},
      aiConfig: { embeddingsTarget: null },
    });
    expect(ctx).toBeNull();
  });

  it('refuses when a misbehaving client returns a row of another account', async () => {
    const lying = {
      from: () => {
        const chain = {
          select: () => chain,
          eq: () => chain,
          maybeSingle: () =>
            Promise.resolve({
              data: { id: CONV_B, account_id: ACCT_B, contact_id: CONTACT_B },
              error: null,
            }),
        };
        return chain;
      },
    } as unknown as SupabaseClient;
    const ctx = await buildToolContext({
      db: lying,
      accountId: ACCT_A,
      conversationId: CONV_A,
      mode: 'auto_reply',
      toolsConfig: {},
      aiConfig: { embeddingsTarget: null },
    });
    expect(ctx).toBeNull();
  });

  it('playground: no conversation, no contact, dry run, no query', async () => {
    const ctx = await buildToolContext({
      db: untouchableDb(),
      accountId: ACCT_A,
      conversationId: null,
      mode: 'playground',
      toolsConfig: {},
      aiConfig: { embeddingsTarget: null },
    });
    expect(ctx).toMatchObject({
      conversationId: null,
      contactId: null,
      dryRun: true,
    });
  });

  it('only the live auto-reply runs writes for real (D-18)', async () => {
    for (const [mode, dryRun] of [
      ['auto_reply', false],
      ['draft', true],
      ['playground', true],
      ['eval', true],
    ] as const) {
      const ctx = await buildToolContext({
        db: untouchableDb(),
        accountId: ACCT_A,
        conversationId: null,
        mode,
        toolsConfig: {},
        aiConfig: { embeddingsTarget: null },
      });
      expect(ctx?.dryRun, mode).toBe(dryRun);
    }
  });
});

describe('get_contact_profile', () => {
  it('ignores ids the model tries to pass (the input has no fields)', () => {
    expect(
      getContactProfileTool.parse({ contact_id: CONTACT_B, account_id: ACCT_B })
    ).toEqual({ ok: true, value: {} });
    expect(getContactProfileTool.parse('x').ok).toBe(false);
  });

  it('fail-closed: with an empty allow-list only the name is visible', async () => {
    const { db } = fakeDb(seed());
    const r = await getContactProfileTool.handler(ctxFor(db), {});
    expect(r).toEqual({ ok: true, data: { name: 'Ana' } });
  });

  it('shows only allowed fields, tags and custom fields of THIS account', async () => {
    const { db } = fakeDb(seed());
    const cfg: ToolsConfig = {
      get_contact_profile: {
        enabled: true,
        // FIELD_B_SECRET is another account's field: must resolve to nothing.
        visibleFields: [
          'email',
          'tags',
          `custom:${FIELD_A_CPF}`,
          `custom:${FIELD_B_SECRET}`,
        ],
      },
    };
    const r = await getContactProfileTool.handler(ctxFor(db, {}, cfg), {});
    expect(r).toEqual({
      ok: true,
      data: {
        name: 'Ana',
        email: 'ana@a.test',
        tags: ['vip'],
        custom_fields: { CPF: '123' },
      },
    });
    const json = JSON.stringify(r);
    expect(json).not.toContain('leaked-b');
    expect(json).not.toContain('Segredo');
    expect(json).not.toContain('Pro'); // FIELD_A_PLAN not allowed
    expect(json).not.toContain('5511'); // phone not allowed
  });

  it("never returns another account's contact, even if the context points at it", async () => {
    const { db } = fakeDb(seed());
    const r = await getContactProfileTool.handler(
      ctxFor(db, { contactId: CONTACT_B }),
      {}
    );
    expect(r).toEqual({ ok: false, error: 'contact_not_found' });
  });

  it('no contact in the playground', async () => {
    const r = await getContactProfileTool.handler(
      ctxFor(untouchableDb(), {
        contactId: null,
        conversationId: null,
        mode: 'playground',
      }),
      {}
    );
    expect(r).toEqual({ ok: false, error: 'no_contact' });
  });

  it('a database error is a code, not the message', async () => {
    const { db } = fakeDb(seed(), { failOn: ['contacts'] });
    expect(await getContactProfileTool.handler(ctxFor(db), {})).toEqual({
      ok: false,
      error: 'lookup_failed',
    });
  });
});

describe('list_contact_deals', () => {
  it('fail-closed: no allowed funnel = no deals, no query', async () => {
    const { db, calls } = fakeDb(seed());
    const r = await listContactDealsTool.handler(ctxFor(db), {});
    expect(r).toEqual({ ok: true, data: { deals: [] } });
    expect(calls).toHaveLength(0);
  });

  it('only allowed funnels, only this account and contact', async () => {
    const { db, calls } = fakeDb(seed());
    const cfg: ToolsConfig = {
      list_contact_deals: { enabled: true, pipelineIds: [PIPE_A_SALES] },
    };
    const r = await listContactDealsTool.handler(ctxFor(db, {}, cfg), {});
    expect(r).toEqual({
      ok: true,
      data: {
        deals: [
          {
            id: 'deal-a1',
            title: 'Plano Pro',
            value: 129,
            currency: 'BRL',
            status: 'active',
            expected_close_date: null,
            pipeline: 'Vendas',
            stage: 'Proposta',
          },
        ],
      },
    });
    expect(calls[0].filters).toEqual(
      expect.arrayContaining([
        { op: 'eq', column: 'account_id', value: ACCT_A },
        { op: 'eq', column: 'contact_id', value: CONTACT_A },
      ])
    );
  });

  it("returns nothing for another account's contact", async () => {
    const { db } = fakeDb(seed());
    const cfg: ToolsConfig = {
      list_contact_deals: {
        enabled: true,
        pipelineIds: [PIPE_A_SALES, PIPE_B],
      },
    };
    const r = await listContactDealsTool.handler(
      ctxFor(db, { contactId: CONTACT_B }, cfg),
      {}
    );
    expect(r).toEqual({ ok: true, data: { deals: [] } });
  });
});

describe('search_knowledge', () => {
  beforeEach(() => h.searchKnowledge.mockReset());

  it("searches the context's account with the model's query and returns sources apart", async () => {
    h.searchKnowledge.mockResolvedValue({
      hits: [
        {
          chunkId: 'c1',
          documentId: 'd1',
          title: 'Preços',
          heading: 'Planos',
          content: 'Plano Avançado: R$ 129,00',
          score: 0.03,
          distance: 0.3,
          lexicalRank: 0.1,
          origin: 'both',
        },
      ],
      searchFailed: false,
      usedEmbedding: false,
      embeddingFailed: false,
      knowledgeEmpty: false,
    });
    const db = {} as SupabaseClient;
    const parsed = searchKnowledgeTool.parse({
      query: ' preço plano ',
      account_id: ACCT_B,
    });
    expect(parsed).toEqual({ ok: true, value: { query: 'preço plano' } });
    const r = await searchKnowledgeTool.handler(ctxFor(db), {
      query: 'preço plano',
    });
    expect(h.searchKnowledge).toHaveBeenCalledWith(
      db,
      ACCT_A,
      { embeddingsTarget: null },
      'preço plano',
      { k: 3 }
    );
    expect(r).toEqual({
      ok: true,
      data: {
        results: [
          {
            title: 'Preços',
            section: 'Planos',
            excerpt: 'Plano Avançado: R$ 129,00',
          },
        ],
      },
      sources: [
        { chunkId: 'c1', documentId: 'd1', title: 'Preços', score: 0.03 },
      ],
    });
  });

  it('a failed search is an error code; an empty or oversized query is refused', async () => {
    h.searchKnowledge.mockResolvedValue({
      hits: [],
      searchFailed: true,
      usedEmbedding: false,
      embeddingFailed: false,
      knowledgeEmpty: false,
    });
    expect(
      await searchKnowledgeTool.handler(ctxFor({} as SupabaseClient), {
        query: 'x',
      })
    ).toEqual({ ok: false, error: 'search_failed' });
    expect(searchKnowledgeTool.parse({}).ok).toBe(false);
    expect(searchKnowledgeTool.parse({ query: '   ' }).ok).toBe(false);
    expect(searchKnowledgeTool.parse({ query: 'a'.repeat(301) })).toEqual({
      ok: false,
      error: 'query_too_long',
    });
  });
});
