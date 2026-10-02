import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  fetchBillingSummary,
  fetchChannelBilling,
  postPaymentAck,
  refreshAdvanced,
} from './billing-client';
import type { ChannelBillingDto } from './billing-dto';

function mockFetch(status: number, body: unknown, rejectJson = false) {
  const fn = vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: rejectJson
      ? () => Promise.reject(new Error('bad json'))
      : () => Promise.resolve(body),
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

afterEach(() => vi.unstubAllGlobals());

const CH = '8f0c0000-0000-4000-8000-000000000000';

describe('fetchChannelBilling', () => {
  it('200 → ok com o DTO', async () => {
    const dto = { channel_id: CH, state: 'ok' };
    mockFetch(200, dto);
    expect(await fetchChannelBilling(CH)).toEqual({ status: 'ok', data: dto });
  });

  it('manda channel_id e só acrescenta refresh=1 quando pedido', async () => {
    const fn = mockFetch(200, { channel_id: CH });
    await fetchChannelBilling(CH);
    expect(fn.mock.calls[0][0]).toBe(`/api/whatsapp/billing?channel_id=${CH}`);
    await fetchChannelBilling(CH, { refresh: true });
    expect(fn.mock.calls[1][0]).toBe(
      `/api/whatsapp/billing?channel_id=${CH}&refresh=1`
    );
  });

  it('404 "Not found" = flag desligado', async () => {
    mockFetch(404, { error: 'Not found' });
    expect(await fetchChannelBilling(CH)).toEqual({ status: 'disabled' });
  });

  it('404 "Channel not found" NÃO é flag desligado', async () => {
    mockFetch(404, { error: 'Channel not found' });
    expect(await fetchChannelBilling(CH)).toEqual({ status: 'error' });
  });

  it('429 → throttled com retry_after_seconds', async () => {
    mockFetch(429, { error: 'x', retry_after_seconds: 42 });
    expect(await fetchChannelBilling(CH, { refresh: true })).toEqual({
      status: 'throttled',
      retryAfterSeconds: 42,
    });
  });

  it('429 sem número válido → 60 s', async () => {
    mockFetch(429, { error: 'x', retry_after_seconds: 'abc' });
    expect(await fetchChannelBilling(CH, { refresh: true })).toEqual({
      status: 'throttled',
      retryAfterSeconds: 60,
    });
  });

  it('403, 500 e corpo ilegível → error', async () => {
    mockFetch(403, { error: 'x' });
    expect((await fetchChannelBilling(CH)).status).toBe('error');
    mockFetch(500, {});
    expect((await fetchChannelBilling(CH)).status).toBe('error');
    mockFetch(200, null, true);
    expect((await fetchChannelBilling(CH)).status).toBe('error');
  });

  it('falha de rede → error, sem lançar', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    expect(await fetchChannelBilling(CH)).toEqual({ status: 'error' });
  });
});

describe('fetchBillingSummary', () => {
  it('200 com channels → ok', async () => {
    const body = { channels: [], worst_state: null };
    mockFetch(200, body);
    expect(await fetchBillingSummary()).toEqual({ status: 'ok', data: body });
  });

  it('404 → disabled; corpo sem channels → error', async () => {
    mockFetch(404, { error: 'Not found' });
    expect(await fetchBillingSummary()).toEqual({ status: 'disabled' });
    mockFetch(200, { foo: 1 });
    expect((await fetchBillingSummary()).status).toBe('error');
  });
});

describe('postPaymentAck', () => {
  it('manda POST JSON com channel_id', async () => {
    const fn = mockFetch(200, { cleared: true, cleared_at: 'x' });
    expect(await postPaymentAck(CH)).toEqual({
      status: 'ok',
      data: { cleared: true, cleared_at: 'x' },
    });
    const [url, init] = fn.mock.calls[0];
    expect(url).toBe('/api/whatsapp/billing/payment-ack');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ channel_id: CH });
  });

  it('cleared:false é sucesso (clique duplo)', async () => {
    mockFetch(200, { cleared: false });
    expect(await postPaymentAck(CH)).toEqual({
      status: 'ok',
      data: { cleared: false },
    });
  });

  it('403/500 → error; corpo sem `cleared` → error', async () => {
    mockFetch(403, { error: 'x' });
    expect((await postPaymentAck(CH)).status).toBe('error');
    mockFetch(200, {});
    expect((await postPaymentAck(CH)).status).toBe('error');
  });
});

describe('refreshAdvanced — o "Atualizar" leu algo de novo?', () => {
  const dto = (health: string | null, spend?: string | null) =>
    ({
      send_status: { overall: 'AVAILABLE', checked_at: health, problems: [] },
      ...(spend !== undefined
        ? {
            spend: {
              available: true,
              currency: 'USD',
              currency_changed: false,
              period_start: '2026-10-01',
              checked_at: spend,
              total: 1,
              by_category: [],
            },
          }
        : {}),
    }) as unknown as ChannelBillingDto;

  it('carimbo do status de envio andou → true', () => {
    expect(
      refreshAdvanced(dto('2026-10-01T10:00:00Z'), dto('2026-10-01T10:05:00Z'))
    ).toBe(true);
  });

  it('só o consumo andou (status em recuo) → true', () => {
    expect(
      refreshAdvanced(
        dto('2026-10-01T10:00:00Z', '2026-10-01T10:00:00Z'),
        dto('2026-10-01T10:00:00Z', '2026-10-01T10:05:00Z')
      )
    ).toBe(true);
  });

  it('só o consumo andou, mas o status de envio segue com erro/stale → false (o toast não contradiz o aviso)', () => {
    const prev = dto('2026-10-01T10:00:00Z', '2026-10-01T10:00:00Z');
    const next = {
      ...dto('2026-10-01T10:00:00Z', '2026-10-01T10:05:00Z'),
      stale: true,
      error: { field: 'health', kind: 'transient', code: null, at: null },
    } as unknown as ChannelBillingDto;
    expect(refreshAdvanced(prev, next)).toBe(false);
  });

  it('nada andou (recuo vigente, ou a Meta falhou e veio o retrato antigo) → false', () => {
    const same = dto('2026-10-01T10:00:00Z', '2026-10-01T10:00:00Z');
    expect(refreshAdvanced(same, same)).toBe(false);
  });

  it('nunca lido e continua sem leitura → false; primeira leitura → true', () => {
    expect(refreshAdvanced(dto(null), dto(null))).toBe(false);
    expect(refreshAdvanced(null, dto('2026-10-01T10:05:00Z'))).toBe(true);
    expect(refreshAdvanced(dto(null), dto('2026-10-01T10:05:00Z'))).toBe(true);
  });
});
