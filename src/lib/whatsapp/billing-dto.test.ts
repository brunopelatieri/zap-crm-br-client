/**
 * SPEC 076 F4 — decisões puras do monitor (§7.5, §7.6) e DTO por papel (§9).
 */

import { describe, expect, it } from 'vitest';
import type { WhatsappBillingStatusRow } from '@/types';
import {
  billingUrl,
  buildChannelBillingDto,
  buildChannelSummary,
  computeNextRetryAt,
  decideRead,
  localYearMonth,
  spendIsCurrentMonth,
  worstState,
} from './billing-dto';

const NOW = new Date('2026-10-15T15:00:00.000Z');
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
const MIN = 60_000;

function row(
  over: Partial<WhatsappBillingStatusRow> = {}
): WhatsappBillingStatusRow {
  return {
    account_id: 'acct-1',
    waba_id: '100000000004821',
    currency: 'USD',
    health_overall: 'AVAILABLE',
    health_entities: [],
    business_id: '200000000000111',
    health_checked_at: ago(MIN),
    spend_period_start: '2026-10-01',
    spend_tz_offset_seconds: -10800,
    spend_total: 7.0625,
    spend_by_category: {
      SERVICE: { volume: 6, cost: 0 },
      MARKETING: { volume: 113, cost: 7.0625 },
    },
    spend_currency: 'USD',
    spend_checked_at: ago(MIN),
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
    payment_blocked_since: null,
    last_payment_error_at: null,
    last_payment_error_phone_number_id: null,
    payment_cleared_at: null,
    payment_cleared_by: null,
    payment_clear_reason: null,
    created_at: ago(60 * MIN),
    updated_at: ago(MIN),
    ...over,
  };
}

describe('computeNextRetryAt (§7.6)', () => {
  const at = (args: Parameters<typeof computeNextRetryAt>[0]) =>
    computeNextRetryAt(args)?.getTime() ?? null;

  it('credencial/permissão: sem recuo automático', () => {
    for (const kind of ['auth', 'permission'] as const) {
      expect(
        computeNextRetryAt({ kind, consecutiveFailures: 1, now: NOW })
      ).toBeNull();
    }
  });

  it('transitório: 2^n min, teto de 30 min', () => {
    const base = NOW.getTime();
    expect(at({ kind: 'transient', consecutiveFailures: 1, now: NOW })).toBe(
      base + 2 * MIN
    );
    expect(at({ kind: 'transient', consecutiveFailures: 3, now: NOW })).toBe(
      base + 8 * MIN
    );
    expect(at({ kind: 'transient', consecutiveFailures: 9, now: NOW })).toBe(
      base + 30 * MIN
    );
    // `unknown` recua como transitório (desvio declarado).
    expect(at({ kind: 'unknown', consecutiveFailures: 2, now: NOW })).toBe(
      base + 4 * MIN
    );
  });

  it('limite de taxa: max(espera da Meta, 2^n min), teto de 60 min', () => {
    const base = NOW.getTime();
    // A Meta pede 45 min; 2^1 = 2 → vale 45.
    expect(
      at({
        kind: 'rate_limit',
        consecutiveFailures: 1,
        usageMinutes: 45,
        now: NOW,
      })
    ).toBe(base + 45 * MIN);
    // Sem cabeçalho: cai no exponencial.
    expect(at({ kind: 'rate_limit', consecutiveFailures: 4, now: NOW })).toBe(
      base + 16 * MIN
    );
    // A Meta pede 90 min: o teto de 60 vale para o resultado inteiro.
    expect(
      at({
        kind: 'rate_limit',
        consecutiveFailures: 1,
        usageMinutes: 90,
        now: NOW,
      })
    ).toBe(base + 60 * MIN);
  });

  it('expoente enorme não vira Infinity/NaN', () => {
    const d = computeNextRetryAt({
      kind: 'transient',
      consecutiveFailures: 5000,
      now: NOW,
    });
    expect(d?.getTime()).toBe(NOW.getTime() + 30 * MIN);
  });
});

describe('mês do consumo (§7.4)', () => {
  it('localYearMonth respeita o fuso do WABA', () => {
    // 01/11 01:00 UTC é 31/10 22:00 em UTC−3.
    const edge = new Date('2026-11-01T01:00:00.000Z');
    expect(localYearMonth(edge, -10800)).toBe('2026-10');
    expect(localYearMonth(edge, null)).toBe('2026-11');
  });

  it('spendIsCurrentMonth: virada de mês invalida o consumo', () => {
    expect(spendIsCurrentMonth(row(), NOW)).toBe(true);
    expect(
      spendIsCurrentMonth(row({ spend_period_start: '2026-09-01' }), NOW)
    ).toBe(false);
    expect(spendIsCurrentMonth(row({ spend_period_start: null }), NOW)).toBe(
      false
    );
    expect(spendIsCurrentMonth(null, NOW)).toBe(false);
  });
});

describe('decideRead (§7.5, §7.6)', () => {
  const d = (
    r: WhatsappBillingStatusRow | null,
    field: 'health' | 'spend',
    force = false
  ) => decideRead({ row: r, field, now: NOW, force });

  it('sem retrato: vencido', () => {
    expect(d(null, 'health')).toBe('due');
    expect(d(null, 'spend')).toBe('due');
  });

  it('TTL por campo: status 5 min, consumo 15 min', () => {
    const r = row({
      health_checked_at: ago(6 * MIN),
      spend_checked_at: ago(6 * MIN),
    });
    expect(d(r, 'health')).toBe('due');
    expect(d(r, 'spend')).toBe('fresh');
    const r2 = row({ spend_checked_at: ago(16 * MIN) });
    expect(d(r2, 'spend')).toBe('due');
    expect(d(r2, 'health')).toBe('fresh');
  });

  it('virada de mês vence o consumo mesmo dentro do TTL', () => {
    const r = row({ spend_period_start: '2026-09-01' });
    expect(d(r, 'spend')).toBe('due');
    expect(d(r, 'health')).toBe('fresh');
  });

  it('force ignora o TTL', () => {
    expect(d(row(), 'health', true)).toBe('due');
    expect(d(row(), 'spend', true)).toBe('due');
  });

  it('next_retry_at no futuro vence até o force', () => {
    const r = row({
      health_checked_at: ago(60 * MIN),
      health_next_retry_at: new Date(NOW.getTime() + 5 * MIN).toISOString(),
    });
    expect(d(r, 'health')).toBe('backoff');
    expect(d(r, 'health', true)).toBe('backoff');
    // next_retry_at no passado não segura.
    const past = row({
      health_checked_at: ago(60 * MIN),
      health_next_retry_at: ago(MIN),
    });
    expect(d(past, 'health')).toBe('due');
  });

  it('erro de credencial: não repete sozinho; o force passa', () => {
    const r = row({
      health_checked_at: ago(60 * MIN),
      health_error_kind: 'auth',
      health_error_at: ago(30 * MIN),
    });
    expect(d(r, 'health')).toBe('blocked_auth');
    expect(d(r, 'health', true)).toBe('due');
    // Os campos são independentes: erro do status não bloqueia o consumo.
    expect(d(r, 'spend')).toBe('fresh');
  });
});

describe('buildChannelBillingDto (§9.1, D-8)', () => {
  const base = {
    channelId: 'chan-1',
    wabaId: '100000000004821',
    sharedWithChannels: 1,
    now: NOW,
  };

  it('admin: estado, consumo por categoria e carimbos do episódio', () => {
    const dto = buildChannelBillingDto({
      ...base,
      role: 'admin',
      row: row({
        payment_blocked_since: ago(20 * MIN),
        last_payment_error_at: ago(5 * MIN),
      }),
    });
    expect(dto.state).toBe('payment_blocked');
    expect(dto.waba_id).toBe('****4821');
    expect(dto.payment).toEqual({
      pending: true,
      since: ago(20 * MIN),
      last_error_at: ago(5 * MIN),
    });
    expect(dto.spend).toMatchObject({
      available: true,
      currency: 'USD',
      currency_changed: false,
      period_start: '2026-10-01',
      total: 7.0625,
    });
    // Ordenado por categoria; `cost` zero é zero, não "indisponível".
    expect(dto.spend?.by_category).toEqual([
      { category: 'MARKETING', volume: 113, cost: 7.0625 },
      { category: 'SERVICE', volume: 6, cost: 0 },
    ]);
    expect(dto.billing_url).toBe(
      'https://business.facebook.com/billing_hub/accounts?business_id=200000000000111'
    );
  });

  it('agent/viewer: as CHAVES de consumo e dos carimbos somem', () => {
    for (const role of ['agent', 'viewer'] as const) {
      const dto = buildChannelBillingDto({
        ...base,
        role,
        row: row({
          payment_blocked_since: ago(20 * MIN),
          last_payment_error_at: ago(5 * MIN),
        }),
      });
      expect(dto.state).toBe('payment_blocked');
      expect(dto.payment).toEqual({ pending: true });
      expect('since' in dto.payment).toBe(false);
      expect('spend' in dto).toBe(false);
      expect(JSON.stringify(dto)).not.toContain('7.0625');
    }
  });

  it('erro: a mensagem crua só chega ao admin', () => {
    const r = row({
      health_error_kind: 'transient',
      health_error_code: 2,
      health_error_message: 'Service temporarily unavailable',
      health_error_at: ago(MIN / 2),
    });
    const admin = buildChannelBillingDto({ ...base, role: 'admin', row: r });
    const agent = buildChannelBillingDto({ ...base, role: 'agent', row: r });
    expect(admin.error).toEqual({
      field: 'health',
      kind: 'transient',
      code: 2,
      at: ago(MIN / 2),
      message: 'Service temporarily unavailable',
    });
    expect(agent.error).toEqual({
      field: 'health',
      kind: 'transient',
      code: 2,
      at: ago(MIN / 2),
    });
    expect(agent.stale).toBe(true);
  });

  it('só o consumo falhou: error aponta o consumo e o estado de envio não muda', () => {
    const dto = buildChannelBillingDto({
      ...base,
      role: 'admin',
      row: row({
        spend_error_kind: 'rate_limit',
        spend_error_code: 80008,
        spend_error_at: ago(MIN),
      }),
    });
    expect(dto.state).toBe('ok');
    expect(dto.stale).toBe(false);
    expect(dto.error).toMatchObject({ field: 'spend', kind: 'rate_limit' });
  });

  it('consumo de outro mês nunca aparece como o do mês corrente', () => {
    const dto = buildChannelBillingDto({
      ...base,
      role: 'admin',
      row: row({ spend_period_start: '2026-09-01', spend_total: 99 }),
    });
    expect(dto.spend).toMatchObject({
      available: false,
      total: null,
      by_category: [],
    });
    expect(JSON.stringify(dto)).not.toContain('99');
  });

  it('custo ausente (F-11): indisponível com volume preservado, nunca zero', () => {
    const dto = buildChannelBillingDto({
      ...base,
      role: 'admin',
      row: row({
        spend_total: null,
        spend_by_category: { MARKETING: { volume: 113, cost: null } },
      }),
    });
    expect(dto.spend?.available).toBe(false);
    expect(dto.spend?.total).toBeNull();
    expect(dto.spend?.by_category).toEqual([
      { category: 'MARKETING', volume: 113, cost: null },
    ]);
  });

  it('moeda diferente entre status e consumo liga currency_changed (F-5)', () => {
    const dto = buildChannelBillingDto({
      ...base,
      role: 'admin',
      row: row({ currency: 'BRL', spend_currency: 'USD' }),
    });
    expect(dto.spend?.currency_changed).toBe(true);
  });

  it('problems: só entidades não AVAILABLE, com o id mascarado', () => {
    const dto = buildChannelBillingDto({
      ...base,
      role: 'agent',
      row: row({
        health_overall: 'BLOCKED',
        health_entities: [
          {
            entity_type: 'WABA',
            id: '100000000004821',
            can_send_message: 'AVAILABLE',
            errors: [],
            additional_info: [],
          },
          {
            entity_type: 'BUSINESS',
            id: '200000000000111',
            can_send_message: 'BLOCKED',
            errors: [
              {
                error_code: 141000,
                error_description: 'Business is not verified',
                possible_solution: 'Verify your business',
              },
            ],
            additional_info: [],
          },
        ],
      }),
    });
    expect(dto.state).toBe('blocked');
    expect(dto.send_status.problems).toHaveLength(1);
    expect(dto.send_status.problems[0]).toMatchObject({
      entity_type: 'BUSINESS',
      id: '****0111',
    });
    // O id do BUSINESS só aparece no `billing_url` (é o que o link
    // precisa, D-11); o do WABA não aparece em lugar nenhum.
    expect(JSON.stringify(dto.send_status)).not.toContain('200000000000111');
    expect(JSON.stringify(dto)).not.toContain('100000000004821');
  });

  it('sem waba_id: no_credentials, sem retrato', () => {
    const dto = buildChannelBillingDto({
      ...base,
      wabaId: null,
      role: 'admin',
      row: null,
    });
    expect(dto.state).toBe('no_credentials');
    expect(dto.waba_id).toBeNull();
  });

  it('next_retry_at: só o futuro, e o mais tardio dos dois', () => {
    const dto = buildChannelBillingDto({
      ...base,
      role: 'admin',
      row: row({
        health_next_retry_at: new Date(NOW.getTime() + 5 * MIN).toISOString(),
        spend_next_retry_at: new Date(NOW.getTime() + 9 * MIN).toISOString(),
      }),
    });
    expect(dto.next_retry_at).toBe(
      new Date(NOW.getTime() + 9 * MIN).toISOString()
    );
    const past = buildChannelBillingDto({
      ...base,
      role: 'admin',
      row: row({ health_next_retry_at: ago(MIN) }),
    });
    expect(past.next_retry_at).toBeNull();
  });
});

describe('billingUrl (D-11)', () => {
  it('só dígitos entram na URL; senão a raiz do Billing Hub', () => {
    expect(billingUrl('123')).toBe(
      'https://business.facebook.com/billing_hub/accounts?business_id=123'
    );
    expect(billingUrl(null)).toBe('https://business.facebook.com/billing_hub/');
    expect(billingUrl('1&evil=2')).toBe(
      'https://business.facebook.com/billing_hub/'
    );
  });
});

describe('resumo da lista (§9.2)', () => {
  it('admin recebe moeda e consumo; agent não', () => {
    const input = {
      channelId: 'chan-1',
      wabaId: '100000000004821',
      row: row(),
      now: NOW,
    };
    const admin = buildChannelSummary({ ...input, role: 'owner' });
    expect(admin).toMatchObject({
      state: 'ok',
      currency: 'USD',
      spend_total: 7.0625,
    });
    const agent = buildChannelSummary({ ...input, role: 'agent' });
    expect('currency' in agent).toBe(false);
    expect('spend_total' in agent).toBe(false);
  });

  it('consumo de outro mês vira null na lista', () => {
    const s = buildChannelSummary({
      channelId: 'chan-1',
      wabaId: 'w',
      row: row({ spend_period_start: '2026-09-01' }),
      role: 'admin',
      now: NOW,
    });
    expect(s.spend_total).toBeNull();
  });

  it('worstState: problema de envio vence; unknown/no_credentials não alarmam', () => {
    expect(worstState([])).toBeNull();
    expect(worstState(['ok', 'no_credentials'])).toBe('ok');
    expect(worstState(['ok', 'limited', 'blocked'])).toBe('blocked');
    expect(worstState(['blocked', 'payment_blocked'])).toBe('payment_blocked');
    expect(worstState(['unknown', 'no_credentials'])).toBe('unknown');
    expect(worstState(['no_credentials'])).toBe('no_credentials');
    expect(worstState(['ok', 'auth_error'])).toBe('auth_error');
  });
});
