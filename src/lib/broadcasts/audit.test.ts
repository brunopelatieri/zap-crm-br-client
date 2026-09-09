import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { logBroadcastAudit } from './audit';

const recordActivityMock = vi.fn(async () => undefined);
vi.mock('@/lib/activity/record', () => ({
  recordActivity: (...args: unknown[]) => recordActivityMock(...(args as [])),
}));

function makeDb() {
  return {
    from: () => ({
      insert: () => Promise.resolve({ error: null }),
    }),
  } as unknown as SupabaseClient;
}

beforeEach(() => {
  recordActivityMock.mockClear();
});

// SPEC 075 F3 — `logBroadcastAudit` é o ÚNICO ponto de gravação de
// `broadcast_audit_log`; hooká-lo aqui alimenta `account_activity_log`
// para os quatro chamadores (send/route, broadcast-dispatch, cron, e
// qualquer cancelamento futuro) de uma vez.
describe('logBroadcastAudit — ponte com account_activity_log (SPEC 075)', () => {
  it.each([
    ['dispatched', 'broadcast.dispatched'],
    ['scheduled', 'broadcast.scheduled'],
    ['canceled', 'broadcast.canceled'],
    ['blocked_window', 'broadcast.blocked'],
    ['blocked_quota', 'broadcast.blocked'],
  ] as const)('%s → %s', async (event, action) => {
    const db = makeDb();
    await logBroadcastAudit(db, {
      accountId: 'acct-1',
      event,
      broadcastId: 'bcast-1',
      broadcastName: 'Black Friday',
      actorUserId: 'user-1',
    });

    expect(recordActivityMock).toHaveBeenCalledTimes(1);
    expect(recordActivityMock).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        accountId: 'acct-1',
        resourceType: 'broadcast',
        action,
        resourceId: 'bcast-1',
        resourceLabel: 'Black Friday',
        actor: { kind: 'user', userId: 'user-1' },
      })
    );
  });

  it('ator "system" quando actorUserId é null (cron)', async () => {
    await logBroadcastAudit(makeDb(), {
      accountId: 'acct-1',
      event: 'dispatched',
      broadcastId: 'bcast-1',
      actorUserId: null,
    });

    expect(recordActivityMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ actor: { kind: 'system', name: 'cron' } })
    );
  });

  it.each(['rescheduled', 'postponed_window', 'failed'] as const)(
    '%s NÃO gera evento (fora do catálogo v1)',
    async (event) => {
      await logBroadcastAudit(makeDb(), {
        accountId: 'acct-1',
        event,
        broadcastId: 'bcast-1',
      });

      expect(recordActivityMock).not.toHaveBeenCalled();
    }
  );

  it('nunca lança quando o INSERT de broadcast_audit_log falha', async () => {
    const db = {
      from: () => ({
        insert: () => Promise.resolve({ error: { message: 'boom' } }),
      }),
    } as unknown as SupabaseClient;

    await expect(
      logBroadcastAudit(db, { accountId: 'acct-1', event: 'dispatched' })
    ).resolves.toBeUndefined();

    // O feed de atividade ainda recebe o evento — a trilha de broadcast
    // falhando não pode apagar o rastro de auditoria da conta.
    expect(recordActivityMock).toHaveBeenCalledTimes(1);
  });
});
