import { describe, it, expect } from 'vitest';

import { shouldRunNow, isClaimStale } from './schedule';

describe('shouldRunNow', () => {
  const now = new Date('2026-08-26T12:00:00Z');

  it('nunca rodou (lastRunAt null) → roda', () => {
    expect(shouldRunNow(null, 6, now)).toBe(true);
  });

  it('dentro do intervalo → não roda', () => {
    const lastRunAt = new Date('2026-08-26T10:00:00Z'); // 2h atrás
    expect(shouldRunNow(lastRunAt, 6, now)).toBe(false);
  });

  it('um minuto antes da borda → não roda', () => {
    const lastRunAt = new Date(now.getTime() - (6 * 60 - 1) * 60 * 1000);
    expect(shouldRunNow(lastRunAt, 6, now)).toBe(false);
  });

  it('um minuto depois da borda → roda', () => {
    const lastRunAt = new Date(now.getTime() - (6 * 60 + 1) * 60 * 1000);
    expect(shouldRunNow(lastRunAt, 6, now)).toBe(true);
  });

  it('exatamente na borda → roda (>=)', () => {
    const lastRunAt = new Date(now.getTime() - 6 * 60 * 60 * 1000);
    expect(shouldRunNow(lastRunAt, 6, now)).toBe(true);
  });
});

describe('isClaimStale', () => {
  const now = new Date('2026-08-26T12:00:00Z');

  it('sem claim (null) → não é vencido', () => {
    expect(isClaimStale(null, now)).toBe(false);
  });

  it('claim fresco (5 min) → não é vencido', () => {
    const runningSince = new Date(now.getTime() - 5 * 60 * 1000);
    expect(isClaimStale(runningSince, now)).toBe(false);
  });

  it('claim vencido (31 min) → é vencido', () => {
    const runningSince = new Date(now.getTime() - 31 * 60 * 1000);
    expect(isClaimStale(runningSince, now)).toBe(true);
  });

  it('exatamente nos 30 min → é vencido (>=)', () => {
    const runningSince = new Date(now.getTime() - 30 * 60 * 1000);
    expect(isClaimStale(runningSince, now)).toBe(true);
  });
});
