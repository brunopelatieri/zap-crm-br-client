import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// SPEC 074 F4 — POST /api/inbox/messages/[id]/delete
//
// Foco na ROTA: as guardas, a decisão de `planDeletion` traduzida em
// HTTP, o disparo (ou não) do endpoint do provedor, e a gravação do log
// nos dois caminhos (mark/purge). `resolveChannelContext` e o adaptador
// são mockados na fronteira — cada um já tem teste próprio.
// ---------------------------------------------------------------------------

const MESSAGE_ID = '11111111-1111-1111-1111-111111111111';
const CONVERSATION_ID = '22222222-2222-2222-2222-222222222222';
const CHANNEL_ID = '33333333-3333-3333-3333-333333333333';

interface FakeMessageRow {
  id: string;
  message_id: string | null;
  conversation_id: string;
  sender_type: 'customer' | 'agent' | 'bot';
  status: string;
  content_type: string;
  content_text: string | null;
  media_path: string | null;
  created_at: string;
  channel_id: string | null;
  deleted_at: string | null;
  deletion_scope: string | null;
}

function makeMessage(overrides: Partial<FakeMessageRow> = {}): FakeMessageRow {
  return {
    id: MESSAGE_ID,
    message_id: 'wamid.abc',
    conversation_id: CONVERSATION_ID,
    sender_type: 'agent',
    status: 'delivered',
    content_type: 'text',
    content_text: 'Preço errado, desculpa',
    media_path: null,
    created_at: new Date().toISOString(),
    channel_id: null,
    deleted_at: null,
    deletion_scope: null,
    ...overrides,
  };
}

// ------------------------------------------------------------------
// Cliente Supabase falso: cada `.from(table)` devolve um chain que
// resolve por `.maybeSingle()` (fila 'select') ou por ser AWAITADO
// direto após `.update()/.delete()/.insert()` (fila 'write'). Os dois
// modos são contados e consumidos em ORDEM de chamada, por tabela.
// ------------------------------------------------------------------
type Resp = { data?: unknown; error?: { message: string } | null };

function makeFakeClient(
  selectQueues: Record<string, Resp[]>,
  writeQueues: Record<string, Resp[]> = {},
  recorded: {
    inserts: Array<{ table: string; row: unknown }>;
    updates: Array<{ table: string; row: unknown }>;
  } = {
    inserts: [],
    updates: [],
  }
) {
  const selectCounters: Record<string, number> = {};
  const writeCounters: Record<string, number> = {};

  function popSelect(table: string): Resp {
    const idx = selectCounters[table] ?? 0;
    selectCounters[table] = idx + 1;
    return (selectQueues[table] ?? [])[idx] ?? { data: null, error: null };
  }
  function popWrite(table: string): Resp {
    const idx = writeCounters[table] ?? 0;
    writeCounters[table] = idx + 1;
    return (writeQueues[table] ?? [])[idx] ?? { error: null };
  }

  function chain(table: string) {
    const obj: {
      select: () => typeof obj;
      eq: () => typeof obj;
      order: () => typeof obj;
      limit: () => typeof obj;
      update: (row: unknown) => typeof obj;
      delete: () => typeof obj;
      insert: (row: unknown) => typeof obj;
      maybeSingle: () => Promise<Resp>;
      then: (resolve: (r: Resp) => void) => void;
    } = {
      select: () => obj,
      eq: () => obj,
      order: () => obj,
      limit: () => obj,
      update: (row: unknown) => {
        recorded.updates.push({ table, row });
        return obj;
      },
      delete: () => obj,
      insert: (row: unknown) => {
        recorded.inserts.push({ table, row });
        return obj;
      },
      maybeSingle: async () => popSelect(table),
      then: (resolve) => resolve(popWrite(table)),
    };
    return obj;
  }

  return { from: (table: string) => chain(table) };
}

let userSeq = 0;
function nextUserId(): string {
  userSeq += 1;
  return `user-${userSeq}`;
}

vi.mock('@/lib/auth/account', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/account')>();
  return { ...actual, requireRole: vi.fn() };
});

let adminInserts: Array<{ table: string; row: unknown }> = [];
let adminUpdates: Array<{ table: string; row: unknown }> = [];
let adminSelectQueues: Record<string, Resp[]> = {};
let adminWriteQueues: Record<string, Resp[]> = {};
let storageRemove = vi.fn(async () => ({
  error: null as { message: string } | null,
}));

vi.mock('@/lib/supabase/admin', () => ({
  supabaseAdmin: () => {
    const recorded = { inserts: adminInserts, updates: adminUpdates };
    const base = makeFakeClient(adminSelectQueues, adminWriteQueues, recorded);
    return {
      ...base,
      storage: { from: () => ({ remove: storageRemove }) },
    };
  },
}));

let resolveChannelContextMock = vi.fn(async () => ({
  ctx: {
    accountId: 'acct-1',
    channel: { id: CHANNEL_ID, type: 'whatsapp_qr' },
    credentials: {},
  },
  configRow: {},
  source: 'conversation' as const,
}));
vi.mock('@/lib/channels/send', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/channels/send')>();
  return {
    ...actual,
    resolveChannelContext: (...args: unknown[]) =>
      resolveChannelContextMock(...(args as [])),
  };
});

let deleteMessageMock = vi.fn(async () => undefined);
vi.mock('@/lib/channels/registry', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/lib/channels/registry')>();
  return {
    ...actual,
    getAdapter: vi.fn(() => ({
      type: 'whatsapp_qr',
      deleteMessage: deleteMessageMock,
    })),
  };
});

import { requireRole } from '@/lib/auth/account';
import { POST } from './route';

function mockContext(opts: {
  userId: string;
  role: 'owner' | 'admin' | 'agent' | 'viewer';
  message: FakeMessageRow;
  channelType?: 'whatsapp_qr' | 'whatsapp_cloud';
}) {
  const selectQueues: Record<string, Resp[]> = {
    messages: [
      { data: opts.message, error: null },
      // segunda leitura (última mensagem da conversa) — por padrão, ELA
      // MESMA é a última.
      { data: { id: opts.message.id }, error: null },
    ],
    conversations: [
      {
        data: {
          id: CONVERSATION_ID,
          channel_id: CHANNEL_ID,
          contact: { phone: '5511999998888' },
        },
        error: null,
      },
    ],
    channels: [
      { data: { type: opts.channelType ?? 'whatsapp_qr' }, error: null },
    ],
  };
  const writeQueues: Record<string, Resp[]> = {
    messages: [{ error: null }],
    conversations: [{ error: null }],
  };
  const recorded = {
    inserts: [] as Array<{ table: string; row: unknown }>,
    updates: [] as Array<{ table: string; row: unknown }>,
  };
  const supabase = makeFakeClient(selectQueues, writeQueues, recorded);

  vi.mocked(requireRole).mockResolvedValue({
    supabase,
    userId: opts.userId,
    accountId: 'acct-1',
    role: opts.role,
    account: { id: 'acct-1', name: 'Conta' },
  } as unknown as Awaited<ReturnType<typeof requireRole>>);

  return { recorded };
}

function makeRequest(body: unknown) {
  return new Request('http://localhost/api/inbox/messages/x/delete', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  adminInserts = [];
  adminUpdates = [];
  adminSelectQueues = {
    message_deletion_log: [{ data: { id: 'log-1' }, error: null }],
  };
  adminWriteQueues = { message_deletion_log: [{ error: null }] };
  storageRemove = vi.fn(async () => ({ error: null }));
  resolveChannelContextMock = vi.fn(async () => ({
    ctx: {
      accountId: 'acct-1',
      channel: { id: CHANNEL_ID, type: 'whatsapp_qr' },
      credentials: {},
    },
    configRow: {},
    source: 'conversation' as const,
  }));
  deleteMessageMock = vi.fn(async () => undefined);
});

describe('POST /api/inbox/messages/[id]/delete', () => {
  it('404 quando a mensagem nao existe', async () => {
    vi.mocked(requireRole).mockResolvedValue({
      supabase: makeFakeClient({ messages: [{ data: null, error: null }] }),
      userId: nextUserId(),
      accountId: 'acct-1',
      role: 'agent',
      account: { id: 'acct-1', name: 'Conta' },
    } as unknown as Awaited<ReturnType<typeof requireRole>>);

    const res = await POST(makeRequest({}), {
      params: Promise.resolve({ id: MESSAGE_ID }),
    });
    expect(res.status).toBe(404);
  });

  it('400 not_outbound para mensagem do contato', async () => {
    mockContext({
      userId: nextUserId(),
      role: 'agent',
      message: makeMessage({ sender_type: 'customer' }),
    });

    const res = await POST(makeRequest({}), {
      params: Promise.resolve({ id: MESSAGE_ID }),
    });
    const json = await res.json();
    expect(res.status).toBe(400);
    expect(json.code).toBe('not_outbound');
  });

  it('400 nothing_to_do quando agent tenta agir sobre mensagem ja marcada (revogada com sucesso)', async () => {
    mockContext({
      userId: nextUserId(),
      role: 'agent',
      message: makeMessage({
        deleted_at: new Date().toISOString(),
        deletion_scope: 'revoked',
      }),
    });

    const res = await POST(makeRequest({}), {
      params: Promise.resolve({ id: MESSAGE_ID }),
    });
    const json = await res.json();
    expect(res.status).toBe(400);
    expect(json.code).toBe('nothing_to_do');
  });

  it('agent PODE tentar de novo (retry) quando a revogacao anterior falhou — achado de code review', async () => {
    const { recorded } = mockContext({
      userId: nextUserId(),
      role: 'agent',
      message: makeMessage({
        deleted_at: '2026-01-01T00:00:00.000Z',
        deletion_scope: 'revoke_failed',
      }),
      channelType: 'whatsapp_qr',
    });

    const res = await POST(makeRequest({}), {
      params: Promise.resolve({ id: MESSAGE_ID }),
    });
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json).toMatchObject({ ok: true, provider_outcome: 'revoked' });

    const retryUpdate = recorded.updates.find((u) => u.table === 'messages');
    expect(retryUpdate?.row).not.toHaveProperty('deleted_at');

    const logInsert = adminInserts.find(
      (i) => i.table === 'message_deletion_log'
    );
    expect(logInsert?.row).toMatchObject({ action: 'revoke_retry' });
  });

  it('403 quando agent pede purge:true', async () => {
    mockContext({
      userId: nextUserId(),
      role: 'agent',
      message: makeMessage(),
    });

    const res = await POST(makeRequest({ purge: true }), {
      params: Promise.resolve({ id: MESSAGE_ID }),
    });
    expect(res.status).toBe(403);
  });

  it('marca e revoga com sucesso no QRCode', async () => {
    const { recorded } = mockContext({
      userId: nextUserId(),
      role: 'agent',
      message: makeMessage(),
      channelType: 'whatsapp_qr',
    });

    const res = await POST(makeRequest({}), {
      params: Promise.resolve({ id: MESSAGE_ID }),
    });
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json).toMatchObject({
      ok: true,
      purged: false,
      provider_outcome: 'revoked',
    });
    expect(deleteMessageMock).toHaveBeenCalledTimes(1);

    const markUpdate = recorded.updates.find((u) => u.table === 'messages');
    expect(markUpdate?.row).toMatchObject({
      deletion_scope: 'revoked',
      deletion_actor: 'agent',
    });

    const logInsert = adminInserts.find(
      (i) => i.table === 'message_deletion_log'
    );
    expect(logInsert?.row).toMatchObject({
      action: 'mark',
      provider_outcome: 'revoked',
    });
  });

  it('marca no canal oficial sem tentar revogar (not_supported)', async () => {
    mockContext({
      userId: nextUserId(),
      role: 'agent',
      message: makeMessage(),
      channelType: 'whatsapp_cloud',
    });

    const res = await POST(makeRequest({}), {
      params: Promise.resolve({ id: MESSAGE_ID }),
    });
    const json = await res.json();

    expect(json).toMatchObject({ ok: true, provider_outcome: 'not_supported' });
    expect(deleteMessageMock).not.toHaveBeenCalled();
  });

  it('marca assim mesmo quando a revogacao falha, com motivo (D-6)', async () => {
    deleteMessageMock = vi.fn(async () => {
      throw new Error('revoke window expired');
    });
    mockContext({
      userId: nextUserId(),
      role: 'agent',
      message: makeMessage(),
      channelType: 'whatsapp_qr',
    });

    const res = await POST(makeRequest({}), {
      params: Promise.resolve({ id: MESSAGE_ID }),
    });
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json).toMatchObject({
      ok: true,
      provider_outcome: 'revoke_failed',
      provider_error: 'revoke window expired',
    });
  });

  it('retry (revoke_retry) sobre mensagem ja marcada, sem tocar deleted_at', async () => {
    const { recorded } = mockContext({
      userId: nextUserId(),
      role: 'admin',
      message: makeMessage({ deleted_at: '2026-01-01T00:00:00.000Z' }),
      channelType: 'whatsapp_qr',
    });

    const res = await POST(makeRequest({}), {
      params: Promise.resolve({ id: MESSAGE_ID }),
    });
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json).toMatchObject({ ok: true, provider_outcome: 'revoked' });

    const retryUpdate = recorded.updates.find((u) => u.table === 'messages');
    expect(retryUpdate?.row).not.toHaveProperty('deleted_at');
    expect(retryUpdate?.row).toMatchObject({ deletion_scope: 'revoked' });

    const logInsert = adminInserts.find(
      (i) => i.table === 'message_deletion_log'
    );
    expect(logInsert?.row).toMatchObject({ action: 'revoke_retry' });
  });

  it('admin exclui do sistema (purge) e remove a midia', async () => {
    const { recorded } = mockContext({
      userId: nextUserId(),
      role: 'admin',
      message: makeMessage({ media_path: 'account-1/foo.jpg' }),
      channelType: 'whatsapp_qr',
    });

    const res = await POST(makeRequest({ purge: true }), {
      params: Promise.resolve({ id: MESSAGE_ID }),
    });
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json).toMatchObject({ ok: true, purged: true });
    expect(storageRemove).toHaveBeenCalledWith(['account-1/foo.jpg']);

    const deleteCall = recorded.updates.find((u) => u.table === 'messages');
    // purge nao passa por `.update()` em `messages` — so `.delete()`.
    expect(deleteCall).toBeUndefined();

    const logInsert = adminInserts.find(
      (i) => i.table === 'message_deletion_log'
    );
    expect(logInsert?.row).toMatchObject({ action: 'purge', had_media: true });
  });
});
