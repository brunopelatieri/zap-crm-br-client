import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({ recordActivity: vi.fn() }));
vi.mock('@/lib/activity/record', () => ({ recordActivity: h.recordActivity }));
// The draft audits through the service role (SPEC 089 F6); no real client here.
vi.mock('../admin-client', () => ({ supabaseAdmin: () => ({ rpc: vi.fn() }) }));

import { createToolAudit, AI_ACTOR_NAME } from './audit';
import { buildToolContext } from './context';
import {
  auditInputFor,
  maskForAudit,
  maskPiiText,
  summarizeForAudit,
  summarizeShape,
} from './mask';
import { fakeDb, type Row } from './test-fake-db';

const ACCT = 'aaaaaaaa-0000-4000-8000-000000000001';
const CONV = 'aaaaaaaa-2222-4000-8000-000000000001';
const CONTACT = 'aaaaaaaa-1111-4000-8000-000000000001';

type Outcome = {
  outcome: string;
  call_id: string | null;
  used?: number;
  limit?: number | null;
};

function setup(claim: Outcome | { error: string } | Error) {
  const { db, rpcCalls } = fakeDb(
    {},
    {
      rpc: {
        claim_ai_tool_call: () => {
          if (claim instanceof Error) throw claim;
          if ('error' in claim)
            return { data: null, error: { message: claim.error } };
          return { data: [claim], error: null };
        },
        finish_ai_tool_call: () => ({ data: true, error: null }),
      },
    }
  );
  const audit = createToolAudit({
    db,
    accountId: ACCT,
    conversationId: CONV,
    mode: 'auto_reply',
    turnId: 'turn-9',
    contactId: CONTACT,
  });
  return { audit, rpcCalls };
}

beforeEach(() => h.recordActivity.mockReset());

describe('createToolAudit.begin', () => {
  it('claims atomically through the RPC with the account, conversation, a per-turn key and the write cap', async () => {
    const { audit, rpcCalls } = setup({ outcome: 'claimed', call_id: 'row-1' });
    const r = await audit.begin({
      tool: 'add_contact_tags',
      risk: 'write',
      callId: 'call_1',
      input: { tags: ['VIP'] },
    });
    expect(r).toEqual({ ok: true, id: 'row-1' });
    expect(rpcCalls[0]).toEqual({
      name: 'claim_ai_tool_call',
      args: {
        p_account_id: ACCT,
        p_conversation_id: CONV,
        p_mode: 'auto_reply',
        p_tool: 'add_contact_tags',
        p_risk: 'write',
        p_call_key: 'turn-9:call_1',
        p_input: { tags: ['VIP'] },
        p_max_writes: 10,
      },
    });
    // No contact id is sent: the database takes it from the conversation row.
    expect(Object.keys(rpcCalls[0].args)).not.toContain('p_contact_id');
  });

  it('stores personal data masked, never raw', async () => {
    const { audit, rpcCalls } = setup({ outcome: 'claimed', call_id: 'row-1' });
    await audit.begin({
      tool: 'update_contact_fields',
      risk: 'write',
      callId: 'c',
      input: {
        name: 'Maria da Silva',
        email: 'maria.silva@exemplo.com.br',
        custom_fields: { CPF: '123.456.789-09', Fone: '+55 (11) 99999-1234' },
      },
    });
    const stored = JSON.stringify(rpcCalls[0].args.p_input);
    expect(stored).not.toContain('maria.silva@exemplo');
    expect(stored).not.toContain('Maria da Silva');
    expect(stored).not.toContain('123.456.789-09');
    expect(stored).not.toContain('99999-1234');
    // The values of the customer's own fields are not stored at all, only
    // the field names and the length of each value.
    expect(stored).toContain('fields_value_length');
  });

  it('turns the database refusals into tool errors the model can read', async () => {
    const cases: [string, string][] = [
      ['write_cap_reached', 'write_limit_reached'],
      ['quota_exceeded', 'quota_exceeded'],
      ['conversation_not_found', 'conversation_not_found'],
      ['duplicate', 'duplicate_call'],
      ['something_new', 'audit_unavailable'],
    ];
    for (const [outcome, error] of cases) {
      const { audit } = setup({ outcome, call_id: null });
      expect(
        await audit.begin({ tool: 't', risk: 'write', callId: 'c', input: {} }),
        outcome
      ).toEqual({ ok: false, error });
    }
  });

  it('fails CLOSED for a write and OPEN for a read when the audit is unavailable (RPC error, throw, empty)', async () => {
    for (const claim of [
      { error: 'function does not exist' },
      new Error('network'),
    ]) {
      const { audit } = setup(claim);
      expect(
        await audit.begin({ tool: 't', risk: 'write', callId: 'c', input: {} })
      ).toEqual({ ok: false, error: 'audit_unavailable' });
      expect(
        await audit.begin({ tool: 't', risk: 'read', callId: 'c', input: {} })
      ).toEqual({ ok: true, id: null });
    }
  });
});

describe('createToolAudit.finish', () => {
  it('closes the row and records the activity of a successful write as the system actor', async () => {
    const { audit, rpcCalls } = setup({ outcome: 'claimed', call_id: 'row-1' });
    await audit.finish('row-1', {
      status: 'ok',
      outputSummary: 'done',
      durationMs: 12.4,
      activity: {
        action: 'ai.tool_tags_added',
        label: 'VIP',
        metadata: { tags: ['VIP'] },
      },
    });
    expect(rpcCalls[0]).toEqual({
      name: 'finish_ai_tool_call',
      args: {
        p_call_id: 'row-1',
        p_status: 'ok',
        p_error_code: null,
        p_output_summary: 'done',
        p_duration_ms: 12,
      },
    });
    expect(h.recordActivity).toHaveBeenCalledTimes(1);
    expect(h.recordActivity.mock.calls[0][1]).toMatchObject({
      accountId: ACCT,
      action: 'ai.tool_tags_added',
      resourceType: 'ai',
      actor: { kind: 'system', name: AI_ACTOR_NAME },
      conversationId: CONV,
      contactId: CONTACT,
      source: { table: 'ai_tool_calls', id: 'row-1' },
    });
  });

  it('an error or timeout writes no activity line', async () => {
    const { audit } = setup({ outcome: 'claimed', call_id: 'row-1' });
    await audit.finish('row-1', {
      status: 'error',
      errorCode: 'tag_not_allowed',
      outputSummary: '',
      durationMs: 1,
      activity: { action: 'ai.tool_tags_added' },
    });
    expect(h.recordActivity).not.toHaveBeenCalled();
  });

  it('never throws, whatever the database does', async () => {
    const { audit } = setup(new Error('x'));
    const { db } = fakeDb(
      {},
      {
        rpc: {
          finish_ai_tool_call: () => {
            throw new Error('down');
          },
        },
      }
    );
    const broken = createToolAudit({
      db,
      accountId: ACCT,
      conversationId: CONV,
      mode: 'auto_reply',
      turnId: 't',
      contactId: null,
    });
    await expect(
      broken.finish('row', { status: 'ok', outputSummary: '', durationMs: 1 })
    ).resolves.toBeUndefined();
    await expect(
      audit.finish(null, { status: 'ok', outputSummary: '', durationMs: 1 })
    ).resolves.toBeUndefined();
  });
});

describe('buildToolContext attaches the audit only to REAL calls', () => {
  const seed = (): Record<string, Row[]> => ({
    conversations: [{ id: CONV, account_id: ACCT, contact_id: CONTACT }],
  });
  const args = {
    accountId: ACCT,
    conversationId: CONV,
    toolsConfig: {},
    aiConfig: { embeddingsTarget: null },
  };

  it('auto-reply: audited, with a turn id and an empty turn state', async () => {
    const { db } = fakeDb(seed());
    const ctx = await buildToolContext({ ...args, db, mode: 'auto_reply' });
    expect(ctx?.audit).toBeDefined();
    expect(ctx?.turnId).toMatch(/^[0-9a-f-]{36}$/);
    expect(ctx?.turnState).toEqual({});
  });

  it('playground and eval: no audit (nothing is called)', async () => {
    for (const mode of ['playground', 'eval'] as const) {
      const { db } = fakeDb(seed());
      const ctx = await buildToolContext({
        ...args,
        db,
        mode,
        conversationId: mode === 'playground' ? null : CONV,
      });
      expect(ctx?.audit, mode).toBeUndefined();
    }
  });

  it('draft: has the audit (F6: only an `external` HTTP tool uses it), through the service role', async () => {
    const { db } = fakeDb(seed());
    const ctx = await buildToolContext({ ...args, db, mode: 'draft' });
    expect(ctx?.audit).toBeDefined();
    expect(ctx?.dryRun).toBe(true);
  });
});

describe('masking (SPEC 089 §8)', () => {
  it('masks e-mails, CPF, CNPJ and phone numbers inside free text', () => {
    const out = maskPiiText(
      'Fale com joao@x.com, CPF 123.456.789-09, CNPJ 12.345.678/0001-90, tel +55 11 98888-7777'
    );
    expect(out).not.toMatch(/joao@x|123\.456|12\.345|98888/);
    expect(out).toContain('j***@x***.com');
    expect(out).toContain('***.***.***-**');
    expect(out).toContain('**.***.***/****-**');
    expect(out).toContain('tel ***');
    // Nothing of the numbers survives, not even the last two digits.
    expect(out).not.toMatch(/d/);
  });

  it('leaves ordinary numbers and words alone', () => {
    expect(maskPiiText('Plano Pro por R$ 129,00 em 3x')).toBe(
      'Plano Pro por R$ 129,00 em 3x'
    );
  });

  it('bounds depth, size and string length of what it stores', () => {
    const deep = { a: { b: { c: { d: { e: 'x' } } } } };
    expect(JSON.stringify(maskForAudit(deep))).toContain('[…]');
    const long = maskForAudit({ blob: 'a'.repeat(1000) }) as { blob: string };
    expect(long.blob.length).toBeLessThanOrEqual(201);
    expect(
      summarizeForAudit({ big: 'z'.repeat(2000) }).length
    ).toBeLessThanOrEqual(500);
    expect(maskForAudit(undefined)).toBeNull();
  });
});

describe('what the audit keeps of an input (adversarial review of F5)', () => {
  it('never stores the VALUES of the customer data a tool writes: names and lengths only', () => {
    const stored = JSON.stringify(
      auditInputFor('update_contact_fields', {
        name: 'Maria Aparecida da Silva',
        email: 'maria@x.com',
        custom_fields: {
          'Nome da mae': 'Ana Souza',
          'joao@x.com cpf 123.456.789-00': 'x',
        },
      })
    );
    expect(stored).not.toMatch(/Maria|Aparecida|Ana Souza|maria@x/);
    expect(stored).not.toContain('joao@x.com');
    expect(stored).not.toContain('123.456.789-00');
    expect(stored).toContain('Nome da mae');
    expect(JSON.parse(stored)).toMatchObject({
      fields_value_length: { name: 24, email: 11, 'Nome da mae': 9 },
    });
  });

  it('a note is stored as its length; a handoff keeps only the lengths of reason and summary', () => {
    expect(
      auditInputFor('add_internal_note', { note: 'Cliente tem HIV' })
    ).toEqual({ note_length: 15 });
    expect(
      auditInputFor('handoff_to_human', {
        reason: 'wants a person, call 11 98888-7777',
        summary: 'long private story',
      })
    ).toEqual({ reason_length: 34, summary_length: 18 });
  });

  it("tag and funnel names (the account's own catalog) are kept, masked", () => {
    expect(auditInputFor('add_contact_tags', { tags: ['VIP'] })).toEqual({
      tags: ['VIP'],
    });
  });

  it('summarizeShape keeps keys, counts and lengths — never values', () => {
    const s = summarizeShape({
      deals: [{ title: 'Segredo' }, { title: 'X' }],
      name: 'Zé',
      nested: { a: { b: { c: 1 } } },
    });
    expect(s).toContain('deals: list(2)');
    expect(s).toContain('name: text(2)');
    expect(s).not.toContain('Segredo');
    expect(summarizeShape('x'.repeat(2000)).length).toBeLessThanOrEqual(500);
  });
});

describe('masking keeps identifiers (adversarial review of F5)', () => {
  it('a UUID is not mistaken for a phone number', () => {
    const id = 'aaaaaaaa-0000-4000-8000-000000000001';
    expect(summarizeForAudit({ deal_id: id })).toContain(id);
    expect(maskPiiText('deal ' + id + ' for 11 98888-7777')).toBe(
      'deal ' + id + ' for ***'
    );
  });

  it('search_knowledge audits the length of the query, not its text', () => {
    expect(
      auditInputFor('search_knowledge', {
        query: 'tenho diabetes e preciso do plano',
      })
    ).toEqual({
      query_length: 33,
    });
  });
});

describe('free text in the audit keeps length only (LGPD review)', () => {
  const NAME_ADDRESS = 'Pedido Joana Prado - Av. Brasil 500';

  it('create_deal: the title is stored as its length; funnel, stage and value stay', () => {
    const stored = auditInputFor('create_deal', {
      title: NAME_ADDRESS,
      pipeline: 'Vendas',
      stage: 'Novo',
      value: 500,
    });
    expect(stored).toEqual({
      title_length: NAME_ADDRESS.length,
      pipeline: 'Vendas',
      stage: 'Novo',
      value: 500,
    });
    expect(JSON.stringify(stored)).not.toMatch(/Joana|Prado|Brasil/);
  });

  it('handoff_to_human: reason and summary are stored as lengths', () => {
    const stored = auditInputFor('handoff_to_human', {
      reason: 'Joana Prado, Rua das Flores 12, quer falar',
      summary: 'x',
    });
    expect(stored).toEqual({ reason_length: 42, summary_length: 1 });
  });

  it('a title, reason, summary or note under any other tool is also reduced to a length', () => {
    const stored = JSON.stringify(
      maskForAudit({ title: NAME_ADDRESS, summary: 'Joana Prado' })
    );
    expect(stored).not.toMatch(/Joana|Prado|Brasil/);
    expect(JSON.parse(stored)).toEqual({
      title: { length: NAME_ADDRESS.length },
      summary: { length: 11 },
    });
  });

  it('what the model typed in a refusal (the field it asked for) is a length, not text', () => {
    const out = summarizeForAudit({
      error: 'field_not_allowed',
      refused: [{ field: 'Joana Prado', reason: 'field_not_allowed' }],
    });
    expect(out).not.toMatch(/Joana|Prado/);
    expect(out).toContain('field_not_allowed');
  });

  it('phone, CEP and card in free text leave no digit at all', () => {
    const out = maskPiiText(
      'tel 11 98888-7777, CEP 01310-100, cartão 4111 1111 1111 1111'
    );
    expect(out).toBe('tel ***, CEP ***, cartão ***');
  });

  it('a street address and a licence plate in free text are masked', () => {
    const out = maskPiiText(
      'entregar na Rua das Flores, 123, apto 45; carro BRA2E19 e ABC-1234'
    );
    expect(out).not.toMatch(/Flores|123|apto|BRA2E19|ABC-1234/);
    expect(out).toContain('[endereço]');
    expect(out).toContain('[placa]');
    expect(maskPiiText(out)).toBe(out);
  });

  it('a UUID next to an address stays whole', () => {
    const id = 'aaaaaaaa-0000-4000-8000-000000000001';
    expect(maskPiiText(`deal ${id} em Av. Paulista 1578`)).toBe(
      `deal ${id} em [endereço]`
    );
  });
});
