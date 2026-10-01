import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// SPEC 076 F4 — GET /api/whatsapp/billing (§9.1, §9.2, §15.2)
//
// A rota roda COM o `billing-server.ts` de verdade: só o limite da sessão
// (quem é o usuário), o banco (fake em memória) e o `fetch` da Meta são
// simulados. É o que deixa provar o que só a rota decide — flag, papel,
// limite de taxa — sem testar um dublê da lógica.
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
  afterCallbacks: [] as Array<() => unknown>,
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

vi.mock('next/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/server')>()),
  after: (cb: () => unknown) => {
    h.afterCallbacks.push(cb);
  },
}));

import { __resetRateLimitForTests } from '@/lib/rate-limit';
import {
  BILLING_ROW_DEFAULTS,
  makeFakeDb,
  type FakeState,
  type Row,
  type WriteLog,
} from '@/lib/whatsapp/billing-fake-db';
import { __resetBillingServerStateForTests } from '@/lib/whatsapp/billing-server';
import { encrypt } from '@/lib/whatsapp/encryption';

import { GET } from './route';

const ACCOUNT = 'acct-1';
const CHANNEL = '8f0c1d2e-3a4b-4c5d-8e6f-7a8b9c0d1e2f';
const OTHER_CHANNEL = 'a71e0000-0000-4000-8000-000000000001';
const WABA = '100000000004821';
const TOKEN = 'EAAGtest0123456789abcdefghijklmnop';
const MIN = 60_000;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const inFuture = (ms: number) => new Date(Date.now() + ms).toISOString();

const HEALTH_OK = {
  currency: 'USD',
  health_status: {
    can_send_message: 'AVAILABLE',
    entities: [
      { entity_type: 'WABA', id: WABA, can_send_message: 'AVAILABLE' },
    ],
  },
};

function spendBody() {
  // Início do mês corrente (UTC−3), no relógio real do teste.
  const d = new Date();
  const start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1, 3) / 1000;
  return {
    pricing_analytics: {
      data: [
        {
          data_points: [
            {
              start,
              end: start + 86_400,
              pricing_category: 'MARKETING',
              volume: 113,
              cost: 7.0625,
            },
          ],
        },
      ],
    },
  };
}

type Handler = () => Response;
const ok =
  (body: unknown): Handler =>
  () =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
const metaError =
  (code: number, status: number): Handler =>
  () =>
    new Response(JSON.stringify({ error: { message: 'Meta error', code } }), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });

function stubMeta(handlers: { health?: Handler; spend?: Handler } = {}) {
  const fn = vi.fn(async (input: URL | string) => {
    const fields = new URL(String(input)).searchParams.get('fields') ?? '';
    const handler = fields.startsWith('pricing_analytics')
      ? (handlers.spend ?? ok(spendBody()))
      : (handlers.health ?? ok(HEALTH_OK));
    return handler();
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

let state: FakeState;
let writes: WriteLog[];

function seed(over: Row = {}) {
  state.whatsapp_billing_status.push({
    ...BILLING_ROW_DEFAULTS,
    account_id: ACCOUNT,
    waba_id: WABA,
    currency: 'USD',
    health_overall: 'AVAILABLE',
    health_entities: [],
    health_checked_at: ago(MIN),
    spend_period_start: new Date().toISOString().slice(0, 8) + '01',
    spend_tz_offset_seconds: 0,
    spend_total: 7.0625,
    spend_by_category: { MARKETING: { volume: 113, cost: 7.0625 } },
    spend_currency: 'USD',
    spend_checked_at: ago(MIN),
    ...over,
  });
}

function signIn(role: AccountRole) {
  h.auth = { userId: `user-${role}`, accountId: ACCOUNT, role };
}

beforeEach(() => {
  __resetBillingServerStateForTests();
  __resetRateLimitForTests();
  h.afterCallbacks = [];
  writes = [];
  state = {
    channels: [
      {
        id: CHANNEL,
        account_id: ACCOUNT,
        type: 'whatsapp_cloud',
        status: 'connected',
        name: 'Principal',
        identifier: '5511999990000',
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
        access_token: encrypt(TOKEN),
      },
    ],
    whatsapp_billing_status: [],
    platform_settings: [{ whatsapp_billing_monitor_enabled: true }],
  };
  h.session = makeFakeDb('session', state, writes);
  h.admin = makeFakeDb('admin', state, writes);
  signIn('admin');
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function get(query = '') {
  return GET(new Request(`http://localhost/api/whatsapp/billing${query}`));
}
const detail = (extra = '') => get(`?channel_id=${CHANNEL}${extra}`);

describe('GET /api/whatsapp/billing — autenticação, flag e validação', () => {
  it('401 sem sessão', async () => {
    h.auth = null;
    const meta = stubMeta();
    const res = await detail();
    expect(res.status).toBe(401);
    expect(meta).not.toHaveBeenCalled();
  });

  it('flag desligado: 404 para todo papel, na lista e no detalhe, sem tocar a Meta', async () => {
    state.platform_settings[0]!.whatsapp_billing_monitor_enabled = false;
    const meta = stubMeta();

    for (const role of ['owner', 'admin', 'agent', 'viewer'] as const) {
      signIn(role);
      for (const res of [
        await get(),
        await detail(),
        await detail('&refresh=1'),
      ]) {
        expect(res.status).toBe(404);
        expect(await res.json()).toEqual({ error: 'Not found' });
      }
    }
    expect(meta).not.toHaveBeenCalled();
    expect(writes).toHaveLength(0);
  });

  it('coluna do flag ausente (projeto sem a 086) também é 404, não 500', async () => {
    h.admin = makeFakeDb('admin', state, writes, {
      fail: ({ table }) =>
        table === 'platform_settings'
          ? { code: '42703', message: 'column does not exist' }
          : null,
    });
    expect((await detail()).status).toBe(404);
  });

  it('channel_id que não é UUID: 400', async () => {
    const res = await get('?channel_id=not-a-uuid');
    expect(res.status).toBe(400);
  });

  it('canal de outra conta, de outro tipo ou desativado: 404 "Channel not found"', async () => {
    const meta = stubMeta();

    state.channels[0]!.account_id = 'acct-2';
    let res = await detail();
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Channel not found' });

    state.channels[0]!.account_id = ACCOUNT;
    state.channels[0]!.type = 'whatsapp_qr';
    expect((await detail()).status).toBe(404);

    state.channels[0]!.type = 'whatsapp_cloud';
    state.channels[0]!.status = 'disabled';
    expect((await detail()).status).toBe(404);

    res = await get(`?channel_id=${OTHER_CHANNEL}`);
    expect(res.status).toBe(404);
    expect(meta).not.toHaveBeenCalled();
  });
});

describe('GET /api/whatsapp/billing?channel_id= — o painel de um número', () => {
  it('200 completo para admin: estado, consumo e carimbos, com o WABA mascarado', async () => {
    stubMeta();
    const res = await detail();
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body).toMatchObject({
      channel_id: CHANNEL,
      waba_id: '****4821',
      state: 'ok',
      stale: false,
      error: null,
      spend: { available: true, currency: 'USD', total: 7.0625 },
      payment: { pending: false },
    });
    expect(body.spend.by_category).toEqual([
      { category: 'MARKETING', volume: 113, cost: 7.0625 },
    ]);
    expect(JSON.stringify(body)).not.toContain(WABA);
    expect(JSON.stringify(body)).not.toContain(TOKEN);
  });

  it('agent e viewer: 200 SEM consumo e sem os carimbos do episódio', async () => {
    seed({
      payment_blocked_since: ago(20 * MIN),
      last_payment_error_at: ago(5 * MIN),
    });
    stubMeta();

    for (const role of ['agent', 'viewer'] as const) {
      signIn(role);
      const res = await detail();
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.state).toBe('payment_blocked');
      expect(body.payment).toEqual({ pending: true });
      expect('spend' in body).toBe(false);
    }
  });

  it('refresh=1 de agent/viewer: 403, sem gastar chamada da Meta', async () => {
    seed();
    const meta = stubMeta();
    for (const role of ['agent', 'viewer'] as const) {
      signIn(role);
      const res = await detail('&refresh=1');
      expect(res.status).toBe(403);
      expect((await res.json()).error).toContain("'admin' role");
    }
    expect(meta).not.toHaveBeenCalled();
  });

  it('refresh=1 de admin ignora o TTL', async () => {
    seed();
    const meta = stubMeta();
    const res = await detail('&refresh=1');
    expect(res.status).toBe(200);
    expect(meta).toHaveBeenCalledTimes(2);
  });

  it('Meta com 500: 200 com o último retrato, stale e error — nunca 5xx', async () => {
    seed({
      health_checked_at: ago(120 * MIN),
      spend_checked_at: ago(120 * MIN),
    });
    stubMeta({ health: metaError(1, 500), spend: metaError(1, 500) });

    const res = await detail();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      state: 'ok',
      stale: true,
      error: { field: 'health', kind: 'transient' },
    });
    expect(body.next_retry_at).toBeTruthy();
  });

  it('Meta fora e sem nenhum retrato: 200 unknown', async () => {
    stubMeta({ health: metaError(1, 503), spend: metaError(1, 503) });
    const res = await detail();
    expect(res.status).toBe(200);
    expect((await res.json()).state).toBe('unknown');
  });

  it('o admin vê a mensagem do erro; o agent não', async () => {
    seed({
      health_checked_at: ago(120 * MIN),
      spend_checked_at: ago(120 * MIN),
    });
    stubMeta({ health: metaError(1, 500), spend: metaError(1, 500) });

    const admin = await (await detail()).json();
    expect(admin.error.message).toContain('Meta error');

    // Em recuo agora: o agent só lê o que está gravado.
    signIn('agent');
    const agent = await (await detail()).json();
    expect(agent.error.kind).toBe('transient');
    expect('message' in agent.error).toBe(false);
  });

  it('429 no 7º refresh/min do usuário', async () => {
    // Tudo em recuo: o refresh não chama a Meta e não consome o cooldown
    // por WABA — o que sobra para barrar é o balde do usuário.
    seed({
      health_next_retry_at: inFuture(30 * MIN),
      spend_next_retry_at: inFuture(30 * MIN),
    });
    stubMeta();

    for (let i = 1; i <= 6; i++) {
      expect((await detail('&refresh=1')).status).toBe(200);
    }
    const res = await detail('&refresh=1');
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.error).toBe('Too many refresh requests');
    expect(body.retry_after_seconds).toBeGreaterThanOrEqual(1);
    expect(body.retry_after_seconds).toBeLessThanOrEqual(60);
    expect(res.headers.get('Retry-After')).toBe(
      String(body.retry_after_seconds)
    );

    // O aberto comum (sem refresh) não é limitado.
    expect((await detail()).status).toBe(200);
  });

  it('429 quando o MESMO WABA é forçado de novo antes de 60 s', async () => {
    seed();
    const meta = stubMeta();

    expect((await detail('&refresh=1')).status).toBe(200);
    const calls = meta.mock.calls.length;

    const res = await detail('&refresh=1');
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.error).toBe('Too many refresh requests');
    expect(body.retry_after_seconds).toBeGreaterThan(0);
    expect(body.retry_after_seconds).toBeLessThanOrEqual(60);
    expect(meta.mock.calls.length).toBe(calls);
  });

  it('o balde de refresh é por usuário', async () => {
    seed({
      health_next_retry_at: inFuture(30 * MIN),
      spend_next_retry_at: inFuture(30 * MIN),
    });
    stubMeta();
    for (let i = 0; i < 6; i++) await detail('&refresh=1');
    expect((await detail('&refresh=1')).status).toBe(429);

    h.auth = { userId: 'user-outro-admin', accountId: ACCOUNT, role: 'admin' };
    expect((await detail('&refresh=1')).status).toBe(200);
  });

  it('um refresh recusado por papel (403) não gasta o balde', async () => {
    seed({
      health_next_retry_at: inFuture(30 * MIN),
      spend_next_retry_at: inFuture(30 * MIN),
    });
    stubMeta();
    signIn('agent');
    for (let i = 0; i < 10; i++) {
      expect((await detail('&refresh=1')).status).toBe(403);
    }
    // O balde é por userId. Promovido a admin, o MESMO usuário ainda tem
    // os 6 refreshes inteiros: o 403 do papel veio antes do limite.
    h.auth = { userId: 'user-agent', accountId: ACCOUNT, role: 'admin' };
    for (let i = 0; i < 6; i++) {
      expect((await detail('&refresh=1')).status).toBe(200);
    }
    expect((await detail('&refresh=1')).status).toBe(429);
  });
});

describe('GET /api/whatsapp/billing — a lista (§9.2)', () => {
  it('sem channel_id: resumo lido do banco, sem chamar a Meta', async () => {
    seed();
    const meta = stubMeta();

    const res = await get();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.worst_state).toBe('ok');
    expect(body.channels).toEqual([
      expect.objectContaining({
        channel_id: CHANNEL,
        state: 'ok',
        stale: false,
        currency: 'USD',
        spend_total: 7.0625,
      }),
    ]);
    expect(meta).not.toHaveBeenCalled();
  });

  it('?channel_id= vazio é a lista, não "canal não existe"', async () => {
    seed();
    stubMeta();
    const res = await get('?channel_id=');
    expect(res.status).toBe(200);
    expect((await res.json()).channels).toHaveLength(1);
  });

  it('retrato vencido: a lista responde na hora e atualiza em after()', async () => {
    const meta = stubMeta();

    const res = await get();
    expect(res.status).toBe(200);
    expect((await res.json()).channels[0].state).toBe('unknown');
    expect(meta).not.toHaveBeenCalled();
    expect(h.afterCallbacks).toHaveLength(1);

    await h.afterCallbacks[0]!();
    expect(meta).toHaveBeenCalledTimes(2);
    expect(state.whatsapp_billing_status[0]).toMatchObject({
      health_overall: 'AVAILABLE',
    });
  });

  it('agent não recebe moeda nem consumo na lista', async () => {
    seed();
    stubMeta();
    signIn('agent');
    const body = await (await get()).json();
    expect('spend_total' in body.channels[0]).toBe(false);
    expect('currency' in body.channels[0]).toBe(false);
  });
});
