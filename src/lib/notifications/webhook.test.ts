import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/webhooks/ssrf', () => ({
  isDeliverableUrl: vi.fn(async () => true),
}));

import { deliverSystemWebhook } from './webhook';
import { isDeliverableUrl } from '@/lib/webhooks/ssrf';
import { buildEventPayload } from './types';

const isDeliverableUrlMock = vi.mocked(isDeliverableUrl);

const account = { id: 'acc-1', name: 'Acme Ltda', ownerEmail: 'ana@acme.com' };
const now = new Date('2026-08-26T12:00:00.000Z');

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  isDeliverableUrlMock.mockResolvedValue(true);
  fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
  vi.unstubAllEnvs();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('deliverSystemWebhook', () => {
  it('is a silent no-op (skipped) when no URL is configured', async () => {
    const payload = buildEventPayload(
      { type: 'plan.changed', accountId: account.id, account },
      now
    );
    const result = await deliverSystemWebhook(payload);
    expect(result).toEqual({ ok: true, skipped: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('plan.requested keeps the legacy `event` and root fields the current n8n workflow filters on', async () => {
    vi.stubEnv(
      'SYSTEM_EVENT_WEBHOOK_URL',
      'https://n8n.example.com/webhook/zapcrm'
    );
    const payload = buildEventPayload(
      {
        type: 'plan.requested',
        accountId: account.id,
        account,
        data: {
          accountId: account.id,
          accountName: account.name,
          planCode: 'enterprise',
          planName: 'Empresarial',
          message: null,
        },
      },
      now
    );

    const result = await deliverSystemWebhook(payload);
    expect(result).toEqual({ ok: true, skipped: false });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://n8n.example.com/webhook/zapcrm');
    const body = JSON.parse(init.body as string);
    expect(body.event).toBe('plan_change_requested');
    expect(body.accountId).toBe(account.id);
    expect(body.planCode).toBe('enterprise');
    expect(init.redirect).toBe('manual');
  });

  it('SYSTEM_EVENT_WEBHOOK_URL wins when both env vars are set', async () => {
    vi.stubEnv('SYSTEM_EVENT_WEBHOOK_URL', 'https://new.example.com/hook');
    vi.stubEnv('PLAN_REQUEST_WEBHOOK_URL', 'https://old.example.com/hook');
    const payload = buildEventPayload(
      { type: 'plan.changed', accountId: account.id, account },
      now
    );
    await deliverSystemWebhook(payload);
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe('https://new.example.com/hook');
  });

  it('falls back to PLAN_REQUEST_WEBHOOK_URL when the new alias is absent', async () => {
    vi.stubEnv('PLAN_REQUEST_WEBHOOK_URL', 'https://old.example.com/hook');
    const payload = buildEventPayload(
      { type: 'plan.changed', accountId: account.id, account },
      now
    );
    await deliverSystemWebhook(payload);
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe('https://old.example.com/hook');
  });

  it('refuses a private/internal URL via the SSRF guard', async () => {
    vi.stubEnv('SYSTEM_EVENT_WEBHOOK_URL', 'http://169.254.169.254/hook');
    isDeliverableUrlMock.mockResolvedValue(false);
    const payload = buildEventPayload(
      { type: 'plan.changed', accountId: account.id, account },
      now
    );
    const result = await deliverSystemWebhook(payload);
    expect(result.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('signs the body with HMAC when SYSTEM_EVENT_WEBHOOK_SECRET is set', async () => {
    vi.stubEnv(
      'SYSTEM_EVENT_WEBHOOK_URL',
      'https://n8n.example.com/webhook/zapcrm'
    );
    vi.stubEnv('SYSTEM_EVENT_WEBHOOK_SECRET', 'shh');
    const payload = buildEventPayload(
      { type: 'plan.changed', accountId: account.id, account },
      now
    );
    await deliverSystemWebhook(payload);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers['X-ZapCRM-Signature']).toMatch(/^t=\d+,v1=[0-9a-f]+$/);
  });

  it('does not sign when SYSTEM_EVENT_WEBHOOK_SECRET is absent', async () => {
    vi.stubEnv(
      'SYSTEM_EVENT_WEBHOOK_URL',
      'https://n8n.example.com/webhook/zapcrm'
    );
    const payload = buildEventPayload(
      { type: 'plan.changed', accountId: account.id, account },
      now
    );
    await deliverSystemWebhook(payload);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers['X-ZapCRM-Signature']).toBeUndefined();
  });

  it('treats a non-ok response as failure', async () => {
    vi.stubEnv(
      'SYSTEM_EVENT_WEBHOOK_URL',
      'https://n8n.example.com/webhook/zapcrm'
    );
    fetchMock.mockResolvedValue(new Response(null, { status: 500 }));
    const payload = buildEventPayload(
      { type: 'plan.changed', accountId: account.id, account },
      now
    );
    const result = await deliverSystemWebhook(payload);
    expect(result.ok).toBe(false);
  });
});
