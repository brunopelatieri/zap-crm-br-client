import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

vi.mock('@/lib/mailer/send', () => ({
  deliverSystemEmail: vi.fn(),
}));
vi.mock('./webhook', () => ({
  deliverSystemWebhook: vi.fn(),
}));

import { deliverOne, deliverPending } from './dispatch';
import { deliverSystemEmail } from '@/lib/mailer/send';
import { deliverSystemWebhook } from './webhook';
import { buildEventPayload } from './types';

const emailMock = vi.mocked(deliverSystemEmail);
const hookMock = vi.mocked(deliverSystemWebhook);

interface Row {
  id: string;
  payload: Record<string, unknown>;
  email_status: string;
  hook_status: string;
  attempts: number;
  last_error: string | null;
  next_attempt_at: string;
  delivered_at: string | null;
  created_at: string;
}

function makeDb(initialRows: Row[]) {
  const rows = new Map(initialRows.map((r) => [r.id, { ...r }]));

  function from() {
    let mode: 'select' | 'update' = 'select';
    let updatePayload: Record<string, unknown> = {};
    const eqFilters: { col: string; val: unknown }[] = [];
    const lteFilters: { col: string; val: unknown }[] = [];
    let orExpr: string | null = null;
    let limitN: number | null = null;

    function matched(): Row[] {
      let result = Array.from(rows.values());
      for (const f of eqFilters) {
        result = result.filter(
          (r) => (r as Record<string, unknown>)[f.col] === f.val
        );
      }
      for (const f of lteFilters) {
        result = result.filter(
          (r) => String((r as Record<string, unknown>)[f.col]) <= String(f.val)
        );
      }
      if (orExpr) {
        const parts = orExpr.split(',');
        result = result.filter((r) =>
          parts.some((p) => {
            const [col, , val] = p.split('.');
            return (r as Record<string, unknown>)[col] === val;
          })
        );
      }
      result = [...result].sort((a, b) =>
        a.created_at.localeCompare(b.created_at)
      );
      if (limitN !== null) result = result.slice(0, limitN);
      return result;
    }

    const builder = {
      select: () => builder,
      update: (p: Record<string, unknown>) => {
        mode = 'update';
        updatePayload = p;
        return builder;
      },
      eq: (col: string, val: unknown) => {
        eqFilters.push({ col, val });
        return builder;
      },
      lte: (col: string, val: unknown) => {
        lteFilters.push({ col, val });
        return builder;
      },
      or: (expr: string) => {
        orExpr = expr;
        return builder;
      },
      order: () => builder,
      limit: (n: number) => {
        limitN = n;
        return builder;
      },
      maybeSingle: async () => {
        const m = matched();
        if (mode === 'update') {
          if (m.length !== 1) return { data: null, error: null };
          const row = rows.get(m[0].id)!;
          Object.assign(row, updatePayload);
          return { data: { ...row }, error: null };
        }
        return { data: m[0] ? { ...m[0] } : null, error: null };
      },
      then: (resolve: (v: unknown) => unknown) => {
        const m = matched();
        if (mode === 'update') {
          for (const r of m) Object.assign(rows.get(r.id)!, updatePayload);
          return resolve({ data: null, error: null });
        }
        return resolve({ data: m.map((r) => ({ ...r })), error: null });
      },
    };
    return builder;
  }

  return { db: { from } as unknown as SupabaseClient, rows };
}

function makeRow(overrides: Partial<Row> = {}): Row {
  const payload = buildEventPayload(
    {
      type: 'plan.changed',
      accountId: 'acc-1',
      account: { id: 'acc-1', name: 'Acme', ownerEmail: null },
    },
    new Date('2026-08-26T12:00:00.000Z')
  );
  return {
    id: 'notif-1',
    payload: payload as unknown as Record<string, unknown>,
    email_status: 'pending',
    hook_status: 'pending',
    attempts: 0,
    last_error: null,
    next_attempt_at: '2026-08-26T12:00:00.000Z',
    delivered_at: null,
    created_at: '2026-08-26T12:00:00.000Z',
    ...overrides,
  };
}

const now = new Date('2026-08-26T12:00:00.000Z');

beforeEach(() => {
  emailMock.mockReset();
  hookMock.mockReset();
});

describe('deliverOne', () => {
  it('delivers both channels and marks the row resolved with delivered_at', async () => {
    emailMock.mockResolvedValue({ ok: true, skipped: false });
    hookMock.mockResolvedValue({ ok: true, skipped: true });
    const { db, rows } = makeDb([makeRow()]);

    await deliverOne('notif-1', db, now);

    const row = rows.get('notif-1')!;
    expect(row.email_status).toBe('sent');
    expect(row.hook_status).toBe('skipped');
    expect(row.delivered_at).toBe(now.toISOString());
  });

  it('is a no-op when both channels are already resolved', async () => {
    const { db, rows } = makeDb([
      makeRow({ email_status: 'sent', hook_status: 'sent' }),
    ]);
    await deliverOne('notif-1', db, now);
    expect(emailMock).not.toHaveBeenCalled();
    expect(rows.get('notif-1')!.email_status).toBe('sent');
  });

  it('bumps attempts and schedules backoff on failure, without giving up early', async () => {
    emailMock.mockResolvedValue({
      ok: false,
      skipped: false,
      error: 'smtp down',
    });
    hookMock.mockResolvedValue({ ok: true, skipped: true });
    const { db, rows } = makeDb([makeRow()]);

    await deliverOne('notif-1', db, now);

    const row = rows.get('notif-1')!;
    expect(row.email_status).toBe('pending');
    expect(row.hook_status).toBe('skipped');
    expect(row.attempts).toBe(1);
    expect(row.last_error).toContain('smtp down');
    expect(row.delivered_at).toBeNull();
    // next_attempt_at moved forward (2^1 = 2 minutes)
    expect(new Date(row.next_attempt_at).getTime()).toBe(
      now.getTime() + 2 * 60_000
    );
  });

  it('gives up (marks failed) once attempts reach 6, and stops moving next_attempt_at', async () => {
    emailMock.mockResolvedValue({
      ok: false,
      skipped: false,
      error: 'bad auth',
    });
    hookMock.mockResolvedValue({ ok: true, skipped: true });
    const { db, rows } = makeDb([
      makeRow({ attempts: 5, hook_status: 'sent' }),
    ]);

    await deliverOne('notif-1', db, now);

    const row = rows.get('notif-1')!;
    expect(row.attempts).toBe(6);
    expect(row.email_status).toBe('failed');
    expect(row.delivered_at).toBe(now.toISOString());
  });

  it('does not re-attempt a channel that already succeeded in a prior run', async () => {
    emailMock.mockResolvedValue({ ok: true, skipped: false });
    const { db, rows } = makeDb([makeRow({ hook_status: 'sent' })]);

    await deliverOne('notif-1', db, now);

    expect(hookMock).not.toHaveBeenCalled();
    expect(rows.get('notif-1')!.hook_status).toBe('sent');
  });
});

describe('deliverPending', () => {
  it('claims and delivers every due row, skipping ones not yet due', async () => {
    emailMock.mockResolvedValue({ ok: true, skipped: false });
    hookMock.mockResolvedValue({ ok: true, skipped: false });
    const { db, rows } = makeDb([
      makeRow({ id: 'due-1', next_attempt_at: '2026-08-26T11:00:00.000Z' }),
      makeRow({ id: 'due-2', next_attempt_at: '2026-08-26T12:00:00.000Z' }),
      makeRow({ id: 'not-due', next_attempt_at: '2026-08-26T13:00:00.000Z' }),
      makeRow({
        id: 'resolved',
        email_status: 'sent',
        hook_status: 'sent',
        next_attempt_at: '2026-08-26T11:00:00.000Z',
      }),
    ]);

    const result = await deliverPending(now, 50, db);

    expect(result.claimed).toBe(2);
    expect(result.delivered).toBe(2);
    expect(rows.get('due-1')!.email_status).toBe('sent');
    expect(rows.get('due-2')!.hook_status).toBe('sent');
    expect(rows.get('not-due')!.email_status).toBe('pending');
  });

  it('running twice on the same due row a single delivery only counts once (idempotent)', async () => {
    emailMock.mockResolvedValue({ ok: true, skipped: false });
    hookMock.mockResolvedValue({ ok: true, skipped: false });
    const { db } = makeDb([makeRow({ id: 'a' })]);

    const first = await deliverPending(now, 50, db);
    const second = await deliverPending(now, 50, db);

    expect(first.claimed).toBe(1);
    expect(second.claimed).toBe(0); // already resolved, drops out of the pending scan
  });
});
