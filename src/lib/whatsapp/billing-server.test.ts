/**
 * SPEC 076 F4 — `billing-server.ts` (§7.2, §7.5, §7.6, §9, §15.1).
 *
 * Aqui o `fetch` é o ÚNICO limite simulado da Meta (billing-graph.ts roda
 * de verdade) e o banco é o fake em memória de `billing-fake-db.ts`, que
 * filtra por `account_id` e mescla o upsert de verdade. É isso que deixa
 * provar o que importa: o que NÃO sai (token na URL/log/resposta/tabela),
 * o que NÃO é gravado (`payment_*`) e o que NÃO é chamado (retrato fresco).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { afterState } = vi.hoisted(() => ({
  afterState: { callbacks: [] as Array<() => unknown>, throws: false },
}));
vi.mock('next/server', () => ({
  after: (cb: () => unknown) => {
    if (afterState.throws) throw new Error('after outside request scope');
    afterState.callbacks.push(cb);
  },
}));

// Sem as variáveis de ambiente `createClient` lança: é o caso do achado de
// `isBillingMonitorEnabled()` sem argumento. Todo o resto dos testes passa
// o `admin` explicitamente, então este mock não os afeta.
vi.mock('@/lib/supabase/admin', () => ({
  supabaseAdmin: () => {
    throw new Error('supabaseUrl is required.');
  },
}));

// Só para provar que a limpeza manual descarta o retrato de processo do
// sinal de pagamento; o resto do módulo roda de verdade.
const { signalSpy } = vi.hoisted(() => ({ signalSpy: { invalidate: 0 } }));
vi.mock('./billing-signal', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./billing-signal')>()),
  invalidatePaymentSignalCache: () => {
    signalSpy.invalidate++;
  },
}));

import type { SupabaseClient } from '@supabase/supabase-js';

import {
  BILLING_ROW_DEFAULTS,
  makeFakeDb,
  type FakeDbOptions,
  type FakeState,
  type Row,
  type WriteLog,
} from './billing-fake-db';
import {
  __resetBillingServerStateForTests,
  acknowledgePayment,
  isBillingMonitorEnabled,
  loadBillingSummary,
  loadChannelBilling,
  resetBillingReadErrors,
  type BillingLoadResult,
  type LoadChannelBillingOptions,
} from './billing-server';
import { encrypt } from './encryption';
import type { ChannelBillingDto } from './billing-dto';

const ACCOUNT = 'acct-1';
const OTHER_ACCOUNT = 'acct-2';
const CHANNEL = 'chan-1';
const WABA = '100000000004821';
const BUSINESS = '200000000000111';
const TOKEN = 'EAAGtest0123456789abcdefghijklmnop';
const NOW = new Date('2026-10-15T15:00:00.000Z');
const MIN = 60_000;
const ago = (ms: number, from: Date = NOW) =>
  new Date(from.getTime() - ms).toISOString();
const inFuture = (ms: number, from: Date = NOW) =>
  new Date(from.getTime() + ms).toISOString();

// ------------------------------------------------------------
// Fixtures da Meta (payloads do §4.1)
// ------------------------------------------------------------

const HEALTH_OK = {
  id: WABA,
  currency: 'USD',
  health_status: {
    can_send_message: 'AVAILABLE',
    entities: [
      { entity_type: 'WABA', id: WABA, can_send_message: 'AVAILABLE' },
      { entity_type: 'BUSINESS', id: BUSINESS, can_send_message: 'AVAILABLE' },
    ],
  },
};

/** Meia-noite local de UTC−3, em segundos Unix. */
const localMidnight = (month: number, day: number) =>
  Date.UTC(2026, month - 1, day, 3) / 1000;

const SPEND_OK = {
  pricing_analytics: {
    data: [
      {
        data_points: [
          // Do mês anterior: tem de ficar de fora.
          {
            start: localMidnight(9, 30),
            end: localMidnight(10, 1),
            pricing_category: 'MARKETING',
            volume: 50,
            cost: 3,
          },
          {
            start: localMidnight(10, 1),
            end: localMidnight(10, 2),
            pricing_category: 'MARKETING',
            volume: 113,
            cost: 7.0625,
          },
          {
            start: localMidnight(10, 2),
            end: localMidnight(10, 3),
            pricing_category: 'SERVICE',
            volume: 6,
            cost: 0,
          },
        ],
      },
    ],
  },
  id: WABA,
};

function metaError(code: number, message: string, status: number) {
  return () =>
    new Response(
      JSON.stringify({ error: { message, type: 'OAuthException', code } }),
      { status, headers: { 'Content-Type': 'application/json' } }
    );
}

function ok(body: unknown) {
  return () =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
}

type Handler = () => Response | Promise<Response>;

/** `fetch` simulado: despacha por campo (`health_status` × `pricing_analytics`). */
function stubMeta(handlers: { health?: Handler; spend?: Handler } = {}) {
  const fn = vi.fn(async (input: URL | string) => {
    const url = new URL(String(input));
    const fields = url.searchParams.get('fields') ?? '';
    const h = fields.startsWith('pricing_analytics')
      ? (handlers.spend ?? ok(SPEND_OK))
      : (handlers.health ?? ok(HEALTH_OK));
    return h();
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

const fieldOf = (call: unknown[]) =>
  new URL(String(call[0])).searchParams.get('fields') ?? '';
const healthCalls = (fn: ReturnType<typeof stubMeta>) =>
  fn.mock.calls.filter((c) => !fieldOf(c).startsWith('pricing_analytics'));
const spendCalls = (fn: ReturnType<typeof stubMeta>) =>
  fn.mock.calls.filter((c) => fieldOf(c).startsWith('pricing_analytics'));

// ------------------------------------------------------------
// Mundo de teste
// ------------------------------------------------------------

let state: FakeState;
let writes: WriteLog[];
let logs: string[];

function baseState(): FakeState {
  return {
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
}

/** Linha completa de `whatsapp_billing_status`, no estado "fresco e ok". */
function seed(over: Row = {}): Row {
  const r: Row = {
    ...BILLING_ROW_DEFAULTS,
    account_id: ACCOUNT,
    waba_id: WABA,
    currency: 'USD',
    health_overall: 'AVAILABLE',
    health_entities: [],
    business_id: BUSINESS,
    health_checked_at: ago(MIN),
    spend_period_start: '2026-10-01',
    spend_tz_offset_seconds: -10800,
    spend_total: 7.0625,
    spend_by_category: { MARKETING: { volume: 113, cost: 7.0625 } },
    spend_currency: 'USD',
    spend_checked_at: ago(MIN),
    created_at: ago(60 * MIN),
    updated_at: ago(MIN),
    ...over,
  };
  state.whatsapp_billing_status.push(r);
  return r;
}

const stored = (): Row => {
  const r = state.whatsapp_billing_status.find(
    (x) => x.account_id === ACCOUNT && x.waba_id === WABA
  );
  if (!r) throw new Error('no stored snapshot');
  return r;
};

function dbs(options?: FakeDbOptions) {
  return {
    db: makeFakeDb('session', state, writes, options),
    admin: makeFakeDb('admin', state, writes, options),
  };
}

async function load(
  opts: Partial<LoadChannelBillingOptions> = {},
  dbOptions?: FakeDbOptions
): Promise<BillingLoadResult> {
  const { db, admin } = dbs(dbOptions);
  return loadChannelBilling(db, ACCOUNT, CHANNEL, {
    role: 'admin',
    now: NOW,
    admin,
    ...opts,
  });
}

async function loadDto(
  opts: Partial<LoadChannelBillingOptions> = {},
  dbOptions?: FakeDbOptions
): Promise<ChannelBillingDto> {
  const res = await load(opts, dbOptions);
  if (res.status !== 'ok') throw new Error(`expected ok, got ${res.status}`);
  return res.dto;
}

const billingWrites = () =>
  writes.filter((w) => w.table === 'whatsapp_billing_status');

beforeEach(() => {
  __resetBillingServerStateForTests();
  state = baseState();
  writes = [];
  logs = [];
  afterState.callbacks = [];
  afterState.throws = false;
  for (const level of ['log', 'warn', 'error'] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      logs.push(
        args
          .map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))
          .join(' ')
      );
    });
  }
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ============================================================
// Cache e TTL (§7.5)
// ============================================================

describe('loadChannelBilling — cache e TTL', () => {
  it('retrato fresco NÃO chama a Meta nem grava', async () => {
    seed();
    const meta = stubMeta();

    const dto = await loadDto();

    expect(meta).not.toHaveBeenCalled();
    expect(billingWrites()).toHaveLength(0);
    expect(dto.state).toBe('ok');
    expect(dto.spend?.total).toBe(7.0625);
  });

  it('sem retrato: chama os DOIS campos em paralelo e grava o resultado', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const meta = stubMeta({
      health: async () => {
        await gate;
        return ok(HEALTH_OK)();
      },
      spend: async () => {
        await gate;
        return ok(SPEND_OK)();
      },
    });

    const pending = load();
    // Se fossem em série, o segundo `fetch` só sairia depois do primeiro
    // resolver — e o portão só abre depois dos dois.
    await vi.waitFor(() => expect(meta).toHaveBeenCalledTimes(2));
    release();
    const res = await pending;

    expect(res.status).toBe('ok');
    expect(healthCalls(meta)).toHaveLength(1);
    expect(spendCalls(meta)).toHaveLength(1);

    const row = stored();
    expect(row).toMatchObject({
      currency: 'USD',
      health_overall: 'AVAILABLE',
      business_id: BUSINESS,
      health_checked_at: NOW.toISOString(),
      spend_period_start: '2026-10-01',
      spend_tz_offset_seconds: -10800,
      spend_total: 7.0625,
      spend_currency: 'USD',
      spend_checked_at: NOW.toISOString(),
    });
    // Um carimbo por rodada.
    expect(row.health_checked_at).toBe(row.spend_checked_at);
  });

  it('só o campo vencido vai à Meta, e o patch leva só as colunas dele', async () => {
    seed({ spend_checked_at: ago(20 * MIN) });
    const meta = stubMeta();

    await load();

    expect(healthCalls(meta)).toHaveLength(0);
    expect(spendCalls(meta)).toHaveLength(1);
    const keys = Object.keys(billingWrites()[0]!.payload);
    expect(keys).toContain('spend_total');
    expect(keys).not.toContain('health_overall');
    expect(keys).not.toContain('health_checked_at');
  });

  it('virada de mês invalida o consumo mesmo dentro do TTL', async () => {
    seed({
      spend_period_start: '2026-09-01',
      spend_total: 99,
      spend_checked_at: ago(MIN),
    });
    const meta = stubMeta();

    const dto = await loadDto();

    expect(healthCalls(meta)).toHaveLength(0);
    expect(spendCalls(meta)).toHaveLength(1);
    expect(dto.spend?.total).toBe(7.0625);
    expect(dto.spend?.period_start).toBe('2026-10-01');
  });

  it('virada de mês + Meta fora: o valor de setembro NÃO aparece como de outubro', async () => {
    seed({
      spend_period_start: '2026-09-01',
      spend_total: 99,
      spend_checked_at: ago(MIN),
    });
    stubMeta({ spend: metaError(2, 'Service unavailable', 503) });

    const dto = await loadDto();

    expect(dto.spend?.available).toBe(false);
    expect(dto.spend?.total).toBeNull();
    expect(JSON.stringify(dto)).not.toContain('99');
  });

  it('agrega o consumo só do mês local e na moeda do WABA', async () => {
    stubMeta();
    const dto = await loadDto();
    expect(dto.spend).toMatchObject({
      available: true,
      currency: 'USD',
      total: 7.0625,
      period_start: '2026-10-01',
    });
    expect(dto.spend?.by_category).toEqual([
      { category: 'MARKETING', volume: 113, cost: 7.0625 },
      { category: 'SERVICE', volume: 6, cost: 0 },
    ]);
  });
});

// ============================================================
// force (§7.6, §9.1)
// ============================================================

describe('loadChannelBilling — force', () => {
  it('ignora o TTL', async () => {
    seed();
    const meta = stubMeta();

    await load({ force: true });

    expect(healthCalls(meta)).toHaveLength(1);
    expect(spendCalls(meta)).toHaveLength(1);
  });

  it('respeita next_retry_at: o campo em recuo não é chamado nem forçado', async () => {
    seed({
      health_checked_at: ago(60 * MIN),
      health_error_kind: 'rate_limit',
      health_error_at: ago(MIN),
      health_consecutive_failures: 1,
      health_next_retry_at: inFuture(30 * MIN),
    });
    const meta = stubMeta();

    const dto = await loadDto({ force: true });

    expect(healthCalls(meta)).toHaveLength(0);
    expect(spendCalls(meta)).toHaveLength(1);
    expect(dto.next_retry_at).toBe(inFuture(30 * MIN));
  });

  it('1 leitura forçada por WABA a cada 60 s → throttled com retry_after', async () => {
    seed();
    const meta = stubMeta();

    expect((await load({ force: true })).status).toBe('ok');
    const calls = meta.mock.calls.length;

    const second = await load({
      force: true,
      now: new Date(NOW.getTime() + 20_000),
    });
    expect(second).toEqual({ status: 'throttled', retryAfterSeconds: 40 });
    expect(meta.mock.calls.length).toBe(calls);

    // Passados os 60 s, libera.
    const third = await load({
      force: true,
      now: new Date(NOW.getTime() + 61_000),
    });
    expect(third.status).toBe('ok');
    expect(meta.mock.calls.length).toBeGreaterThan(calls);
  });

  it('force sem nada a chamar (tudo em recuo) não consome o cooldown', async () => {
    seed({
      health_next_retry_at: inFuture(10 * MIN),
      spend_next_retry_at: inFuture(10 * MIN),
    });
    const meta = stubMeta();

    expect((await load({ force: true })).status).toBe('ok');
    expect((await load({ force: true })).status).toBe('ok');
    expect(meta).not.toHaveBeenCalled();
  });

  it('é a saída do auth_error sem salvar a credencial: o force chama, o aberto comum não', async () => {
    seed({
      health_checked_at: ago(60 * MIN),
      health_error_kind: 'auth',
      health_error_code: 190,
      health_error_at: ago(30 * MIN),
      health_consecutive_failures: 1,
    });
    const meta = stubMeta();

    const blocked = await loadDto();
    expect(blocked.state).toBe('auth_error');
    expect(healthCalls(meta)).toHaveLength(0);

    const forced = await loadDto({ force: true });
    expect(healthCalls(meta)).toHaveLength(1);
    expect(forced.state).toBe('ok');
    expect(stored().health_error_kind).toBeNull();
  });
});

// ============================================================
// Falhas da Meta (§6.2, §7.6, §13.2)
// ============================================================

describe('loadChannelBilling — falhas da Meta', () => {
  it('falha de um campo NÃO apaga o outro, e a Meta fora vira 200 + stale', async () => {
    seed({
      health_overall: 'LIMITED',
      health_checked_at: ago(10 * MIN),
      spend_total: 5,
      spend_checked_at: ago(20 * MIN),
    });
    stubMeta({
      health: metaError(2, 'Service temporarily unavailable', 503),
      spend: ok(SPEND_OK),
    });

    const res = await load();
    expect(res.status).toBe('ok');
    const dto = (res as { dto: ChannelBillingDto }).dto;

    // Status: mantém o último retrato, marca stale e registra o erro.
    const row = stored();
    expect(row.health_overall).toBe('LIMITED');
    expect(row.health_checked_at).toBe(ago(10 * MIN));
    expect(row).toMatchObject({
      health_error_kind: 'transient',
      health_error_code: 2,
      health_consecutive_failures: 1,
      health_next_retry_at: inFuture(2 * MIN),
    });
    expect(dto.state).toBe('limited');
    expect(dto.stale).toBe(true);
    expect(dto.error).toMatchObject({ field: 'health', kind: 'transient' });

    // Consumo: gravou normalmente, sem erro.
    expect(row.spend_total).toBe(7.0625);
    expect(row.spend_error_kind).toBeNull();
  });

  it('falha só do consumo não toca o estado de envio nem o consumo anterior', async () => {
    seed({
      health_checked_at: ago(10 * MIN),
      spend_total: 5,
      spend_checked_at: ago(20 * MIN),
    });
    stubMeta({ spend: metaError(80008, 'Rate limit', 429) });

    const dto = await loadDto();

    const row = stored();
    expect(row.health_error_kind).toBeNull();
    expect(row.health_checked_at).toBe(NOW.toISOString());
    expect(row.spend_total).toBe(5);
    expect(row).toMatchObject({
      spend_error_kind: 'rate_limit',
      spend_error_code: 80008,
      spend_consecutive_failures: 1,
    });
    expect(dto.state).toBe('ok');
    expect(dto.stale).toBe(false);
    expect(dto.error).toMatchObject({ field: 'spend', kind: 'rate_limit' });
  });

  it('sucesso de uma leitura zera erro, contador e retry DAQUELA leitura', async () => {
    seed({
      health_checked_at: ago(10 * MIN),
      health_error_kind: 'transient',
      health_error_code: 2,
      health_error_message: 'x',
      health_error_at: ago(5 * MIN),
      health_consecutive_failures: 2,
      health_next_retry_at: ago(MIN),
      spend_checked_at: ago(20 * MIN),
      spend_error_kind: 'transient',
      spend_error_at: ago(5 * MIN),
      spend_consecutive_failures: 3,
      spend_next_retry_at: ago(MIN),
    });
    stubMeta();

    await load();

    expect(stored()).toMatchObject({
      health_error_kind: null,
      health_error_code: null,
      health_error_message: null,
      health_error_at: null,
      health_consecutive_failures: 0,
      health_next_retry_at: null,
      spend_error_kind: null,
      spend_error_at: null,
      spend_consecutive_failures: 0,
      spend_next_retry_at: null,
    });
  });

  it('limite de taxa: recuo = max(espera da Meta, 2^n), e nada é chamado até lá', async () => {
    const usage = JSON.stringify({
      [WABA]: [
        {
          type: 'whatsapp_business_management',
          call_count: 100,
          estimated_time_to_regain_access: 45,
        },
      ],
    });
    stubMeta({
      health: () =>
        new Response(
          JSON.stringify({ error: { message: 'Rate limit', code: 80008 } }),
          {
            status: 429,
            headers: {
              'Content-Type': 'application/json',
              'X-Business-Use-Case-Usage': usage,
            },
          }
        ),
    });

    const dto = await loadDto();
    expect(stored()).toMatchObject({
      health_error_kind: 'rate_limit',
      health_next_retry_at: inFuture(45 * MIN),
    });
    expect(dto.next_retry_at).toBe(inFuture(45 * MIN));

    // Dentro do recuo: nem o aberto comum nem o force chamam a Meta.
    const meta = stubMeta();
    const later = new Date(NOW.getTime() + 10 * MIN);
    await load({ now: later });
    await load({ now: later, force: true });
    expect(healthCalls(meta)).toHaveLength(0);
  });

  it('falhas seguidas dobram o recuo e o alerta de 3 falhas vai ao log', async () => {
    seed({
      health_checked_at: ago(60 * MIN),
      health_error_kind: 'transient',
      health_error_at: ago(10 * MIN),
      health_consecutive_failures: 2,
      health_next_retry_at: ago(MIN),
    });
    stubMeta({ health: metaError(1, 'Unknown error', 500) });

    await load();

    expect(stored()).toMatchObject({
      health_consecutive_failures: 3,
      health_next_retry_at: inFuture(8 * MIN),
    });
    expect(logs.join('\n')).toContain('ALERT health read failing');
  });

  it('token recusado (190): auth_error sem recuo, e o aberto seguinte não repete', async () => {
    const failing = stubMeta({
      health: metaError(190, 'Invalid OAuth access token', 401),
      spend: metaError(190, 'Invalid OAuth access token', 401),
    });

    const dto = await loadDto();
    expect(dto.state).toBe('auth_error');
    expect(stored()).toMatchObject({
      health_error_kind: 'auth',
      health_next_retry_at: null,
    });
    const calls = failing.mock.calls.length;

    // Dois minutos depois, retrato ainda "vencido": não adianta repetir.
    const again = await loadDto({ now: new Date(NOW.getTime() + 2 * MIN) });
    expect(again.state).toBe('auth_error');
    expect(failing.mock.calls.length).toBe(calls);
  });

  it('timeout/rede: transitório, 200 e nunca exceção', async () => {
    seed({ health_checked_at: ago(10 * MIN) });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new DOMException('The operation timed out', 'TimeoutError');
      })
    );

    const res = await load();

    expect(res.status).toBe('ok');
    expect(stored().health_error_kind).toBe('transient');
    expect(stored().spend_error_kind).toBeNull(); // consumo fresco: não chamado
  });

  it('código 100 (campo/versão): unknown, com recuo e alerta de log', async () => {
    stubMeta({ health: metaError(100, 'Invalid parameter', 400) });

    const dto = await loadDto();

    expect(dto.state).toBe('unknown');
    expect(stored().health_error_kind).toBe('unknown');
    expect(stored().health_next_retry_at).toBe(inFuture(2 * MIN));
    expect(logs.join('\n')).toContain('ALERT code=100');
  });

  it('conta restrita por política (368): vira BLOQUEADO com o texto, não erro de leitura', async () => {
    stubMeta({
      health: metaError(368, 'Account temporarily blocked for policy', 403),
    });

    const dto = await loadDto();

    expect(dto.state).toBe('blocked');
    expect(dto.stale).toBe(false);
    expect(stored().health_error_kind).toBeNull();
    expect(dto.send_status.problems[0]?.errors[0]).toMatchObject({
      error_code: 368,
      error_description: expect.stringContaining('blocked for policy'),
    });
  });

  it('token que não decifra: auth_error sem chamar a Meta', async () => {
    state.whatsapp_config[0]!.access_token = 'not-a-valid-ciphertext';
    const meta = stubMeta();

    const dto = await loadDto();

    expect(meta).not.toHaveBeenCalled();
    expect(dto.state).toBe('auth_error');
    expect(stored()).toMatchObject({
      health_error_kind: 'auth',
      health_error_message: 'Stored access token cannot be decrypted',
    });
  });
});

// ============================================================
// Pagamento e UPSERT (contratos da F3)
// ============================================================

describe('loadChannelBilling — o UPSERT não toca o pagamento', () => {
  const PAYMENT = {
    payment_blocked_since: '2026-10-15T13:40:05.000Z',
    last_payment_error_at: '2026-10-15T13:58:42.000Z',
    last_payment_error_phone_number_id: '900000000007781',
  };

  it('nenhuma escrita do retrato leva colunas payment_* / last_payment_*', async () => {
    seed({ ...PAYMENT, health_checked_at: ago(10 * MIN) });
    stubMeta({ spend: metaError(2, 'x', 503) });

    await load({ force: true });

    expect(billingWrites().length).toBeGreaterThan(0);
    for (const w of billingWrites()) {
      for (const key of Object.keys(w.payload)) {
        expect(key).not.toMatch(/^(payment_|last_payment_)/);
      }
    }
    expect(stored()).toMatchObject(PAYMENT);
  });

  it('um 131042 gravado no MEIO da leitura da Graph sobrevive e aparece na resposta', async () => {
    seed({ health_checked_at: ago(10 * MIN) });
    stubMeta({
      health: async () => {
        // Webhook abre um episódio enquanto a Graph ainda responde.
        Object.assign(stored(), PAYMENT);
        return ok(HEALTH_OK)();
      },
    });

    const dto = await loadDto();

    expect(dto.state).toBe('payment_blocked');
    expect(dto.payment).toMatchObject({
      pending: true,
      since: PAYMENT.payment_blocked_since,
    });
    expect(stored().payment_blocked_since).toBe(PAYMENT.payment_blocked_since);
  });

  it('health AVAILABLE nunca limpa o pagamento pendente (D-4)', async () => {
    seed({ ...PAYMENT, health_checked_at: ago(10 * MIN) });
    stubMeta();

    const dto = await loadDto();

    expect(dto.send_status.overall).toBe('AVAILABLE');
    expect(dto.state).toBe('payment_blocked');
    expect(stored().payment_blocked_since).toBe(PAYMENT.payment_blocked_since);
  });
});

// ============================================================
// Papéis (D-8) e isolamento (RNF-02)
// ============================================================

describe('loadChannelBilling — papéis e isolamento', () => {
  it('agent/viewer: DTO sem spend e sem payment.since/last_error_at', async () => {
    seed({
      payment_blocked_since: '2026-10-15T13:40:05.000Z',
      last_payment_error_at: '2026-10-15T13:58:42.000Z',
    });
    stubMeta();

    for (const role of ['agent', 'viewer'] as const) {
      const dto = await loadDto({ role });
      expect('spend' in dto).toBe(false);
      expect(dto.payment).toEqual({ pending: true });
      expect(JSON.stringify(dto)).not.toContain('7.0625');
    }
    const admin = await loadDto({ role: 'admin' });
    expect(admin.spend?.total).toBe(7.0625);
    expect(admin.payment.since).toBe('2026-10-15T13:40:05.000Z');
  });

  it('o waba_id sai mascarado', async () => {
    seed();
    const dto = await loadDto();
    expect(dto.waba_id).toBe('****4821');
    expect(JSON.stringify(dto)).not.toContain(WABA);
  });

  it('canal de OUTRA conta → not_found, sem tocar a Meta', async () => {
    state.channels[0]!.account_id = OTHER_ACCOUNT;
    const meta = stubMeta();
    expect((await load()).status).toBe('not_found');
    expect(meta).not.toHaveBeenCalled();
  });

  it('canal de outro tipo ou desativado → not_found', async () => {
    const meta = stubMeta();

    state.channels[0]!.type = 'whatsapp_qr';
    expect((await load()).status).toBe('not_found');

    state.channels[0]!.type = 'whatsapp_cloud';
    state.channels[0]!.status = 'disabled';
    expect((await load()).status).toBe('not_found');

    expect(meta).not.toHaveBeenCalled();
  });

  it('canal inexistente → not_found', async () => {
    stubMeta();
    const { db, admin } = dbs();
    const res = await loadChannelBilling(db, ACCOUNT, 'chan-nope', {
      role: 'admin',
      now: NOW,
      admin,
    });
    expect(res).toEqual({ status: 'not_found' });
  });

  it('o retrato de OUTRA conta com o mesmo WABA nunca é lido', async () => {
    state.whatsapp_billing_status.push({
      ...BILLING_ROW_DEFAULTS,
      account_id: OTHER_ACCOUNT,
      waba_id: WABA,
      health_overall: 'BLOCKED',
      health_checked_at: ago(MIN),
      payment_blocked_since: ago(MIN),
    });
    const meta = stubMeta();

    const dto = await loadDto();

    // Sem retrato próprio: lê da Meta, em vez de herdar o do vizinho.
    expect(healthCalls(meta)).toHaveLength(1);
    expect(dto.state).toBe('ok');
    expect(dto.payment.pending).toBe(false);
    // E a escrita foi só na linha desta conta.
    const other = state.whatsapp_billing_status.find(
      (r) => r.account_id === OTHER_ACCOUNT
    );
    expect(other?.health_overall).toBe('BLOCKED');
  });

  it('só o cliente admin escreve em whatsapp_billing_status', async () => {
    stubMeta();
    await load();
    expect(billingWrites().length).toBeGreaterThan(0);
    expect(billingWrites().every((w) => w.client === 'admin')).toBe(true);
  });

  it('o waba_id consultado vem da whatsapp_config, não de outro lugar', async () => {
    state.whatsapp_config[0]!.waba_id = '300000000009999';
    const meta = stubMeta();
    await load();
    const url = new URL(String(meta.mock.calls[0]![0]));
    expect(url.pathname).toContain('300000000009999');
  });

  it('dois números no mesmo WABA dividem o retrato e a contagem', async () => {
    state.channels.push({
      ...state.channels[0]!,
      id: 'chan-2',
      is_default: false,
      created_at: '2026-02-01T00:00:00.000Z',
    });
    state.whatsapp_config.push({
      ...state.whatsapp_config[0]!,
      id: 'cfg-2',
      channel_id: 'chan-2',
      phone_number_id: '900000000008888',
    });
    const meta = stubMeta();

    const dto = await loadDto();
    expect(dto.shared_with_channels).toBe(2);

    // O segundo número lê o MESMO retrato: nenhuma chamada nova.
    const calls = meta.mock.calls.length;
    const { db, admin } = dbs();
    await loadChannelBilling(db, ACCOUNT, 'chan-2', {
      role: 'admin',
      now: NOW,
      admin,
    });
    expect(meta.mock.calls.length).toBe(calls);
  });
});

// ============================================================
// Sem credencial (RF-12) e schema ausente (RNF-11)
// ============================================================

describe('loadChannelBilling — sem credencial e sem schema', () => {
  it('waba_id ausente → no_credentials, sem Meta e sem banco do monitor', async () => {
    state.whatsapp_config[0]!.waba_id = null;
    const meta = stubMeta();
    const dto = await loadDto();
    expect(dto.state).toBe('no_credentials');
    expect(dto.waba_id).toBeNull();
    expect(meta).not.toHaveBeenCalled();
    expect(billingWrites()).toHaveLength(0);
  });

  it('token zerado ou canal órfão → no_credentials', async () => {
    const meta = stubMeta();

    state.whatsapp_config[0]!.access_token = '';
    expect((await loadDto()).state).toBe('no_credentials');

    state.whatsapp_config.length = 0;
    expect((await loadDto()).state).toBe('no_credentials');

    expect(meta).not.toHaveBeenCalled();
  });

  it('tabela ausente (086 não aplicada): responde sem explodir e sem chamar a Meta', async () => {
    const meta = stubMeta();
    const missing: FakeDbOptions = {
      fail: ({ table }) =>
        table === 'whatsapp_billing_status'
          ? {
              code: 'PGRST205',
              message: "Could not find the table 'whatsapp_billing_status'",
            }
          : null,
    };

    const dto = await loadDto({}, missing);
    expect(dto.state).toBe('unknown');
    expect(meta).not.toHaveBeenCalled();

    // Segunda abertura: nem consulta o banco de novo.
    const again = await loadDto({}, missing);
    expect(again.state).toBe('unknown');
    expect(meta).not.toHaveBeenCalled();
  });

  it('erro de banco que NÃO é schema ausente sobe (é erro interno)', async () => {
    stubMeta();
    await expect(
      load(
        {},
        {
          fail: ({ table, verb }) =>
            table === 'whatsapp_billing_status' && verb === 'select'
              ? { code: '57014', message: 'canceling statement' }
              : null,
        }
      )
    ).rejects.toThrow(/failed to read whatsapp_billing_status/);
  });

  it('falha ao GRAVAR não perde o que acabou de ser lido', async () => {
    stubMeta();
    const dto = await loadDto(
      {},
      {
        fail: ({ table, verb }) =>
          table === 'whatsapp_billing_status' && verb === 'upsert'
            ? { code: '57014', message: 'canceling statement' }
            : null,
      }
    );
    expect(dto.state).toBe('ok');
    expect(dto.spend?.total).toBe(7.0625);
  });
});

// ============================================================
// Single-flight (§7.5)
// ============================================================

describe('loadChannelBilling — single-flight', () => {
  it('duas aberturas simultâneas do mesmo WABA dividem as mesmas chamadas', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const meta = stubMeta({
      health: async () => {
        await gate;
        return ok(HEALTH_OK)();
      },
      spend: async () => {
        await gate;
        return ok(SPEND_OK)();
      },
    });

    const a = load();
    await vi.waitFor(() => expect(meta).toHaveBeenCalledTimes(2));
    const b = load();
    await new Promise((r) => setTimeout(r, 15));
    release();
    const [ra, rb] = await Promise.all([a, b]);

    expect(ra.status).toBe('ok');
    expect(rb.status).toBe('ok');
    expect(meta).toHaveBeenCalledTimes(2);
  });
});

// ============================================================
// Token fora de tudo (RNF-01)
// ============================================================

describe('RNF-01 — o token não vaza', () => {
  it('nem na URL, nem no log, nem na resposta, nem na tabela; só no header', async () => {
    // A Meta devolve uma mensagem de erro que ECOA o token: o saneamento
    // tem de tirá-lo antes de gravar.
    const meta = stubMeta({
      health: metaError(
        190,
        `Invalid OAuth access token. Bearer ${TOKEN} access_token=${TOKEN}`,
        401
      ),
    });

    const dto = await loadDto();

    // Header, não query string.
    expect(meta).toHaveBeenCalled();
    for (const call of meta.mock.calls as unknown[][]) {
      const url = String(call[0]);
      expect(url).not.toContain(TOKEN);
      expect(url).not.toContain('access_token');
      const init = call[1] as { headers: Record<string, string> };
      expect(init.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    }
    // Resposta.
    expect(JSON.stringify(dto)).not.toContain(TOKEN);
    // Tabela (o que foi escrito e o que ficou).
    expect(JSON.stringify(billingWrites())).not.toContain(TOKEN);
    expect(JSON.stringify(state.whatsapp_billing_status)).not.toContain(TOKEN);
    expect(stored().health_error_message).toContain('[redacted]');
    // Log.
    expect(logs.join('\n')).not.toContain(TOKEN);
    // O cifrado também não vai para a resposta.
    expect(JSON.stringify(dto)).not.toContain(
      String(state.whatsapp_config[0]!.access_token)
    );
  });
});

// ============================================================
// Lista (§9.2)
// ============================================================

describe('loadBillingSummary', () => {
  function addChannel(n: number, over: { waba?: string | null } = {}) {
    const id = `chan-${n}`;
    state.channels.push({
      ...state.channels[0]!,
      id,
      is_default: false,
      created_at: `2026-02-0${n}T00:00:00.000Z`,
    });
    state.whatsapp_config.push({
      ...state.whatsapp_config[0]!,
      id: `cfg-${n}`,
      channel_id: id,
      phone_number_id: `90000000000${n}000`,
      waba_id: over.waba === undefined ? `10000000000000${n}` : over.waba,
    });
    return id;
  }

  async function summary(
    role: 'admin' | 'agent' = 'admin',
    scheduleRefresh = true
  ) {
    const { db, admin } = dbs();
    return loadBillingSummary(db, ACCOUNT, {
      role,
      now: NOW,
      admin,
      scheduleRefresh,
    });
  }

  it('lê SÓ do banco: a lista nunca espera a Meta', async () => {
    seed();
    const meta = stubMeta();
    const res = await summary();
    expect(meta).not.toHaveBeenCalled();
    expect(res).toEqual({
      channels: [
        {
          channel_id: CHANNEL,
          state: 'ok',
          stale: false,
          checked_at: ago(MIN),
          currency: 'USD',
          spend_total: 7.0625,
        },
      ],
      worst_state: 'ok',
    });
    // Retrato fresco: nada a atualizar depois.
    expect(afterState.callbacks).toHaveLength(0);
  });

  it('agent não recebe moeda nem consumo', async () => {
    seed();
    stubMeta();
    const res = await summary('agent');
    expect('currency' in res.channels[0]!).toBe(false);
    expect('spend_total' in res.channels[0]!).toBe(false);
  });

  it('canal sem waba_id: no_credentials, que não puxa o pior estado para baixo de ok', async () => {
    seed();
    addChannel(2, { waba: null });
    stubMeta();
    const res = await summary();
    expect(res.channels.map((c) => c.state).sort()).toEqual([
      'no_credentials',
      'ok',
    ]);
    expect(res.worst_state).toBe('ok');
  });

  it('o pior estado vence (pagamento pendente)', async () => {
    seed({ payment_blocked_since: ago(5 * MIN) });
    stubMeta();
    expect((await summary()).worst_state).toBe('payment_blocked');
  });

  it('conta sem nenhum número oficial: worst_state null', async () => {
    state.channels.length = 0;
    state.whatsapp_config.length = 0;
    stubMeta();
    expect(await summary()).toEqual({ channels: [], worst_state: null });
  });

  it('dispara via after() a atualização de NO MÁXIMO 5 WABAs vencidos', async () => {
    // 7 WABAs distintos, nenhum com retrato → todos vencidos.
    for (let n = 2; n <= 7; n++) addChannel(n);
    state.whatsapp_config[0]!.waba_id = '100000000000001';
    const meta = stubMeta();

    const res = await summary();

    expect(res.channels).toHaveLength(7);
    // A lista respondeu sem chamar a Meta; o trabalho ficou para o after().
    expect(meta).not.toHaveBeenCalled();
    expect(afterState.callbacks).toHaveLength(1);

    await afterState.callbacks[0]!();

    // 5 WABAs × (1 status + 1 consumo).
    expect(healthCalls(meta)).toHaveLength(5);
    expect(spendCalls(meta)).toHaveLength(5);
    // Todas as gravações foram do cliente admin, com a conta certa.
    expect(billingWrites().every((w) => w.client === 'admin')).toBe(true);
    expect(billingWrites().every((w) => w.payload.account_id === ACCOUNT)).toBe(
      true
    );
  });

  it('não agenda nada para WABA fresco, em recuo ou com credencial recusada', async () => {
    // Fresco.
    seed();
    // Em recuo.
    addChannel(2);
    state.whatsapp_billing_status.push({
      ...BILLING_ROW_DEFAULTS,
      account_id: ACCOUNT,
      waba_id: '100000000000002',
      health_next_retry_at: inFuture(10 * MIN),
      spend_next_retry_at: inFuture(10 * MIN),
    });
    // Credencial recusada (e consumo fresco).
    addChannel(3);
    state.whatsapp_billing_status.push({
      ...BILLING_ROW_DEFAULTS,
      account_id: ACCOUNT,
      waba_id: '100000000000003',
      health_checked_at: ago(60 * MIN),
      health_error_kind: 'auth',
      health_error_at: ago(30 * MIN),
      spend_checked_at: ago(MIN),
      spend_period_start: '2026-10-01',
      spend_total: 1,
    });
    const meta = stubMeta();

    await summary();

    expect(afterState.callbacks).toHaveLength(0);
    expect(meta).not.toHaveBeenCalled();
  });

  it('after() fora de uma requisição: cai no fallback sem lançar', async () => {
    afterState.throws = true;
    const meta = stubMeta();
    await expect(summary()).resolves.toBeDefined();
    await vi.waitFor(() => expect(meta).toHaveBeenCalled());
  });
});

// ============================================================
// Limpeza manual (§6.3, §9.3)
// ============================================================

describe('acknowledgePayment', () => {
  const PENDING = {
    payment_blocked_since: '2026-10-15T13:40:05.000Z',
    last_payment_error_at: '2026-10-15T13:58:42.000Z',
  };

  async function ack(
    over: { userId?: string; channelId?: string; now?: Date } = {}
  ) {
    const { db, admin } = dbs();
    return acknowledgePayment(db, ACCOUNT, over.channelId ?? CHANNEL, {
      userId: over.userId ?? 'user-admin',
      now: over.now ?? NOW,
      admin,
    });
  }

  it("limpa com reason 'manual', payment_cleared_by e now() — e mantém a memória do último erro", async () => {
    seed(PENDING);

    const res = await ack();

    expect(res).toEqual({
      status: 'ok',
      cleared: true,
      clearedAt: NOW.toISOString(),
      channelName: 'Principal',
    });
    expect(stored()).toMatchObject({
      payment_blocked_since: null,
      payment_cleared_at: NOW.toISOString(),
      payment_cleared_by: 'user-admin',
      payment_clear_reason: 'manual',
      last_payment_error_at: PENDING.last_payment_error_at,
    });
    expect(billingWrites().every((w) => w.client === 'admin')).toBe(true);
  });

  it('limpeza que de fato limpou descarta o retrato de processo do sinal (e só ela)', async () => {
    signalSpy.invalidate = 0;
    seed(PENDING);
    expect((await ack()).status).toBe('ok');
    expect(signalSpy.invalidate).toBe(1);

    // Segundo clique: nada limpo, nada a descartar.
    await ack({ userId: 'user-2' });
    expect(signalSpy.invalidate).toBe(1);
  });

  it('sem pendência: cleared false e a linha fica como estava', async () => {
    // O UPDATE condicional é tentado e não casa linha nenhuma.
    seed();
    expect(await ack()).toEqual({ status: 'ok', cleared: false });
    expect(stored().payment_cleared_by).toBeNull();
    expect(stored().payment_cleared_at).toBeNull();
    expect(stored().payment_clear_reason).toBeNull();
  });

  it('sem retrato nenhum: cleared false', async () => {
    expect(await ack()).toEqual({ status: 'ok', cleared: false });
  });

  it('segundo clique: cleared false (o UPDATE é condicional)', async () => {
    seed(PENDING);
    expect((await ack()).status).toBe('ok');
    expect(await ack({ userId: 'user-2' })).toEqual({
      status: 'ok',
      cleared: false,
    });
    expect(stored().payment_cleared_by).toBe('user-admin');
  });

  it('só limpa o WABA do canal e só da conta do usuário', async () => {
    seed(PENDING);
    state.whatsapp_billing_status.push({
      ...BILLING_ROW_DEFAULTS,
      account_id: OTHER_ACCOUNT,
      waba_id: WABA,
      ...PENDING,
    });

    await ack();

    const other = state.whatsapp_billing_status.find(
      (r) => r.account_id === OTHER_ACCOUNT
    );
    expect(other?.payment_blocked_since).toBe(PENDING.payment_blocked_since);
  });

  it('canal de outra conta, de outro tipo ou desativado → not_found', async () => {
    seed(PENDING);

    state.channels[0]!.account_id = OTHER_ACCOUNT;
    expect(await ack()).toEqual({ status: 'not_found' });

    state.channels[0]!.account_id = ACCOUNT;
    state.channels[0]!.type = 'whatsapp_qr';
    expect(await ack()).toEqual({ status: 'not_found' });

    state.channels[0]!.type = 'whatsapp_cloud';
    state.channels[0]!.status = 'disabled';
    expect(await ack()).toEqual({ status: 'not_found' });

    expect(stored().payment_blocked_since).toBe(PENDING.payment_blocked_since);
  });

  it('canal sem waba_id: cleared false', async () => {
    state.whatsapp_config[0]!.waba_id = null;
    expect(await ack()).toEqual({ status: 'ok', cleared: false });
  });
});

// ============================================================
// Credencial refeita (§9.4)
// ============================================================

describe('resetBillingReadErrors', () => {
  it('zera erros, contadores e recuos das DUAS leituras do WABA e nada mais', async () => {
    seed({
      health_error_kind: 'auth',
      health_error_code: 190,
      health_error_message: 'x',
      health_error_at: ago(MIN),
      health_consecutive_failures: 4,
      health_next_retry_at: inFuture(MIN),
      spend_error_kind: 'rate_limit',
      spend_error_code: 80008,
      spend_error_message: 'y',
      spend_error_at: ago(MIN),
      spend_consecutive_failures: 2,
      spend_next_retry_at: inFuture(MIN),
      payment_blocked_since: '2026-10-15T13:40:05.000Z',
    });
    const { admin } = dbs();

    await resetBillingReadErrors(admin, ACCOUNT, WABA);

    expect(stored()).toMatchObject({
      health_error_kind: null,
      health_error_code: null,
      health_error_message: null,
      health_error_at: null,
      health_consecutive_failures: 0,
      health_next_retry_at: null,
      spend_error_kind: null,
      spend_error_code: null,
      spend_error_message: null,
      spend_error_at: null,
      spend_consecutive_failures: 0,
      spend_next_retry_at: null,
      // Intocados:
      health_overall: 'AVAILABLE',
      spend_total: 7.0625,
      payment_blocked_since: '2026-10-15T13:40:05.000Z',
    });
    for (const w of billingWrites()) {
      expect(Object.keys(w.payload).some((k) => /^payment_/.test(k))).toBe(
        false
      );
    }
  });

  it('só o WABA e a conta salvos', async () => {
    seed({ health_error_kind: 'auth', health_consecutive_failures: 2 });
    state.whatsapp_billing_status.push({
      ...BILLING_ROW_DEFAULTS,
      account_id: OTHER_ACCOUNT,
      waba_id: WABA,
      health_error_kind: 'auth',
      health_consecutive_failures: 2,
    });
    const { admin } = dbs();

    await resetBillingReadErrors(admin, ACCOUNT, WABA);

    const other = state.whatsapp_billing_status.find(
      (r) => r.account_id === OTHER_ACCOUNT
    );
    expect(other?.health_error_kind).toBe('auth');
  });

  it('nunca lança (tabela ausente ou banco fora)', async () => {
    const throwing = {
      from: () => {
        throw new Error('db down');
      },
    } as unknown as SupabaseClient;
    await expect(
      resetBillingReadErrors(throwing, ACCOUNT, WABA)
    ).resolves.toBeUndefined();

    const { admin } = dbs({
      fail: () => ({ code: '42P01', message: 'relation does not exist' }),
    });
    await expect(
      resetBillingReadErrors(admin, ACCOUNT, WABA)
    ).resolves.toBeUndefined();
  });
});

// ============================================================
// Flag (D-10)
// ============================================================

describe('isBillingMonitorEnabled', () => {
  it('lê o flag; padrão e erro de leitura (coluna ausente) = desligado', async () => {
    const { admin } = dbs();
    expect(await isBillingMonitorEnabled(admin)).toBe(true);

    state.platform_settings[0]!.whatsapp_billing_monitor_enabled = false;
    expect(await isBillingMonitorEnabled(admin)).toBe(false);

    state.platform_settings.length = 0;
    expect(await isBillingMonitorEnabled(admin)).toBe(false);

    const broken = dbs({
      fail: ({ table }) =>
        table === 'platform_settings'
          ? { code: '42703', message: 'column does not exist' }
          : null,
    }).admin;
    state.platform_settings.push({ whatsapp_billing_monitor_enabled: true });
    expect(await isBillingMonitorEnabled(broken)).toBe(false);
  });
});

// ============================================================
// Revisão de código — achados 1, 2, 4, 7 e 9
// ============================================================

describe('moeda do consumo no mês (F-5, R-5)', () => {
  const BRL = { ...HEALTH_OK, currency: 'BRL' };

  it('troca de moeda no meio do mês: spend_currency mantém a do início do mês e o aviso FICA', async () => {
    seed({
      currency: 'USD',
      spend_currency: 'USD',
      health_checked_at: ago(10 * MIN),
      spend_checked_at: ago(20 * MIN),
    });
    stubMeta({ health: ok(BRL) });

    const first = await loadDto();
    expect(stored()).toMatchObject({ currency: 'BRL', spend_currency: 'USD' });
    expect(first.spend?.currency_changed).toBe(true);

    // 20 min depois, outra leitura de consumo: o aviso não pode sumir.
    stubMeta({ health: ok(BRL) });
    const later = await loadDto({ now: new Date(NOW.getTime() + 20 * MIN) });
    expect(stored().spend_currency).toBe('USD');
    expect(later.spend?.currency_changed).toBe(true);
  });

  it('na virada do mês a moeda do consumo é renovada', async () => {
    seed({
      currency: 'BRL',
      spend_currency: 'USD',
      spend_period_start: '2026-09-01',
      spend_total: 99,
    });
    stubMeta({ health: ok(BRL) });

    const dto = await loadDto();

    expect(stored()).toMatchObject({
      spend_period_start: '2026-10-01',
      spend_currency: 'BRL',
    });
    expect(dto.spend?.currency_changed).toBe(false);
  });

  it('primeira leitura do mês: usa a moeda corrente', async () => {
    stubMeta();
    await load();
    expect(stored().spend_currency).toBe('USD');
  });
});

describe('acknowledgePayment — leitura que falha', () => {
  it('falha ao ler o waba_id LANÇA em vez de virar cleared:false', async () => {
    seed({
      payment_blocked_since: '2026-10-15T13:40:05.000Z',
      last_payment_error_at: '2026-10-15T13:58:42.000Z',
    });
    const { db, admin } = dbs({
      fail: ({ table, verb }) =>
        table === 'whatsapp_config' && verb === 'select'
          ? { code: '57014', message: 'canceling statement' }
          : null,
    });

    await expect(
      acknowledgePayment(db, ACCOUNT, CHANNEL, {
        userId: 'user-admin',
        now: NOW,
        admin,
      })
    ).rejects.toThrow(/failed to read waba_id/);
    // E o alerta continua aberto, como estava.
    expect(stored().payment_blocked_since).toBe('2026-10-15T13:40:05.000Z');
  });
});

describe('contagem de números do WABA (barata no caso comum)', () => {
  /** Quais tabelas o cliente de SESSÃO consultou durante a chamada. */
  async function tablesQueried(): Promise<string[]> {
    const tables: string[] = [];
    const { db, admin } = dbs();
    const spyDb = {
      ...db,
      from: (t: string) => {
        tables.push(t);
        return db.from(t);
      },
    } as unknown as SupabaseClient;
    // P-15: a credencial é lida pelo `admin` (service role), então as duas
    // pontas entram na contagem.
    const spyAdmin = {
      ...admin,
      from: (t: string) => {
        tables.push(t);
        return admin.from(t);
      },
    } as unknown as SupabaseClient;
    await loadChannelBilling(spyDb, ACCOUNT, CHANNEL, {
      role: 'admin',
      now: NOW,
      admin: spyAdmin,
    });
    return tables;
  }

  it('um número só: nenhuma consulta extra a channels além da resolução do canal', async () => {
    seed();
    stubMeta();
    const tables = await tablesQueried();
    // `resolveCloudConfig` lê `channels` uma vez. A contagem não faz
    // `listCloudChannels` (que leria de novo).
    expect(tables.filter((t) => t === 'channels')).toHaveLength(1);
    expect(tables.filter((t) => t === 'whatsapp_config')).toHaveLength(2);
  });

  it('número DESATIVADO do mesmo WABA não conta', async () => {
    seed();
    state.channels.push({
      ...state.channels[0]!,
      id: 'chan-2',
      is_default: false,
      status: 'disabled',
    });
    state.whatsapp_config.push({
      ...state.whatsapp_config[0]!,
      id: 'cfg-2',
      channel_id: 'chan-2',
      phone_number_id: '900000000008888',
    });
    stubMeta();
    expect((await loadDto()).shared_with_channels).toBe(1);
  });

  it('outro WABA da mesma conta não conta', async () => {
    seed();
    state.channels.push({
      ...state.channels[0]!,
      id: 'chan-2',
      is_default: false,
    });
    state.whatsapp_config.push({
      ...state.whatsapp_config[0]!,
      id: 'cfg-2',
      channel_id: 'chan-2',
      phone_number_id: '900000000008888',
      waba_id: '300000000009999',
    });
    stubMeta();
    expect((await loadDto()).shared_with_channels).toBe(1);
  });

  it('falha na contagem não derruba a leitura: vira 1', async () => {
    seed();
    stubMeta();
    let configReads = 0;
    const dto = await loadDto(
      {},
      {
        // A 1ª leitura de whatsapp_config é a resolução do canal; a 2ª, a contagem.
        fail: ({ table, verb }) =>
          table === 'whatsapp_config' &&
          verb === 'select' &&
          ++configReads === 2
            ? { code: '57014', message: 'canceling statement' }
            : null,
      }
    );
    expect(dto.shared_with_channels).toBe(1);
    expect(dto.state).toBe('ok');
  });
});

describe('force só vale para admin+ (defesa em profundidade)', () => {
  it('agent/viewer com force:true são tratados como leitura comum', async () => {
    seed();
    const meta = stubMeta();

    for (const role of ['agent', 'viewer'] as const) {
      const res = await load({ role, force: true });
      expect(res.status).toBe('ok');
    }

    // Retrato fresco + force ignorado = nenhuma chamada e nenhum cooldown gasto.
    expect(meta).not.toHaveBeenCalled();
    expect((await load({ role: 'admin', force: true })).status).toBe('ok');
    expect(meta).toHaveBeenCalledTimes(2);
  });
});

describe('isBillingMonitorEnabled — sem o cliente admin', () => {
  it('SUPABASE_SERVICE_ROLE_KEY ausente (supabaseAdmin lança) = desligado, não exceção', async () => {
    await expect(isBillingMonitorEnabled()).resolves.toBe(false);
  });
});
