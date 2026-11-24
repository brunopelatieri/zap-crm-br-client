/**
 * Regressão do issue #301 — a mensagem que some sem deixar log.
 *
 * O sintoma: conversas aparecendo no inbox com a thread VAZIA. O
 * contato e a conversa tinham sido criados, o INSERT da mensagem nunca
 * chegou, e nenhum erro em lugar nenhum. A causa foi uma promessa solta
 * (`processWebhook(body)` sem `await` e sem `after()`): na Vercel a
 * função pode ser congelada no instante em que a resposta sai, e o que
 * estava no meio de um write morre ali.
 *
 * `after()` entrega o callback ao runtime, que mantém a função viva até
 * ele resolver. Este arquivo existe para que trocar `after()` por uma
 * promessa solta — ou por um `await` inline, que estouraria o timeout de
 * ~20s da Meta e provocaria reentrega — quebre o build em vez de
 * reabrir o #301 em produção.
 */

import crypto from 'node:crypto';
import { describe, expect, it, vi, beforeEach } from 'vitest';

/** Callbacks que a rota entregou ao runtime via `after()`. */
const afterCallbacks: Array<() => unknown> = [];

vi.mock('next/server', () => ({
  after: (cb: () => unknown) => {
    afterCallbacks.push(cb);
  },
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      body,
    }),
  },
}));

/**
 * O que `resolveMetaWebhookSigner` devolve nos testes com o verificador
 * mockado. Padrão: o App padrão (`META_APP_SECRET`). O escopo de fato
 * (`signerCoversPhoneNumber`, `accountIdsForSigner`) é o REAL.
 */
let mockedSigner: unknown = { kind: 'default' };
vi.mock('@/lib/whatsapp/webhook-signature', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('@/lib/whatsapp/webhook-signature')
  >()),
  resolveMetaWebhookSigner: async () => mockedSigner,
  resolveWebhookChannelSecrets: async () => [],
}));

/** Cada valor que a rota decifrou (achado M-1: quem paga decifração). */
const decryptCalls: string[] = [];
vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: (v: string) => {
    decryptCalls.push(v);
    return `decrypted:${v}`;
  },
  encrypt: (v: string) => v,
  isLegacyFormat: () => false,
}));

const ingestInbound = vi.fn();
vi.mock('@/lib/channels/ingest', () => ({
  ingestInbound: (...args: unknown[]) => ingestInbound(...args),
}));

const dispatchWebhookEvent = vi.fn();
vi.mock('@/lib/webhooks/deliver', () => ({
  dispatchWebhookEvent: (...args: unknown[]) => dispatchWebhookEvent(...args),
}));

// SPEC 088 — o repetidor do webhook da Meta tem testes próprios
// (`meta-relay.test.ts`); aqui só importa COMO e QUANDO a rota o chama.
const relayMetaWebhook = vi.fn();
vi.mock('@/lib/webhooks/meta-relay', () => ({
  relayMetaWebhook: (...args: unknown[]) => relayMetaWebhook(...args),
}));

const markRevokedByContact = vi.fn();
vi.mock('@/lib/messages/revoke-by-contact', () => ({
  markRevokedByContact: (...args: unknown[]) => markRevokedByContact(...args),
}));

/**
 * `getMediaUrl`/`downloadMedia` reais fariam chamada de rede à Meta.
 * Cada teste de mídia ajusta o resolve/reject conforme o cenário.
 */
const getMediaUrl = vi.fn();
const downloadMedia = vi.fn();
vi.mock('@/lib/whatsapp/meta-api', () => ({
  getMediaUrl: (...args: unknown[]) => getMediaUrl(...args),
  downloadMedia: (...args: unknown[]) => downloadMedia(...args),
}));

/** Resultado do `.storage.from('chat-media').upload(...)` dentro do webhook. */
let storageUploadResult: { error: { message: string } | null } = {
  error: null,
};

/**
 * Linha de `messages` que `handleStatusUpdate` (SPEC 049 §5.5) lê para
 * resolver conta + canal do evento `message.status_updated`. `null`
 * por padrão — a maioria dos testes deste arquivo não passa por ali.
 */
let statusMessageRow: {
  conversation_id: string;
  conversations: {
    account_id: string;
    channel_id: string | null;
    channels: { type: string } | null;
  };
} | null = null;

/**
 * Linha de `channels` do número que recebeu a mensagem (SPEC 064 F3).
 * Padrão: conectado. Um teste troca por `disabled` para exercitar a
 * guarda do D-12.
 */
let channelRow: { id: string; name: string; status: string } | null = {
  id: 'chan-1',
  name: 'WhatsApp Oficial',
  status: 'connected',
};

/**
 * SPEC 076 F3 — o que o webhook escreve/consulta por causa do monitor de
 * cobrança. Cada UPDATE em `messages` e `broadcast_recipients` é
 * gravado, as consultas à `whatsapp_config` também (para contar a
 * memoização por número), e `rpc` responde por `rpcImpl`.
 */
const tableUpdates: Array<{
  table: string;
  payload: Record<string, unknown>;
  filters: unknown[][];
}> = [];
const configQueries: unknown[][][] = [];
/** Toda tabela consultada, na ordem (achado M-1: POST anônimo = nenhuma). */
const tablesQueried: string[] = [];
let broadcastRecipient: {
  id: string;
  status: string;
  contact_id: string | null;
} | null = null;
let billingStatusRow: Record<string, unknown> | null = null;
let billingMonitorEnabled = true;
const rpcImpl = vi.fn();
/**
 * `whatsapp_config` de duas contas: A (`pnid-1`, a de sempre) e B
 * (`pnid-2`), cada uma com o PRÓPRIO `app_secret` (cifrado; o `decrypt`
 * mockado devolve `decrypted:<cifra>`).
 */
const CONFIG_ROWS: Array<Record<string, unknown>> = [
  {
    id: 'cfg-1',
    account_id: 'acct-1',
    user_id: 'user-1',
    phone_number_id: 'pnid-1',
    waba_id: '100000000004821',
    access_token: 'cipher',
    channel_id: 'chan-1',
    app_secret: 'chan-secret',
    verify_token: 'verify',
  },
  {
    id: 'cfg-2',
    account_id: 'acct-2',
    user_id: 'user-2',
    phone_number_id: 'pnid-2',
    waba_id: '200000000004821',
    access_token: 'cipher-b',
    channel_id: 'chan-2',
    app_secret: 'chan-secret-b',
  },
];

/**
 * Erro que o UPDATE de `messages` devolve para um dado payload (simula o
 * PostgREST recusando coluna ausente). `null` = sucesso.
 */
let messagesUpdateError:
  | ((
      payload: Record<string, unknown>
    ) => { code: string; message: string } | null)
  | null = null;

// Só a consulta de `whatsapp_config` por `phone_number_id` é exercida
// diretamente aqui — o resto do trabalho de INGESTÃO está mockado no
// ingest. `messages`/`broadcast_recipients` ramificam por tabela porque
// `handleStatusUpdate` (não mockado) os lê de verdade.
vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    rpc: (fn: string, args: unknown) => rpcImpl(fn, args),
    storage: {
      from: () => ({
        upload: () => Promise.resolve(storageUploadResult),
      }),
    },
    from: (table: string) => {
      tablesQueried.push(table);
      if (table === 'messages') {
        // Two different call shapes hit `messages` inside
        // handleStatusUpdate: an `.update(...).eq(...)` mirror (awaited
        // directly, no `.select()`) and a `.select().eq().limit()
        // .maybeSingle()` read that resolves the owning conversation —
        // this fake answers both via `.then()` for the first and
        // `.maybeSingle()` for the second.
        let rec: (typeof tableUpdates)[number] | null = null;
        const chain = {
          select: () => chain,
          eq: (...a: unknown[]) => {
            rec?.filters.push(a);
            return chain;
          },
          limit: () => chain,
          update: (payload: Record<string, unknown>) => {
            rec = { table, payload, filters: [] };
            tableUpdates.push(rec);
            return chain;
          },
          maybeSingle: () =>
            Promise.resolve({ data: statusMessageRow, error: null }),
          then: (
            onF: (v: { error: unknown }) => unknown,
            onR?: (e: unknown) => unknown
          ) =>
            Promise.resolve({
              error: rec ? (messagesUpdateError?.(rec.payload) ?? null) : null,
            }).then(onF, onR),
        };
        return chain;
      }
      if (table === 'broadcast_recipients') {
        let rec: (typeof tableUpdates)[number] | null = null;
        const chain = {
          select: () => chain,
          eq: (...a: unknown[]) => {
            rec?.filters.push(a);
            return chain;
          },
          update: (payload: Record<string, unknown>) => {
            rec = { table, payload, filters: [] };
            tableUpdates.push(rec);
            return chain;
          },
          maybeSingle: () =>
            Promise.resolve({ data: broadcastRecipient, error: null }),
          then: (
            onF: (v: { error: null }) => unknown,
            onR?: (e: unknown) => unknown
          ) => Promise.resolve({ error: null }).then(onF, onR),
        };
        return chain;
      }
      if (table === 'whatsapp_billing_status') {
        const chain = {
          select: () => chain,
          eq: () => chain,
          maybeSingle: () =>
            Promise.resolve({ data: billingStatusRow, error: null }),
        };
        return chain;
      }
      if (table === 'platform_settings') {
        const chain = {
          select: () => chain,
          maybeSingle: () =>
            Promise.resolve({
              data: {
                whatsapp_billing_monitor_enabled: billingMonitorEnabled,
              },
              error: null,
            }),
        };
        return chain;
      }
      // SPEC 064 D-12: antes de ingerir, a rota confere o STATUS do
      // canal dono do número. Número desativado não cria conversa nem
      // decripta segredo nenhum.
      if (table === 'channels') {
        // `.maybeSingle()`: a guarda do D-12 na ingestão. Aguardado
        // direto (`.then`): os canais do WABA que a notificação de
        // pagamento (SPEC 076) consulta.
        const chain = {
          select: () => chain,
          eq: () => chain,
          neq: () => chain,
          in: () => chain,
          maybeSingle: () =>
            Promise.resolve({
              data: channelRow,
              error: null,
            }),
          then: (
            onF: (v: { data: unknown; error: null }) => unknown,
            onR?: (e: unknown) => unknown
          ) =>
            Promise.resolve({
              data: channelRow ? [{ id: channelRow.id }] : [],
              error: null,
            }).then(onF, onR),
        };
        return chain;
      }
      // Revisão de segurança da SPEC 088 — eventos de template (sem
      // número) são gravados com os filtros, para provar o escopo por
      // conta quando o POST veio assinado por segredo de canal.
      if (table === 'message_templates') {
        const rec = {
          table,
          payload: {} as Record<string, unknown>,
          filters: [] as unknown[][],
        };
        const chain = {
          update: (payload: Record<string, unknown>) => {
            rec.payload = payload;
            tableUpdates.push(rec);
            return chain;
          },
          eq: (...a: unknown[]) => {
            rec.filters.push(['eq', ...a]);
            return chain;
          },
          in: (...a: unknown[]) => {
            rec.filters.push(['in', ...a]);
            return chain;
          },
          select: () =>
            Promise.resolve({ data: [{ id: 'tpl-1' }], error: null }),
          then: (
            onF: (v: { error: null }) => unknown,
            onR?: (e: unknown) => unknown
          ) => Promise.resolve({ error: null }).then(onF, onR),
        };
        return chain;
      }
      // whatsapp_config — por `phone_number_id` (ingestão e sinal de
      // pagamento), por conta + WABA (canais a notificar) ou por lista de
      // números (`accountIdsForSigner`). Thenable em vez de resolver no
      // primeiro `.eq()`, para aceitar todos. Filtra por número e conta;
      // sem filtro, devolve só o número da conta A (como sempre).
      const filters: unknown[][] = [];
      const inFilters: Array<[string, unknown[]]> = [];
      let allRows = false;
      configQueries.push(filters);
      const matches = (row: Record<string, unknown>, col: string, v: unknown) =>
        !(col === 'phone_number_id' || col === 'account_id') || row[col] === v;
      const chain = {
        select: () => chain,
        eq: (...a: unknown[]) => {
          filters.push(a);
          return chain;
        },
        in: (col: string, values: unknown[]) => {
          inFilters.push([col, values]);
          return chain;
        },
        // `resolveWebhookChannelSecrets` (`.not('app_secret', 'is', null)`)
        // — só alcançado quando um teste usa o verificador real. Lê os
        // segredos de TODAS as contas.
        not: () => {
          allRows = true;
          return chain;
        },
        then: (
          onF: (v: { data: unknown; error: null }) => unknown,
          onR?: (e: unknown) => unknown
        ) => {
          const filtered = allRows || filters.length + inFilters.length > 0;
          const rows = (filtered ? CONFIG_ROWS : CONFIG_ROWS.slice(0, 1))
            .filter((row) =>
              filters.every(([col, v]) => matches(row, col as string, v))
            )
            .filter((row) =>
              inFilters.every(([col, vs]) =>
                vs.some((v) => matches(row, col, v))
              )
            );
          return Promise.resolve({ data: rows, error: null }).then(onF, onR);
        },
      };
      return chain;
    },
  }),
}));

import { POST } from './route';
import { META_WEBHOOK_MAX_BODY_BYTES } from '@/lib/whatsapp/webhook-body';
import {
  accountUpdateChange,
  envelope,
  messagesChange,
  templateStatusChange,
} from '@/lib/webhooks/meta-relay.fixtures';
import { __resetBillingSignalStateForTests } from '@/lib/whatsapp/billing-signal';

const INBOUND = {
  entry: [
    {
      id: 'entry-1',
      changes: [
        {
          field: 'messages',
          value: {
            messaging_product: 'whatsapp',
            metadata: {
              display_phone_number: '+551130000000',
              phone_number_id: 'pnid-1',
            },
            contacts: [{ profile: { name: 'Ana' }, wa_id: '5511999999999' }],
            messages: [
              {
                id: 'wamid.1',
                from: '5511999999999',
                timestamp: '1786000000',
                type: 'text',
                text: { body: 'oi' },
              },
            ],
          },
        },
      ],
    },
  ],
};

/** Bem formado (passa na guarda barata da rota), mas não valida nada. */
const WELL_FORMED_HEADER = `sha256=${'0'.repeat(64)}`;

function webhookRequest(
  body: BodyInit | null,
  headers: Record<string, string> = {}
): Request {
  return new Request('https://crm.example/api/whatsapp/webhook', {
    method: 'POST',
    body,
    headers,
    // Exigido pelo runtime quando o corpo é um ReadableStream.
    duplex: 'half',
  } as RequestInit);
}

function request(body: unknown): Request {
  return webhookRequest(JSON.stringify(body), {
    'x-hub-signature-256': WELL_FORMED_HEADER,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  afterCallbacks.length = 0;
  mockedSigner = { kind: 'default' };
  ingestInbound.mockResolvedValue(undefined);
  dispatchWebhookEvent.mockResolvedValue(undefined);
  relayMetaWebhook.mockResolvedValue(undefined);
  markRevokedByContact.mockResolvedValue(undefined);
  statusMessageRow = null;
  channelRow = { id: 'chan-1', name: 'WhatsApp Oficial', status: 'connected' };
  tableUpdates.length = 0;
  configQueries.length = 0;
  tablesQueried.length = 0;
  decryptCalls.length = 0;
  messagesUpdateError = null;
  broadcastRecipient = null;
  billingStatusRow = null;
  billingMonitorEnabled = true;
  rpcImpl.mockResolvedValue({ data: false, error: null });
  __resetBillingSignalStateForTests();
  storageUploadResult = { error: null };
  getMediaUrl.mockResolvedValue({
    url: 'https://cdn.meta.example/media-1',
    mimeType: 'image/jpeg',
  });
  downloadMedia.mockResolvedValue({
    buffer: Buffer.from('fake-bytes'),
    contentType: 'image/jpeg',
  });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

function imageRequest(): Request {
  return request({
    entry: [
      {
        id: 'entry-1',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: {
                display_phone_number: '+551130000000',
                phone_number_id: 'pnid-1',
              },
              contacts: [{ profile: { name: 'Ana' }, wa_id: '5511999999999' }],
              messages: [
                {
                  id: 'wamid.2',
                  from: '5511999999999',
                  timestamp: '1786000000',
                  type: 'image',
                  image: { id: 'media-1', mime_type: 'image/jpeg' },
                },
              ],
            },
          },
        ],
      },
    ],
  });
}

function statusRequest(status: {
  id: string;
  status: string;
  timestamp: string;
  recipient_id: string;
}): Request {
  return request({
    entry: [
      {
        id: 'entry-1',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: {
                display_phone_number: '+551130000000',
                phone_number_id: 'pnid-1',
              },
              statuses: [status],
            },
          },
        ],
      },
    ],
  });
}

describe('POST /api/whatsapp/webhook — ack e processamento', () => {
  it('responde 200 ANTES de processar, e processa dentro de after()', async () => {
    const res = await POST(request(INBOUND));

    // 1) A Meta é reconhecida na hora: um ack lento vira reentrega, que
    //    vira mensagem duplicada.
    expect(res.status).toBe(200);

    // 2) Nada de ingestão ainda — o trabalho NÃO pode acontecer inline.
    expect(ingestInbound).not.toHaveBeenCalled();

    // 3) …e não pode ter virado promessa solta: tem de estar na mão do
    //    runtime, que mantém a função viva até resolver (#301).
    expect(afterCallbacks).toHaveLength(1);

    await afterCallbacks[0]!();
    expect(ingestInbound).toHaveBeenCalledTimes(1);
  });

  it('entrega ao ingest o instante DA META e o canal oficial', async () => {
    await POST(request(INBOUND));
    await afterCallbacks[0]!();

    const [ctx, event] = ingestInbound.mock.calls[0] as [
      { accountId: string; ownerUserId: string; channelType: string },
      { occurredAt: Date; providerMessageId: string; fromPhone: string },
    ];

    expect(ctx).toMatchObject({
      accountId: 'acct-1',
      ownerUserId: 'user-1',
      channelType: 'whatsapp_cloud',
    });
    expect(event.providerMessageId).toBe('wamid.1');
    expect(event.fromPhone).toBe('5511999999999');
    // `1786000000` em segundos — nunca `new Date()` do nosso servidor.
    expect(event.occurredAt.getTime()).toBe(1786000000 * 1000);
  });

  it('número DESATIVADO: nada é ingerido, e o log nomeia o número (SPEC 064 D-12)', async () => {
    // Desativar preserva canal, histórico e configuração e zera só o
    // segredo (`access_token = ''`). Sem esta guarda a rota decriptaria
    // uma string vazia e, pior, abriria conversa num número que não
    // pode responder. Antes da 072 o caso equivalente caía no genérico
    // "No config found" — o log agora diz o motivo certo.
    channelRow = { id: 'chan-1', name: 'Suporte', status: 'disabled' };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const res = await POST(request(INBOUND));
    expect(res.status).toBe(200);
    await afterCallbacks[0]!();

    expect(ingestInbound).not.toHaveBeenCalled();
    const logged = warn.mock.calls.flat().join(' ');
    expect(logged).toContain('disabled');
    expect(logged).toContain('Suporte');
    expect(logged).toContain('pnid-1');
    warn.mockRestore();
  });

  it('canal apagado fora do fluxo normal: não ingere', async () => {
    channelRow = null;
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    await POST(request(INBOUND));
    await afterCallbacks[0]!();

    expect(ingestInbound).not.toHaveBeenCalled();
    error.mockRestore();
  });

  it('uma falha no processamento não escapa do callback', async () => {
    ingestInbound.mockRejectedValue(new Error('boom'));

    const res = await POST(request(INBOUND));
    expect(res.status).toBe(200);

    // O runtime não pode receber uma rejeição não tratada por causa de
    // uma mensagem malformada.
    await expect(afterCallbacks[0]!()).resolves.not.toThrow();
  });

  it('assinatura inválida devolve 401 e não agenda trabalho nenhum', async () => {
    // Nenhum segredo conferiu (o resto do módulo de assinatura é o real).
    mockedSigner = null;

    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const res = await POST(request(INBOUND));

    expect(res.status).toBe(401);
    expect(afterCallbacks).toHaveLength(0);
    // SPEC 088 §4.4 — sem assinatura válida o repetidor NÃO recebe nada:
    // um corpo forjado nunca pode ser reenviado ao destino do cliente.
    expect(relayMetaWebhook).not.toHaveBeenCalled();
  });
});

describe('POST /api/whatsapp/webhook — repetidor do webhook da Meta (SPEC 088 §4.4)', () => {
  // Corpo REAL da Meta (exemplo oficial, via fixture) para o número que a
  // config mockada resolve (`pnid-1`).
  const RELAY_BODY = envelope('100000000004821', [
    messagesChange({ phoneNumberId: 'pnid-1' }),
  ]);
  // Bytes que `JSON.stringify(body)` NÃO reproduz: indentação, quebra de
  // linha final e acento em escape unicode (barra invertida + u00e9, que o
  // `JSON.stringify` reescreveria como o próprio caractere). Se a rota
  // reserializasse o corpo, o
  // repetidor receberia outra string e a assinatura do cliente quebraria.
  const RAW_BODY = `${JSON.stringify(RELAY_BODY, null, 2).replace('this is a text message', 'caf\\u00e9')}\n`;

  function rawRequest(raw: string): Request {
    return webhookRequest(raw, { 'x-hub-signature-256': WELL_FORMED_HEADER });
  }

  /** Deixa as promessas e os `await` encadeados do `after()` correrem. */
  const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

  it('assinatura válida: dentro do after(), com o rawBody EXATO e o body já lido', async () => {
    const res = await POST(rawRequest(RAW_BODY));

    expect(res.status).toBe(200);
    // Nada inline: o repetidor também só roda via after() (#301).
    expect(relayMetaWebhook).not.toHaveBeenCalled();
    expect(afterCallbacks).toHaveLength(1);

    await afterCallbacks[0]!();

    expect(relayMetaWebhook).toHaveBeenCalledTimes(1);
    const [db, input] = relayMetaWebhook.mock.calls[0] as [
      unknown,
      { rawBody: string; body: unknown; signer: unknown },
    ];
    expect(db).toBeTruthy();
    expect(input.signer).toEqual({ kind: 'default' });
    // Mesma string lida do corpo da requisição, byte a byte.
    expect(input.rawBody).toBe(RAW_BODY);
    expect(input.rawBody).not.toBe(JSON.stringify(RELAY_BODY));
    expect(input.body).toEqual(JSON.parse(RAW_BODY));
    // O ingest segue idêntico ao de antes.
    expect(ingestInbound).toHaveBeenCalledTimes(1);
  });

  it('roda em PARALELO: ingest travado não atrasa o repetidor', async () => {
    let releaseIngest!: () => void;
    ingestInbound.mockReturnValue(
      new Promise<void>((resolve) => {
        releaseIngest = resolve;
      })
    );

    await POST(rawRequest(RAW_BODY));
    const done = afterCallbacks[0]!();
    await flush();

    expect(ingestInbound).toHaveBeenCalledTimes(1); // ainda pendente
    expect(relayMetaWebhook).toHaveBeenCalledTimes(1);

    releaseIngest();
    await done;
  });

  it('roda em PARALELO: repetidor travado não atrasa o ingest', async () => {
    let releaseRelay!: () => void;
    relayMetaWebhook.mockReturnValue(
      new Promise<void>((resolve) => {
        releaseRelay = resolve;
      })
    );

    await POST(rawRequest(RAW_BODY));
    const done = afterCallbacks[0]!();
    await flush();

    expect(relayMetaWebhook).toHaveBeenCalledTimes(1); // ainda pendente
    expect(ingestInbound).toHaveBeenCalledTimes(1);

    releaseRelay();
    await done;
  });

  it('repetidor que REJEITA não impede o ingest nem faz o after() rejeitar', async () => {
    relayMetaWebhook.mockRejectedValue(new Error('relay boom'));

    await POST(rawRequest(RAW_BODY));

    await expect(afterCallbacks[0]!()).resolves.not.toThrow();
    expect(relayMetaWebhook).toHaveBeenCalledTimes(1);
    expect(ingestInbound).toHaveBeenCalledTimes(1);
  });

  it('ingest que REJEITA não impede o repetidor, e o erro é logado como antes', async () => {
    ingestInbound.mockRejectedValue(new Error('ingest boom'));

    await POST(rawRequest(RAW_BODY));

    await expect(afterCallbacks[0]!()).resolves.not.toThrow();
    expect(relayMetaWebhook).toHaveBeenCalledTimes(1);
    expect(console.error).toHaveBeenCalledWith(
      'Error processing webhook:',
      expect.any(Error)
    );
  });

  it('JSON inválido com assinatura válida: 400 e o repetidor não é chamado', async () => {
    const res = await POST(rawRequest('{ não é json'));

    expect(res.status).toBe(400);
    expect(afterCallbacks).toHaveLength(0);
    expect(relayMetaWebhook).not.toHaveBeenCalled();
  });

  // Revisão de segurança SPEC 088, achado 1 — com o verificador REAL: a
  // rota tem de entregar ao repetidor QUAL segredo validou. O
  // `whatsapp_config` mockado guarda `app_secret` = 'chan-secret' para
  // `pnid-1` (o `decrypt` mockado devolve 'decrypted:chan-secret').
  describe('escopo do segredo que validou (verificador real)', () => {
    async function realPost() {
      vi.resetModules();
      vi.doUnmock('@/lib/whatsapp/webhook-signature');
      return (await import('./route')).POST;
    }

    function signedRequest(raw: string, secret: string): Request {
      const sig =
        'sha256=' +
        crypto.createHmac('sha256', secret).update(raw).digest('hex');
      return webhookRequest(raw, { 'x-hub-signature-256': sig });
    }

    async function signerSeenByRelay(secret: string) {
      const RealPOST = await realPost();
      const res = await RealPOST(signedRequest(RAW_BODY, secret));
      expect(res.status).toBe(200);
      await afterCallbacks[0]!();
      expect(relayMetaWebhook).toHaveBeenCalledTimes(1);
      return (
        relayMetaWebhook.mock.calls[0] as [unknown, { signer: unknown }]
      )[1].signer;
    }

    it('segredo de canal: o repetidor recebe só os números desse canal', async () => {
      const signer = (await signerSeenByRelay('decrypted:chan-secret')) as {
        kind: string;
        phoneNumberIds: Set<string>;
      };
      expect(signer.kind).toBe('channels');
      expect([...signer.phoneNumberIds]).toEqual(['pnid-1']);
    });

    it('META_APP_SECRET: o repetidor recebe o escopo do App padrão', async () => {
      expect(await signerSeenByRelay(process.env.META_APP_SECRET!)).toEqual({
        kind: 'default',
      });
    });

    // Ponta a ponta: o MESMO escopo vale para o ingest, não só para o
    // repetidor. Admin de A assina com o segredo do canal de A um corpo
    // com o número de B.
    it('ingest: segredo do canal de A + número de B → nada é ingerido para B', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const RealPOST = await realPost();
      const raw = JSON.stringify(
        envelope('200000000004821', [
          messagesChange({ phoneNumberId: 'pnid-2' }),
        ])
      );
      const res = await RealPOST(signedRequest(raw, 'decrypted:chan-secret'));
      expect(res.status).toBe(200);
      await afterCallbacks[0]!();
      expect(ingestInbound).not.toHaveBeenCalled();
    });

    it('ingest: segredo do canal de A + número de A → ingerido normalmente', async () => {
      const RealPOST = await realPost();
      const raw = JSON.stringify(
        envelope('100000000004821', [
          messagesChange({ phoneNumberId: 'pnid-1' }),
        ])
      );
      await RealPOST(signedRequest(raw, 'decrypted:chan-secret'));
      await afterCallbacks[0]!();
      expect(ingestInbound).toHaveBeenCalledTimes(1);
      expect(ingestInbound.mock.calls[0]![0]).toMatchObject({
        accountId: 'acct-1',
      });
    });

    it('segredo desconhecido: 401, nada agendado', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const RealPOST = await realPost();
      const res = await RealPOST(signedRequest(RAW_BODY, 'not-on-file'));
      expect(res.status).toBe(401);
      expect(afterCallbacks).toHaveLength(0);
      expect(relayMetaWebhook).not.toHaveBeenCalled();
    });
  });
});

// Revisão de segurança da SPEC 088 — o ingest respeita o escopo do
// segredo que validou o POST. `META_APP_SECRET` vale para todo número; o
// `app_secret` de um canal, só para os números que o guardam. A = `pnid-1`
// (acct-1), B = `pnid-2` (acct-2).
describe('POST /api/whatsapp/webhook — escopo do segredo no ingest', () => {
  const channelSigner = (...ids: string[]) => ({
    kind: 'channels',
    phoneNumberIds: new Set(ids),
  });

  /** Mesmo formato de status dos demais testes deste arquivo. */
  function statusChange(phoneNumberId: string | null) {
    return {
      field: 'messages',
      value: {
        messaging_product: 'whatsapp',
        ...(phoneNumberId
          ? {
              metadata: {
                display_phone_number: '+551130000000',
                phone_number_id: phoneNumberId,
              },
            }
          : {}),
        statuses: [
          {
            id: 'wamid.b-1',
            status: 'delivered',
            timestamp: '1786000000',
            recipient_id: '5511999999999',
          },
        ],
      },
    };
  }

  async function run(body: unknown) {
    const res = await POST(request(body));
    // Nunca erro visível para a Meta: 200 (sem reentrega).
    expect(res.status).toBe(200);
    await afterCallbacks[afterCallbacks.length - 1]!();
  }

  const ingestedAccounts = () =>
    ingestInbound.mock.calls.map(
      (c) => (c[0] as { accountId: string }).accountId
    );
  const updatesOn = (table: string) =>
    tableUpdates.filter((u) => u.table === table);

  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('segredo de A + mensagem do número de B: nada é ingerido para B, e o aviso não vaza o corpo', async () => {
    mockedSigner = channelSigner('pnid-1');

    await run(
      envelope('200000000004821', [
        messagesChange({ phoneNumberId: 'pnid-2', text: 'injetada' }),
      ])
    );

    expect(ingestInbound).not.toHaveBeenCalled();
    expect(dispatchWebhookEvent).not.toHaveBeenCalled();
    const logged = vi.mocked(console.warn).mock.calls.flat().join(' ');
    expect(logged).toContain('pnid-2');
    expect(logged).not.toContain('injetada');
  });

  it('segredo de A + mensagem do número de A: ingerido normalmente', async () => {
    mockedSigner = channelSigner('pnid-1');

    await run(
      envelope('100000000004821', [messagesChange({ phoneNumberId: 'pnid-1' })])
    );

    expect(ingestedAccounts()).toEqual(['acct-1']);
  });

  it('META_APP_SECRET + qualquer número: como antes (B é ingerido)', async () => {
    mockedSigner = { kind: 'default' };

    await run(
      envelope('200000000004821', [messagesChange({ phoneNumberId: 'pnid-2' })])
    );

    expect(ingestedAccounts()).toEqual(['acct-2']);
  });

  it('POST misto (A e B) com segredo de A: só A, sem derrubar os demais changes', async () => {
    mockedSigner = channelSigner('pnid-1');

    await run(
      envelope('100000000004821', [
        messagesChange({ phoneNumberId: 'pnid-2' }),
        accountUpdateChange(),
        messagesChange({ phoneNumberId: 'pnid-1' }),
      ])
    );

    expect(ingestedAccounts()).toEqual(['acct-1']);
  });

  it('status do número de B com segredo de A: nenhum espelho nem webhook de saída', async () => {
    mockedSigner = channelSigner('pnid-1');
    statusMessageRow = {
      conversation_id: 'conv-b',
      conversations: {
        account_id: 'acct-2',
        channel_id: 'chan-2',
        channels: { type: 'whatsapp_cloud' },
      },
    };
    broadcastRecipient = { id: 'rec-b', status: 'sent', contact_id: null };

    await run(envelope('200000000004821', [statusChange('pnid-2')]));

    expect(updatesOn('messages')).toEqual([]);
    expect(updatesOn('broadcast_recipients')).toEqual([]);
    expect(dispatchWebhookEvent).not.toHaveBeenCalled();
  });

  it('status SEM número com segredo de canal: ignorado (fail-closed); com META_APP_SECRET, como antes', async () => {
    mockedSigner = channelSigner('pnid-1');
    await run(envelope('100000000004821', [statusChange(null)]));
    expect(updatesOn('messages')).toEqual([]);

    mockedSigner = { kind: 'default' };
    await run(envelope('100000000004821', [statusChange(null)]));
    expect(updatesOn('messages')).toHaveLength(1);
  });

  it('status do número de A com segredo de A: espelhado normalmente', async () => {
    mockedSigner = channelSigner('pnid-1');

    await run(envelope('100000000004821', [statusChange('pnid-1')]));

    expect(updatesOn('messages')).toHaveLength(1);
  });

  it('evento de template com segredo de A: só toca templates das contas desse segredo', async () => {
    mockedSigner = channelSigner('pnid-1');

    await run(envelope('100000000004821', [templateStatusChange()]));

    const [update] = updatesOn('message_templates');
    expect(update?.payload).toMatchObject({ status: 'APPROVED' });
    expect(update?.filters).toEqual([
      ['eq', 'meta_template_id', '12345678'],
      ['in', 'account_id', ['acct-1']],
    ]);
  });

  it('evento de template com META_APP_SECRET: sem restrição de conta, como antes', async () => {
    mockedSigner = { kind: 'default' };

    await run(envelope('100000000004821', [templateStatusChange()]));

    expect(updatesOn('message_templates')[0]?.filters).toEqual([
      ['eq', 'meta_template_id', '12345678'],
    ]);
  });

  it('evento de template com segredo de canal que não cobre número algum: ignorado', async () => {
    mockedSigner = channelSigner();

    await run(envelope('100000000004821', [templateStatusChange()]));

    expect(updatesOn('message_templates')).toEqual([]);
  });
});

// Achado M-1 da revisão da SPEC 088 — a rota é anônima até a assinatura
// validar: um POST qualquer não pode custar memória, banco nem decifração.
// Verificador REAL (só banco, cifra e ingest são mockados).
describe('POST /api/whatsapp/webhook — custo de um POST anônimo', () => {
  const ENV_SECRET = process.env.META_APP_SECRET!;
  const BODY = JSON.stringify(
    envelope('100000000004821', [messagesChange({ phoneNumberId: 'pnid-1' })])
  );
  const encode = (text: string) => new TextEncoder().encode(text);

  async function realRoute() {
    vi.resetModules();
    vi.doUnmock('@/lib/whatsapp/webhook-signature');
    return import('./route');
  }

  function sign(raw: string | Uint8Array, secret = ENV_SECRET): string {
    return (
      'sha256=' + crypto.createHmac('sha256', secret).update(raw).digest('hex')
    );
  }

  /** Corpo em stream (um chunk por leitura, sem buffer), com contador. */
  function streamOf(chunks: Iterable<Uint8Array>) {
    const it = chunks[Symbol.iterator]();
    const seen = { pulls: 0, cancelled: false };
    const stream = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          seen.pulls++;
          const { done, value } = it.next();
          if (done) controller.close();
          else controller.enqueue(value);
        },
        cancel() {
          seen.cancelled = true;
        },
      },
      { highWaterMark: 0 }
    );
    return { stream, seen };
  }

  /** Corpo JSON válido com exatamente `size` bytes (preenche com espaços). */
  function bodyOfSize(size: number): string {
    return BODY + ' '.repeat(size - encode(BODY).byteLength);
  }

  function expectNothingHappened() {
    expect(tablesQueried).toEqual([]);
    expect(decryptCalls).toEqual([]);
    expect(afterCallbacks).toHaveLength(0);
    expect(relayMetaWebhook).not.toHaveBeenCalled();
  }

  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  const hex = 'a'.repeat(64);
  it.each([
    ['ausente', null],
    ['vazio', ''],
    ['curto', 'sha256=abc'],
    ['sem prefixo', hex],
    ['de outro algoritmo', `sha512=${hex}`],
    ['não-hex', `sha256=${'z'.repeat(64)}`],
    [
      'com o digest CERTO em maiúsculas',
      `sha256=${sign(BODY).slice(7).toUpperCase()}`,
    ],
  ])(
    'cabeçalho %s: 401 sem ler o corpo e sem tocar o banco',
    async (_label, header) => {
      const { POST: RealPOST } = await realRoute();
      const { stream, seen } = streamOf([encode(BODY)]);

      const res = (await RealPOST(
        webhookRequest(
          stream,
          header === null ? {} : { 'x-hub-signature-256': header }
        )
      )) as unknown as { status: number; body: unknown };

      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error: 'Invalid signature' });
      expect(seen.pulls).toBe(0);
      expectNothingHappened();
    }
  );

  it('content-length declarado acima do teto: 413 sem ler o corpo', async () => {
    const { POST: RealPOST } = await realRoute();
    const { stream, seen } = streamOf([encode(BODY)]);

    const res = (await RealPOST(
      webhookRequest(stream, {
        'x-hub-signature-256': sign(BODY),
        'content-length': String(META_WEBHOOK_MAX_BODY_BYTES + 1),
      })
    )) as unknown as { status: number; body: unknown };

    expect(res.status).toBe(413);
    expect(res.body).toEqual({ error: 'Payload too large' });
    expect(seen.pulls).toBe(0);
    expectNothingHappened();
  });

  it.each([
    ['sem content-length', {}],
    ['content-length mentiroso', { 'content-length': '10' }],
  ])('stream sem fim, %s: 413 abortando a leitura', async (_label, extra) => {
    const { POST: RealPOST } = await realRoute();
    const mib = new Uint8Array(1024 * 1024);
    // 64 MiB: o código antigo leria tudo antes de decidir.
    const { stream, seen } = streamOf(Array(64).fill(mib));

    const res = await RealPOST(
      webhookRequest(stream, {
        'x-hub-signature-256': WELL_FORMED_HEADER,
        ...(extra as Record<string, string>),
      })
    );

    expect(res.status).toBe(413);
    expect(seen.pulls).toBe(5); // 4 MiB cabem; o 5º estoura.
    expect(seen.cancelled).toBe(true);
    expectNothingHappened();
  });

  it('corpo ASSINADO um byte acima do teto: 413', async () => {
    const { POST: RealPOST } = await realRoute();
    const raw = bodyOfSize(META_WEBHOOK_MAX_BODY_BYTES + 1);

    const res = await RealPOST(
      webhookRequest(raw, { 'x-hub-signature-256': sign(raw) })
    );

    expect(res.status).toBe(413);
    expectNothingHappened();
  });

  it.each([
    ['3 MB (o máximo que a Meta documenta)', 3 * 1024 * 1024],
    ['exatamente o teto', META_WEBHOOK_MAX_BODY_BYTES],
  ])('%s: processado, com o rawBody intacto', async (_label, size) => {
    const { POST: RealPOST } = await realRoute();
    const raw = bodyOfSize(size);

    const res = await RealPOST(
      webhookRequest(raw, {
        'x-hub-signature-256': sign(raw),
        'content-length': String(size),
      })
    );
    expect(res.status).toBe(200);
    await afterCallbacks[0]!();

    expect(ingestInbound).toHaveBeenCalledTimes(1);
    const [, input] = relayMetaWebhook.mock.calls[0] as [
      unknown,
      { rawBody: string },
    ];
    expect(input.rawBody === raw).toBe(true);
  });

  it('META_APP_SECRET valida: 200 sem consultar nem decifrar segredo de canal', async () => {
    const { POST: RealPOST } = await realRoute();

    const res = (await RealPOST(
      webhookRequest(BODY, { 'x-hub-signature-256': sign(BODY) })
    )) as unknown as { status: number; body: unknown };

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'received' });
    expect(tablesQueried).toEqual([]);
    expect(decryptCalls).toEqual([]);

    await afterCallbacks[0]!();
    expect(ingestInbound).toHaveBeenCalledTimes(1);
    // Nem depois: só o token do canal, nunca os `app_secret`.
    expect(decryptCalls).toEqual(['cipher']);
  });

  it('segredo de canal: uma consulta, e o escopo é preservado', async () => {
    const { POST: RealPOST } = await realRoute();

    const res = await RealPOST(
      webhookRequest(BODY, {
        'x-hub-signature-256': sign(BODY, 'decrypted:chan-secret-b'),
      })
    );

    expect(res.status).toBe(200);
    expect(tablesQueried).toEqual(['whatsapp_config']);
    expect(decryptCalls).toEqual(['chan-secret', 'chan-secret-b']);
    await afterCallbacks[0]!();
    const [, input] = relayMetaWebhook.mock.calls[0] as [
      unknown,
      { signer: unknown },
    ];
    expect(input.signer).toEqual({
      kind: 'channels',
      phoneNumberIds: new Set(['pnid-2']),
    });
    // O corpo é do número de A; o segredo é o de B.
    expect(ingestInbound).not.toHaveBeenCalled();
  });

  it('cabeçalho bem formado mas errado: 401 só depois do ambiente e dos canais', async () => {
    const { POST: RealPOST } = await realRoute();

    const res = await RealPOST(
      webhookRequest(BODY, { 'x-hub-signature-256': WELL_FORMED_HEADER })
    );

    expect(res.status).toBe(401);
    expect(tablesQueried).toEqual(['whatsapp_config']);
    expect(afterCallbacks).toHaveLength(0);
  });

  // Semântica de `request.text()` preservada: o BOM some e o byte inválido
  // vira U+FFFD na decodificação, então o HMAC dos BYTES (o que a Meta
  // assina) não confere.
  it.each([
    ['BOM', Uint8Array.from([0xef, 0xbb, 0xbf, ...encode(BODY)])],
    ['UTF-8 inválido', Uint8Array.from([...encode(BODY), 0xff])],
  ])('%s: 401 para quem assinou os bytes, como antes', async (_label, raw) => {
    const { POST: RealPOST } = await realRoute();

    const res = await RealPOST(
      webhookRequest(raw, { 'x-hub-signature-256': sign(raw) })
    );

    expect(res.status).toBe(401);
    expect(relayMetaWebhook).not.toHaveBeenCalled();
  });

  it('caractere partido entre chunks: assinatura confere e o rawBody sai intacto', async () => {
    const { POST: RealPOST } = await realRoute();
    const raw = BODY.replace('this is a text message', 'olá, coração 💚');
    expect(raw).not.toBe(BODY);
    const encoded = encode(raw);

    const res = await RealPOST(
      webhookRequest(
        streamOf(Array.from(encoded, (b) => Uint8Array.of(b))).stream,
        { 'x-hub-signature-256': sign(encoded) }
      )
    );

    expect(res.status).toBe(200);
    await afterCallbacks[0]!();
    const [, input] = relayMetaWebhook.mock.calls[0] as [
      unknown,
      { rawBody: string },
    ];
    expect(input.rawBody).toBe(raw);
  });

  it('GET de verificação não depende do cabeçalho de assinatura', async () => {
    const { GET } = await realRoute();
    const url =
      'https://crm.example/api/whatsapp/webhook?hub.mode=subscribe' +
      '&hub.challenge=12345&hub.verify_token=decrypted:verify';

    const res = await GET(new Request(url));

    expect(res.status).toBe(200);
    await expect((res as Response).text()).resolves.toBe('12345');
  });
});

describe('mídia recebida — download eager no ingest, não mais só na abertura da conversa', () => {
  it('baixa o byte e grava media_path; media_url fica null (proxy nunca é chamado)', async () => {
    await POST(imageRequest());
    await afterCallbacks[0]!();

    const [, event] = ingestInbound.mock.calls[0] as [
      unknown,
      {
        mediaId: string | null;
        mediaUrl: string | null;
        mediaPath: string | null;
      },
    ];

    expect(downloadMedia).toHaveBeenCalledWith(
      expect.objectContaining({
        downloadUrl: 'https://cdn.meta.example/media-1',
      })
    );
    expect(event.mediaId).toBe('media-1');
    expect(event.mediaPath).toMatch(/^account-acct-1\/.+\.jpeg$/);
    expect(event.mediaUrl).toBeNull();
  });

  it('upload no bucket falhando cai pro caminho antigo (rota-proxy)', async () => {
    storageUploadResult = { error: { message: 'bucket indisponível' } };

    await POST(imageRequest());
    await afterCallbacks[0]!();

    const [, event] = ingestInbound.mock.calls[0] as [
      unknown,
      {
        mediaId: string | null;
        mediaUrl: string | null;
        mediaPath: string | null;
      },
    ];

    expect(event.mediaId).toBe('media-1');
    expect(event.mediaPath).toBeNull();
    expect(event.mediaUrl).toBe('/api/whatsapp/media/media-1');
  });

  it('mídia que não existe mais na Meta (getMediaUrl falha) não guarda nada', async () => {
    getMediaUrl.mockRejectedValue(new Error('subcode 33'));

    await POST(imageRequest());
    await afterCallbacks[0]!();

    const [, event] = ingestInbound.mock.calls[0] as [
      unknown,
      {
        mediaId: string | null;
        mediaUrl: string | null;
        mediaPath: string | null;
      },
    ];

    expect(downloadMedia).not.toHaveBeenCalled();
    expect(event.mediaId).toBeNull();
    expect(event.mediaPath).toBeNull();
    expect(event.mediaUrl).toBeNull();
  });
});

describe('message.status_updated carrega channel_id/channel_type (SPEC 049 §5.5)', () => {
  it('inclui channel_id e channel_type resolvidos da conversa, ao lado dos campos de sempre', async () => {
    statusMessageRow = {
      conversation_id: 'conv-1',
      conversations: {
        account_id: 'acct-1',
        channel_id: 'chan-qr-1',
        channels: { type: 'whatsapp_qr' },
      },
    };

    await POST(
      statusRequest({
        id: 'wamid.1',
        status: 'delivered',
        timestamp: '1786000000',
        recipient_id: '5511999999999',
      })
    );
    await afterCallbacks[0]!();

    expect(dispatchWebhookEvent).toHaveBeenCalledWith(
      expect.anything(),
      'acct-1',
      'message.status_updated',
      expect.objectContaining({
        whatsapp_message_id: 'wamid.1',
        conversation_id: 'conv-1',
        status: 'delivered',
        channel_id: 'chan-qr-1',
        channel_type: 'whatsapp_qr',
      })
    );
  });

  it('sem linha de mensagem correspondente, não dispara webhook nenhum', async () => {
    statusMessageRow = null;

    await POST(
      statusRequest({
        id: 'wamid.missing',
        status: 'delivered',
        timestamp: '1786000000',
        recipient_id: '5511999999999',
      })
    );
    await afterCallbacks[0]!();

    expect(dispatchWebhookEvent).not.toHaveBeenCalled();
  });
});

describe('POST /api/whatsapp/webhook — revogação pelo contato (SPEC 074 §9.1)', () => {
  function revokeRequest(originalMessageId: string | undefined): Request {
    return request({
      entry: [
        {
          id: 'entry-1',
          changes: [
            {
              field: 'messages',
              value: {
                messaging_product: 'whatsapp',
                metadata: {
                  display_phone_number: '+551130000000',
                  phone_number_id: 'pnid-1',
                },
                contacts: [
                  { profile: { name: 'Ana' }, wa_id: '5511999999999' },
                ],
                messages: [
                  {
                    id: 'wamid.revoke-event',
                    from: '5511999999999',
                    timestamp: '1786000000',
                    type: 'revoke',
                    ...(originalMessageId
                      ? { original_message_id: originalMessageId }
                      : {}),
                  },
                ],
              },
            },
          ],
        },
      ],
    });
  }

  it('marca a mensagem original via markRevokedByContact, sem ingerir nada', async () => {
    await POST(revokeRequest('wamid.original'));
    await afterCallbacks[0]!();

    expect(markRevokedByContact).toHaveBeenCalledTimes(1);
    expect(markRevokedByContact).toHaveBeenCalledWith(
      expect.anything(),
      'acct-1',
      'wamid.original'
    );
    expect(ingestInbound).not.toHaveBeenCalled();
  });

  it('sem original_message_id, ignora sem chamar markRevokedByContact', async () => {
    await POST(revokeRequest(undefined));
    await afterCallbacks[0]!();

    expect(markRevokedByContact).not.toHaveBeenCalled();
  });
});

describe('SPEC 076 F3 — pricing e sinal de pagamento no webhook de status', () => {
  /** Um POST com N statuses num único `change` do número `pnid-1`. */
  function statusesRequest(statuses: Array<Record<string, unknown>>): Request {
    return request({
      entry: [
        {
          // WABA segundo a Meta. Diverge de propósito do `waba_id` da
          // config ('100000000004821'): quem vale é a config (§7.8).
          id: '999999999990000',
          changes: [
            {
              field: 'messages',
              value: {
                messaging_product: 'whatsapp',
                metadata: {
                  display_phone_number: '+551130000000',
                  phone_number_id: 'pnid-1',
                },
                statuses,
              },
            },
          ],
        },
      ],
    });
  }

  const FAILED_131042 = {
    id: 'wamid.f1',
    status: 'failed',
    timestamp: '1790823600',
    recipient_id: '5511999999999',
    errors: [{ code: 131042, title: 'Business eligibility payment issue' }],
  };

  const applyCalls = () =>
    rpcImpl.mock.calls.filter((c) => c[0] === 'apply_payment_signal');
  const notifyCalls = () =>
    rpcImpl.mock.calls.filter((c) => c[0] === 'notify_channel_payment_blocked');

  async function run(req: Request) {
    await POST(req);
    await afterCallbacks[afterCallbacks.length - 1]!();
  }

  it('failed/131042 aciona o sinal com o WABA da CONFIG, o phone_number_id do evento e o carimbo da Meta', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await run(statusesRequest([FAILED_131042]));

    expect(applyCalls()).toEqual([
      [
        'apply_payment_signal',
        {
          p_account_id: 'acct-1',
          p_waba_id: '100000000004821',
          p_kind: 'payment_error',
          p_ts: '2026-10-01T03:00:00.000Z',
          p_phone_number_id: 'pnid-1',
        },
      ],
    ]);
    // A conta veio do número, não do entry.id.
    expect(configQueries[0]).toEqual([['phone_number_id', 'pnid-1']]);
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('waba mismatch')
    );
  });

  it('episódio novo com flag ligado notifica; a Meta REENVIANDO o mesmo webhook não duplica', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    // A função SQL abre o episódio na primeira vez e devolve FALSE na
    // repetição (COALESCE/GREATEST — verificado contra Postgres na F3).
    rpcImpl.mockImplementation(async (fn: string) => {
      if (fn === 'notify_channel_payment_blocked')
        return { data: 2, error: null };
      const first = applyCalls().length === 1;
      return { data: first, error: null };
    });

    await run(statusesRequest([FAILED_131042]));
    // Reenvio com o retrato do processo ainda quente: barrado ANTES do
    // banco (pendente, carimbo igual).
    await run(statusesRequest([FAILED_131042]));
    expect(applyCalls()).toHaveLength(1);

    // Reenvio caindo em OUTRO processo (cache frio): a função SQL é
    // chamada, devolve FALSE, e nenhuma notificação nova sai.
    __resetBillingSignalStateForTests();
    await run(statusesRequest([FAILED_131042]));
    expect(applyCalls()).toHaveLength(2);

    expect(notifyCalls()).toEqual([
      [
        'notify_channel_payment_blocked',
        {
          p_account_id: 'acct-1',
          p_channel_id: 'chan-1',
          p_waba_id: '100000000004821',
        },
      ],
    ]);
  });

  it('flag DESLIGADO: o estado é gravado, nenhuma notificação é criada', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    billingMonitorEnabled = false;
    rpcImpl.mockResolvedValue({ data: true, error: null });

    await run(statusesRequest([FAILED_131042]));

    expect(applyCalls()).toHaveLength(1);
    expect(notifyCalls()).toHaveLength(0);
  });

  it('vários statuses no mesmo change: a conta é resolvida UMA vez', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});

    rpcImpl.mockImplementation(async (fn: string) =>
      fn === 'apply_payment_signal'
        ? { data: applyCalls().length === 1, error: null }
        : { data: 1, error: null }
    );

    await run(
      statusesRequest([
        { ...FAILED_131042, id: 'wamid.a' },
        { ...FAILED_131042, id: 'wamid.b', timestamp: '1790823660' },
        { ...FAILED_131042, id: 'wamid.c', timestamp: '1790823720' },
      ])
    );

    const byPhone = configQueries.filter((f) =>
      f.some((a) => a[0] === 'phone_number_id')
    );
    expect(byPhone).toHaveLength(1);
  });

  it('delivered com pricing grava as colunas no MESMO UPDATE do status (1 escrita); status sem pricing não toca nelas', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    await run(
      statusesRequest([
        {
          id: 'wamid.d',
          status: 'delivered',
          timestamp: '1790823600',
          recipient_id: '5511999999999',
          pricing: {
            billable: true,
            pricing_model: 'PMP',
            category: 'marketing',
            type: 'regular',
          },
        },
        {
          id: 'wamid.r',
          status: 'read',
          timestamp: '1790823700',
          recipient_id: '5511999999999',
        },
      ])
    );

    const msgUpdates = tableUpdates.filter((u) => u.table === 'messages');
    expect(msgUpdates).toEqual([
      {
        table: 'messages',
        payload: {
          status: 'delivered',
          pricing_billable: true,
          pricing_category: 'MARKETING',
        },
        filters: [['message_id', 'wamid.d']],
      },
      // O `read` sem pricing: só o status — nada de pricing_* nulo por cima.
      {
        table: 'messages',
        payload: { status: 'read' },
        filters: [['message_id', 'wamid.r']],
      },
    ]);
  });

  it('086 ausente (coluna recusada): o UPDATE é REPETIDO só com o status — o espelho não cai — e o pricing fica desligado', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    messagesUpdateError = (payload) =>
      'pricing_billable' in payload || 'pricing_category' in payload
        ? { code: 'PGRST204', message: 'no column pricing_billable' }
        : null;
    const withPricing = (id: string) => ({
      id,
      status: 'delivered',
      timestamp: '1790823600',
      recipient_id: '5511999999999',
      pricing: { billable: false, category: 'service' },
    });

    await run(
      statusesRequest([withPricing('wamid.1'), withPricing('wamid.2')])
    );

    const payloads = tableUpdates
      .filter((u) => u.table === 'messages')
      .map((u) => [u.filters[0]![1], u.payload]);
    expect(payloads).toEqual([
      // 1º: tenta com pricing, é recusado, repete só com o status.
      [
        'wamid.1',
        {
          status: 'delivered',
          pricing_billable: false,
          pricing_category: 'SERVICE',
        },
      ],
      ['wamid.1', { status: 'delivered' }],
      // 2º: o pricing já está desligado — uma escrita só, sem tentar à toa.
      ['wamid.2', { status: 'delivered' }],
    ]);
    // Nenhum erro "Error updating message status" para o operador.
    expect(console.error).not.toHaveBeenCalledWith(
      'Error updating message status:',
      expect.anything()
    );
  });

  it('POSTs seguidos do mesmo número: conta/WABA resolvidos uma vez só (cache de processo)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    rpcImpl.mockImplementation(async (fn: string) =>
      fn === 'apply_payment_signal'
        ? { data: applyCalls().length === 1, error: null }
        : { data: 1, error: null }
    );

    for (let i = 0; i < 3; i++) {
      await run(
        statusesRequest([
          {
            ...FAILED_131042,
            id: `wamid.${i}`,
            timestamp: `${1790823600 + i * 60}`,
          },
        ])
      );
    }

    expect(
      configQueries.filter((f) => f.some((a) => a[0] === 'phone_number_id'))
    ).toHaveLength(1);
  });

  it('delivered cobrável depois do último 131042 limpa; billable=false nunca', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    billingStatusRow = {
      payment_blocked_since: '2026-10-01T02:00:00Z',
      last_payment_error_at: '2026-10-01T02:00:00Z',
    };

    await run(
      statusesRequest([
        {
          id: 'wamid.free',
          status: 'delivered',
          timestamp: '1790823600',
          recipient_id: '5511999999999',
          pricing: { billable: false, category: 'service' },
        },
        {
          id: 'wamid.paid',
          status: 'delivered',
          timestamp: '1790823660',
          recipient_id: '5511999999999',
          pricing: { billable: true, category: 'marketing' },
        },
      ])
    );

    expect(applyCalls()).toEqual([
      [
        'apply_payment_signal',
        expect.objectContaining({
          p_kind: 'billable_ok',
          p_ts: '2026-10-01T03:01:00.000Z',
        }),
      ],
    ]);
  });

  it('falha do sinal NÃO impede o espelho em broadcast_recipients nem o fan-out', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    broadcastRecipient = { id: 'rec-1', status: 'sent', contact_id: null };
    statusMessageRow = {
      conversation_id: 'conv-1',
      conversations: {
        account_id: 'acct-1',
        channel_id: 'chan-1',
        channels: { type: 'whatsapp_cloud' },
      },
    };
    rpcImpl.mockRejectedValue(new Error('db down'));

    await run(statusesRequest([FAILED_131042]));

    // O sinal foi tentado…
    expect(applyCalls()).toHaveLength(1);
    // …e mesmo falhando, o espelho e o fan-out aconteceram.
    expect(tableUpdates).toContainEqual({
      table: 'broadcast_recipients',
      payload: {
        status: 'failed',
        error_message: '(#131042) Business eligibility payment issue',
      },
      filters: [['id', 'rec-1']],
    });
    expect(dispatchWebhookEvent).toHaveBeenCalledWith(
      expect.anything(),
      'acct-1',
      'message.status_updated',
      expect.objectContaining({
        whatsapp_message_id: 'wamid.f1',
        status: 'failed',
      })
    );
  });
});
