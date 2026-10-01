import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// SPEC 076 F4 — POST /api/whatsapp/billing/payment-ack (§9.3, §15.2)
//
// Roda com o `billing-server.ts` de verdade e o banco fake em memória: o
// que a rota precisa provar é papel, flag, validação e que a limpeza
// manual grava `payment_cleared_by` com reason 'manual'.
// ---------------------------------------------------------------------------

import type { AccountRole } from '@/lib/auth/roles';

const h = vi.hoisted(() => ({
  auth: null as null | {
    userId: string;
    accountId: string;
    role: AccountRole;
  },
  session: null as unknown,
  admin: null as unknown,
}));

vi.mock('@/lib/auth/account', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/account')>();
  const { hasMinRole } = await import('@/lib/auth/roles');
  return {
    ...actual,
    requireRole: vi.fn(async (min: AccountRole) => {
      if (!h.auth) throw new actual.UnauthorizedError();
      if (!hasMinRole(h.auth.role, min)) {
        throw new actual.ForbiddenError(
          `This action requires the '${min}' role or higher`
        );
      }
      return {
        supabase: h.session,
        userId: h.auth.userId,
        accountId: h.auth.accountId,
        role: h.auth.role,
        account: { id: h.auth.accountId, name: 'Conta' },
      };
    }),
  };
});

vi.mock('@/lib/supabase/admin', () => ({ supabaseAdmin: () => h.admin }));

import { __resetRateLimitForTests } from '@/lib/rate-limit';
import {
  BILLING_ROW_DEFAULTS,
  makeFakeDb,
  type FakeState,
  type WriteLog,
} from '@/lib/whatsapp/billing-fake-db';
import { __resetBillingServerStateForTests } from '@/lib/whatsapp/billing-server';

import { POST } from './route';

const ACCOUNT = 'acct-1';
const CHANNEL = '8f0c1d2e-3a4b-4c5d-8e6f-7a8b9c0d1e2f';
const WABA = '100000000004821';
const PENDING_SINCE = '2026-10-01T13:40:05.000Z';
const LAST_ERROR = '2026-10-01T13:58:42.000Z';

let state: FakeState;
let writes: WriteLog[];

function post(body: unknown) {
  return POST(
    new Request('http://localhost/api/whatsapp/billing/payment-ack', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    })
  );
}

function signIn(role: AccountRole, userId = `user-${role}`) {
  h.auth = { userId, accountId: ACCOUNT, role };
}

beforeEach(() => {
  __resetBillingServerStateForTests();
  __resetRateLimitForTests();
  writes = [];
  state = {
    channels: [
      {
        id: CHANNEL,
        account_id: ACCOUNT,
        type: 'whatsapp_cloud',
        status: 'connected',
        name: 'Principal',
        is_default: true,
        created_at: '2026-01-01T00:00:00.000Z',
      },
    ],
    whatsapp_config: [
      {
        id: 'cfg-1',
        account_id: ACCOUNT,
        channel_id: CHANNEL,
        phone_number_id: '900000000007781',
        waba_id: WABA,
        access_token: 'enc',
      },
    ],
    whatsapp_billing_status: [
      {
        ...BILLING_ROW_DEFAULTS,
        account_id: ACCOUNT,
        waba_id: WABA,
        payment_blocked_since: PENDING_SINCE,
        last_payment_error_at: LAST_ERROR,
      },
    ],
    platform_settings: [{ whatsapp_billing_monitor_enabled: true }],
  };
  h.session = makeFakeDb('session', state, writes);
  h.admin = makeFakeDb('admin', state, writes);
  signIn('admin');
});

describe('POST /api/whatsapp/billing/payment-ack', () => {
  it('401 sem sessão', async () => {
    h.auth = null;
    expect((await post({ channel_id: CHANNEL })).status).toBe(401);
  });

  it('403 para agent e viewer — e nada é limpo', async () => {
    for (const role of ['agent', 'viewer'] as const) {
      signIn(role);
      const res = await post({ channel_id: CHANNEL });
      expect(res.status).toBe(403);
    }
    expect(state.whatsapp_billing_status[0]!.payment_blocked_since).toBe(
      PENDING_SINCE
    );
    expect(writes).toHaveLength(0);
  });

  it('flag desligado: 404 para todo papel', async () => {
    state.platform_settings[0]!.whatsapp_billing_monitor_enabled = false;
    for (const role of ['owner', 'admin', 'agent', 'viewer'] as const) {
      signIn(role);
      const res = await post({ channel_id: CHANNEL });
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'Not found' });
    }
    expect(state.whatsapp_billing_status[0]!.payment_blocked_since).toBe(
      PENDING_SINCE
    );
  });

  it('400 sem channel_id, com id inválido ou com corpo que não é JSON', async () => {
    expect((await post({})).status).toBe(400);
    expect((await post({ channel_id: 'nope' })).status).toBe(400);
    expect((await post({ channel_id: 42 })).status).toBe(400);
    expect((await post('{ not json')).status).toBe(400);
  });

  it('404 para canal de outra conta, de outro tipo ou desativado', async () => {
    state.channels[0]!.account_id = 'acct-2';
    let res = await post({ channel_id: CHANNEL });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Channel not found' });

    state.channels[0]!.account_id = ACCOUNT;
    state.channels[0]!.type = 'whatsapp_qr';
    res = await post({ channel_id: CHANNEL });
    expect(res.status).toBe(404);

    state.channels[0]!.type = 'whatsapp_cloud';
    state.channels[0]!.status = 'disabled';
    res = await post({ channel_id: CHANNEL });
    expect(res.status).toBe(404);

    expect(state.whatsapp_billing_status[0]!.payment_blocked_since).toBe(
      PENDING_SINCE
    );
  });

  it("limpeza manual: grava payment_cleared_by, reason 'manual' e now()", async () => {
    signIn('admin', 'user-who-clicked');

    const before = Date.now();
    const res = await post({ channel_id: CHANNEL });
    const after = Date.now();

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.cleared).toBe(true);
    const clearedAt = Date.parse(body.cleared_at);
    expect(clearedAt).toBeGreaterThanOrEqual(before);
    expect(clearedAt).toBeLessThanOrEqual(after);

    expect(state.whatsapp_billing_status[0]).toMatchObject({
      payment_blocked_since: null,
      payment_cleared_by: 'user-who-clicked',
      payment_clear_reason: 'manual',
      payment_cleared_at: body.cleared_at,
      // memória do último erro preservada
      last_payment_error_at: LAST_ERROR,
    });
    // Escrita só pelo cliente service_role.
    expect(writes.every((w) => w.client === 'admin')).toBe(true);
  });

  it('falha ao ler o WABA do canal: 500, e o alerta continua aberto', async () => {
    h.session = makeFakeDb('session', state, writes, {
      fail: ({ table, verb }) =>
        table === 'whatsapp_config' && verb === 'select'
          ? { code: '57014', message: 'canceling statement' }
          : null,
    });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await post({ channel_id: CHANNEL });

    expect(res.status).toBe(500);
    expect(state.whatsapp_billing_status[0]!.payment_blocked_since).toBe(
      PENDING_SINCE
    );
    errorSpy.mockRestore();
  });

  it('owner também pode', async () => {
    signIn('owner');
    const res = await post({ channel_id: CHANNEL });
    expect((await res.json()).cleared).toBe(true);
  });

  it('sem pendência: 200 { cleared: false }', async () => {
    state.whatsapp_billing_status[0]!.payment_blocked_since = null;
    const res = await post({ channel_id: CHANNEL });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ cleared: false });
    expect(state.whatsapp_billing_status[0]!.payment_cleared_by).toBeNull();
  });

  it('clique duplo: o segundo vê cleared false e não sobrescreve o autor', async () => {
    signIn('admin', 'first');
    expect((await (await post({ channel_id: CHANNEL })).json()).cleared).toBe(
      true
    );
    signIn('admin', 'second');
    expect(await (await post({ channel_id: CHANNEL })).json()).toEqual({
      cleared: false,
    });
    expect(state.whatsapp_billing_status[0]!.payment_cleared_by).toBe('first');
  });

  it('não limpa o WABA de outra conta', async () => {
    state.whatsapp_billing_status.push({
      ...BILLING_ROW_DEFAULTS,
      account_id: 'acct-2',
      waba_id: WABA,
      payment_blocked_since: PENDING_SINCE,
    });
    await post({ channel_id: CHANNEL });
    expect(state.whatsapp_billing_status[1]!.payment_blocked_since).toBe(
      PENDING_SINCE
    );
  });
});
