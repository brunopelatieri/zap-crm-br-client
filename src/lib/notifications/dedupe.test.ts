import { describe, expect, it } from 'vitest';

import { dedupeKeyFor } from './dedupe';
import type { SystemEventType } from './types';

const now = new Date('2026-08-26T12:00:00.000Z');
const accountId = 'acc-1';

function keyFor(
  type: SystemEventType,
  data: Record<string, unknown> = {},
  when: Date = now
): string | null {
  return dedupeKeyFor({ type, accountId, data }, when);
}

describe('dedupeKeyFor — a tabela da §3.1', () => {
  it('account.created is keyed by account only', () => {
    expect(keyFor('account.created')).toBe(`account.created:${accountId}`);
  });

  it('plan.changed / plan.requested / plan.canceled / plan.cancel_reverted / block events always deliver (null)', () => {
    const alwaysNull: SystemEventType[] = [
      'plan.changed',
      'plan.requested',
      'plan.canceled',
      'plan.cancel_reverted',
      'account.blocked',
      'account.unblocked',
      'member.blocked',
      'member.unblocked',
    ];
    for (const type of alwaysNull) {
      expect(keyFor(type)).toBeNull();
    }
  });

  it('plan.expiring keys different periods differently', () => {
    const a = keyFor('plan.expiring', {
      plan: { periodEnd: '2026-09-01T00:00:00.000Z', daysUntil: 7 },
    });
    const b = keyFor('plan.expiring', {
      plan: { periodEnd: '2027-09-01T00:00:00.000Z', daysUntil: 7 },
    });
    expect(a).not.toBe(b);
  });

  it('plan.expiring keys the same period + days the same', () => {
    const a = keyFor('plan.expiring', {
      plan: { periodEnd: '2026-09-01T00:00:00.000Z', daysUntil: 7 },
    });
    const b = keyFor('plan.expiring', {
      plan: { periodEnd: '2026-09-01T00:00:00.000Z', daysUntil: 7 },
    });
    expect(a).toBe(b);
  });

  it('plan.expiring distinguishes 7-day and 1-day notices for the same period', () => {
    const sevenDays = keyFor('plan.expiring', {
      plan: { periodEnd: '2026-09-01T00:00:00.000Z', daysUntil: 7 },
    });
    const oneDay = keyFor('plan.expiring', {
      plan: { periodEnd: '2026-09-01T00:00:00.000Z', daysUntil: 1 },
    });
    expect(sevenDays).not.toBe(oneDay);
  });

  it('plan.expired keys by period end', () => {
    expect(
      keyFor('plan.expired', {
        plan: { periodEnd: '2026-09-01T00:00:00.000Z' },
      })
    ).toBe(`plan.expired:${accountId}:2026-09-01T00:00:00.000Z`);
  });

  it('plan.grace_ended keys by grace_until (unique per period, same as lifecycle.ts own dedupe)', () => {
    expect(
      keyFor('plan.grace_ended', {
        plan: { graceUntil: '2026-09-08T00:00:00.000Z' },
      })
    ).toBe(`plan.grace_ended:${accountId}:2026-09-08T00:00:00.000Z`);
  });

  it('plan.canceled_applied keys by period end', () => {
    expect(
      keyFor('plan.canceled_applied', {
        plan: { periodEnd: '2026-09-01T00:00:00.000Z' },
      })
    ).toBe(`plan.canceled_applied:${accountId}:2026-09-01T00:00:00.000Z`);
  });

  it('plan.renewed keys by paymentRef', () => {
    const a = keyFor('plan.renewed', { plan: { paymentRef: 'fatura-1' } });
    const b = keyFor('plan.renewed', { plan: { paymentRef: 'fatura-2' } });
    expect(a).not.toBe(b);
    expect(a).toBe(`plan.renewed:${accountId}:fatura-1`);
  });

  it('quota.exceeded is keyed once per metric per day (D-10)', () => {
    const morning = keyFor(
      'quota.exceeded',
      { quota: { metric: 'contacts' } },
      new Date('2026-08-26T09:00:00.000Z')
    );
    const evening = keyFor(
      'quota.exceeded',
      { quota: { metric: 'contacts' } },
      new Date('2026-08-26T23:59:00.000Z')
    );
    expect(morning).toBe(evening);
    expect(morning).toBe(`quota.exceeded:${accountId}:contacts:2026-08-26`);
  });

  it('quota.exceeded on a different day gets a different key', () => {
    const day1 = keyFor(
      'quota.exceeded',
      { quota: { metric: 'contacts' } },
      new Date('2026-08-26T09:00:00.000Z')
    );
    const day2 = keyFor(
      'quota.exceeded',
      { quota: { metric: 'contacts' } },
      new Date('2026-08-27T09:00:00.000Z')
    );
    expect(day1).not.toBe(day2);
  });

  it('quota.exceeded on a different metric gets a different key', () => {
    const contacts = keyFor('quota.exceeded', {
      quota: { metric: 'contacts' },
    });
    const members = keyFor('quota.exceeded', {
      quota: { metric: 'members_total' },
    });
    expect(contacts).not.toBe(members);
  });
});
