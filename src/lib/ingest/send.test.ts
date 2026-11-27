import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

const adminState = vi.hoisted(() => ({ client: undefined as unknown }));
vi.mock('@/lib/supabase/admin', () => ({
  supabaseAdmin: () => adminState.client,
}));

const cloudSendTemplate = vi.fn(async () => ({ providerMessageId: 'wamid.1' }));
vi.mock('@/lib/channels/registry', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/lib/channels/registry')>();
  return {
    ...actual,
    getAdapter: (type: string) =>
      type === 'whatsapp_cloud'
        ? {
            type: 'whatsapp_cloud',
            capabilities: {},
            sendText: vi.fn(),
            sendMedia: vi.fn(),
            sendTemplate: cloudSendTemplate,
            normalizeInbound: () => [],
          }
        : actual.getAdapter(type as never),
  };
});

import { encrypt } from '@/lib/whatsapp/encryption';
import {
  sendIngestTemplate,
  deriveChannelIdFromTemplateWaba,
  IngestSendError,
} from './send';

const APPROVED_TEMPLATE = {
  id: 'tpl-1',
  user_id: 'u1',
  account_id: 'acc-1',
  name: 'promo_july',
  language: 'en_US',
  category: 'Marketing',
  body_text: 'Hello {{1}}',
  status: 'APPROVED',
  created_at: '2026-01-01T00:00:00Z',
};

const CONFIG_ROW = {
  id: 'cfg-1',
  account_id: 'acc-1',
  channel_id: 'ch-cloud-1',
  user_id: 'u1',
  phone_number_id: '1234567890',
  access_token: encrypt('fake-access-token'),
  status: 'connected',
};

/**
 * Canal oficial da conta (SPEC 064 F3).
 *
 * A credencial passou a ser resolvida PELO CANAL: sem uma linha em
 * `channels`, o disparo de ingestão não chega à `whatsapp_config` — e
 * em produção é assim também.
 */
const CLOUD_CHANNEL = {
  id: 'ch-cloud-1',
  account_id: 'acc-1',
  user_id: 'u1',
  type: 'whatsapp_cloud',
  name: 'WhatsApp Oficial',
  identifier: '5511988887777',
  status: 'connected',
  status_detail: null,
  is_default: true,
  created_at: '2026-01-01T00:00:00.000Z',
};

interface FakeDbOptions {
  channelRows?: Record<string, unknown>[] | null;
  config?: Record<string, unknown> | null;
  template?: Record<string, unknown> | null;
}

/**
 * Elo encadeável que ignora os filtros e resolve no `then`/`maybeSingle`
 * — serve tanto à LISTA (`assertAccountCanBroadcast`,
 * `resolveDefaultChannelId`) quanto à LINHA por id (`resolveCloudConfig`).
 */
function chain(resolveWith: (filters: [string, unknown][]) => unknown) {
  const filters: [string, unknown][] = [];
  const link: Record<string, unknown> = {
    select: () => link,
    eq: (k: string, v: unknown) => (filters.push([k, v]), link),
    neq: () => link,
    in: () => link,
    limit: () => link,
    maybeSingle: () => Promise.resolve(resolveWith(filters)),
    single: () => Promise.resolve(resolveWith(filters)),
    then: (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) =>
      Promise.resolve(resolveWith(filters)).then(onF, onR),
  };
  return link;
}

function fakeDb(opts: FakeDbOptions = {}): {
  db: SupabaseClient;
  calls: string[];
  recipientUpdates: Record<string, unknown>[];
} {
  const calls: string[] = [];
  const recipientUpdates: Record<string, unknown>[] = [];

  const client = {
    from: (table: string) => {
      calls.push(table);
      // SPEC 062 §4.3 ponto 4: `assertAccountCanBroadcast` confere
      // `accounts.blocked_at` antes de tudo. Conta não bloqueada.
      if (table === 'accounts') {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: () =>
                Promise.resolve({ data: { blocked_at: null }, error: null }),
            }),
          }),
        };
      }
      if (table === 'channels') {
        return chain((filters) => {
          const id = filters.find(([k]) => k === 'id')?.[1];
          const rows = opts.channelRows ?? null;
          if (id !== undefined) {
            return {
              data: (rows ?? []).find((r) => r.id === id) ?? null,
              error: null,
            };
          }
          return { data: rows, error: null };
        });
      }
      if (table === 'whatsapp_config') {
        return chain(() =>
          opts.config
            ? { data: opts.config, error: null }
            : { data: null, error: null }
        );
      }
      if (table === 'message_templates') {
        // Dois formatos de consulta batem aqui: `sendIngestTemplate`
        // busca UMA linha por id (`.eq().eq().maybeSingle()`), e
        // `assertTemplateChannelCompatible` (via `loadTemplateCandidates`,
        // SPEC 065 D-3) busca uma LISTA por nome+idioma, sem
        // `.maybeSingle()` — o link precisa responder aos dois.
        const link: Record<string, unknown> = {
          eq: () => link,
          maybeSingle: () =>
            Promise.resolve({ data: opts.template ?? null, error: null }),
          then: (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) =>
            Promise.resolve({
              data: opts.template ? [opts.template] : [],
              error: null,
            }).then(onF, onR),
        };
        return { select: () => link };
      }
      if (table === 'broadcast_recipients') {
        return {
          update: (patch: Record<string, unknown>) => ({
            eq: () => {
              recipientUpdates.push(patch);
              return Promise.resolve({ error: null });
            },
          }),
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  };

  // P-15: `resolveCloudConfig` lê a credencial pelo service role; aqui ele e o
  // `db` são o mesmo fake.
  adminState.client = client;
  return { db: client as unknown as SupabaseClient, calls, recipientUpdates };
}

beforeEach(() => {
  cloudSendTemplate.mockClear();
  cloudSendTemplate.mockImplementation(async () => ({
    providerMessageId: 'wamid.1',
  }));
});

describe('sendIngestTemplate — channel capability (SPEC 049 §5.3)', () => {
  it('QR-only account: throws channel_not_capable, never queries whatsapp_config/message_templates', async () => {
    const { db, calls } = fakeDb({ channelRows: [{ type: 'whatsapp_qr' }] });

    await expect(
      sendIngestTemplate(db, {
        accountId: 'acc-1',
        phone: '5519991234567',
        templateId: 'tpl-1',
        templateParams: [],
        recipientRowId: 'rec-1',
      })
    ).rejects.toMatchObject({ code: 'channel_not_capable' });

    expect(calls).toEqual(['accounts', 'channels']);
    expect(cloudSendTemplate).not.toHaveBeenCalled();
  });
});

describe('sendIngestTemplate — template lookup', () => {
  it('throws template_not_found when the id does not exist in this account', async () => {
    const { db } = fakeDb({ channelRows: [], template: null });

    await expect(
      sendIngestTemplate(db, {
        accountId: 'acc-1',
        phone: '5519991234567',
        templateId: 'missing',
        templateParams: [],
        recipientRowId: 'rec-1',
      })
    ).rejects.toBeInstanceOf(IngestSendError);
    await expect(
      sendIngestTemplate(db, {
        accountId: 'acc-1',
        phone: '5519991234567',
        templateId: 'missing',
        templateParams: [],
        recipientRowId: 'rec-1',
      })
    ).rejects.toMatchObject({ code: 'template_not_found' });
  });

  it('throws template_not_approved for a PENDING template', async () => {
    const { db } = fakeDb({
      channelRows: [],
      template: { ...APPROVED_TEMPLATE, status: 'PENDING' },
    });

    await expect(
      sendIngestTemplate(db, {
        accountId: 'acc-1',
        phone: '5519991234567',
        templateId: 'tpl-1',
        templateParams: [],
        recipientRowId: 'rec-1',
      })
    ).rejects.toMatchObject({
      code: 'template_not_approved',
      status: 'PENDING',
    });
  });
});

describe('sendIngestTemplate — channel not configured', () => {
  it('canal órfão (sem credencial) vira channel_not_capable, com o motivo', async () => {
    const { db } = fakeDb({
      channelRows: [CLOUD_CHANNEL],
      template: APPROVED_TEMPLATE,
      config: null,
    });

    await expect(
      sendIngestTemplate(db, {
        accountId: 'acc-1',
        phone: '5519991234567',
        templateId: 'tpl-1',
        templateParams: [],
        recipientRowId: 'rec-1',
      })
    ).rejects.toMatchObject({ code: 'channel_not_capable' });
  });
});

describe('sendIngestTemplate — send success/failure', () => {
  it('sends, stamps the recipient row as sent, and returns the provider message id', async () => {
    const { db, recipientUpdates } = fakeDb({
      channelRows: [CLOUD_CHANNEL],
      template: APPROVED_TEMPLATE,
      config: CONFIG_ROW,
    });

    const result = await sendIngestTemplate(db, {
      accountId: 'acc-1',
      phone: '5519991234567',
      templateId: 'tpl-1',
      templateParams: ['Maria'],
      recipientRowId: 'rec-1',
    });

    expect(result).toEqual({ messageId: 'wamid.1' });
    expect(recipientUpdates).toEqual([
      expect.objectContaining({
        status: 'sent',
        whatsapp_message_id: 'wamid.1',
        error_message: null,
      }),
    ]);
  });

  it('usa a credencial DO CANAL, e o canal escolhido quando há um (SPEC 064)', async () => {
    // Antes da F3 isto era um `.single()` sobre `whatsapp_config` por
    // `account_id`: com dois números a ingestão sairia pelo número
    // errado — ou estouraria, mas só depois de a conta ter dois.
    const outro = {
      ...CLOUD_CHANNEL,
      id: 'ch-cloud-2',
      identifier: '5511977776666',
      is_default: false,
    };
    const { db } = fakeDb({
      channelRows: [CLOUD_CHANNEL, outro],
      template: APPROVED_TEMPLATE,
      config: { ...CONFIG_ROW, channel_id: 'ch-cloud-2' },
    });

    await sendIngestTemplate(db, {
      accountId: 'acc-1',
      phone: '5519991234567',
      templateId: 'tpl-1',
      templateParams: [],
      recipientRowId: 'rec-1',
      channelId: 'ch-cloud-2',
    });

    const [ctx] = cloudSendTemplate.mock.calls[0] as unknown as [
      { channel: { id: string; identifier: string | null } },
    ];
    expect(ctx.channel.id).toBe('ch-cloud-2');
    expect(ctx.channel.identifier).toBe('5511977776666');
  });

  it('a Meta failure marks the recipient row failed and throws send_failed', async () => {
    cloudSendTemplate.mockRejectedValueOnce(
      new Error('Meta API error: bad param')
    );
    const { db, recipientUpdates } = fakeDb({
      channelRows: [CLOUD_CHANNEL],
      template: APPROVED_TEMPLATE,
      config: CONFIG_ROW,
    });

    await expect(
      sendIngestTemplate(db, {
        accountId: 'acc-1',
        phone: '5519991234567',
        templateId: 'tpl-1',
        templateParams: [],
        recipientRowId: 'rec-1',
      })
    ).rejects.toMatchObject({ code: 'send_failed' });

    expect(recipientUpdates).toEqual([
      expect.objectContaining({
        status: 'failed',
        error_message: expect.stringContaining('Meta API error'),
      }),
    ]);
  });
});

describe('sendIngestTemplate — template×channel compatibility (SPEC 065 D-3)', () => {
  it('throws template_waba_mismatch when the resolved channel sends through a different WABA, and never calls Meta', async () => {
    const { db, recipientUpdates } = fakeDb({
      channelRows: [CLOUD_CHANNEL],
      template: { ...APPROVED_TEMPLATE, waba_id: 'waba-B' },
      config: { ...CONFIG_ROW, waba_id: 'waba-A' },
    });

    await expect(
      sendIngestTemplate(db, {
        accountId: 'acc-1',
        phone: '5519991234567',
        templateId: 'tpl-1',
        templateParams: [],
        recipientRowId: 'rec-1',
      })
    ).rejects.toMatchObject({ code: 'template_waba_mismatch' });

    expect(cloudSendTemplate).not.toHaveBeenCalled();
    // Nada de `broadcast_recipients` foi tocado: o disparo nem chegou a
    // ser tentado, então a linha permanece `pending` (mesma regra das
    // falhas de template não encontrado/aprovado).
    expect(recipientUpdates).toEqual([]);
  });

  it('sends when the resolved channel and the template share the same WABA', async () => {
    const { db } = fakeDb({
      channelRows: [CLOUD_CHANNEL],
      template: { ...APPROVED_TEMPLATE, waba_id: 'waba-A' },
      config: { ...CONFIG_ROW, waba_id: 'waba-A' },
    });

    const result = await sendIngestTemplate(db, {
      accountId: 'acc-1',
      phone: '5519991234567',
      templateId: 'tpl-1',
      templateParams: [],
      recipientRowId: 'rec-1',
    });

    expect(result).toEqual({ messageId: 'wamid.1' });
  });
});

describe('deriveChannelIdFromTemplateWaba (SPEC 065 D-9)', () => {
  function channelsDb(opts: {
    templateWabaId: string | null;
    channels: { id: string; waba_id: string | null }[];
  }): SupabaseClient {
    const client = {
      from: (table: string) => {
        if (table === 'message_templates') {
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  maybeSingle: () =>
                    Promise.resolve({
                      data: { waba_id: opts.templateWabaId },
                      error: null,
                    }),
                }),
              }),
            }),
          };
        }
        if (table === 'channels') {
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  neq: () =>
                    Promise.resolve({
                      data: opts.channels.map((c, i) => ({
                        id: c.id,
                        name: `Canal ${i}`,
                        identifier: null,
                        status: 'connected',
                        is_default: i === 0,
                        created_at: '2026-01-01T00:00:00.000Z',
                      })),
                      error: null,
                    }),
                }),
              }),
            }),
          };
        }
        if (table === 'whatsapp_config') {
          return {
            select: () => ({
              eq: () => ({
                in: () =>
                  Promise.resolve({
                    data: opts.channels.map((c) => ({
                      channel_id: c.id,
                      waba_id: c.waba_id,
                    })),
                    error: null,
                  }),
              }),
            }),
          };
        }
        throw new Error(`unexpected table ${table}`);
      },
    };
    return client as unknown as SupabaseClient;
  }

  it('derives the single Cloud channel of the template WABA', async () => {
    const db = channelsDb({
      templateWabaId: 'waba-B',
      channels: [
        { id: 'ch-a', waba_id: 'waba-A' },
        { id: 'ch-b', waba_id: 'waba-B' },
      ],
    });

    await expect(
      deriveChannelIdFromTemplateWaba(db, 'acc-1', 'tpl-1')
    ).resolves.toBe('ch-b');
  });

  it('returns null when two channels share the template WABA (ambiguous — falls back to default)', async () => {
    const db = channelsDb({
      templateWabaId: 'waba-A',
      channels: [
        { id: 'ch-a', waba_id: 'waba-A' },
        { id: 'ch-b', waba_id: 'waba-A' },
      ],
    });

    await expect(
      deriveChannelIdFromTemplateWaba(db, 'acc-1', 'tpl-1')
    ).resolves.toBeNull();
  });

  it('returns null when no channel matches the template WABA', async () => {
    const db = channelsDb({
      templateWabaId: 'waba-C',
      channels: [{ id: 'ch-a', waba_id: 'waba-A' }],
    });

    await expect(
      deriveChannelIdFromTemplateWaba(db, 'acc-1', 'tpl-1')
    ).resolves.toBeNull();
  });

  it('returns null for a legacy template with no WABA on file', async () => {
    const db = channelsDb({
      templateWabaId: null,
      channels: [{ id: 'ch-a', waba_id: 'waba-A' }],
    });

    await expect(
      deriveChannelIdFromTemplateWaba(db, 'acc-1', 'tpl-1')
    ).resolves.toBeNull();
  });
});
