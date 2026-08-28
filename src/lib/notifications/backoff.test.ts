import { describe, expect, it } from 'vitest';

import { hasGivenUp, nextAttemptAt } from './backoff';

describe('nextAttemptAt', () => {
  const now = new Date('2026-08-26T12:00:00.000Z');

  it('grows exponentially with attempts', () => {
    expect(nextAttemptAt(1, now).getTime() - now.getTime()).toBe(2 * 60_000);
    expect(nextAttemptAt(2, now).getTime() - now.getTime()).toBe(4 * 60_000);
    expect(nextAttemptAt(3, now).getTime() - now.getTime()).toBe(8 * 60_000);
    expect(nextAttemptAt(4, now).getTime() - now.getTime()).toBe(16 * 60_000);
    expect(nextAttemptAt(5, now).getTime() - now.getTime()).toBe(32 * 60_000);
  });

  it('caps at 6 hours', () => {
    const sixHoursMs = 6 * 60 * 60_000;
    expect(nextAttemptAt(20, now).getTime() - now.getTime()).toBe(sixHoursMs);
    expect(nextAttemptAt(100, now).getTime() - now.getTime()).toBe(sixHoursMs);
  });
});

describe('hasGivenUp', () => {
  it('is false before 6 attempts', () => {
    expect(hasGivenUp(0)).toBe(false);
    expect(hasGivenUp(5)).toBe(false);
  });

  it('gives up at 6 attempts', () => {
    expect(hasGivenUp(6)).toBe(true);
    expect(hasGivenUp(7)).toBe(true);
  });
});
