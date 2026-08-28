import { describe, expect, it } from 'vitest';

import { computePlatformSummary, type AccountSummaryRow } from './summary';

function row(overrides: Partial<AccountSummaryRow> = {}): AccountSummaryRow {
  return {
    accountId: 'acct-1',
    blockedAt: null,
    status: 'active',
    currentPeriodEnd: null,
    isOverage: false,
    ...overrides,
  };
}

describe('computePlatformSummary', () => {
  const now = new Date('2026-06-01T00:00:00Z');

  it('conta sem vencimento não entra em "vencendo" nem em "vencida"', () => {
    const summary = computePlatformSummary(
      [row({ currentPeriodEnd: null })],
      0,
      now
    );
    expect(summary.expiringSoon).toBe(0);
    expect(summary.expired).toBe(0);
  });

  it('vence exatamente na borda da janela (7 dias) entra em "vencendo"', () => {
    const periodEnd = new Date(
      now.getTime() + 7 * 24 * 60 * 60 * 1000
    ).toISOString();
    const summary = computePlatformSummary(
      [row({ currentPeriodEnd: periodEnd })],
      0,
      now,
      7
    );
    expect(summary.expiringSoon).toBe(1);
    expect(summary.expired).toBe(0);
  });

  it('vence em 8 dias fica fora da janela de 7', () => {
    const periodEnd = new Date(
      now.getTime() + 8 * 24 * 60 * 60 * 1000
    ).toISOString();
    const summary = computePlatformSummary(
      [row({ currentPeriodEnd: periodEnd })],
      0,
      now,
      7
    );
    expect(summary.expiringSoon).toBe(0);
  });

  it('já vencida entra em "vencida", não em "vencendo"', () => {
    const periodEnd = new Date(now.getTime() - 1000).toISOString();
    const summary = computePlatformSummary(
      [row({ currentPeriodEnd: periodEnd })],
      0,
      now,
      7
    );
    expect(summary.expired).toBe(1);
    expect(summary.expiringSoon).toBe(0);
  });

  it('vence exatamente agora não é "vencida" (isExpired é estritamente maior)', () => {
    const summary = computePlatformSummary(
      [row({ currentPeriodEnd: now.toISOString() })],
      0,
      now,
      7
    );
    expect(summary.expired).toBe(0);
    expect(summary.expiringSoon).toBe(1);
  });

  it('conta bloqueada não conta como ativa mesmo com status active', () => {
    const summary = computePlatformSummary(
      [row({ blockedAt: '2026-05-01T00:00:00Z', status: 'active' })],
      0,
      now
    );
    expect(summary.accountsBlocked).toBe(1);
    expect(summary.accountsActive).toBe(0);
  });

  it('soma overage e solicitações pendentes', () => {
    const summary = computePlatformSummary(
      [row({ isOverage: true }), row({ isOverage: false })],
      3,
      now
    );
    expect(summary.accountsOverage).toBe(1);
    expect(summary.pendingRequests).toBe(3);
    expect(summary.accountsTotal).toBe(2);
  });
});
