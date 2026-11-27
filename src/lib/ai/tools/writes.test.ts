import { describe, it, expect } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  addContactTagsTool,
  removeContactTagsTool,
  updateContactFieldsTool,
} from './contact-writes';
import {
  createDealTool,
  dealDedupeKey,
  moveDealStageTool,
} from './deal-writes';
import { addInternalNoteTool, handoffToHumanTool } from './note-handoff';
import { fakeDb, untouchableDb, type Row } from './test-fake-db';
import type { AgentTool, ToolAudit, ToolContext, ToolsConfig } from './types';

// SPEC 089 F5: the write handlers against an in-memory database with TWO
// accounts. Each test proves a write stays inside the account, the
// conversation's contact and the admin's allow-list — and that a refusal
// writes nothing.

const A = 'aaaaaaaa-0000-4000-8000-000000000001';
const B = 'bbbbbbbb-0000-4000-8000-000000000002';
const CONTACT_A = 'aaaaaaaa-1111-4000-8000-000000000001';
const CONTACT_A2 = 'aaaaaaaa-1111-4000-8000-000000000009';
const CONTACT_B = 'bbbbbbbb-1111-4000-8000-000000000002';
const CONV_A = 'aaaaaaaa-2222-4000-8000-000000000001';

const T_VIP = 'aaaaaaaa-5555-4000-8000-000000000001';
const T_LEAD = 'aaaaaaaa-5555-4000-8000-000000000002';
const T_INTERNAL = 'aaaaaaaa-5555-4000-8000-000000000003';
const T_VIP_B = 'bbbbbbbb-5555-4000-8000-000000000004';

const F_CPF = 'aaaaaaaa-3333-4000-8000-000000000001';
const F_PLAN = 'aaaaaaaa-3333-4000-8000-000000000002';
const F_SECRET = 'aaaaaaaa-3333-4000-8000-000000000003';
const F_CPF_B = 'bbbbbbbb-3333-4000-8000-000000000004';

const P_SALES = 'aaaaaaaa-4444-4000-8000-000000000001';
const P_SUPPORT = 'aaaaaaaa-4444-4000-8000-000000000002';
const P_B = 'bbbbbbbb-4444-4000-8000-000000000003';
const S_NEW = 'aaaaaaaa-6666-4000-8000-000000000001';
const S_PROPOSAL = 'aaaaaaaa-6666-4000-8000-000000000002';
const S_WON = 'aaaaaaaa-6666-4000-8000-000000000003';
const S_OPEN = 'aaaaaaaa-6666-4000-8000-000000000004';
const S_B = 'bbbbbbbb-6666-4000-8000-000000000005';

const DEAL_OK = '11111111-1111-4111-8111-111111111111';
const DEAL_OTHER_CONTACT = '22222222-2222-4222-8222-222222222222';
const DEAL_B = '33333333-3333-4333-8333-333333333333';
const DEAL_WON = '44444444-4444-4444-8444-444444444444';
const DEAL_SUPPORT = '55555555-5555-4555-8555-555555555555';
const DEAL_IN_WON_STAGE = '66666666-6666-4666-8666-666666666666';

function seed(): Record<string, Row[]> {
  return {
    accounts: [
      { id: A, default_currency: 'BRL', owner_user_id: 'owner-a' },
      { id: B, default_currency: 'USD', owner_user_id: 'owner-b' },
    ],
    contacts: [
      { id: CONTACT_A, account_id: A, name: 'Ana', email: 'ana@a.test' },
      { id: CONTACT_A2, account_id: A, name: 'Outra', email: 'o@a.test' },
      { id: CONTACT_B, account_id: B, name: 'Bruno', email: 'b@b.test' },
    ],
    tags: [
      { id: T_VIP, account_id: A, name: 'VIP' },
      { id: T_LEAD, account_id: A, name: 'Lead' },
      { id: T_INTERNAL, account_id: A, name: 'Interno' },
      // Another account has a tag with the SAME name.
      { id: T_VIP_B, account_id: B, name: 'VIP' },
    ],
    contact_tags: [
      { contact_id: CONTACT_A, tag_id: T_LEAD },
      { contact_id: CONTACT_A2, tag_id: T_LEAD },
    ],
    custom_fields: [
      { id: F_CPF, account_id: A, field_name: 'CPF' },
      { id: F_PLAN, account_id: A, field_name: 'Plano' },
      { id: F_SECRET, account_id: A, field_name: 'Segredo' },
      { id: F_CPF_B, account_id: B, field_name: 'CPF' },
    ],
    contact_custom_values: [],
    contact_notes: [],
    pipelines: [
      { id: P_SALES, account_id: A, name: 'Vendas' },
      { id: P_SUPPORT, account_id: A, name: 'Suporte' },
      { id: P_B, account_id: B, name: 'Vendas' },
    ],
    pipeline_stages: [
      { id: S_NEW, pipeline_id: P_SALES, name: 'Novo', position: 0 },
      { id: S_PROPOSAL, pipeline_id: P_SALES, name: 'Proposta', position: 1 },
      { id: S_WON, pipeline_id: P_SALES, name: 'Ganho', position: 2 },
      { id: S_OPEN, pipeline_id: P_SUPPORT, name: 'Aberto', position: 0 },
      { id: S_B, pipeline_id: P_B, name: 'Novo', position: 0 },
    ],
    deals: [
      deal(DEAL_OK, A, CONTACT_A, P_SALES, S_NEW, 'Plano Pro'),
      deal(DEAL_OTHER_CONTACT, A, CONTACT_A2, P_SALES, S_NEW, 'Do outro'),
      deal(DEAL_B, B, CONTACT_B, P_B, S_B, 'Do B'),
      deal(DEAL_WON, A, CONTACT_A, P_SALES, S_NEW, 'Fechado', 'won'),
      deal(DEAL_SUPPORT, A, CONTACT_A, P_SUPPORT, S_OPEN, 'Chamado'),
      deal(DEAL_IN_WON_STAGE, A, CONTACT_A, P_SALES, S_WON, 'Ja ganho'),
    ],
  };
}

function deal(
  id: string,
  account: string,
  contact: string,
  pipeline: string,
  stage: string,
  title: string,
  status = 'open'
): Row {
  return {
    id,
    account_id: account,
    contact_id: contact,
    pipeline_id: pipeline,
    stage_id: stage,
    title,
    status,
  };
}

const okAudit: ToolAudit = {
  begin: async () => ({ ok: true, id: 'audit-1' }),
  finish: async () => {},
};

function ctxFor(
  db: SupabaseClient,
  toolsConfig: ToolsConfig,
  over: Partial<ToolContext> = {}
): ToolContext {
  return {
    db,
    accountId: A,
    conversationId: CONV_A,
    contactId: CONTACT_A,
    mode: 'auto_reply',
    dryRun: false,
    toolsConfig,
    aiConfig: { embeddingsTarget: null },
    turnId: 'turn-1',
    turnState: {},
    audit: okAudit,
    ...over,
  };
}

async function run(
  tool: AgentTool<never> | AgentTool<unknown>,
  input: unknown,
  ctx: ToolContext
) {
  const t = tool as AgentTool<unknown>;
  const parsed = t.parse(input);
  if (!parsed.ok) throw new Error(`parse failed: ${parsed.error}`);
  return t.handler(ctx, parsed.value);
}

describe('add_contact_tags / remove_contact_tags', () => {
  const cfg: ToolsConfig = {
    add_contact_tags: { enabled: true, tagIds: [T_VIP, T_LEAD] },
    remove_contact_tags: { enabled: true, tagIds: [T_VIP, T_LEAD] },
  };

  it('applies only allowed tags of THIS account, to the contact of the context', async () => {
    const { db, writes } = fakeDb(seed());
    const r = await run(
      addContactTagsTool,
      { tags: ['vip', 'Interno', 'inexistente'], contact_id: CONTACT_B },
      ctxFor(db, cfg)
    );
    expect(r).toMatchObject({
      ok: true,
      data: {
        status: 'ok',
        applied: ['VIP'],
        refused: ['Interno', 'inexistente'],
      },
      activity: { action: 'ai.tool_tags_added' },
    });
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({
      table: 'contact_tags',
      op: 'upsert',
      values: { contact_id: CONTACT_A, tag_id: T_VIP },
    });
    // Never the other account's tag of the same name.
    expect(JSON.stringify(writes)).not.toContain(T_VIP_B);
  });

  it('a tag that exists but is not on the list is refused like one that does not exist', async () => {
    const { db, writes } = fakeDb(seed());
    const a = await run(
      addContactTagsTool,
      { tags: ['Interno'] },
      ctxFor(db, cfg)
    );
    const b = await run(
      addContactTagsTool,
      { tags: ['nada'] },
      ctxFor(db, cfg)
    );
    expect(a).toMatchObject({ ok: false, error: 'tag_not_allowed' });
    expect(b).toEqual(a);
    expect(writes).toHaveLength(0);
  });

  it('fail-closed: no allow-list means nothing may be tagged', async () => {
    const { db, writes } = fakeDb(seed());
    for (const config of [
      {},
      { add_contact_tags: { enabled: true } },
      { add_contact_tags: { enabled: true, tagIds: [] } },
    ] as ToolsConfig[]) {
      const r = await run(
        addContactTagsTool,
        { tags: ['VIP'] },
        ctxFor(db, config)
      );
      expect(r).toMatchObject({ ok: false, error: 'tag_not_allowed' });
    }
    expect(writes).toHaveLength(0);
  });

  it("an allow-list that holds ANOTHER account's tag id resolves to nothing", async () => {
    const { db, writes } = fakeDb(seed());
    const r = await run(
      addContactTagsTool,
      { tags: ['VIP'] },
      ctxFor(db, { add_contact_tags: { enabled: true, tagIds: [T_VIP_B] } })
    );
    expect(r).toMatchObject({ ok: false, error: 'tag_not_allowed' });
    expect(writes).toHaveLength(0);
  });

  it('remove deletes only the contact of the context', async () => {
    const { db, writes, tables } = fakeDb(seed());
    const r = await run(
      removeContactTagsTool,
      { tags: ['lead'] },
      ctxFor(db, cfg)
    );
    expect(r).toMatchObject({
      ok: true,
      activity: { action: 'ai.tool_tags_removed' },
    });
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ table: 'contact_tags', op: 'delete' });
    expect(tables.contact_tags).toEqual([
      { contact_id: CONTACT_A2, tag_id: T_LEAD },
    ]);
  });

  it('refuses when the context contact is not in the account (nothing written)', async () => {
    const { db, writes } = fakeDb(seed());
    const r = await run(
      addContactTagsTool,
      { tags: ['VIP'] },
      ctxFor(db, cfg, { contactId: CONTACT_B })
    );
    expect(r).toEqual({ ok: false, error: 'contact_not_found' });
    expect(writes).toHaveLength(0);
  });

  it('dry run lists what would be applied and writes nothing', async () => {
    const { db, writes } = fakeDb(seed());
    const r = await run(
      addContactTagsTool,
      { tags: ['VIP', 'Interno'] },
      ctxFor(db, cfg, { mode: 'playground', dryRun: true, audit: undefined })
    );
    expect(r).toMatchObject({
      ok: true,
      simulated: true,
      data: { would_apply: ['VIP'], refused: ['Interno'] },
    });
    expect(writes).toHaveLength(0);
  });
});

describe('update_contact_fields', () => {
  const cfg: ToolsConfig = {
    update_contact_fields: {
      enabled: true,
      writableFields: ['email', `custom:${F_CPF}`, `custom:${F_PLAN}`],
    },
  };

  it('writes only allowed fields, scoped by account and by the context contact', async () => {
    const { db, writes, tables } = fakeDb(seed());
    const r = await run(
      updateContactFieldsTool,
      { email: 'novo@a.test', company: 'Hack Ltda', account_id: B },
      ctxFor(db, cfg)
    );
    expect(r).toMatchObject({
      ok: true,
      data: {
        updated: ['email'],
        refused: [{ field: 'company', reason: 'field_not_allowed' }],
      },
      activity: { action: 'ai.tool_contact_updated' },
    });
    const update = writes.find((w) => w.op === 'update')!;
    expect(update.table).toBe('contacts');
    expect(update.filters).toEqual(
      expect.arrayContaining([
        { op: 'eq', column: 'id', value: CONTACT_A },
        { op: 'eq', column: 'account_id', value: A },
      ])
    );
    expect(tables.contacts.find((c) => c.id === CONTACT_A)).toMatchObject({
      email: 'novo@a.test',
    });
    expect(
      tables.contacts.find((c) => c.id === CONTACT_A)?.company
    ).toBeUndefined();
    // The other tenant's contact is untouched.
    expect(tables.contacts.find((c) => c.id === CONTACT_B)).toMatchObject({
      email: 'b@b.test',
    });
  });

  it("custom fields resolve by name among THIS account's allowed fields only", async () => {
    const { db, writes } = fakeDb(seed());
    const r = await run(
      updateContactFieldsTool,
      {
        custom_fields: {
          cpf: '123.456.789-09',
          Segredo: 'x',
          Inexistente: 'y',
        },
      },
      ctxFor(db, cfg)
    );
    expect(r).toMatchObject({
      ok: true,
      data: {
        updated: ['CPF'],
        refused: [
          { field: 'Segredo', reason: 'field_not_allowed' },
          { field: 'Inexistente', reason: 'field_not_allowed' },
        ],
      },
    });
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({
      table: 'contact_custom_values',
      op: 'upsert',
      values: [
        {
          contact_id: CONTACT_A,
          custom_field_id: F_CPF,
          value: '123.456.789-09',
        },
      ],
    });
    // Never the same-named field of the other account.
    expect(JSON.stringify(writes)).not.toContain(F_CPF_B);
  });

  it('two allowed fields with the same name are ambiguous, never written at random', async () => {
    const data = seed();
    data.custom_fields.push({ id: F_SECRET, account_id: A, field_name: 'cpf' });
    const { db, writes } = fakeDb(data);
    const r = await run(
      updateContactFieldsTool,
      { custom_fields: { CPF: '1' } },
      ctxFor(db, {
        update_contact_fields: {
          enabled: true,
          writableFields: [`custom:${F_CPF}`, `custom:${F_SECRET}`],
        },
      })
    );
    expect(r).toMatchObject({
      ok: false,
      error: 'field_not_allowed',
      detail: { refused: [{ field: 'CPF', reason: 'ambiguous_field' }] },
    });
    expect(writes).toHaveLength(0);
  });

  it('fail-closed and validated: empty list, bad e-mail', async () => {
    const { db, writes } = fakeDb(seed());
    expect(
      await run(updateContactFieldsTool, { email: 'a@b.co' }, ctxFor(db, {}))
    ).toMatchObject({ ok: false, error: 'field_not_allowed' });
    expect(
      await run(
        updateContactFieldsTool,
        { email: 'not-an-email' },
        ctxFor(db, cfg)
      )
    ).toMatchObject({
      ok: false,
      detail: { refused: [{ reason: 'invalid_value' }] },
    });
    expect(writes).toHaveLength(0);
  });

  it('refuses when the context contact is not in the account (nothing written)', async () => {
    const { db, writes } = fakeDb(seed());
    const r = await run(
      updateContactFieldsTool,
      { email: 'x@y.co' },
      ctxFor(db, cfg, { contactId: CONTACT_B })
    );
    expect(r).toEqual({ ok: false, error: 'contact_not_found' });
    expect(writes).toHaveLength(0);
  });

  it('dry run validates against the lists and writes nothing', async () => {
    const { db, writes } = fakeDb(seed());
    const r = await run(
      updateContactFieldsTool,
      { email: 'x@y.co', company: 'Z' },
      ctxFor(db, cfg, { mode: 'eval', dryRun: true, audit: undefined })
    );
    expect(r).toMatchObject({
      ok: true,
      simulated: true,
      data: { would_update: ['email'] },
    });
    expect(writes).toHaveLength(0);
  });
});

describe('create_deal', () => {
  const cfg: ToolsConfig = {
    create_deal: {
      enabled: true,
      pipelineIds: [P_SALES],
      stageIds: [S_PROPOSAL, S_NEW],
    },
  };

  it('creates in the allowed funnel, first allowed stage by position, for the context contact', async () => {
    const { db, tables } = fakeDb(seed());
    const r = await run(
      createDealTool,
      {
        title: 'Plano Enterprise',
        pipeline: 'vendas',
        value: 500,
        contact_id: CONTACT_B,
      },
      ctxFor(db, cfg)
    );
    expect(r).toMatchObject({
      ok: true,
      data: { status: 'ok', pipeline: 'Vendas', stage: 'Novo' },
      activity: { action: 'ai.tool_deal_created' },
    });
    const created = tables.deals.find((d) => d.title === 'Plano Enterprise')!;
    expect(created).toMatchObject({
      account_id: A,
      contact_id: CONTACT_A,
      pipeline_id: P_SALES,
      stage_id: S_NEW,
      user_id: 'owner-a',
      currency: 'BRL',
      status: 'open',
    });
  });

  // SPEC 089 F8 (migration 110): the look-up cannot stop two turns running
  // at once from both creating the deal; the partial unique index on
  // `deals.ai_dedupe_key` does.
  it('stores the dedupe key and turns the unique-index refusal into duplicate_deal', async () => {
    const unique = {
      deals: {
        columns: ['account_id', 'ai_dedupe_key'],
        where: (r: Record<string, unknown>) => r.status === 'open',
      },
    };
    const { db, tables } = fakeDb(seed(), { unique });
    const first = await run(
      createDealTool,
      { title: 'Plano Enterprise', pipeline: 'vendas' },
      ctxFor(db, cfg)
    );
    expect(first).toMatchObject({ ok: true });
    const created = tables.deals.find((d) => d.title === 'Plano Enterprise')!;
    expect(created.ai_dedupe_key).toBe(
      dealDedupeKey(CONTACT_A, P_SALES, 'Plano Enterprise')
    );
    // No title text in the key.
    expect(String(created.ai_dedupe_key)).not.toMatch(/enterprise/i);

    // A concurrent turn that missed the look-up: simulate it by hiding the
    // first deal from the look-up (status) but not from the index.
    const { db: db2 } = fakeDb(
      {
        ...seed(),
        deals: [
          ...seed().deals,
          { ...created, id: 'concurrent', title: 'other text', status: 'open' },
        ],
      },
      { unique }
    );
    expect(
      await run(
        createDealTool,
        { title: '  plano ENTERPRISE ', pipeline: 'vendas' },
        ctxFor(db2, cfg)
      )
    ).toMatchObject({ ok: false, error: 'duplicate_deal' });
  });

  it('still creates the deal on a database without the column (migration 110 not applied)', async () => {
    const { db, tables } = fakeDb(seed(), {
      missingColumns: { deals: ['ai_dedupe_key'] },
    });
    expect(
      await run(
        createDealTool,
        { title: 'Plano Enterprise', pipeline: 'vendas' },
        ctxFor(db, cfg)
      )
    ).toMatchObject({ ok: true });
    const created = tables.deals.find((d) => d.title === 'Plano Enterprise')!;
    expect(created).not.toHaveProperty('ai_dedupe_key');
  });

  it('refuses a funnel or stage that is not on the lists (and the other account has a funnel with the same name)', async () => {
    const { db, writes } = fakeDb(seed());
    expect(
      await run(
        createDealTool,
        { title: 'x', pipeline: 'Suporte' },
        ctxFor(db, cfg)
      )
    ).toMatchObject({
      ok: false,
      error: 'pipeline_not_allowed',
      detail: { allowed_pipelines: ['Vendas'] },
    });
    expect(
      await run(
        createDealTool,
        { title: 'x', pipeline: 'Vendas', stage: 'Ganho' },
        ctxFor(db, cfg)
      )
    ).toMatchObject({
      ok: false,
      error: 'stage_not_allowed',
      detail: { allowed_stages: ['Novo', 'Proposta'] },
    });
    expect(writes).toHaveLength(0);
  });

  it('fail-closed: a funnel list without a stage list (or the reverse) allows nothing', async () => {
    const { db, writes } = fakeDb(seed());
    for (const config of [
      { create_deal: { enabled: true, pipelineIds: [P_SALES] } },
      { create_deal: { enabled: true, stageIds: [S_NEW] } },
      { create_deal: { enabled: true, pipelineIds: [P_B], stageIds: [S_B] } },
    ] as ToolsConfig[]) {
      const r = await run(
        createDealTool,
        { title: 'x', pipeline: 'Vendas' },
        ctxFor(db, config)
      );
      expect(r).toMatchObject({ ok: false });
    }
    expect(writes).toHaveLength(0);
  });

  it('does not create the same open deal twice', async () => {
    const { db, writes } = fakeDb(seed());
    const r = await run(
      createDealTool,
      { title: 'plano pro', pipeline: 'Vendas' },
      ctxFor(db, cfg)
    );
    expect(r).toMatchObject({
      ok: false,
      error: 'duplicate_deal',
      detail: { deal_id: DEAL_OK },
    });
    expect(writes).toHaveLength(0);
  });

  it('dry run writes nothing; invalid values are refused at parse', async () => {
    const { db, writes } = fakeDb(seed());
    const r = await run(
      createDealTool,
      { title: 'Novo', pipeline: 'Vendas' },
      ctxFor(db, cfg, { mode: 'playground', dryRun: true, audit: undefined })
    );
    expect(r).toMatchObject({
      ok: true,
      simulated: true,
      data: { would_create: { pipeline: 'Vendas', stage: 'Novo' } },
    });
    expect(writes).toHaveLength(0);
    expect(
      createDealTool.parse({ title: 'x', pipeline: 'y', value: -1 })
    ).toEqual({
      ok: false,
      error: 'invalid_value',
    });
    expect(
      createDealTool.parse({ title: 'x', pipeline: 'y', value: 1e12 })
    ).toEqual({ ok: false, error: 'invalid_value' });
  });
});

describe('move_deal_stage', () => {
  const cfg: ToolsConfig = {
    move_deal_stage: {
      enabled: true,
      pipelineIds: [P_SALES],
      stageIds: [S_NEW, S_PROPOSAL],
    },
  };

  it("moves the contact's own open deal between allowed stages, scoped by account, contact and funnel", async () => {
    const { db, writes, tables } = fakeDb(seed());
    const r = await run(
      moveDealStageTool,
      { deal_id: DEAL_OK, stage: 'proposta' },
      ctxFor(db, cfg)
    );
    expect(r).toMatchObject({
      ok: true,
      data: { status: 'ok', from: 'Novo', to: 'Proposta' },
      activity: { action: 'ai.tool_deal_moved' },
    });
    const update = writes.find((w) => w.op === 'update')!;
    expect(update.filters).toEqual(
      expect.arrayContaining([
        { op: 'eq', column: 'id', value: DEAL_OK },
        { op: 'eq', column: 'account_id', value: A },
        { op: 'eq', column: 'contact_id', value: CONTACT_A },
        { op: 'eq', column: 'pipeline_id', value: P_SALES },
      ])
    );
    expect(tables.deals.find((d) => d.id === DEAL_OK)?.stage_id).toBe(
      S_PROPOSAL
    );
  });

  it("never touches another contact's deal, another account's deal, or an unknown id", async () => {
    for (const id of [
      DEAL_OTHER_CONTACT,
      DEAL_B,
      '99999999-9999-4999-8999-999999999999',
    ]) {
      const { db, writes } = fakeDb(seed());
      const r = await run(
        moveDealStageTool,
        { deal_id: id, stage: 'Proposta' },
        ctxFor(db, cfg)
      );
      expect(r, id).toEqual({ ok: false, error: 'deal_not_found' });
      expect(writes, id).toHaveLength(0);
    }
  });

  it('refuses a funnel, a current stage or a target stage outside the lists, and a closed deal', async () => {
    const cases: [string, string, string][] = [
      [DEAL_SUPPORT, 'Aberto', 'deal_not_allowed'],
      [DEAL_WON, 'Proposta', 'deal_not_open'],
      [DEAL_IN_WON_STAGE, 'Novo', 'deal_stage_not_allowed'],
      [DEAL_OK, 'Ganho', 'stage_not_allowed'],
    ];
    for (const [id, stage, error] of cases) {
      const { db, writes } = fakeDb(seed());
      const r = await run(
        moveDealStageTool,
        { deal_id: id, stage },
        ctxFor(db, cfg)
      );
      expect(r, error).toMatchObject({ ok: false, error });
      expect(writes, error).toHaveLength(0);
    }
  });

  it('moving to the stage it is already in is a no-op without a write', async () => {
    const { db, writes } = fakeDb(seed());
    const r = await run(
      moveDealStageTool,
      { deal_id: DEAL_OK, stage: 'Novo' },
      ctxFor(db, cfg)
    );
    expect(r).toMatchObject({ ok: true, data: { unchanged: true } });
    expect(writes).toHaveLength(0);
  });

  it('fail-closed without lists; refuses a malformed id', async () => {
    const { db, writes } = fakeDb(seed());
    expect(
      await run(
        moveDealStageTool,
        { deal_id: DEAL_OK, stage: 'Proposta' },
        ctxFor(db, { move_deal_stage: { enabled: true } })
      )
    ).toEqual({ ok: false, error: 'pipeline_not_allowed' });
    expect(writes).toHaveLength(0);
    expect(moveDealStageTool.parse({ deal_id: 'x', stage: 'y' })).toEqual({
      ok: false,
      error: 'invalid_deal_id',
    });
  });

  it('dry run shows the move and writes nothing', async () => {
    const { db, writes } = fakeDb(seed());
    const r = await run(
      moveDealStageTool,
      { deal_id: DEAL_OK, stage: 'Proposta' },
      ctxFor(db, cfg, { mode: 'playground', dryRun: true, audit: undefined })
    );
    expect(r).toMatchObject({
      ok: true,
      simulated: true,
      data: { would_move: { from: 'Novo', to: 'Proposta' } },
    });
    expect(writes).toHaveLength(0);
  });
});

describe('add_internal_note', () => {
  it('writes a note on the context contact, in the context account, marked as the agent', async () => {
    const { db, tables } = fakeDb(seed());
    const r = await run(
      addInternalNoteTool,
      { note: 'Prefere boleto.', contact_id: CONTACT_B },
      ctxFor(db, { add_internal_note: { enabled: true } })
    );
    expect(r).toMatchObject({
      ok: true,
      activity: { action: 'ai.tool_note_added', metadata: { length: 15 } },
    });
    expect(tables.contact_notes).toEqual([
      expect.objectContaining({
        contact_id: CONTACT_A,
        account_id: A,
        user_id: 'owner-a',
        note_text: '🤖 [AI, unverified] Prefere boleto.',
      }),
    ]);
    // The note text never goes to the activity log.
    expect(JSON.stringify((r as { activity: unknown }).activity)).not.toContain(
      'boleto'
    );
  });

  it('dry run writes nothing and the note is capped at parse', async () => {
    const { db, writes } = fakeDb(seed());
    const r = await run(
      addInternalNoteTool,
      { note: 'x' },
      ctxFor(db, {}, { mode: 'playground', dryRun: true, audit: undefined })
    );
    expect(r).toMatchObject({ ok: true, simulated: true });
    expect(writes).toHaveLength(0);
    expect(addInternalNoteTool.parse({ note: 'a'.repeat(2001) })).toEqual({
      ok: false,
      error: 'note_too_long',
    });
  });
});

describe('handoff_to_human', () => {
  it('records the request in the turn state and ends the turn', async () => {
    const ctx = ctxFor(untouchableDb(), {});
    const r = await run(
      handoffToHumanTool,
      { reason: 'Wants a discount', summary: 'Asked for 15% off.' },
      ctx
    );
    expect(r).toMatchObject({
      ok: true,
      endTurn: 'handoff',
      activity: { action: 'ai.tool_handoff' },
    });
    expect(ctx.turnState.handoff).toEqual({
      reason: 'Wants a discount',
      summary: 'Asked for 15% off.',
    });
  });

  it('the summary defaults to the reason; a dry run simulates and still ends the turn', async () => {
    const ctx = ctxFor(
      untouchableDb(),
      {},
      { mode: 'playground', dryRun: true, audit: undefined }
    );
    const r = await run(handoffToHumanTool, { reason: 'Angry customer' }, ctx);
    expect(r).toMatchObject({ ok: true, simulated: true, endTurn: 'handoff' });
    expect(ctx.turnState.handoff).toEqual({
      reason: 'Angry customer',
      summary: 'Angry customer',
    });
  });
});

describe('every write handler re-checks the mode and the context itself (D-18)', () => {
  const writes: [AgentTool<never> | AgentTool<unknown>, unknown][] = [
    [updateContactFieldsTool, { email: 'a@b.co' }],
    [addContactTagsTool, { tags: ['VIP'] }],
    [removeContactTagsTool, { tags: ['VIP'] }],
    [createDealTool, { title: 'x', pipeline: 'Vendas' }],
    [moveDealStageTool, { deal_id: DEAL_OK, stage: 'Novo' }],
    [addInternalNoteTool, { note: 'x' }],
    [handoffToHumanTool, { reason: 'x' }],
  ];

  it('the draft never writes, even when a caller offers the tool', async () => {
    for (const [tool, input] of writes) {
      const r = await run(
        tool,
        input,
        ctxFor(untouchableDb(), {}, { mode: 'draft', dryRun: false })
      );
      expect(r, tool.key).toEqual({ ok: false, error: 'not_available' });
    }
  });

  it('a real write needs the live auto-reply, a conversation, a contact and the audit', async () => {
    const bad: Partial<ToolContext>[] = [
      { mode: 'playground' },
      { mode: 'eval' },
      { audit: undefined },
      { contactId: null },
      { conversationId: null },
    ];
    for (const over of bad) {
      for (const [tool, input] of writes) {
        const r = await run(tool, input, ctxFor(untouchableDb(), {}, over));
        expect(r, `${tool.key} ${JSON.stringify(Object.keys(over))}`).toEqual({
          ok: false,
          error: 'not_available',
        });
      }
    }
  });

  it('no write schema accepts an account, contact or conversation id', () => {
    for (const [tool] of writes) {
      const t = tool as AgentTool<unknown>;
      expect(
        Object.keys(t.inputSchema.properties).join(','),
        t.key
      ).not.toMatch(/account|contact_id|conversation|user_id/);
    }
  });
});

describe('review fixes (adversarial review of F5)', () => {
  it('update_contact_fields reports PARTIAL when the custom values fail after the contact row landed', async () => {
    const { db, tables } = fakeDb(seed(), {
      failOn: ['contact_custom_values'],
    });
    const r = await run(
      updateContactFieldsTool,
      { email: 'novo@a.test', custom_fields: { CPF: '1' } },
      ctxFor(db, {
        update_contact_fields: {
          enabled: true,
          writableFields: ['email', `custom:${F_CPF}`],
        },
      })
    );
    expect(r).toMatchObject({
      ok: true,
      data: { status: 'partial', updated: ['email'], failed: ['CPF'] },
      activity: { metadata: { fields: ['email'] } },
    });
    expect(tables.contacts.find((c) => c.id === CONTACT_A)).toMatchObject({
      email: 'novo@a.test',
    });
  });

  it('a failure with nothing written is a plain error', async () => {
    const { db } = fakeDb(seed(), { failOn: ['contact_custom_values'] });
    const r = await run(
      updateContactFieldsTool,
      { custom_fields: { CPF: '1' } },
      ctxFor(db, {
        update_contact_fields: {
          enabled: true,
          writableFields: [`custom:${F_CPF}`],
        },
      })
    );
    expect(r).toEqual({ ok: false, error: 'update_failed' });
  });

  it('control characters (NUL) never reach the database or the audit', () => {
    const nul = String.fromCharCode(0);
    const parsed = updateContactFieldsTool.parse({
      company: `Acme${nul} Ltda`,
      custom_fields: { [`CP${nul}F`]: `a${nul}b` },
    });
    expect(parsed).toEqual({
      ok: true,
      value: { company: 'Acme Ltda', custom_fields: { CPF: 'ab' } },
    });
    expect(addInternalNoteTool.parse({ note: `x${nul}y` })).toEqual({
      ok: true,
      value: { note: 'xy' },
    });
  });

  it('move_deal_stage re-checks stage and status inside the UPDATE (a person who closed the deal wins)', async () => {
    const { db, writes } = fakeDb(seed());
    await run(
      moveDealStageTool,
      { deal_id: DEAL_OK, stage: 'Proposta' },
      ctxFor(db, {
        move_deal_stage: {
          enabled: true,
          pipelineIds: [P_SALES],
          stageIds: [S_NEW, S_PROPOSAL],
        },
      })
    );
    const update = writes.find((w) => w.op === 'update')!;
    expect(update.filters).toEqual(
      expect.arrayContaining([
        { op: 'eq', column: 'stage_id', value: S_NEW },
        { op: 'eq', column: 'status', value: 'open' },
      ])
    );
  });
});

describe('activity log keeps no free text (LGPD review)', () => {
  it('create_deal: the label is not the title, even masked; only the length goes in the metadata', async () => {
    const { db } = fakeDb(seed());
    const title = 'Pedido Joana Prado - Av. Brasil 500';
    const r = await run(
      createDealTool,
      { title, pipeline: 'Vendas' },
      ctxFor(db, {
        create_deal: {
          enabled: true,
          pipelineIds: [P_SALES],
          stageIds: [S_NEW],
        },
      })
    );
    const activity = (r as { activity: { label?: string; metadata?: unknown } })
      .activity;
    expect(activity.label).toBeUndefined();
    expect(JSON.stringify(activity)).not.toMatch(/Joana|Prado|Brasil|500/);
    expect(activity.metadata).toMatchObject({ title_length: title.length });
  });

  it('move_deal_stage: the label is not the deal title', async () => {
    const { db, tables } = fakeDb(seed());
    const deal = tables.deals.find((d) => d.id === DEAL_OK)!;
    deal.title = 'Joana Prado - Rua das Flores 12';
    const r = await run(
      moveDealStageTool,
      { deal_id: DEAL_OK, stage: 'proposta' },
      ctxFor(db, {
        move_deal_stage: {
          enabled: true,
          pipelineIds: [P_SALES],
          stageIds: [S_NEW, S_PROPOSAL],
        },
      })
    );
    expect(r).toMatchObject({ ok: true });
    const activity = (r as { activity: { label?: string } }).activity;
    expect(activity.label).toBeUndefined();
    expect(JSON.stringify(activity)).not.toMatch(/Joana|Prado|Flores/);
  });

  it('handoff_to_human: the label is not the reason, even masked; only its length goes in the metadata', async () => {
    const ctx = ctxFor(untouchableDb(), {});
    const reason = 'Joana Prado, Rua das Flores 12, quer falar com gente';
    const r = await run(handoffToHumanTool, { reason }, ctx);
    const activity = (r as { activity: { label?: string; metadata?: unknown } })
      .activity;
    expect(activity.label).toBeUndefined();
    expect(JSON.stringify(activity)).not.toMatch(/Joana|Prado|Flores/);
    expect(activity.metadata).toMatchObject({ reason_length: reason.length });
  });
});
