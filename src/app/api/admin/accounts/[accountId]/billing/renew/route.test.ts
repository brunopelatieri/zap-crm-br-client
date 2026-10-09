import { beforeEach, describe, expect, it, vi } from 'vitest';

// Rota de máquina do sistema externo de cobrança. O ponto destes testes
// é o que `already_applied` significa: só um pagamento VIGENTE da mesma
// conta. `payment_ref` é UNIQUE na plataforma inteira (SPEC 078).

vi.mock('@/lib/auth/platform-admin', () => ({
  requirePlatformAdminSecret: () => null,
}));
vi.mock('@/lib/supabase/admin', () => ({
  supabaseAdmin: () => ({ marker: 'admin-db' }),
}));

const renewAccountPlan = vi.fn();
vi.mock('@/lib/plans/billing-renew', () => ({
  renewAccountPlan: (...args: unknown[]) => renewAccountPlan(...args),
}));

const resolveDuplicateRef = vi.fn();
vi.mock('@/lib/plans/payments', () => ({
  resolveDuplicateRef: (...args: unknown[]) => resolveDuplicateRef(...args),
}));

const writePlatformAudit = vi.fn().mockResolvedValue(undefined);
vi.mock('@/lib/platform/audit', () => ({
  writePlatformAudit: (...args: unknown[]) => writePlatformAudit(...args),
}));
const recordActivity = vi.fn().mockResolvedValue(undefined);
vi.mock('@/lib/activity/record', () => ({
  recordActivity: (...args: unknown[]) => recordActivity(...args),
}));
const dispatchWebhookEvent = vi.fn().mockResolvedValue(undefined);
vi.mock('@/lib/webhooks/deliver', () => ({
  dispatchWebhookEvent: (...args: unknown[]) => dispatchWebhookEvent(...args),
}));
const emitSystemEvent = vi.fn().mockResolvedValue(undefined);
vi.mock('@/lib/notifications/emit', () => ({
  emitSystemEvent: (...args: unknown[]) => emitSystemEvent(...args),
}));

import { POST } from './route';

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const params = { params: Promise.resolve({ accountId: ACCOUNT }) };
const request = () =>
  new Request('http://localhost/x', {
    method: 'POST',
    body: JSON.stringify({ paymentRef: 'E2E123', periods: 1 }),
  });

beforeEach(() => {
  renewAccountPlan.mockReset();
  resolveDuplicateRef.mockReset();
  writePlatformAudit.mockClear();
  recordActivity.mockClear();
  dispatchWebhookEvent.mockClear();
  emitSystemEvent.mockClear();
});

describe('POST /api/admin/accounts/[id]/billing/renew — payment_ref repetido', () => {
  beforeEach(() => {
    renewAccountPlan.mockResolvedValue({ ok: true, status: 'already_applied' });
  });

  const expectNoEffects = () => {
    expect(writePlatformAudit).not.toHaveBeenCalled();
    expect(recordActivity).not.toHaveBeenCalled();
    expect(dispatchWebhookEvent).not.toHaveBeenCalled();
    expect(emitSystemEvent).not.toHaveBeenCalled();
  };

  it('pagamento vigente desta conta: 200 already_applied (retentativa do sistema externo)', async () => {
    resolveDuplicateRef.mockResolvedValue('same_payment');
    const res = await POST(request(), params);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'already_applied' });
    expect(resolveDuplicateRef).toHaveBeenCalledWith(
      { marker: 'admin-db' },
      ACCOUNT,
      'E2E123'
    );
    expectNoEffects();
  });

  it('identificador de outra conta: 409 payment_ref_in_use', async () => {
    resolveDuplicateRef.mockResolvedValue('other_account');
    const res = await POST(request(), params);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'payment_ref_in_use' });
    expectNoEffects();
  });

  it('pagamento estornado pelo operador: 409 payment_ref_reversed', async () => {
    resolveDuplicateRef.mockResolvedValue('reversed');
    const res = await POST(request(), params);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'payment_ref_reversed' });
    expectNoEffects();
  });

  it('dono não verificável: 500, nunca already_applied', async () => {
    resolveDuplicateRef.mockResolvedValue('unknown');
    const res = await POST(request(), params);
    expect(res.status).toBe(500);
    expect(await res.json()).not.toHaveProperty('status', 'already_applied');
    expectNoEffects();
  });
});
