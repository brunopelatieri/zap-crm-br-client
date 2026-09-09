import { describe, expect, it, vi, beforeEach } from 'vitest';
import { POST } from './route';

const AGENT_ID = '11111111-1111-1111-1111-111111111111';
const CONV_ID = '22222222-2222-2222-2222-222222222222';

let requireRoleMock = vi.fn();
vi.mock('@/lib/auth/account', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/account')>();
  return {
    ...actual,
    requireRole: (...args: unknown[]) => requireRoleMock(...args),
  };
});

let reassignResult: unknown;
vi.mock('@/lib/inbox/assignment', () => ({
  reassignConversation: vi.fn(async () => reassignResult),
}));

const recordActivityMock = vi.fn(async () => undefined);
vi.mock('@/lib/activity/record', () => ({
  recordActivity: (...args: unknown[]) => recordActivityMock(...(args as [])),
}));

function request(body: unknown) {
  return new Request('http://localhost/api/inbox/conversations/x/assign', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  recordActivityMock.mockClear();
  requireRoleMock = vi.fn(async () => ({
    supabase: {},
    userId: 'user-1',
    accountId: 'acct-1',
    role: 'admin',
  }));
});

describe('POST /api/inbox/conversations/[id]/assign — SPEC 075 F3', () => {
  it('registra conversation.assigned quando passa a conversa para alguém', async () => {
    reassignResult = {
      ok: true,
      conversation: {
        id: CONV_ID,
        contact_id: 'contact-1',
        channel_id: 'chan-1',
      },
    };

    const res = await POST(request({ assigned_agent_id: AGENT_ID }), {
      params: Promise.resolve({ id: CONV_ID }),
    });

    expect(res.status).toBe(200);
    expect(recordActivityMock).toHaveBeenCalledTimes(1);
    expect(recordActivityMock).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        accountId: 'acct-1',
        resourceType: 'conversation',
        action: 'conversation.assigned',
        resourceId: CONV_ID,
        contactId: 'contact-1',
        channelId: 'chan-1',
        actor: { kind: 'user', userId: 'user-1', role: 'admin' },
      })
    );
  });

  it('NÃO registra nada quando a conversa volta para a fila (target null)', async () => {
    reassignResult = {
      ok: true,
      conversation: {
        id: CONV_ID,
        contact_id: 'contact-1',
        channel_id: 'chan-1',
      },
    };

    const res = await POST(request({ assigned_agent_id: null }), {
      params: Promise.resolve({ id: CONV_ID }),
    });

    expect(res.status).toBe(200);
    expect(recordActivityMock).not.toHaveBeenCalled();
  });

  it('não registra nada quando o RPC falha', async () => {
    reassignResult = {
      ok: false,
      status: 409,
      code: 'CONVERSATION_ALREADY_CLAIMED',
      error: 'já foi',
    };

    const res = await POST(request({ assigned_agent_id: AGENT_ID }), {
      params: Promise.resolve({ id: CONV_ID }),
    });

    expect(res.status).toBe(409);
    expect(recordActivityMock).not.toHaveBeenCalled();
  });
});
