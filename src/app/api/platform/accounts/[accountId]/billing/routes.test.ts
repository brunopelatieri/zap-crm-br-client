import { beforeEach, describe, expect, it, vi } from 'vitest';

// Porta fechada (SPEC 078 §13 item 17): qualquer falha de
// `requirePlatformOwner` — sessão ausente, e-mail fora da lista — vira
// 404 em TODAS as rotas de cobrança do console, sem tocar no banco.

const requirePlatformOwner = vi.fn();
vi.mock('@/lib/platform/owner', () => ({
  requirePlatformOwner: () => requirePlatformOwner(),
}));

vi.mock('@/lib/supabase/admin', () => ({
  supabaseAdmin: () => ({ marker: 'admin-db' }),
}));

const changePlanPeriodEnd = vi.fn();
const recordManualPayment = vi.fn();
const listPayments = vi.fn();
const reverseManualPayment = vi.fn();
vi.mock('@/lib/platform/billing-console', () => ({
  changePlanPeriodEnd: (...args: unknown[]) => changePlanPeriodEnd(...args),
  recordManualPayment: (...args: unknown[]) => recordManualPayment(...args),
  listPayments: (...args: unknown[]) => listPayments(...args),
  reverseManualPayment: (...args: unknown[]) => reverseManualPayment(...args),
}));

import { PUT as putPeriodEnd } from './period-end/route';
import { GET as getPayments, POST as postPayment } from './payments/route';
import { POST as postReverse } from './payments/[paymentId]/reverse/route';

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const PAYMENT = '22222222-2222-4222-8222-222222222222';

const jsonRequest = (body: unknown) =>
  new Request('http://localhost/api/platform/test', {
    method: 'POST',
    body: JSON.stringify(body),
  });

const accountParams = { params: Promise.resolve({ accountId: ACCOUNT }) };
const reverseParams = {
  params: Promise.resolve({ accountId: ACCOUNT, paymentId: PAYMENT }),
};

beforeEach(() => {
  requirePlatformOwner.mockReset();
  changePlanPeriodEnd.mockReset();
  recordManualPayment.mockReset();
  listPayments.mockReset();
  reverseManualPayment.mockReset();
});

describe('sem sessão de proprietário → 404 em todas as rotas', () => {
  beforeEach(() => {
    requirePlatformOwner.mockRejectedValue(new Error('Not a platform owner'));
  });

  it('PUT period-end', async () => {
    const res = await putPeriodEnd(
      jsonRequest({ date: '2026-12-20' }),
      accountParams
    );
    expect(res.status).toBe(404);
    expect(changePlanPeriodEnd).not.toHaveBeenCalled();
  });

  it('GET payments', async () => {
    const res = await getPayments(
      new Request('http://localhost/x'),
      accountParams
    );
    expect(res.status).toBe(404);
    expect(listPayments).not.toHaveBeenCalled();
  });

  it('POST payments', async () => {
    const res = await postPayment(jsonRequest({}), accountParams);
    expect(res.status).toBe(404);
    expect(recordManualPayment).not.toHaveBeenCalled();
  });

  it('POST reverse', async () => {
    const res = await postReverse(jsonRequest({}), reverseParams);
    expect(res.status).toBe(404);
    expect(reverseManualPayment).not.toHaveBeenCalled();
  });

  it('o 404 é uma Response nova a cada requisição (o corpo é legível sempre)', async () => {
    for (let i = 0; i < 3; i++) {
      const res = await getPayments(
        new Request('http://localhost/x'),
        accountParams
      );
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'Not found' });
    }
  });
});

describe('com proprietário', () => {
  beforeEach(() => {
    requirePlatformOwner.mockResolvedValue({
      email: 'bruno@zapcrmbr.com',
      userId: 'owner-1',
    });
  });

  it('PUT period-end: repassa conta, e-mail do proprietário e corpo; devolve o resultado', async () => {
    changePlanPeriodEnd.mockResolvedValue({
      ok: true,
      data: { status: 'active' },
    });
    const res = await putPeriodEnd(
      jsonRequest({ date: '2026-12-20' }),
      accountParams
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'active' });
    expect(changePlanPeriodEnd).toHaveBeenCalledWith(
      { marker: 'admin-db' },
      {
        accountId: ACCOUNT,
        ownerEmail: 'bruno@zapcrmbr.com',
        body: { date: '2026-12-20' },
      }
    );
  });

  it('falha de negócio vira status + code + error no corpo', async () => {
    recordManualPayment.mockResolvedValue({
      ok: false,
      status: 400,
      code: 'payment_ref_required',
      error: "'paymentRef' is required",
    });
    const res = await postPayment(jsonRequest({}), accountParams);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "'paymentRef' is required",
      code: 'payment_ref_required',
    });
  });

  it('corpo que não é JSON chega como null ao orquestrador', async () => {
    reverseManualPayment.mockResolvedValue({ ok: true, data: {} });
    const bad = new Request('http://localhost/x', {
      method: 'POST',
      body: '{',
    });
    await postReverse(bad, reverseParams);
    expect(reverseManualPayment.mock.calls[0][1].body).toBeNull();
  });

  it('accountId que não é UUID → 404 sem chamar o orquestrador', async () => {
    const res = await putPeriodEnd(jsonRequest({}), {
      params: Promise.resolve({ accountId: 'nao-e-uuid' }),
    });
    expect(res.status).toBe(404);
    expect(changePlanPeriodEnd).not.toHaveBeenCalled();
  });

  it('paymentId que não é UUID → 404 sem chamar o orquestrador', async () => {
    const res = await postReverse(jsonRequest({}), {
      params: Promise.resolve({ accountId: ACCOUNT, paymentId: '1; drop' }),
    });
    expect(res.status).toBe(404);
    expect(reverseManualPayment).not.toHaveBeenCalled();
  });
});
