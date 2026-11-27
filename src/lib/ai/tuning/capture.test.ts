import { describe, it, expect, vi } from 'vitest';
import {
  captureAfterSend,
  isFirstHumanReplyAfterHandoff,
  normalizeForCompare,
  registerDraft,
} from './capture';
import { tuningDb, type Row } from './test-db';

const A = 'acct-a';
const B = 'acct-b';
const DRAFT = '11111111-1111-4111-8111-111111111111';
const CONV = 'conv-1';
const NOW = () => new Date().toISOString();

// Synthetic data only.
function world(over: Record<string, Row[]> = {}) {
  return tuningDb(
    {
      conversations: [
        {
          id: CONV,
          account_id: A,
          contact_id: 'ct-1',
          ai_autoreply_disabled: false,
          ai_handoff_summary: null,
        },
        {
          id: 'conv-b',
          account_id: B,
          contact_id: 'ct-b',
          ai_autoreply_disabled: true,
          ai_handoff_summary: 'handoff',
        },
      ],
      contacts: [
        { id: 'ct-1', account_id: A, name: 'Marina Teixeira' },
        { id: 'ct-b', account_id: B, name: 'Outra Pessoa' },
      ],
      messages: [],
      ai_drafts: [],
      ai_examples: [],
      ...over,
    },
    { unique: { ai_examples: [['account_id', 'source_message_id']] } }
  );
}

const draftRow = (over: Row = {}): Row => ({
  id: DRAFT,
  account_id: A,
  conversation_id: CONV,
  user_id: 'u1',
  customer_message: 'quanto custa o plano premium?',
  draft_text: 'O plano premium custa R$ 129,00 por mês.',
  created_at: NOW(),
  ...over,
});

const args = (over: Record<string, unknown> = {}) => ({
  accountId: A,
  userId: 'u1',
  conversationId: CONV,
  messageId: 'msg-1',
  finalText: 'O plano premium sai por R$ 129,00 ao mês, com 7 dias de teste.',
  aiDraftId: DRAFT,
  ...over,
});

describe('captureAfterSend — AI draft edited before sending', () => {
  it('an edited draft becomes a candidate, never approved', async () => {
    const { db, tables } = world({ ai_drafts: [draftRow()] });
    const out = await captureAfterSend(db, args());
    expect(out).toEqual({ kind: 'candidate', source: 'draft_edit' });
    expect(tables.ai_examples).toHaveLength(1);
    expect(tables.ai_examples[0]).toMatchObject({
      account_id: A,
      status: 'candidate',
      source: 'draft_edit',
      customer_message: 'quanto custa o plano premium?',
      ai_draft: 'O plano premium custa R$ 129,00 por mês.',
      source_message_id: 'msg-1',
      conversation_id: CONV,
      created_by: 'u1',
    });
    // Nothing is embedded for a candidate.
    expect(tables.ai_examples[0].embedding).toBeUndefined();
  });

  it('the draft is consumed: the same id cannot capture twice', async () => {
    const { db, tables } = world({ ai_drafts: [draftRow()] });
    await captureAfterSend(db, args());
    expect(tables.ai_drafts).toHaveLength(0);
    const again = await captureAfterSend(db, args({ messageId: 'msg-2' }));
    expect(again.kind).toBe('skipped');
    expect(tables.ai_examples).toHaveLength(1);
  });

  it('sent as written (even with different spacing): nothing to learn', async () => {
    const { db, tables } = world({ ai_drafts: [draftRow()] });
    const out = await captureAfterSend(
      db,
      args({ finalText: '  O plano premium   custa R$ 129,00 por mês.\n' })
    );
    expect(out).toEqual({ kind: 'unedited' });
    expect(tables.ai_examples).toHaveLength(0);
    // The draft is still consumed.
    expect(tables.ai_drafts).toHaveLength(0);
  });

  it('personal data is masked in the captured pair (draft side, human side, contact name)', async () => {
    const { db, tables } = world({
      ai_drafts: [
        draftRow({
          customer_message: 'sou a [nome], meu zap [telefone]',
          draft_text: 'Oi [nome], te ligo em breve.',
        }),
      ],
    });
    await captureAfterSend(
      db,
      args({
        finalText:
          'Oi Marina, anotei seu e-mail marina@exemplo.com e o zap (11) 98765-4321. CPF 529.982.247-25 ok.',
      })
    );
    const row = tables.ai_examples[0];
    expect(row.ideal_response).toBe(
      'Oi [nome], anotei seu e-mail [e-mail] e o zap [telefone]. CPF [cpf] ok.'
    );
    expect(JSON.stringify(row)).not.toMatch(/Marina|marina@|98765|529\.982/);
  });

  it('a draft of another user, another account or another conversation is ignored', async () => {
    for (const draft of [
      draftRow({ user_id: 'u2' }),
      draftRow({ account_id: B }),
      draftRow({ conversation_id: 'conv-other' }),
    ]) {
      const { db, tables } = world({ ai_drafts: [draft] });
      const out = await captureAfterSend(db, args());
      expect(out.kind).toBe('skipped');
      expect(tables.ai_examples).toHaveLength(0);
      // The foreign draft is NOT consumed by this caller.
      expect(tables.ai_drafts).toHaveLength(1);
    }
  });

  it('a stale draft (older than 6 h) is not compared', async () => {
    const old = new Date(Date.now() - 7 * 3600 * 1000).toISOString();
    const { db, tables } = world({
      ai_drafts: [draftRow({ created_at: old })],
    });
    const out = await captureAfterSend(db, args());
    expect(out.kind).toBe('skipped');
    expect(tables.ai_examples).toHaveLength(0);
  });

  it('a malformed draft id is ignored without touching the table', async () => {
    const { db, writes } = world({ ai_drafts: [draftRow()] });
    const out = await captureAfterSend(db, args({ aiDraftId: "x' or 1=1" }));
    expect(out.kind).toBe('skipped');
    expect(writes.filter((w) => w.table === 'ai_drafts')).toHaveLength(0);
  });

  it('a one-word reply teaches nothing', async () => {
    const { db, tables } = world({ ai_drafts: [draftRow()] });
    const out = await captureAfterSend(db, args({ finalText: 'ok' }));
    expect(out).toEqual({ kind: 'skipped', reason: 'too_short' });
    expect(tables.ai_examples).toHaveLength(0);
  });

  it('replaying the same message does not create a second candidate', async () => {
    const { db, tables } = world({
      ai_drafts: [
        draftRow(),
        draftRow({ id: '22222222-2222-4222-8222-222222222222' }),
      ],
    });
    await captureAfterSend(db, args());
    const out = await captureAfterSend(
      db,
      args({ aiDraftId: '22222222-2222-4222-8222-222222222222' })
    );
    expect(out).toEqual({ kind: 'skipped', reason: 'duplicate' });
    expect(tables.ai_examples).toHaveLength(1);
  });

  it('stops capturing when the account is full of unreviewed candidates', async () => {
    const full = Array.from({ length: 200 }, (_, i) => ({
      id: `c${i}`,
      account_id: A,
      status: 'candidate',
    }));
    const { db } = world({ ai_drafts: [draftRow()], ai_examples: full });
    const out = await captureAfterSend(db, args());
    expect(out).toEqual({ kind: 'skipped', reason: 'limit' });
  });
});

describe('captureAfterSend — first human reply after an AI hand-off', () => {
  const handoffWorld = (over: Record<string, Row[]> = {}) =>
    world({
      conversations: [
        {
          id: CONV,
          account_id: A,
          contact_id: 'ct-1',
          ai_autoreply_disabled: true,
          ai_handoff_summary: 'The AI handed this over.',
        },
      ],
      messages: [
        {
          id: 'm1',
          conversation_id: CONV,
          sender_type: 'customer',
          content_type: 'text',
          content_text:
            'quero trocar o tênis, comprei com o cpf 529.982.247-25',
          created_at: '2026-11-20T10:00:00Z',
        },
        {
          id: 'm2',
          conversation_id: CONV,
          sender_type: 'bot',
          ai_generated: true,
          content_type: 'text',
          content_text: 'Vou chamar um atendente.',
          created_at: '2026-11-20T10:00:05Z',
        },
        {
          id: 'm3',
          conversation_id: CONV,
          sender_type: 'agent',
          ai_generated: false,
          content_type: 'text',
          content_text: 'Claro, me passe o número do pedido.',
          created_at: '2026-11-20T10:05:00Z',
        },
      ],
      ...over,
    });

  it('the first human reply is a handoff_reply candidate with the masked customer side', async () => {
    const { db, tables } = handoffWorld();
    const out = await captureAfterSend(
      db,
      args({
        messageId: 'm3',
        aiDraftId: null,
        finalText: 'Claro, me passe o número do pedido.',
      })
    );
    expect(out).toEqual({ kind: 'candidate', source: 'handoff_reply' });
    expect(tables.ai_examples[0]).toMatchObject({
      status: 'candidate',
      source: 'handoff_reply',
      customer_message: 'quero trocar o tênis, comprei com o cpf [cpf]',
      ideal_response: 'Claro, me passe o número do pedido.',
      ai_draft: null,
    });
  });

  it('the second human reply is not a correction', async () => {
    const { db, tables } = handoffWorld();
    tables.messages.push({
      id: 'm4',
      conversation_id: CONV,
      sender_type: 'agent',
      ai_generated: false,
      content_type: 'text',
      content_text: 'Pode mandar também a foto.',
      created_at: '2026-11-20T10:06:00Z',
    });
    const out = await captureAfterSend(
      db,
      args({
        messageId: 'm4',
        aiDraftId: null,
        finalText: 'Pode mandar também a foto.',
      })
    );
    expect(out).toEqual({ kind: 'skipped', reason: 'not_a_correction' });
    expect(tables.ai_examples).toHaveLength(0);
  });

  it('a human takeover WITHOUT an AI hand-off is not a correction', async () => {
    const { db, tables } = handoffWorld({
      conversations: [
        {
          id: CONV,
          account_id: A,
          contact_id: 'ct-1',
          ai_autoreply_disabled: true,
          ai_handoff_summary: null,
        },
      ],
    });
    const out = await captureAfterSend(
      db,
      args({
        messageId: 'm3',
        aiDraftId: null,
        finalText: 'Claro, me passe o número do pedido.',
      })
    );
    expect(out.kind).toBe('skipped');
    expect(tables.ai_examples).toHaveLength(0);
  });

  it('a conversation the bot never paused is not a correction (the common send)', async () => {
    const { db, tables, writes } = world();
    const out = await captureAfterSend(
      db,
      args({ aiDraftId: null, finalText: 'Bom dia! Tudo bem?' })
    );
    expect(out).toEqual({ kind: 'skipped', reason: 'not_a_correction' });
    expect(tables.ai_examples).toHaveLength(0);
    // Cheap path: nothing written, no name lookup needed.
    expect(writes).toHaveLength(0);
  });

  it('never reads a conversation of another account', async () => {
    const { db } = world();
    // `conv-b` is in handoff but belongs to account B.
    const ok = await isFirstHumanReplyAfterHandoff(db, {
      accountId: A,
      conversationId: 'conv-b',
      messageId: 'x',
    });
    expect(ok).toBe(false);
  });

  it('a draft that is missing or already used still lets the hand-off rule apply', async () => {
    const { db, tables } = handoffWorld();
    const out = await captureAfterSend(
      db,
      args({
        messageId: 'm3',
        finalText: 'Claro, me passe o número do pedido.',
      })
    );
    expect(out).toEqual({ kind: 'candidate', source: 'handoff_reply' });
    expect(tables.ai_examples).toHaveLength(1);
  });
});

describe('capture never throws', () => {
  it('a database failure is reported as skipped, not raised', async () => {
    const { db } = world({ ai_drafts: [draftRow()] });
    const broken = tuningDb(
      {},
      { failOn: ['ai_drafts', 'conversations', 'contacts', 'ai_examples'] }
    ).db;
    for (const client of [broken, db]) {
      await expect(
        captureAfterSend(client, args({ aiDraftId: null }))
      ).resolves.toBeDefined();
    }
    const throwing = {
      from: () => {
        throw new Error('boom');
      },
    } as never;
    await expect(captureAfterSend(throwing, args())).resolves.toEqual({
      kind: 'skipped',
      reason: 'error',
    });
    await expect(
      registerDraft(throwing, {
        accountId: A,
        conversationId: CONV,
        userId: 'u1',
        messages: [{ role: 'user', content: 'oi' }],
        draftText: 'olá',
      })
    ).resolves.toBeNull();
  });
});

describe('registerDraft', () => {
  it('stores the masked customer message and draft, and returns the id', async () => {
    const { db, tables } = world();
    const id = await registerDraft(db, {
      accountId: A,
      conversationId: CONV,
      userId: 'u1',
      messages: [
        { role: 'user', content: 'Oi, sou a Marina. Meu zap é 11 98765-4321' },
        { role: 'assistant', content: 'Olá!' },
        { role: 'user', content: 'quanto custa?' },
      ],
      draftText:
        'Marina, o plano custa R$ 129,00. Escreva para vendas@loja.com',
    });
    expect(id).toBeTruthy();
    const row = tables.ai_drafts[0];
    expect(row).toMatchObject({
      account_id: A,
      user_id: 'u1',
      conversation_id: CONV,
    });
    expect(row.customer_message).toBe(
      'Oi, sou a [nome]. Meu zap é [telefone]\nquanto custa?'
    );
    expect(row.draft_text).toBe(
      '[nome], o plano custa R$ 129,00. Escreva para [e-mail]'
    );
  });

  it('stores nothing when there is no customer text', async () => {
    const { db, tables } = world();
    const id = await registerDraft(db, {
      accountId: A,
      conversationId: CONV,
      userId: 'u1',
      messages: [],
      draftText: 'olá',
    });
    expect(id).toBeNull();
    expect(tables.ai_drafts).toHaveLength(0);
  });
});

describe('normalizeForCompare', () => {
  it('collapses whitespace and normalizes unicode, keeps case and punctuation', () => {
    expect(normalizeForCompare('  a\n\n b\t c ')).toBe('a b c');
    const decomposed = 'e' + String.fromCharCode(0x301);
    const composed = String.fromCharCode(0xe9);
    expect(decomposed).not.toBe(composed);
    expect(normalizeForCompare(decomposed)).toBe(normalizeForCompare(composed));
    expect(normalizeForCompare('Olá!')).not.toBe(normalizeForCompare('olá!'));
  });
});

describe('capture — error log (LGPD review)', () => {
  const PG_ERROR = {
    code: '23514',
    message: 'new row violates check constraint',
    details: 'Failing row contains (Marina Teixeira, 11987654321)',
    hint: 'x',
  };
  const failInsert = (db: ReturnType<typeof world>['db'], table: string) => {
    const real = db.from.bind(db);
    (db as unknown as { from: unknown }).from = (t: string) => {
      const q = real(t);
      if (t !== table) return q;
      return Object.assign(q, {
        insert: () => {
          const res = { data: null, error: PG_ERROR };
          return Object.assign(Promise.resolve(res), {
            select: () => ({ single: () => Promise.resolve(res) }),
          });
        },
      });
    };
  };

  it('registerDraft logs the code and message, never the details', async () => {
    const { db } = world();
    failInsert(db, 'ai_drafts');
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const id = await registerDraft(db, {
        accountId: A,
        conversationId: CONV,
        userId: 'u1',
        messages: [{ role: 'user', content: 'quanto custa?' }],
        draftText: 'Custa R$ 129,00.',
      });
      expect(id).toBeNull();
      const logged = JSON.stringify(spy.mock.calls);
      expect(logged).toContain('23514');
      expect(logged).not.toMatch(/Marina|11987654321|Failing row/);
    } finally {
      spy.mockRestore();
    }
  });

  it('a failed candidate insert logs the code and message, never the details', async () => {
    const { db } = world({ ai_drafts: [draftRow()] });
    failInsert(db, 'ai_examples');
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const out = await captureAfterSend(db, args());
      expect(out).toEqual({ kind: 'skipped', reason: 'database_error' });
      const logged = JSON.stringify(spy.mock.calls);
      expect(logged).toContain('23514');
      expect(logged).not.toMatch(/Marina|11987654321|Failing row/);
    } finally {
      spy.mockRestore();
    }
  });
});
