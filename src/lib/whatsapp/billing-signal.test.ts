/**
 * SPEC 076 F3 — sinal de pagamento (§6.3, §10.3, §10.4, §15.1).
 *
 * O que é testado aqui: QUEM é resolvido (conta/WABA pela config, nunca
 * pelo `entry.id`), QUANDO a função SQL é chamada (e quando o retrato
 * local a poupa), que a notificação só sai em episódio novo com o flag
 * ligado, e que nada daqui lança.
 *
 * A regra do §6.3 em si (COALESCE/GREATEST, reabertura só depois da
 * limpeza) mora em `apply_payment_signal` (migração 087) e não roda no
 * Vitest — o banco aqui é de mentira. Ela foi verificada contra um
 * Postgres real (PGlite) na F3; ver o resumo da fase.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

const { adminState } = vi.hoisted(() => ({
  adminState: {
    client: undefined as unknown,
    throws: false,
    calls: 0,
  },
}));

vi.mock('@/lib/supabase/admin', () => ({
  supabaseAdmin: () => {
    adminState.calls++;
    if (adminState.throws) throw new Error('missing env');
    return adminState.client;
  },
}));

/**
 * `after()` do Next: guarda os callbacks (como a rota entrega ao runtime)
 * e, com `afterThrows`, simula a chamada FORA de um ciclo de requisição.
 */
const { afterState } = vi.hoisted(() => ({
  afterState: { callbacks: [] as Array<() => unknown>, throws: false },
}));
vi.mock('next/server', () => ({
  after: (cb: () => unknown) => {
    if (afterState.throws) throw new Error('after outside request scope');
    afterState.callbacks.push(cb);
  },
}));

import {
  __resetBillingSignalStateForTests,
  applyPaymentSignal,
  createWebhookPaymentSignals,
  isPaymentMethodError,
  notePricingSchemaMissing,
  parseMetaTimestamp,
  pricingPatchFor,
  resolvePaymentSignalTarget,
  schedulePaymentErrorSignal,
  signalKindForStatus,
  signalPaymentErrorFromSend,
} from './billing-signal';
import { MetaApiError } from './meta-api';

// ------------------------------------------------------------
// Supabase de mentira
// ------------------------------------------------------------

interface Op {
  table: string;
  verb: 'select' | 'update';
  payload?: unknown;
  filters: Array<[string, ...unknown[]]>;
}

interface Result {
  data?: unknown;
  error?: unknown;
}

function makeDb(opts: {
  table?: (op: Op) => Result;
  rpc?: (fn: string, args: Record<string, unknown>) => Result | Promise<Result>;
}) {
  const ops: Op[] = [];
  const rpcs: Array<{ fn: string; args: Record<string, unknown> }> = [];

  function builder(table: string) {
    const op: Op = { table, verb: 'select', filters: [] };
    const settle = () => {
      ops.push(op);
      const r = opts.table?.(op) ?? { data: null, error: null };
      return Promise.resolve({ data: r.data ?? null, error: r.error ?? null });
    };
    const chain: Record<string, unknown> = {
      select: () => chain,
      update: (payload: unknown) => {
        op.verb = 'update';
        op.payload = payload;
        return chain;
      },
      maybeSingle: () => settle(),
      then: (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) =>
        settle().then(onF, onR),
    };
    for (const f of ['eq', 'neq', 'in', 'lt', 'not']) {
      chain[f] = (...args: unknown[]) => {
        op.filters.push([f, ...args]);
        return chain;
      };
    }
    return chain;
  }

  const db = {
    from: (t: string) => builder(t),
    rpc: async (fn: string, args: Record<string, unknown>) => {
      rpcs.push({ fn, args });
      const r = (await opts.rpc?.(fn, args)) ?? { data: null, error: null };
      return { data: r.data ?? null, error: r.error ?? null };
    },
  };
  return { db: db as unknown as SupabaseClient, ops, rpcs };
}

const CONFIG_ROW = { account_id: 'acct-1', waba_id: '100000000004821' };

/**
 * Banco "normal": config do número, WABA com 2 canais (um desativado),
 * flag configurável, retrato de pagamento configurável.
 */
function standardTables(state: {
  flag?: boolean;
  billingRow?: Record<string, unknown> | null;
  configRows?: unknown[];
}) {
  return (op: Op): Result => {
    if (op.table === 'whatsapp_config') {
      const byWaba = op.filters.some((f) => f[1] === 'waba_id');
      if (byWaba) {
        return {
          data: [
            { channel_id: 'chan-1' },
            { channel_id: 'chan-2' },
            { channel_id: null },
          ],
        };
      }
      return { data: state.configRows ?? [CONFIG_ROW] };
    }
    if (op.table === 'whatsapp_billing_status') {
      return { data: state.billingRow ?? null };
    }
    if (op.table === 'platform_settings') {
      return { data: { whatsapp_billing_monitor_enabled: state.flag ?? true } };
    }
    if (op.table === 'channels') {
      // O filtro `neq('status','disabled')` é do código; aqui o banco
      // devolve só o que passaria por ele.
      return { data: [{ id: 'chan-1' }] };
    }
    return { data: null };
  };
}

const TARGET = {
  accountId: 'acct-1',
  wabaId: '100000000004821',
  phoneNumberId: 'pnid-7781',
};

beforeEach(() => {
  __resetBillingSignalStateForTests();
  adminState.client = undefined;
  adminState.throws = false;
  adminState.calls = 0;
  afterState.callbacks.length = 0;
  afterState.throws = false;
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

// ------------------------------------------------------------
// Puros
// ------------------------------------------------------------

describe('signalKindForStatus (§10.3)', () => {
  it('failed + 131042 → payment_error', () => {
    expect(
      signalKindForStatus('failed', { paymentBlocked: true, billable: null })
    ).toBe('payment_error');
  });

  it('sent/delivered cobrável → billable_ok', () => {
    for (const s of ['sent', 'delivered']) {
      expect(
        signalKindForStatus(s, { paymentBlocked: false, billable: true })
      ).toBe('billable_ok');
    }
  });

  it('billable=false NUNCA limpa (mensagem gratuita sai sem cartão)', () => {
    expect(
      signalKindForStatus('delivered', {
        paymentBlocked: false,
        billable: false,
      })
    ).toBeNull();
  });

  it('sem pricing, ou `read` cobrável, não é sinal', () => {
    expect(
      signalKindForStatus('delivered', {
        paymentBlocked: false,
        billable: null,
      })
    ).toBeNull();
    expect(
      signalKindForStatus('read', { paymentBlocked: false, billable: true })
    ).toBeNull();
  });
});

describe('parseMetaTimestamp', () => {
  it('segundos em string → Date', () => {
    expect(parseMetaTimestamp('1790823600')?.toISOString()).toBe(
      '2026-10-01T03:00:00.000Z'
    );
  });

  it('ilegível → null', () => {
    for (const v of [undefined, '', 'abc', '0', -5]) {
      expect(parseMetaTimestamp(v)).toBeNull();
    }
  });
});

describe('isPaymentMethodError', () => {
  it('MetaApiError 131042 → true; outro código → false', () => {
    expect(
      isPaymentMethodError(new MetaApiError('(#131042) x', 402, 131042))
    ).toBe(true);
    expect(isPaymentMethodError(new MetaApiError('(#190) x', 401, 190))).toBe(
      false
    );
  });

  it('olha a causa quando um embrulho esconde o MetaApiError', () => {
    const wrapped = new Error('send failed', {
      cause: new MetaApiError('(#131042) x', 402, 131042),
    });
    expect(isPaymentMethodError(wrapped)).toBe(true);
  });

  it('só code NUMÉRICO: texto e code string não contam', () => {
    expect(isPaymentMethodError(new Error('(#131042) payment'))).toBe(false);
    expect(isPaymentMethodError({ code: '131042' })).toBe(false);
    expect(isPaymentMethodError(null)).toBe(false);
  });
});

// ------------------------------------------------------------
// Resolução do alvo
// ------------------------------------------------------------

describe('resolvePaymentSignalTarget (§7.8)', () => {
  it('resolve conta + WABA pela whatsapp_config', async () => {
    const { db, ops } = makeDb({ table: standardTables({}) });
    const t = await resolvePaymentSignalTarget(db, {
      phoneNumberId: 'pnid-7781',
    });
    expect(t).toEqual(TARGET);
    expect(ops[0]!.filters).toEqual([['eq', 'phone_number_id', 'pnid-7781']]);
  });

  it('com accountId: número de OUTRA conta → null (RNF-02)', async () => {
    const { db } = makeDb({ table: standardTables({}) });
    expect(
      await resolvePaymentSignalTarget(db, {
        phoneNumberId: 'pnid-7781',
        accountId: 'acct-1',
      })
    ).toEqual(TARGET);
    expect(
      await resolvePaymentSignalTarget(db, {
        phoneNumberId: 'pnid-7781',
        accountId: 'acct-OUTRA',
      })
    ).toBeNull();
  });

  it('entry.id divergente: vale o da config, e a divergência é logada', async () => {
    const { db } = makeDb({ table: standardTables({}) });
    const t = await resolvePaymentSignalTarget(db, {
      phoneNumberId: 'pnid-7781',
      entryWabaId: '999999999990000',
    });
    expect(t?.wabaId).toBe('100000000004821');
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('waba mismatch')
    );
  });

  it('config sem waba_id → null (sem chutar o entry.id)', async () => {
    const { db } = makeDb({
      table: standardTables({
        configRows: [{ account_id: 'acct-1', waba_id: null }],
      }),
    });
    expect(
      await resolvePaymentSignalTarget(db, {
        phoneNumberId: 'pnid-7781',
        entryWabaId: '100000000004821',
      })
    ).toBeNull();
  });

  it('número desconhecido → null', async () => {
    const { db } = makeDb({ table: standardTables({ configRows: [] }) });
    expect(
      await resolvePaymentSignalTarget(db, { phoneNumberId: 'x' })
    ).toBeNull();
  });
});

// ------------------------------------------------------------
// applyPaymentSignal
// ------------------------------------------------------------

describe('applyPaymentSignal', () => {
  const TS = new Date('2026-10-01T13:40:05Z');

  it('episódio novo com flag ligado: chama a função atômica e notifica cada canal ativo do WABA', async () => {
    const { db, rpcs, ops } = makeDb({
      table: standardTables({ flag: true }),
      rpc: (fn) =>
        fn === 'apply_payment_signal' ? { data: true } : { data: 2 },
    });

    const r = await applyPaymentSignal(db, {
      target: TARGET,
      kind: 'payment_error',
      ts: TS,
    });

    expect(r).toEqual({ ok: true, changed: true, notified: 2 });
    expect(rpcs[0]).toEqual({
      fn: 'apply_payment_signal',
      args: {
        p_account_id: 'acct-1',
        p_waba_id: '100000000004821',
        p_kind: 'payment_error',
        p_ts: '2026-10-01T13:40:05.000Z',
        p_phone_number_id: 'pnid-7781',
      },
    });
    expect(
      rpcs.filter((c) => c.fn === 'notify_channel_payment_blocked')
    ).toEqual([
      {
        fn: 'notify_channel_payment_blocked',
        args: {
          p_account_id: 'acct-1',
          p_channel_id: 'chan-1',
          p_waba_id: '100000000004821',
        },
      },
    ]);
    // Canais do WABA desta conta, só Cloud e não desativados.
    const channelsOp = ops.find((o) => o.table === 'channels')!;
    expect(channelsOp.filters).toEqual(
      expect.arrayContaining([
        ['eq', 'account_id', 'acct-1'],
        ['eq', 'type', 'whatsapp_cloud'],
        ['neq', 'status', 'disabled'],
        ['in', 'id', ['chan-1', 'chan-2']],
      ])
    );
  });

  it('repetição (função devolve FALSE): nenhuma notificação', async () => {
    const { db, rpcs } = makeDb({
      table: standardTables({ flag: true }),
      rpc: () => ({ data: false }),
    });
    const r = await applyPaymentSignal(db, {
      target: TARGET,
      kind: 'payment_error',
      ts: TS,
    });
    expect(r.changed).toBe(false);
    expect(rpcs.map((c) => c.fn)).toEqual(['apply_payment_signal']);
  });

  it('flag DESLIGADO: o estado é gravado, a notificação não sai (D-10)', async () => {
    const { db, rpcs } = makeDb({
      table: standardTables({ flag: false }),
      rpc: () => ({ data: true }),
    });
    const r = await applyPaymentSignal(db, {
      target: TARGET,
      kind: 'payment_error',
      ts: TS,
    });
    expect(r).toEqual({ ok: true, changed: true, notified: 0 });
    expect(rpcs.map((c) => c.fn)).toEqual(['apply_payment_signal']);
  });

  it('erro ao ler o flag NÃO dá a notificação por resolvida: o próximo 131042 tenta de novo', async () => {
    let flagFails = true;
    const { db, rpcs } = makeDb({
      table: (op) =>
        op.table === 'platform_settings' && flagFails
          ? { error: { message: 'boom' } }
          : standardTables({ flag: true })(op),
      // 1ª chamada abre o episódio; as seguintes já o encontram aberto.
      rpc: (fn) => {
        if (fn !== 'apply_payment_signal') return { data: 1 };
        return { data: rpcs.filter((c) => c.fn === fn).length === 1 };
      },
    });

    const first = await applyPaymentSignal(db, {
      target: TARGET,
      kind: 'payment_error',
      ts: TS,
    });
    expect(first).toEqual({ ok: true, changed: true, notified: 0 });
    expect(rpcs.map((c) => c.fn)).toEqual(['apply_payment_signal']);

    // O banco volta; o 131042 seguinte (episódio JÁ aberto → changed
    // FALSE) ainda assim entrega a notificação que ficou em falta.
    flagFails = false;
    const second = await applyPaymentSignal(db, {
      target: TARGET,
      kind: 'payment_error',
      ts: new Date(TS.getTime() + 1000),
    });
    expect(second.changed).toBe(false);
    expect(second.notified).toBe(1);

    // E, resolvida, não repete: um terceiro 131042 não notifica.
    const third = await applyPaymentSignal(db, {
      target: TARGET,
      kind: 'payment_error',
      ts: new Date(TS.getTime() + 2000),
    });
    expect(third.notified).toBe(0);
    expect(
      rpcs.filter((c) => c.fn === 'notify_channel_payment_blocked')
    ).toHaveLength(1);
  });

  it('falha da função de notificação também fica em falta para o retry', async () => {
    let notifyFails = true;
    const { db, rpcs } = makeDb({
      table: standardTables({ flag: true }),
      rpc: (fn) => {
        if (fn === 'apply_payment_signal') {
          return { data: rpcs.filter((c) => c.fn === fn).length === 1 };
        }
        return notifyFails
          ? { error: { code: '40001', message: 'serialization' } }
          : { data: 1 };
      },
    });
    await applyPaymentSignal(db, {
      target: TARGET,
      kind: 'payment_error',
      ts: TS,
    });
    notifyFails = false;
    const retry = await applyPaymentSignal(db, {
      target: TARGET,
      kind: 'payment_error',
      ts: new Date(TS.getTime() + 1000),
    });
    expect(retry.notified).toBe(1);
  });

  it('billable_ok nunca notifica, mesmo limpando', async () => {
    const { db, rpcs } = makeDb({
      table: standardTables({ flag: true }),
      rpc: () => ({ data: true }),
    });
    const r = await applyPaymentSignal(db, {
      target: TARGET,
      kind: 'billable_ok',
      ts: TS,
    });
    expect(r.changed).toBe(true);
    expect(rpcs).toHaveLength(1);
    expect(rpcs[0]!.args.p_kind).toBe('billable_ok');
  });

  it('erro da função: não lança, devolve ok=false', async () => {
    const { db } = makeDb({
      table: standardTables({}),
      rpc: () => ({ error: { code: '40001', message: 'serialization' } }),
    });
    await expect(
      applyPaymentSignal(db, { target: TARGET, kind: 'payment_error', ts: TS })
    ).resolves.toEqual({ ok: false, changed: false, notified: 0 });
  });

  it('função lançando: não lança', async () => {
    const { db } = makeDb({
      table: standardTables({}),
      rpc: () => {
        throw new Error('network');
      },
    });
    await expect(
      applyPaymentSignal(db, { target: TARGET, kind: 'payment_error', ts: TS })
    ).resolves.toMatchObject({ ok: false });
  });

  it('schema ausente (projeto sem a 087): para de tentar por um tempo', async () => {
    const { db, rpcs } = makeDb({
      table: standardTables({}),
      rpc: () => ({ error: { code: 'PGRST202', message: 'no function' } }),
    });
    await applyPaymentSignal(db, {
      target: TARGET,
      kind: 'payment_error',
      ts: TS,
    });
    await applyPaymentSignal(db, {
      target: TARGET,
      kind: 'payment_error',
      ts: TS,
    });
    expect(rpcs).toHaveLength(1);
    expect(console.warn).toHaveBeenCalledTimes(1);
  });

  it('log mascara WABA e número, e não carrega token', async () => {
    const { db } = makeDb({
      table: standardTables({ flag: false }),
      rpc: () => ({ data: true }),
    });
    await applyPaymentSignal(db, {
      target: TARGET,
      kind: 'payment_error',
      ts: TS,
    });
    const line = vi
      .mocked(console.log)
      .mock.calls.map((c) => c.join(' '))
      .join('\n');
    expect(line).toContain('waba=****4821');
    expect(line).toContain('pnid=****7781');
    expect(line).not.toContain('100000000004821');
  });
});

// ------------------------------------------------------------
// pricing em messages (junto do UPDATE de status)
// ------------------------------------------------------------

describe('pricingPatchFor (D-7)', () => {
  it('sem pricing: patch vazio (nunca grava nulo por cima)', () => {
    expect(pricingPatchFor({ billable: null, category: null })).toEqual({});
  });

  it('só o que veio', () => {
    expect(pricingPatchFor({ billable: false, category: null })).toEqual({
      pricing_billable: false,
    });
    expect(pricingPatchFor({ billable: true, category: 'MARKETING' })).toEqual({
      pricing_billable: true,
      pricing_category: 'MARKETING',
    });
  });

  it('coluna ausente (086 não aplicada): depois do erro o patch some por um tempo', () => {
    expect(pricingPatchFor({ billable: true, category: 'X' })).not.toEqual({});
    expect(
      notePricingSchemaMissing({ code: 'PGRST204', message: 'no column' })
    ).toBe(true);
    expect(pricingPatchFor({ billable: true, category: 'X' })).toEqual({});
  });

  it('erro que não é de schema não desliga o pricing', () => {
    expect(
      notePricingSchemaMissing({ code: '57014', message: 'timeout' })
    ).toBe(false);
    expect(pricingPatchFor({ billable: true, category: 'X' })).not.toEqual({});
  });
});

// ------------------------------------------------------------
// Webhook — sessão por número
// ------------------------------------------------------------

function failed131042(ts: string, id = 'wamid.f') {
  return {
    id,
    status: 'failed',
    timestamp: ts,
    errors: [{ code: 131042 }],
  };
}
function billable(status: string, ts: string, id = 'wamid.b', value = true) {
  return {
    id,
    status,
    timestamp: ts,
    pricing: { billable: value, category: 'marketing' },
  };
}

describe('createWebhookPaymentSignals', () => {
  it('status sem sinal não consulta nada', async () => {
    const { db, ops, rpcs } = makeDb({ table: standardTables({}) });
    const s = createWebhookPaymentSignals(db, { phoneNumberId: 'pnid-7781' });
    await s.handleStatus({ id: 'w', status: 'read', timestamp: '1790823600' });
    await s.handleStatus(billable('delivered', '1790823600', 'w2', false));
    expect(ops).toHaveLength(0);
    expect(rpcs).toHaveLength(0);
  });

  it('rajada de 131042 do mesmo WABA: conta resolvida UMA vez, função chamada uma vez, uma notificação', async () => {
    const { db, ops, rpcs } = makeDb({
      table: standardTables({ flag: true }),
      rpc: (fn) =>
        fn === 'apply_payment_signal' ? { data: true } : { data: 1 },
    });
    const s = createWebhookPaymentSignals(db, {
      phoneNumberId: 'pnid-7781',
      entryWabaId: '100000000004821',
    });
    for (let i = 0; i < 5; i++) {
      await s.handleStatus(failed131042('1790823600', `wamid.${i}`));
    }

    expect(
      ops.filter(
        (o) =>
          o.table === 'whatsapp_config' &&
          o.filters.some((f) => f[1] === 'phone_number_id')
      )
    ).toHaveLength(1);
    expect(
      ops.filter((o) => o.table === 'whatsapp_billing_status')
    ).toHaveLength(1);
    expect(rpcs.filter((c) => c.fn === 'apply_payment_signal')).toHaveLength(1);
    expect(
      rpcs.filter((c) => c.fn === 'notify_channel_payment_blocked')
    ).toHaveLength(1);
  });

  it('131042 mais novo que o último gravado chama a função de novo (GREATEST)', async () => {
    const { db, rpcs } = makeDb({
      table: standardTables({
        flag: true,
        billingRow: {
          payment_blocked_since: '2026-10-01T03:00:00Z',
          last_payment_error_at: '2026-10-01T03:00:00Z',
        },
      }),
      rpc: () => ({ data: false }),
    });
    const s = createWebhookPaymentSignals(db, { phoneNumberId: 'pnid-7781' });
    await s.handleStatus(failed131042('1790823600')); // == último: pula
    await s.handleStatus(failed131042('1790823660')); // +60s: chama
    expect(rpcs.map((c) => c.args.p_ts)).toEqual(['2026-10-01T03:01:00.000Z']);
  });

  it('WABA sem pendência: delivered cobrável não paga UPDATE nenhum', async () => {
    const { db, rpcs } = makeDb({
      table: standardTables({ billingRow: null }),
    });
    const s = createWebhookPaymentSignals(db, { phoneNumberId: 'pnid-7781' });
    await s.handleStatus(billable('delivered', '1790823600'));
    await s.handleStatus(billable('sent', '1790823601'));
    expect(rpcs).toHaveLength(0);
  });

  it('pendente: cobrável MAIS ANTIGO que o último 131042 não limpa', async () => {
    const { db, rpcs } = makeDb({
      table: standardTables({
        billingRow: {
          payment_blocked_since: '2026-10-01T03:00:00Z',
          last_payment_error_at: '2026-10-01T03:10:00Z',
        },
      }),
    });
    const s = createWebhookPaymentSignals(db, { phoneNumberId: 'pnid-7781' });
    await s.handleStatus(billable('delivered', '1790824200')); // 03:10:00 — igual
    await s.handleStatus(billable('delivered', '1790823900')); // 03:05:00 — antes
    expect(rpcs).toHaveLength(0);
  });

  it('pendente: cobrável posterior limpa, e o resto do lote não repete', async () => {
    const { db, rpcs } = makeDb({
      table: standardTables({
        billingRow: {
          payment_blocked_since: '2026-10-01T03:00:00Z',
          last_payment_error_at: '2026-10-01T03:00:00Z',
        },
      }),
      rpc: () => ({ data: true }),
    });
    const s = createWebhookPaymentSignals(db, { phoneNumberId: 'pnid-7781' });
    await s.handleStatus(billable('delivered', '1790823660'));
    await s.handleStatus(billable('delivered', '1790823720'));
    expect(rpcs).toEqual([
      {
        fn: 'apply_payment_signal',
        args: expect.objectContaining({
          p_kind: 'billable_ok',
          p_ts: '2026-10-01T03:01:00.000Z',
        }),
      },
    ]);
  });

  it('131042 e depois cobrável posterior no mesmo lote: liga e limpa', async () => {
    const { db, rpcs } = makeDb({
      table: standardTables({ flag: false }),
      rpc: () => ({ data: true }),
    });
    const s = createWebhookPaymentSignals(db, { phoneNumberId: 'pnid-7781' });
    await s.handleStatus(failed131042('1790823600'));
    await s.handleStatus(billable('delivered', '1790823599')); // antes: não
    await s.handleStatus(billable('delivered', '1790823700')); // depois: limpa
    expect(rpcs.map((c) => c.args.p_kind)).toEqual([
      'payment_error',
      'billable_ok',
    ]);
  });

  it('timestamp ilegível: ignora sem consultar', async () => {
    const { db, ops } = makeDb({ table: standardTables({}) });
    const s = createWebhookPaymentSignals(db, { phoneNumberId: 'pnid-7781' });
    await s.handleStatus(failed131042('nope'));
    expect(ops).toHaveLength(0);
  });

  it('falha na leitura do retrato: não lança e não chama a função', async () => {
    const { db, rpcs } = makeDb({
      table: (op) =>
        op.table === 'whatsapp_billing_status'
          ? { error: { code: '57014', message: 'timeout' } }
          : standardTables({})(op),
    });
    const s = createWebhookPaymentSignals(db, { phoneNumberId: 'pnid-7781' });
    await expect(
      s.handleStatus(failed131042('1790823600'))
    ).resolves.toBeUndefined();
    expect(rpcs).toHaveLength(0);
  });
});

// ------------------------------------------------------------
// Cache de processo (R-10), invalidação e retry
// ------------------------------------------------------------

describe('cache de sessão por número', () => {
  it('POSTs diferentes do mesmo número dividem a mesma leitura (a Meta manda ~1 status por POST)', async () => {
    const { db, ops, rpcs } = makeDb({
      table: standardTables({}),
      // O 1º abre o episódio; os seguintes o encontram aberto.
      rpc: (fn) =>
        fn === 'apply_payment_signal'
          ? { data: rpcs.filter((c) => c.fn === fn).length === 1 }
          : { data: 0 },
    });
    for (let i = 0; i < 4; i++) {
      // Uma instância por POST/change, como a rota cria.
      const s = createWebhookPaymentSignals(db, { phoneNumberId: 'pnid-7781' });
      await s.handleStatus(failed131042(String(1790823600 + i * 100), `w${i}`));
    }
    // (A consulta por conta+WABA é a dos canais a notificar, não a do alvo.)
    expect(
      ops.filter(
        (o) =>
          o.table === 'whatsapp_config' &&
          o.filters.some((f) => f[1] === 'phone_number_id')
      )
    ).toHaveLength(1);
    expect(
      ops.filter((o) => o.table === 'whatsapp_billing_status')
    ).toHaveLength(1);
  });

  it('falha transitória na leitura NÃO fica guardada: o próximo status tenta de novo', async () => {
    let configFails = true;
    const { db, ops } = makeDb({
      table: (op) =>
        op.table === 'whatsapp_config' && configFails
          ? { error: { code: '57014', message: 'timeout' } }
          : standardTables({})(op),
      rpc: () => ({ data: false }),
    });
    const s = createWebhookPaymentSignals(db, { phoneNumberId: 'pnid-7781' });
    await s.handleStatus(failed131042('1790823600'));
    configFails = false;
    await s.handleStatus(failed131042('1790823700'));
    expect(ops.filter((o) => o.table === 'whatsapp_config')).toHaveLength(2);
    expect(
      ops.filter((o) => o.table === 'whatsapp_billing_status')
    ).toHaveLength(1);
  });

  it('número sem WABA conhecido é resposta definitiva: guardada, sem repetir a consulta', async () => {
    const { db, ops } = makeDb({ table: standardTables({ configRows: [] }) });
    const s = createWebhookPaymentSignals(db, { phoneNumberId: 'pnid-7781' });
    await s.handleStatus(failed131042('1790823600'));
    await s.handleStatus(failed131042('1790823700'));
    expect(ops.filter((o) => o.table === 'whatsapp_config')).toHaveLength(1);
  });

  it('erro aceito mas sem mudança com retrato "não pendente" (outro processo abriu): descarta o retrato e relê', async () => {
    const { db, ops, rpcs } = makeDb({
      table: standardTables({ billingRow: null }),
      rpc: () => ({ data: false }),
    });
    const s = createWebhookPaymentSignals(db, { phoneNumberId: 'pnid-7781' });
    await s.handleStatus(failed131042('1790823600'));
    await s.handleStatus(failed131042('1790823700'));
    // Cada um releu o retrato; os dois chegaram à função SQL.
    expect(
      ops.filter((o) => o.table === 'whatsapp_billing_status')
    ).toHaveLength(2);
    expect(rpcs.filter((c) => c.fn === 'apply_payment_signal')).toHaveLength(2);
  });

  it('o retrato relido enxerga a pendência aberta por outro processo e deixa a limpeza passar', async () => {
    let row: Record<string, unknown> | null = null;
    const { db, rpcs } = makeDb({
      table: (op) =>
        op.table === 'whatsapp_billing_status'
          ? { data: row }
          : standardTables({})(op),
      rpc: (_fn, args) => ({ data: args.p_kind === 'billable_ok' }),
    });
    const s = createWebhookPaymentSignals(db, { phoneNumberId: 'pnid-7781' });
    await s.handleStatus(failed131042('1790823600')); // changed=false, não pendente → invalida
    row = {
      payment_blocked_since: '2026-10-01T03:00:00Z',
      last_payment_error_at: '2026-10-01T03:00:00Z',
    };
    await s.handleStatus(billable('delivered', '1790823700'));
    expect(rpcs.map((c) => c.args.p_kind)).toEqual([
      'payment_error',
      'billable_ok',
    ]);
  });

  it('notificação em falta: o filtro NÃO pula o 131042 repetido', async () => {
    let flagFails = true;
    const { db, rpcs } = makeDb({
      table: (op) =>
        op.table === 'platform_settings' && flagFails
          ? { error: { message: 'boom' } }
          : standardTables({ flag: true })(op),
      rpc: (fn) =>
        fn === 'apply_payment_signal'
          ? { data: rpcs.filter((c) => c.fn === fn).length === 1 }
          : { data: 1 },
    });
    const s = createWebhookPaymentSignals(db, { phoneNumberId: 'pnid-7781' });
    await s.handleStatus(failed131042('1790823600', 'a'));
    flagFails = false;
    // Mesmo ts: sem a notificação em falta seria pulado como reenvio.
    await s.handleStatus(failed131042('1790823600', 'b'));
    expect(
      rpcs.filter((c) => c.fn === 'notify_channel_payment_blocked')
    ).toHaveLength(1);
  });
});

// ------------------------------------------------------------
// Envio síncrono
// ------------------------------------------------------------

describe('signalPaymentErrorFromSend (RF-07)', () => {
  const NOW = new Date('2026-10-01T14:00:00Z');
  const payment = () => new MetaApiError('(#131042) payment', 402, 131042);

  it('erro que não é 131042: nem abre o cliente admin', async () => {
    await signalPaymentErrorFromSend({
      accountId: 'acct-1',
      phoneNumberId: 'pnid-7781',
      error: new MetaApiError('(#190) token', 401, 190),
    });
    expect(adminState.calls).toBe(0);
  });

  it('131042: resolve pelo número, confere a conta e liga o estado com a hora do envio + margem de relógio', async () => {
    const { db, ops, rpcs } = makeDb({
      table: standardTables({ flag: false }),
      rpc: () => ({ data: true }),
    });
    adminState.client = db;

    await signalPaymentErrorFromSend({
      accountId: 'acct-1',
      phoneNumberId: 'pnid-7781',
      error: payment(),
      now: NOW,
    });

    expect(ops[0]!.filters).toEqual([['eq', 'phone_number_id', 'pnid-7781']]);
    expect(rpcs[0]!.args).toMatchObject({
      p_kind: 'payment_error',
      // +60 s: relógio nosso atrasado não pode fazer um cobrável ANTERIOR
      // à falha limpar o episódio.
      p_ts: '2026-10-01T14:01:00.000Z',
      p_waba_id: '100000000004821',
    });
  });

  it('número de OUTRA conta: nada é escrito', async () => {
    const { db, rpcs } = makeDb({ table: standardTables({}) });
    adminState.client = db;
    await signalPaymentErrorFromSend({
      accountId: 'acct-OUTRA',
      phoneNumberId: 'pnid-7781',
      error: payment(),
    });
    expect(rpcs).toHaveLength(0);
  });

  it('rajada síncrona (disparo em massa): uma leitura e UMA chamada à função por janela', async () => {
    const { db, ops, rpcs } = makeDb({
      table: standardTables({ flag: false }),
      rpc: () => ({ data: true }),
    });
    adminState.client = db;
    for (let i = 0; i < 5; i++) {
      await signalPaymentErrorFromSend({
        accountId: 'acct-1',
        phoneNumberId: 'pnid-7781',
        error: payment(),
        now: new Date(NOW.getTime() + i * 500),
      });
    }
    expect(ops.filter((o) => o.table === 'whatsapp_config')).toHaveLength(1);
    expect(rpcs.filter((c) => c.fn === 'apply_payment_signal')).toHaveLength(1);
  });

  it('passada a janela de coalescência, o erro volta a ser gravado (last_payment_error_at anda)', async () => {
    const { db, rpcs } = makeDb({
      table: standardTables({ flag: false }),
      rpc: () => ({ data: true }),
    });
    adminState.client = db;
    for (const offset of [0, 30_000]) {
      await signalPaymentErrorFromSend({
        accountId: 'acct-1',
        phoneNumberId: 'pnid-7781',
        error: payment(),
        now: new Date(NOW.getTime() + offset),
      });
    }
    expect(rpcs.filter((c) => c.fn === 'apply_payment_signal')).toHaveLength(2);
  });

  it('nunca rejeita — nem com o cliente admin lançando', async () => {
    adminState.throws = true;
    await expect(
      signalPaymentErrorFromSend({
        accountId: 'acct-1',
        phoneNumberId: 'pnid-7781',
        error: payment(),
      })
    ).resolves.toBeUndefined();
  });

  it('sem phone_number_id no contexto: não faz nada', async () => {
    await signalPaymentErrorFromSend({
      accountId: 'acct-1',
      phoneNumberId: undefined,
      error: payment(),
    });
    expect(adminState.calls).toBe(0);
  });
});

describe('schedulePaymentErrorSignal — sem promessa solta (issue #301)', () => {
  const payment = () => new MetaApiError('(#131042) payment', 402, 131042);

  it('entrega o trabalho ao `after()` e NÃO o executa inline', async () => {
    const { db, rpcs } = makeDb({
      table: standardTables({ flag: false }),
      rpc: () => ({ data: true }),
    });
    adminState.client = db;

    schedulePaymentErrorSignal({
      accountId: 'acct-1',
      phoneNumberId: 'pnid-7781',
      error: payment(),
    });

    expect(afterState.callbacks).toHaveLength(1);
    expect(rpcs).toHaveLength(0);
    await afterState.callbacks[0]!();
    expect(rpcs.map((c) => c.fn)).toEqual(['apply_payment_signal']);
  });

  it('erro comum: não agenda nada', () => {
    schedulePaymentErrorSignal({
      accountId: 'acct-1',
      phoneNumberId: 'pnid-7781',
      error: new MetaApiError('(#190) token', 401, 190),
    });
    expect(afterState.callbacks).toHaveLength(0);
  });

  it('fora de uma requisição (`after()` lança): ainda executa, sem lançar', async () => {
    const { db, rpcs } = makeDb({
      table: standardTables({ flag: false }),
      rpc: () => ({ data: true }),
    });
    adminState.client = db;
    afterState.throws = true;

    expect(() =>
      schedulePaymentErrorSignal({
        accountId: 'acct-1',
        phoneNumberId: 'pnid-7781',
        error: payment(),
      })
    ).not.toThrow();

    await vi.waitFor(() =>
      expect(rpcs.map((c) => c.fn)).toEqual(['apply_payment_signal'])
    );
  });
});
