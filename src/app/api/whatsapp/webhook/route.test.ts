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
/** Cifras que o `decrypt` mockado recusa (token corrompido; B-6). */
const decryptFailures = new Set<string>();
vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: (v: string) => {
    decryptCalls.push(v);
    if (decryptFailures.has(v)) throw new Error('bad decrypt');
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
 * Linhas de `messages` (o espelho de status localiza por `message_id` e
 * confere a conta da conversa). Vazio por padrão.
 */
interface MessageRow {
  id: string;
  message_id: string;
  conversation_id: string;
  conversations: {
    account_id: string;
    channel_id: string | null;
    channels: { type: string } | null;
  };
}
let messageRows: MessageRow[] = [];
/** Erro do SELECT de `messages`. `null` = sucesso. */
let messagesSelectError: { message: string } | null = null;
/** Quantos SELECTs de `messages` ainda falham (com o erro acima). */
let messagesSelectFailuresLeft = Infinity;
/** SELECTs de `messages` feitos. */
let messagesSelects = 0;

/** Mensagem `wamid` guardada na conta `accountId` (id da linha: `msg-…`). */
function storedMessage(
  wamid: string,
  accountId = 'acct-1',
  over: Partial<MessageRow> = {}
): MessageRow {
  return {
    id: `msg-${wamid}`,
    message_id: wamid,
    conversation_id: `conv-${accountId}`,
    conversations: {
      account_id: accountId,
      channel_id: accountId === 'acct-1' ? 'chan-1' : 'chan-2',
      channels: { type: 'whatsapp_cloud' },
    },
    ...over,
  };
}

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
interface RecipientRow {
  id: string;
  whatsapp_message_id: string;
  status: string;
  contact_id: string | null;
  broadcasts: { account_id: string };
  contacts: { account_id: string } | null;
}
let recipientRows: RecipientRow[] = [];

/** Destinatário de disparo do `wamid`, num disparo da conta `accountId`. */
function storedRecipient(
  wamid: string,
  accountId = 'acct-1',
  over: Partial<RecipientRow> = {}
): RecipientRow {
  return {
    id: `rec-${wamid}`,
    whatsapp_message_id: wamid,
    status: 'sent',
    contact_id: `contact-${accountId}`,
    broadcasts: { account_id: accountId },
    contacts: { account_id: accountId },
    ...over,
  };
}
/** Números cujo canal está `disabled` (embed `channels(status)` da config). */
const disabledNumbers = new Set<string>();
/** Erro da leitura de `whatsapp_config` por número. `null` = sucesso. */
let configError: { message: string } | null = null;
/** Quantas leituras de `whatsapp_config` ainda falham (com o erro acima). */
let configFailuresLeft = Infinity;
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
        // `select().eq('message_id')` (aguardado direto) devolve as
        // linhas; `update().in('id', …)` é gravado com os filtros.
        let rec: (typeof tableUpdates)[number] | null = null;
        const selectFilters: Array<[string, unknown]> = [];
        const selected = () =>
          messageRows.filter((row) =>
            selectFilters.every(([col, v]) =>
              col === 'message_id'
                ? row.message_id === v
                : col === 'conversations.account_id'
                  ? row.conversations.account_id === v
                  : true
            )
          );
        const chain = {
          select: () => chain,
          eq: (...a: [string, unknown]) => {
            if (rec) rec.filters.push(a);
            else selectFilters.push(a);
            return chain;
          },
          in: (...a: unknown[]) => {
            rec?.filters.push(['in', ...a]);
            return chain;
          },
          limit: () => chain,
          update: (payload: Record<string, unknown>) => {
            rec = { table, payload, filters: [] };
            tableUpdates.push(rec);
            return chain;
          },
          maybeSingle: () =>
            Promise.resolve({ data: selected()[0] ?? null, error: null }),
          then: (
            onF: (v: { data?: unknown; error: unknown }) => unknown,
            onR?: (e: unknown) => unknown
          ) => {
            if (!rec) messagesSelects++;
            return Promise.resolve(
              rec
                ? { error: messagesUpdateError?.(rec.payload) ?? null }
                : messagesSelectError && messagesSelectFailuresLeft-- > 0
                  ? { data: null, error: messagesSelectError }
                  : { data: selected(), error: null }
            ).then(onF, onR);
          },
        };
        return chain;
      }
      if (table === 'broadcast_recipients') {
        let rec: (typeof tableUpdates)[number] | null = null;
        let wamid: unknown;
        const chain = {
          select: () => chain,
          eq: (...a: unknown[]) => {
            if (rec) rec.filters.push(a);
            else if (a[0] === 'whatsapp_message_id') wamid = a[1];
            return chain;
          },
          // Heurística das duas últimas falhas (`detectDeadNumberOnFailure`).
          order: () => chain,
          limit: () => chain,
          update: (payload: Record<string, unknown>) => {
            rec = { table, payload, filters: [] };
            tableUpdates.push(rec);
            return chain;
          },
          maybeSingle: () =>
            Promise.resolve({
              data:
                recipientRows.find((r) => r.whatsapp_message_id === wamid) ??
                null,
              error: null,
            }),
          then: (
            onF: (v: { error: null }) => unknown,
            onR?: (e: unknown) => unknown
          ) => Promise.resolve({ error: null }).then(onF, onR),
        };
        return chain;
      }
      // `markWhatsappInvalid` — o flag de número morto.
      if (table === 'contacts') {
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
            rec.filters.push(a);
            return chain;
          },
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
          onF: (v: { data: unknown; error: unknown }) => unknown,
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
          const embedded = rows.map((row) => ({
            ...row,
            channels: {
              status: disabledNumbers.has(row.phone_number_id as string)
                ? 'disabled'
                : 'connected',
            },
          }));
          return Promise.resolve(
            configError && configFailuresLeft-- > 0
              ? { data: null, error: configError }
              : { data: embedded, error: null }
          ).then(onF, onR);
        },
      };
      return chain;
    },
  }),
}));

import { POST } from './route';
import { META_WEBHOOK_MAX_BODY_BYTES } from '@/lib/whatsapp/webhook-body';
import { MAX_ITEMS_PER_POST } from '@/lib/whatsapp/webhook-post-guard';
import {
  accountUpdateChange,
  envelope,
  envelopeOf,
  messagesChange,
  realMessagesRawBody,
  realStatusesRawBody,
  templateStatusChange,
} from '@/lib/webhooks/meta-relay.fixtures';
import { __resetBillingSignalStateForTests } from '@/lib/whatsapp/billing-signal';
import { __resetNumberOwnerCacheForTests } from '@/lib/whatsapp/number-owner';

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
  messageRows = [];
  messagesSelectError = null;
  messagesSelectFailuresLeft = Infinity;
  messagesSelects = 0;
  recipientRows = [];
  disabledNumbers.clear();
  configError = null;
  configFailuresLeft = Infinity;
  __resetNumberOwnerCacheForTests();
  channelRow = { id: 'chan-1', name: 'WhatsApp Oficial', status: 'connected' };
  tableUpdates.length = 0;
  configQueries.length = 0;
  tablesQueried.length = 0;
  decryptCalls.length = 0;
  decryptFailures.clear();
  messagesUpdateError = null;
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
    // B-6: o erro é isolado por `change`/mensagem e logado curto (tipo,
    // mensagem e posição), sem o objeto do erro nem o corpo.
    const logged = vi
      .mocked(console.error)
      .mock.calls.flat()
      .map(String)
      .join(' ');
    expect(logged).toContain('"unit":"message"');
    expect(logged).toContain('ingest boom');
    expect(logged).not.toContain('wamid.1');
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
    messageRows = [storedMessage('wamid.b-1', 'acct-2')];
    recipientRows = [storedRecipient('wamid.b-1', 'acct-2')];

    await run(envelope('200000000004821', [statusChange('pnid-2')]));

    expect(updatesOn('messages')).toEqual([]);
    expect(updatesOn('broadcast_recipients')).toEqual([]);
    expect(dispatchWebhookEvent).not.toHaveBeenCalled();
  });

  it('status SEM número com segredo de canal: ignorado (fail-closed); com META_APP_SECRET, como antes', async () => {
    messageRows = [storedMessage('wamid.b-1', 'acct-2')];
    mockedSigner = channelSigner('pnid-1');
    await run(envelope('100000000004821', [statusChange(null)]));
    expect(updatesOn('messages')).toEqual([]);

    mockedSigner = { kind: 'default' };
    await run(envelope('100000000004821', [statusChange(null)]));
    expect(updatesOn('messages')).toHaveLength(1);
  });

  it('status do número de A com segredo de A: espelhado normalmente', async () => {
    mockedSigner = channelSigner('pnid-1');
    messageRows = [storedMessage('wamid.b-1', 'acct-1')];

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
    messageRows = [
      storedMessage('wamid.1', 'acct-1', {
        conversation_id: 'conv-1',
        conversations: {
          account_id: 'acct-1',
          channel_id: 'chan-qr-1',
          channels: { type: 'whatsapp_qr' },
        },
      }),
    ];

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
    messageRows = [];

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
    messageRows = [storedMessage('wamid.d'), storedMessage('wamid.r')];

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
        filters: [['in', 'id', ['msg-wamid.d']]],
      },
      // O `read` sem pricing: só o status — nada de pricing_* nulo por cima.
      {
        table: 'messages',
        payload: { status: 'read' },
        filters: [['in', 'id', ['msg-wamid.r']]],
      },
    ]);
  });

  it('086 ausente (coluna recusada): o UPDATE é REPETIDO só com o status — o espelho não cai — e o pricing fica desligado', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    messagesUpdateError = (payload) =>
      'pricing_billable' in payload || 'pricing_category' in payload
        ? { code: 'PGRST204', message: 'no column pricing_billable' }
        : null;
    messageRows = [storedMessage('wamid.1'), storedMessage('wamid.2')];
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
      .map((u) => [u.filters[0]![2], u.payload]);
    expect(payloads).toEqual([
      // 1º: tenta com pricing, é recusado, repete só com o status.
      [
        ['msg-wamid.1'],
        {
          status: 'delivered',
          pricing_billable: false,
          pricing_category: 'SERVICE',
        },
      ],
      [['msg-wamid.1'], { status: 'delivered' }],
      // 2º: o pricing já está desligado — uma escrita só, sem tentar à toa.
      [['msg-wamid.2'], { status: 'delivered' }],
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
    recipientRows = [
      storedRecipient('wamid.f1', 'acct-1', { id: 'rec-1', contact_id: null }),
    ];
    messageRows = [storedMessage('wamid.f1')];
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

describe('POST /api/whatsapp/webhook — corpos reais da Meta (F6 da SPEC 088)', () => {
  const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

  function rawRequest(raw: string): Request {
    return webhookRequest(raw, { 'x-hub-signature-256': WELL_FORMED_HEADER });
  }

  it('statuses `read` com pricing: o espelho grava status e pricing, o webhook de saída sai, e o repetidor recebe os bytes originais', async () => {
    const raw = realStatusesRawBody({ phoneNumberId: 'pnid-1' });
    const wamid = JSON.parse(raw).entry[0].changes[0].value.statuses[0].id;
    messageRows = [storedMessage(wamid)];

    const res = await POST(rawRequest(raw));
    expect(res.status).toBe(200);
    await afterCallbacks[0]!();
    await flush();

    // Ingest de status: só o status e o que o espelho sabe ler do pricing
    // (`billable`, `category`); `pricing_model`, `type` e `subtype` não
    // viram coluna.
    expect(tableUpdates).toContainEqual({
      table: 'messages',
      payload: {
        status: 'read',
        pricing_billable: false,
        pricing_category: 'SERVICE',
      },
      filters: [['in', 'id', [`msg-${wamid}`]]],
    });
    expect(dispatchWebhookEvent).toHaveBeenCalledWith(
      expect.anything(),
      'acct-1',
      'message.status_updated',
      expect.objectContaining({ whatsapp_message_id: wamid, status: 'read' })
    );
    expect(ingestInbound).not.toHaveBeenCalled();

    // Repetidor: o corpo cru, sem reserializar.
    expect(relayMetaWebhook).toHaveBeenCalledTimes(1);
    const [, input] = relayMetaWebhook.mock.calls[0] as [
      unknown,
      { rawBody: string },
    ];
    expect(input.rawBody).toBe(raw);
  });

  it('messages de texto: o ingest recebe o texto, o id e o remetente reais, e o repetidor recebe os bytes originais', async () => {
    const raw = realMessagesRawBody({ phoneNumberId: 'pnid-1' });

    await POST(rawRequest(raw));
    await afterCallbacks[0]!();
    await flush();

    expect(ingestInbound).toHaveBeenCalledTimes(1);
    const [, event] = ingestInbound.mock.calls[0] as [
      unknown,
      { providerMessageId: string; fromPhone: string; occurredAt: Date },
    ];
    expect(event.providerMessageId).toMatch(/^wamid\./);
    expect(event.fromPhone).toBe('16315551181');
    expect(event.occurredAt.getTime()).toBe(1795576203 * 1000);

    const [, input] = relayMetaWebhook.mock.calls[0] as [
      unknown,
      { rawBody: string },
    ];
    expect(input.rawBody).toBe(raw);
  });
});

// Achado B-1 da revisão de segurança da SPEC 088 — o escopo do segredo só
// prova que quem assinou fala pelo NÚMERO; o `statuses[].id` é texto livre.
// A = `pnid-1` (acct-1), B = `pnid-2` (acct-2). Corpo real da Meta.
describe('POST /api/whatsapp/webhook — espelho de status só na conta do número (B-1)', () => {
  const WAMID_B = JSON.parse(realStatusesRawBody()).entry[0].changes[0].value
    .statuses[0].id as string;
  const WAMID_A = 'wamid.HBgLMTYzMTU1NTExODEVAgARGBJBQUFBQUFBQUFBQUFBQUFBQUEA';
  const SIGNER_A = { kind: 'channels', phoneNumberIds: new Set(['pnid-1']) };
  const FAILED_131026 = {
    status: 'failed',
    errors: [{ code: 131026, title: 'Message undeliverable' }],
  };
  const FAILED_131042 = {
    status: 'failed',
    errors: [{ code: 131042, title: 'Business eligibility payment issue' }],
  };

  type Status = Record<string, unknown>;

  /** O `change` real, com os `statuses` derivados do status real. */
  function statusesChange(phoneNumberId: string, overrides: Status[]) {
    const body = JSON.parse(realStatusesRawBody({ phoneNumberId }));
    const change = body.entry[0].changes[0];
    const [real] = change.value.statuses;
    change.value.statuses = overrides.map((o) => ({ ...real, ...o }));
    return change;
  }
  const bodyOf = (...changes: unknown[]) =>
    JSON.stringify(
      envelope('100000000004821', changes as Record<string, unknown>[])
    );

  async function run(raw: string) {
    const res = await POST(
      webhookRequest(raw, { 'x-hub-signature-256': WELL_FORMED_HEADER })
    );
    expect(res.status).toBe(200);
    await afterCallbacks[afterCallbacks.length - 1]!();
  }

  const updatesOn = (table: string) =>
    tableUpdates.filter((u) => u.table === table);
  const signalCalls = () =>
    rpcImpl.mock.calls.filter((c) => c[0] === 'apply_payment_signal');
  const warned = () => vi.mocked(console.warn).mock.calls.flat().join(' ');
  const configReads = () =>
    configQueries.filter((f) => f.some((a) => a[0] === 'phone_number_id'));

  function expectNoEffect() {
    expect(tableUpdates).toEqual([]);
    expect(dispatchWebhookEvent).not.toHaveBeenCalled();
    expect(rpcImpl).not.toHaveBeenCalled();
  }

  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    mockedSigner = SIGNER_A;
    messageRows = [
      storedMessage(WAMID_A, 'acct-1'),
      storedMessage(WAMID_B, 'acct-2'),
    ];
    recipientRows = [
      storedRecipient(WAMID_A, 'acct-1'),
      storedRecipient(WAMID_B, 'acct-2'),
    ];
    // Episódio pendente: um cobrável LIMPARIA o estado se o sinal rodasse.
    billingStatusRow = {
      payment_blocked_since: '2026-10-01T02:00:00Z',
      last_payment_error_at: '2026-10-01T02:00:00Z',
    };
  });

  it('corpo real: segredo e número de A + wamid de B → nenhum UPDATE nem webhook de saída', async () => {
    await run(realStatusesRawBody({ phoneNumberId: 'pnid-1' }));

    expectNoEffect();
    expect(warned()).toContain('belongs to another account');
    // Sem corpo: nem o wamid nem o telefone saem no log.
    expect(warned()).not.toContain(WAMID_B);
    expect(warned()).not.toContain('16315551181');
  });

  it.each<[string, Status]>([
    ['failed/131026 (número morto)', FAILED_131026],
    ['failed/131042 (pagamento)', FAILED_131042],
    [
      'delivered cobrável (limparia o episódio)',
      { status: 'delivered', pricing: { billable: true, category: 'utility' } },
    ],
  ])(
    'número de A + wamid de B, %s: nenhum efeito em B nem sinal em A',
    async (_label, status) => {
      await run(bodyOf(statusesChange('pnid-1', [{ id: WAMID_B, ...status }])));
      expectNoEffect();
    }
  );

  it('wamid de B só em broadcast_recipients (disparo sem mensagem): nenhum efeito', async () => {
    messageRows = [];
    await run(
      bodyOf(statusesChange('pnid-1', [{ id: WAMID_B, ...FAILED_131026 }]))
    );
    expectNoEffect();
  });

  it('número de A + wamid de A: espelha status e pricing, e o webhook de saída é de A', async () => {
    await run(bodyOf(statusesChange('pnid-1', [{ id: WAMID_A }])));

    expect(updatesOn('messages')).toEqual([
      {
        table: 'messages',
        payload: {
          status: 'read',
          pricing_billable: false,
          pricing_category: 'SERVICE',
        },
        filters: [['in', 'id', [`msg-${WAMID_A}`]]],
      },
    ]);
    expect(updatesOn('broadcast_recipients')).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({ status: 'read' }),
        filters: [['id', `rec-${WAMID_A}`]],
      }),
    ]);
    expect(dispatchWebhookEvent).toHaveBeenCalledTimes(1);
    expect(dispatchWebhookEvent).toHaveBeenCalledWith(
      expect.anything(),
      'acct-1',
      'message.status_updated',
      {
        whatsapp_message_id: WAMID_A,
        conversation_id: 'conv-acct-1',
        status: 'read',
        channel_id: 'chan-1',
        channel_type: 'whatsapp_cloud',
      }
    );
    expect(console.warn).not.toHaveBeenCalledWith(
      expect.stringContaining('ignored'),
      expect.anything()
    );
  });

  it('número de A + wamid de A, failed/131026: marca o contato de A', async () => {
    await run(
      bodyOf(statusesChange('pnid-1', [{ id: WAMID_A, ...FAILED_131026 }]))
    );

    expect(updatesOn('contacts')).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({ whatsapp_status: 'invalid' }),
        filters: [
          ['id', 'contact-acct-1'],
          ['whatsapp_status', 'valid'],
        ],
      }),
    ]);
  });

  // A RLS de `broadcast_recipients` só confere o disparo: um agente de A
  // consegue gravar um `contact_id` de B num disparo de A.
  it('disparo de A apontando para contato de B: o destinatário é espelhado, o contato de B não é marcado', async () => {
    recipientRows = [
      storedRecipient(WAMID_A, 'acct-1', {
        contact_id: 'contact-acct-2',
        contacts: { account_id: 'acct-2' },
      }),
    ];
    await run(
      bodyOf(statusesChange('pnid-1', [{ id: WAMID_A, ...FAILED_131026 }]))
    );

    expect(updatesOn('broadcast_recipients')).toHaveLength(1);
    expect(updatesOn('contacts')).toEqual([]);
  });

  it('mesmo message_id em A e em B: só a linha de A é atualizada', async () => {
    messageRows = [
      storedMessage(WAMID_A, 'acct-2', { id: 'msg-b' }),
      storedMessage(WAMID_A, 'acct-1', { id: 'msg-a1' }),
      storedMessage(WAMID_A, 'acct-1', { id: 'msg-a2' }),
    ];
    await run(bodyOf(statusesChange('pnid-1', [{ id: WAMID_A }])));

    expect(updatesOn('messages').map((u) => u.filters)).toEqual([
      [['in', 'id', ['msg-a1', 'msg-a2']]],
    ]);
    expect(dispatchWebhookEvent.mock.calls.map((c) => c[1])).toEqual([
      'acct-1',
    ]);
  });

  it('META_APP_SECRET + número de B + wamid de B: espelhado na conta de B, como hoje', async () => {
    mockedSigner = { kind: 'default' };
    await run(realStatusesRawBody({ phoneNumberId: 'pnid-2' }));

    expect(updatesOn('messages').map((u) => u.filters)).toEqual([
      [['in', 'id', [`msg-${WAMID_B}`]]],
    ]);
    expect(dispatchWebhookEvent.mock.calls.map((c) => c[1])).toEqual([
      'acct-2',
    ]);
  });

  it('META_APP_SECRET com número de A + wamid de B: também não cruza a conta', async () => {
    mockedSigner = { kind: 'default' };
    await run(realStatusesRawBody({ phoneNumberId: 'pnid-1' }));
    expectNoEffect();
  });

  it('META_APP_SECRET sem número: sem conta para filtrar, espelha como antes e sem sinal de pagamento', async () => {
    mockedSigner = { kind: 'default' };
    const change = statusesChange('x', [{ id: WAMID_B, ...FAILED_131042 }]);
    delete change.value.metadata;
    await run(bodyOf(change));

    expect(updatesOn('messages').map((u) => u.filters)).toEqual([
      [['in', 'id', [`msg-${WAMID_B}`]]],
    ]);
    expect(dispatchWebhookEvent.mock.calls.map((c) => c[1])).toEqual([
      'acct-2',
    ]);
    expect(rpcImpl).not.toHaveBeenCalled();
  });

  it.each<[string, string, () => void]>([
    ['desconhecido', 'pnid-x', () => {}],
    [
      'de canal desativado',
      'pnid-1',
      () => {
        disabledNumbers.add('pnid-1');
      },
    ],
    [
      'com falha de leitura da config',
      'pnid-1',
      () => {
        configError = { message: 'db down' };
      },
    ],
    ['vazio', '', () => {}],
  ])(
    'número %s: status ignorado com aviso curto',
    async (_label, pnid, arrange) => {
      arrange();
      mockedSigner = { kind: 'default' };
      await run(bodyOf(statusesChange(pnid, [{ id: WAMID_A }])));

      expectNoEffect();
      expect(warned()).toContain('no active account for the number');
      expect(warned()).not.toContain(WAMID_A);
    }
  );

  it('número desconhecido não derruba os changes seguintes do POST', async () => {
    mockedSigner = { kind: 'default' };
    await run(
      bodyOf(
        statusesChange('pnid-x', [{ id: WAMID_B }]),
        statusesChange('pnid-1', [{ id: WAMID_A }]),
        JSON.parse(realMessagesRawBody({ phoneNumberId: 'pnid-1' })).entry[0]
          .changes[0]
      )
    );

    expect(updatesOn('messages').map((u) => u.filters)).toEqual([
      [['in', 'id', [`msg-${WAMID_A}`]]],
    ]);
    expect(ingestInbound).toHaveBeenCalledTimes(1);
  });

  it('POST misto, no mesmo change: só o status de A tem efeito, e um aviso só', async () => {
    await run(
      bodyOf(
        statusesChange('pnid-1', [
          { id: WAMID_B, ...FAILED_131026 },
          { id: WAMID_A },
          { id: WAMID_B, ...FAILED_131042 },
        ])
      )
    );

    expect(updatesOn('messages').map((u) => u.filters)).toEqual([
      [['in', 'id', [`msg-${WAMID_A}`]]],
    ]);
    expect(updatesOn('broadcast_recipients').map((u) => u.filters)).toEqual([
      [['id', `rec-${WAMID_A}`]],
    ]);
    expect(updatesOn('contacts')).toEqual([]);
    expect(signalCalls()).toEqual([]);
    expect(dispatchWebhookEvent.mock.calls.map((c) => c[1])).toEqual([
      'acct-1',
    ]);
    const notices = vi
      .mocked(console.warn)
      .mock.calls.filter((c) => String(c[0]).includes('another account'));
    expect(notices).toHaveLength(1);
    expect(notices[0]![0]).toContain('2 status(es) ignored');
  });

  it('vários statuses no mesmo change (com sinal de pagamento): a conta é lida UMA vez', async () => {
    await run(
      bodyOf(
        statusesChange('pnid-1', [
          { id: WAMID_A },
          { id: WAMID_A, ...FAILED_131042 },
          { id: WAMID_B },
        ])
      )
    );

    expect(configReads()).toHaveLength(1);
    expect(signalCalls()).toHaveLength(1);
  });

  // O status pode chegar antes do INSERT, e o número pode enviar por fora
  // do CRM: o 131042 continua valendo para o WABA do número.
  it('wamid que não existe em conta nenhuma: nada espelhado, o sinal de pagamento continua', async () => {
    await run(
      bodyOf(
        statusesChange('pnid-1', [{ id: 'wamid.unknown', ...FAILED_131042 }])
      )
    );

    expect(tableUpdates).toEqual([]);
    expect(dispatchWebhookEvent).not.toHaveBeenCalled();
    expect(signalCalls()).toHaveLength(1);
    expect(signalCalls()[0]![1]).toMatchObject({ p_account_id: 'acct-1' });
  });

  // L-1: o sinal só atinge o WABA do próprio número; a Meta não reenvia.
  it('leitura da mensagem falhou (duas vezes) e não há disparo: sem espelho nem webhook, mas o 131042 é aplicado na conta do número', async () => {
    messagesSelectError = { message: 'timeout' };
    recipientRows = [];
    await run(
      bodyOf(statusesChange('pnid-1', [{ id: WAMID_A, ...FAILED_131042 }]))
    );

    expect(tableUpdates).toEqual([]);
    expect(dispatchWebhookEvent).not.toHaveBeenCalled();
    expect(messagesSelects).toBe(2);
    expect(signalCalls()).toHaveLength(1);
    expect(signalCalls()[0]![1]).toMatchObject({
      p_account_id: 'acct-1',
      p_kind: 'payment_error',
      p_phone_number_id: 'pnid-1',
    });
  });

  it('leitura da mensagem falhou, mas o disparo é de OUTRA conta: continua sem efeito nenhum', async () => {
    messagesSelectError = { message: 'timeout' };
    await run(
      bodyOf(statusesChange('pnid-1', [{ id: WAMID_B, ...FAILED_131042 }]))
    );
    expectNoEffect();
  });

  // L-2: o webhook de saída e o espelho usam a MESMA leitura.
  describe('falha transitória de leitura (L-2)', () => {
    it('a 1ª leitura falha e a 2ª funciona: espelho E webhook de saída', async () => {
      messagesSelectError = { message: 'timeout' };
      messagesSelectFailuresLeft = 1;
      await run(bodyOf(statusesChange('pnid-1', [{ id: WAMID_A }])));

      expect(messagesSelects).toBe(2);
      expect(updatesOn('messages').map((u) => u.filters)).toEqual([
        [['in', 'id', [`msg-${WAMID_A}`]]],
      ]);
      expect(dispatchWebhookEvent).toHaveBeenCalledTimes(1);
    });

    it('as duas falham (uma 3ª funcionaria): nem espelho, nem webhook de saída', async () => {
      messagesSelectError = { message: 'timeout' };
      messagesSelectFailuresLeft = 2;
      await run(bodyOf(statusesChange('pnid-1', [{ id: WAMID_A }])));

      expect(messagesSelects).toBe(2);
      expect(updatesOn('messages')).toEqual([]);
      expect(dispatchWebhookEvent).not.toHaveBeenCalled();
    });

    it('a linha só aparece depois da leitura do espelho: nenhum webhook de um status não gravado', async () => {
      messageRows = [];
      recipientRows = [];
      rpcImpl.mockImplementation(async () => {
        // O INSERT da mensagem chega no meio do tratamento do status.
        messageRows = [storedMessage(WAMID_A, 'acct-1')];
        return { data: false, error: null };
      });
      await run(
        bodyOf(statusesChange('pnid-1', [{ id: WAMID_A, ...FAILED_131042 }]))
      );

      expect(signalCalls()).toHaveLength(1);
      expect(messagesSelects).toBe(1);
      expect(tableUpdates).toEqual([]);
      expect(dispatchWebhookEvent).not.toHaveBeenCalled();
    });

    // O mesmo para a ESCRITA do espelho.
    const DELIVERED = {
      id: WAMID_A,
      status: 'delivered',
      pricing: { billable: true, category: 'utility' },
    };

    it('o UPDATE falha uma vez: uma nova tentativa com o mesmo patch, espelho E webhook de saída', async () => {
      let calls = 0;
      messagesUpdateError = () =>
        ++calls === 1 ? { code: '57014', message: 'timeout' } : null;
      await run(bodyOf(statusesChange('pnid-1', [DELIVERED])));

      const patch = {
        status: 'delivered',
        pricing_billable: true,
        pricing_category: 'UTILITY',
      };
      expect(updatesOn('messages').map((u) => u.payload)).toEqual([
        patch,
        patch,
      ]);
      expect(dispatchWebhookEvent).toHaveBeenCalledTimes(1);
      expect(console.error).not.toHaveBeenCalled();
    });

    it('o UPDATE falha nas duas: nenhum webhook de saída; disparo e sinal seguem', async () => {
      messagesUpdateError = () => ({ code: '57014', message: 'timeout' });
      await run(bodyOf(statusesChange('pnid-1', [DELIVERED])));

      expect(updatesOn('messages')).toHaveLength(2);
      expect(dispatchWebhookEvent).not.toHaveBeenCalled();
      expect(updatesOn('broadcast_recipients')).toHaveLength(1);
      expect(signalCalls()).toHaveLength(1);
      expect(console.error).toHaveBeenCalledTimes(1);
    });

    it('um status sem espelho não cala o seguinte do mesmo change', async () => {
      let calls = 0;
      messagesUpdateError = () =>
        ++calls <= 2 ? { code: '57014', message: 'timeout' } : null;
      await run(
        bodyOf(
          statusesChange('pnid-1', [DELIVERED, { id: WAMID_A, status: 'read' }])
        )
      );

      expect(
        dispatchWebhookEvent.mock.calls.map(
          (c) => (c[3] as { status: string }).status
        )
      ).toEqual(['read']);
    });

    it('status fora do vocabulário do CRM (CHECK, 23514): não repete, e o evento sai como sempre', async () => {
      messagesUpdateError = () => ({
        code: '23514',
        message: 'messages_status_check',
      });
      await run(
        bodyOf(statusesChange('pnid-1', [{ id: WAMID_A, status: 'played' }]))
      );

      expect(updatesOn('messages')).toHaveLength(1);
      expect(dispatchWebhookEvent).toHaveBeenCalledTimes(1);
    });

    it('086 ausente e depois falha passageira: a repetição leva só o status', async () => {
      let statusOnly = 0;
      messagesUpdateError = (payload) =>
        'pricing_billable' in payload
          ? { code: 'PGRST204', message: 'no column pricing_billable' }
          : ++statusOnly === 1
            ? { code: '57014', message: 'timeout' }
            : null;
      await run(bodyOf(statusesChange('pnid-1', [DELIVERED])));

      expect(updatesOn('messages').map((u) => u.payload)).toEqual([
        {
          status: 'delivered',
          pricing_billable: true,
          pricing_category: 'UTILITY',
        },
        { status: 'delivered' },
        { status: 'delivered' },
      ]);
      expect(dispatchWebhookEvent).toHaveBeenCalledTimes(1);
    });

    it('leitura da config falha uma vez: uma nova tentativa, e o status é espelhado com o sinal', async () => {
      configError = { message: 'db down' };
      configFailuresLeft = 1;
      await run(
        bodyOf(statusesChange('pnid-1', [{ id: WAMID_A, ...FAILED_131042 }]))
      );

      expect(configReads()).toHaveLength(2);
      expect(updatesOn('messages')).toHaveLength(1);
      expect(dispatchWebhookEvent).toHaveBeenCalledTimes(1);
      expect(signalCalls()).toHaveLength(1);
    });
  });
});

// Revisão de segurança da SPEC 088, achado B-6 — o que o POST faz quando UM
// pedaço do corpo está quebrado. A Meta já recebeu 200 e não reenvia: o que
// uma exceção derruba, ela derruba para sempre. Cada `change`, `status` e
// mensagem é isolado dos demais; corpos reais da Meta como base.
describe('POST /api/whatsapp/webhook — um pedaço quebrado não derruba o resto (B-6)', () => {
  const WAMID_A = 'wamid.HBgLMTYzMTU1NTExODEVAgARGBJBQUFBQUFBQUFBQUFBQUFBQUEA';
  const WAMID_A2 = 'wamid.HBgLMTYzMTU1NTExODEVAgARGBJBQkJCQkJCQkJCQkJCQkJCQkIA';

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  type Obj = Record<string, any>;

  /** O `change` real de `messages`, editável antes de entrar no POST. */
  function msgChange(phoneNumberId: string, mutate?: (change: Obj) => void) {
    const change = JSON.parse(realMessagesRawBody({ phoneNumberId })).entry[0]
      .changes[0];
    mutate?.(change);
    return change as Obj;
  }
  /** O `change` real de `statuses`, com os `statuses` trocados. */
  function stChange(phoneNumberId: string, statuses: unknown[]) {
    const change = JSON.parse(realStatusesRawBody({ phoneNumberId })).entry[0]
      .changes[0];
    change.value.statuses = statuses;
    return change as Obj;
  }
  const realStatus = () =>
    JSON.parse(realStatusesRawBody()).entry[0].changes[0].value.statuses[0];
  const post = (...changes: unknown[]) =>
    JSON.stringify(envelope('100000000004821', changes as Obj[]));
  const entriesWith = (change: Obj) => [
    { id: '100000000004821', changes: [change] },
  ];

  async function run(raw: string) {
    const res = await POST(
      webhookRequest(raw, { 'x-hub-signature-256': WELL_FORMED_HEADER })
    );
    // A Meta continua recebendo 200, e o repetidor continua sendo chamado
    // com os bytes originais — o isolamento não pode mudar nenhum dos dois.
    expect(res.status).toBe(200);
    await expect(afterCallbacks[afterCallbacks.length - 1]!()).resolves.toBe(
      undefined
    );
    expect(relayMetaWebhook).toHaveBeenCalledTimes(1);
    expect(relayMetaWebhook.mock.calls[0]![1]).toMatchObject({ rawBody: raw });
  }

  const ingestedAccounts = () =>
    ingestInbound.mock.calls.map(
      (c) => (c[0] as { accountId: string }).accountId
    );
  const logs = () =>
    [
      ...vi.mocked(console.error).mock.calls,
      ...vi.mocked(console.warn).mock.calls,
    ]
      .flat()
      .map(String)
      .join(' ');
  const updatesOn = (table: string) =>
    tableUpdates.filter((u) => u.table === table);

  /** Nada do corpo, do token nem do telefone do contato pode ir ao log. */
  function expectLogsClean() {
    const out = logs();
    for (const secret of [
      'cipher',
      'decrypted',
      'test return 3',
      '16315551181',
      'US.13491208655302741918',
      'test user name',
    ]) {
      expect(out).not.toContain(secret);
    }
  }

  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    messageRows = [
      storedMessage(WAMID_A, 'acct-1'),
      storedMessage(WAMID_A2, 'acct-1'),
    ];
    recipientRows = [storedRecipient(WAMID_A, 'acct-1')];
  });

  describe('change que lança', () => {
    it('token do número A ilegível: o change do número B, no mesmo POST, é ingerido', async () => {
      decryptFailures.add('cipher');

      await run(post(msgChange('pnid-1'), msgChange('pnid-2')));

      expect(ingestedAccounts()).toEqual(['acct-2']);
      expect(decryptCalls).toEqual(['cipher', 'cipher-b']);
      const out = logs();
      expect(out).toContain('"unit":"change"');
      expect(out).toContain('bad decrypt');
      expect(out).toContain('"phone_number_id":"pnid-1"');
      expectLogsClean();
    });

    it('token do número B ilegível, depois de A: A fica ingerido e o erro de B não vaza', async () => {
      decryptFailures.add('cipher-b');

      await run(post(msgChange('pnid-1'), msgChange('pnid-2')));

      expect(ingestedAccounts()).toEqual(['acct-1']);
      expectLogsClean();
    });

    it('ingest que rejeita no primeiro change: o segundo é ingerido, e o log não vaza o corpo', async () => {
      ingestInbound.mockRejectedValueOnce(new Error('ingest boom'));

      await run(post(msgChange('pnid-1'), msgChange('pnid-2')));

      expect(ingestedAccounts()).toEqual(['acct-1', 'acct-2']);
      expect(logs()).toContain('ingest boom');
      expectLogsClean();
    });

    it('mensagem que falha não derruba a seguinte do MESMO change', async () => {
      ingestInbound.mockRejectedValueOnce(new Error('ingest boom'));
      const change = msgChange('pnid-1', (ch) => {
        const [m] = ch.value.messages;
        ch.value.messages = [
          { ...m, id: 'wamid.first' },
          { ...m, id: 'wamid.second' },
        ];
      });

      await run(post(change));

      expect(
        ingestInbound.mock.calls.map(
          (c) => (c[1] as { providerMessageId: string }).providerMessageId
        )
      ).toEqual(['wamid.first', 'wamid.second']);
      expect(logs()).toContain('"unit":"message","index":0');
      expectLogsClean();
    });

    it('erro que é objeto simples (PostgREST): o código e a mensagem entram no log, sem o valor citado', async () => {
      ingestInbound.mockRejectedValueOnce({
        code: '22P02',
        message: 'invalid input syntax for type uuid: "16315551181-secret"',
      });

      await run(post(msgChange('pnid-1'), msgChange('pnid-2')));

      expect(ingestedAccounts()).toEqual(['acct-1', 'acct-2']);
      const out = logs();
      expect(out).toContain('"code":"22P02"');
      expect(out).toContain('invalid input syntax for type uuid');
      expect(out).not.toContain('secret');
      expectLogsClean();
    });

    it('log do erro: posição, número truncado em 64 e mensagem em 200; nunca o corpo', async () => {
      const longPnid = `pnid-1${'9'.repeat(100)}`;
      ingestInbound.mockRejectedValue(new Error('x'.repeat(500)));
      CONFIG_ROWS.push({
        ...CONFIG_ROWS[0]!,
        id: 'cfg-long',
        phone_number_id: longPnid,
      });
      try {
        await run(post(msgChange('pnid-2'), msgChange(longPnid)));
      } finally {
        CONFIG_ROWS.pop();
      }

      const line = vi
        .mocked(console.error)
        .mock.calls.map((c) => String(c[1]))
        .find((l) => l.includes('"change":1'))!;
      const parsed = JSON.parse(line);
      expect(parsed).toMatchObject({ entry: 0, change: 1, unit: 'message' });
      expect(parsed.phone_number_id).toHaveLength(64);
      expect(parsed.error_message).toHaveLength(200);
      expectLogsClean();
    });
  });

  describe('timestamp ausente ou ilegível (decisão: usa o relógio do servidor)', () => {
    it.each<[string, (m: Obj) => void]>([
      ['ausente', (m) => delete m.timestamp],
      ['não numérico', (m) => (m.timestamp = 'ontem')],
      ['fora do alcance de Date', (m) => (m.timestamp = '9'.repeat(30))],
      // L-3: válidos para `Date`, mas o 1º (ano 58868) o Postgres recusa.
      ['em milissegundos', (m) => (m.timestamp = '1795576195000')],
      ['no ano 5138', (m) => (m.timestamp = '99999999999')],
    ])(
      'mensagem com timestamp %s: ingerida com o instante atual, e o change seguinte também',
      async (_label, mutate) => {
        const before = Date.now();
        await run(
          post(
            msgChange('pnid-1', (ch) => mutate(ch.value.messages[0])),
            msgChange('pnid-2')
          )
        );

        expect(ingestedAccounts()).toEqual(['acct-1', 'acct-2']);
        const at = (ingestInbound.mock.calls[0]![1] as { occurredAt: Date })
          .occurredAt;
        expect(Number.isNaN(at.getTime())).toBe(false);
        expect(at.getTime()).toBeGreaterThanOrEqual(before);
        expect(at.getTime()).toBeLessThanOrEqual(Date.now());
        // O segundo, com timestamp real da Meta, segue com o instante dela.
        expect(
          (
            ingestInbound.mock.calls[1]![1] as { occurredAt: Date }
          ).occurredAt.getTime()
        ).toBe(1795576203 * 1000);
        expect(logs()).toContain('unreadable timestamp');
        expectLogsClean();
      }
    );

    it.each<[string, (s: Obj) => void]>([
      ['ausente', (s) => delete s.timestamp],
      ['não numérico', (s) => (s.timestamp = 'ontem')],
      ['fora do alcance de Date', (s) => (s.timestamp = '9'.repeat(30))],
      ['em milissegundos', (s) => (s.timestamp = '1795576195000')],
      ['no ano 5138', (s) => (s.timestamp = '99999999999')],
    ])(
      'status com timestamp %s: espelhado (carimbo do servidor) e o change seguinte processado',
      async (_label, mutate) => {
        const bad = { ...realStatus(), id: WAMID_A };
        mutate(bad);

        const before = Date.now();
        await run(post(stChange('pnid-1', [bad]), msgChange('pnid-2')));

        expect(updatesOn('messages')).toHaveLength(1);
        const [rec] = updatesOn('broadcast_recipients');
        const readAt = Date.parse(String(rec!.payload.read_at));
        expect(readAt).toBeGreaterThanOrEqual(before);
        expect(readAt).toBeLessThanOrEqual(Date.now());
        expect(dispatchWebhookEvent).toHaveBeenCalledTimes(1);
        expect(ingestedAccounts()).toEqual(['acct-2']);
        expect(logs()).toContain('unreadable timestamp');
        expectLogsClean();
      }
    );
  });

  // L-3: o limite é agora + 1 dia.
  it.each<[string, number, boolean]>([
    ['exatamente um dia à frente', 86_400, true],
    ['um segundo além de um dia', 86_401, false],
  ])('mensagem com timestamp %s', async (_label, aheadSeconds, kept) => {
    const now = 1795576203;
    vi.useFakeTimers({ toFake: ['Date'], now: now * 1000 });
    try {
      await run(
        post(
          msgChange('pnid-1', (ch) => {
            ch.value.messages[0].timestamp = String(now + aheadSeconds);
          })
        )
      );
    } finally {
      vi.useRealTimers();
    }

    const at = (ingestInbound.mock.calls[0]![1] as { occurredAt: Date })
      .occurredAt;
    expect(at.getTime()).toBe((kept ? now + aheadSeconds : now) * 1000);
    expect(logs().includes('unreadable timestamp')).toBe(!kept);
  });

  describe('status quebrado no meio de um change', () => {
    it('item nulo, depois um status bom: o bom é espelhado', async () => {
      await run(
        post(stChange('pnid-1', [null, { ...realStatus(), id: WAMID_A }]))
      );

      expect(updatesOn('messages').map((u) => u.filters)).toEqual([
        [['in', 'id', [`msg-${WAMID_A}`]]],
      ]);
      expect(dispatchWebhookEvent).toHaveBeenCalledTimes(1);
      expect(logs()).toContain('"unit":"status","index":0');
      expectLogsClean();
    });

    it('webhook de saída que rejeita no primeiro status: o segundo é espelhado', async () => {
      dispatchWebhookEvent.mockRejectedValueOnce(new Error('dispatch boom'));

      await run(
        post(
          stChange('pnid-1', [
            { ...realStatus(), id: WAMID_A },
            { ...realStatus(), id: WAMID_A2 },
          ])
        )
      );

      expect(updatesOn('messages').map((u) => u.filters)).toEqual([
        [['in', 'id', [`msg-${WAMID_A}`]]],
        [['in', 'id', [`msg-${WAMID_A2}`]]],
      ]);
      expect(logs()).toContain('dispatch boom');
      expectLogsClean();
    });

    it('evento de template que lança: o change de mensagem seguinte é ingerido', async () => {
      await run(
        post(
          // `value` nulo estoura dentro do tratador de template.
          { field: 'message_template_status_update', value: null },
          msgChange('pnid-1')
        )
      );

      expect(ingestedAccounts()).toEqual(['acct-1']);
      expectLogsClean();
    });

    it('status que lança num change: o change de mensagem seguinte é ingerido', async () => {
      dispatchWebhookEvent.mockRejectedValue(new Error('dispatch boom'));

      await run(
        post(
          stChange('pnid-1', [{ ...realStatus(), id: WAMID_A }]),
          msgChange('pnid-2')
        )
      );

      expect(ingestedAccounts()).toEqual(['acct-2']);
    });
  });

  describe('forma do corpo', () => {
    const good = () => msgChange('pnid-1');

    it.each<[string, () => unknown[]]>([
      ['entry sem `changes`', () => [{ id: 'waba-x' }]],
      ['`changes` que não é lista', () => [{ id: 'waba-x', changes: 'x' }]],
      ['`changes` objeto', () => [{ id: 'waba-x', changes: {} }]],
      ['entry nulo', () => [null]],
      ['entry que não é objeto', () => ['x', 42]],
    ])('%s: pula o entry e processa os demais', async (_label, build) => {
      await run(
        JSON.stringify({
          object: 'x',
          entry: [...build(), ...entriesWith(good())],
        })
      );

      expect(ingestedAccounts()).toEqual(['acct-1']);
      expect(console.error).not.toHaveBeenCalled();
      expectLogsClean();
    });

    it.each<[string, Obj | null | string]>([
      ['change nulo', null],
      ['change que não é objeto', 'x'],
      ['value nulo', { field: 'messages', value: null }],
      ['value ausente', { field: 'messages' }],
      ['value que não é objeto', { field: 'messages', value: 'x' }],
      [
        'statuses que não é lista',
        {
          field: 'messages',
          value: {
            metadata: { phone_number_id: 'pnid-1' },
            statuses: 'abc',
          },
        },
      ],
      [
        'messages/contacts que não são listas',
        {
          field: 'messages',
          value: {
            metadata: { phone_number_id: 'pnid-1' },
            messages: 'x',
            contacts: 'y',
          },
        },
      ],
    ])('%s: pula o change e o seguinte é ingerido', async (_label, bad) => {
      await run(post(bad as Obj, good()));

      expect(ingestedAccounts()).toEqual(['acct-1']);
      // Forma inválida é esperada de quem assina: aviso, não erro.
      expect(console.error).not.toHaveBeenCalled();
      expectLogsClean();
    });

    it('sem metadata: sem número não há config (erro de sempre); o change seguinte é ingerido', async () => {
      await run(
        post(
          { field: 'messages', value: { messages: [{}], contacts: [{}] } },
          good()
        )
      );

      expect(ingestedAccounts()).toEqual(['acct-1']);
      expectLogsClean();
    });

    it('`entry` que não é lista: nada a processar, sem exceção, repetidor chamado', async () => {
      await run(JSON.stringify({ object: 'x', entry: { changes: [] } }));

      expect(ingestInbound).not.toHaveBeenCalled();
      expect(logs()).toContain('`entry` is not a list');
    });

    it('corpo JSON `null` com assinatura válida: sem exceção e sem log de erro', async () => {
      await run('null');

      expect(console.error).not.toHaveBeenCalled();
    });
  });

  it('POST bom continua igual: nenhum aviso, nenhum erro', async () => {
    await run(post(msgChange('pnid-1'), msgChange('pnid-2')));

    expect(ingestedAccounts()).toEqual(['acct-1', 'acct-2']);
    expect(console.error).not.toHaveBeenCalled();
    expect(console.warn).not.toHaveBeenCalled();
  });
});

// Revisão integrada da SPEC 088, achado A-1 — um POST assinado de 4 MiB com
// itens nulos parava o processo (todas as contas) por até um minuto e
// escrevia 188 MB de log. Corpos reais da Meta como base.
describe('POST /api/whatsapp/webhook — um POST não gasta o processo inteiro (A-1)', () => {
  const N = 50_000;
  const WAMID_A = 'wamid.HBgLMTYzMTU1NTExODEVAgARGBJBQUFBQUFBQUFBQUFBQUFBQUEA';

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  type Obj = Record<string, any>;

  const many = (item: unknown, n = N) => Array.from({ length: n }, () => item);
  function stChange(statuses: unknown[], phoneNumberId = 'pnid-1'): Obj {
    const change = JSON.parse(realStatusesRawBody({ phoneNumberId })).entry[0]
      .changes[0];
    change.value.statuses = statuses;
    return change;
  }
  function msgChange(messages?: unknown[], phoneNumberId = 'pnid-1'): Obj {
    const change = JSON.parse(realMessagesRawBody({ phoneNumberId })).entry[0]
      .changes[0];
    if (messages) change.value.messages = messages;
    return change;
  }
  const realStatus = (over: Obj = {}) => ({
    ...JSON.parse(realStatusesRawBody()).entry[0].changes[0].value.statuses[0],
    id: WAMID_A,
    ...over,
  });
  const realMessage = (over: Obj = {}) => ({
    ...JSON.parse(realMessagesRawBody()).entry[0].changes[0].value.messages[0],
    ...over,
  });
  const post = (...changes: unknown[]) =>
    JSON.stringify(envelope('100000000004821', changes as Obj[]));

  async function run(raw: string) {
    const res = await POST(
      webhookRequest(raw, { 'x-hub-signature-256': WELL_FORMED_HEADER })
    );
    expect(res.status).toBe(200);
    await expect(afterCallbacks[afterCallbacks.length - 1]!()).resolves.toBe(
      undefined
    );
    expect(relayMetaWebhook).toHaveBeenCalledTimes(1);
    expect(relayMetaWebhook.mock.calls[0]![1]).toMatchObject({ rawBody: raw });
  }

  const lines = () =>
    [console.log, console.info, console.warn, console.error].flatMap((fn) =>
      vi.mocked(fn).mock.calls.map((c) => c.map(String).join(' '))
    );
  const summaries = () =>
    lines().filter((l) => /POST (cut short|processed)/.test(l));
  const summary = () => {
    const [line] = summaries();
    return JSON.parse(line!.slice(line!.indexOf('{')));
  };
  const messageUpdates = () =>
    tableUpdates.filter((u) => u.table === 'messages').length;

  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'info').mockImplementation(() => {});
    mockedSigner = { kind: 'channels', phoneNumberIds: new Set(['pnid-1']) };
    messageRows = [storedMessage(WAMID_A, 'acct-1')];
  });

  it.each<[string, () => string]>([
    ['statuses nulos', () => post(stChange(many(null)))],
    ['statuses numéricos', () => post(stChange(many(0)))],
    ['statuses em lista', () => post(stChange(many([])))],
    ['statuses sem id', () => post(stChange(many({})))],
    ['statuses com id vazio', () => post(stChange(many({ id: '' })))],
    ['statuses com id não texto', () => post(stChange(many({ id: 7 })))],
    ['messages nulas', () => post(msgChange(many(null)))],
    ['messages em lista', () => post(msgChange(many([])))],
    ['changes nulos', () => post(...many(null))],
    ['changes sem value', () => post(...many({ field: 'messages' }))],
    ['entry nulos', () => JSON.stringify({ object: 'x', entry: many(null) })],
    [
      'entry sem changes',
      () => JSON.stringify({ object: 'x', entry: many({ id: 'w' }) }),
    ],
  ])(
    '%s × 50 mil: poucas linhas, nenhuma consulta, POST abandonado',
    async (_label, build) => {
      await run(build());

      // 20 linhas de item mais o resumo.
      expect(lines().length).toBeLessThanOrEqual(21);
      expect(summaries()).toHaveLength(1);
      expect(summary()).toMatchObject({
        reason: 'malformed_items',
        malformed: 100,
        failed: 0,
      });
      expect(tablesQueried).toEqual([]);
      expect(tableUpdates).toEqual([]);
      expect(ingestInbound).not.toHaveBeenCalled();
      // Abandonado: nem leu o resto da lista.
      expect(summary().items).toBeLessThan(200);
    }
  );

  it('99 itens inválidos: os statuses e a mensagem válidos depois deles são processados', async () => {
    await run(
      post(
        stChange([...many(null, 50), realStatus()]),
        stChange([...many({}, 49), realStatus()]),
        msgChange()
      )
    );

    expect(messageUpdates()).toBe(2);
    expect(dispatchWebhookEvent).toHaveBeenCalledTimes(2);
    expect(ingestInbound).toHaveBeenCalledTimes(1);
    expect(lines().length).toBeLessThanOrEqual(21);
    expect(summaries()[0]).toContain('POST processed');
  });

  it('o 100º inválido abandona o POST, mas o que veio ANTES dele já valeu', async () => {
    await run(
      post(
        stChange([realStatus(), ...many(null, 100), realStatus()]),
        msgChange()
      )
    );

    expect(messageUpdates()).toBe(1);
    expect(ingestInbound).not.toHaveBeenCalled();
    expect(summaries()[0]).toContain('POST cut short');
  });

  it('webhook de saída falhando em 300 statuses bem formados: nenhum é descartado', async () => {
    dispatchWebhookEvent.mockRejectedValue(new Error('boom'));
    await run(post(stChange(many(realStatus(), 300)), msgChange()));

    expect(messageUpdates()).toBe(300);
    expect(ingestInbound).toHaveBeenCalledTimes(1);
    expect(lines().length).toBeLessThanOrEqual(21);
    expect(summary()).toMatchObject({
      reason: null,
      malformed: 0,
      failed: 300,
    });
  });

  it('banco fora do ar em 300 statuses: todos tentados, log limitado, e o que vem depois é ingerido', async () => {
    messagesSelectError = { message: 'db down' };
    await run(post(stChange(many(realStatus(), 300)), msgChange()));

    expect(messagesSelects).toBe(600);
    expect(ingestInbound).toHaveBeenCalledTimes(1);
    expect(lines().length).toBeLessThanOrEqual(21);
    expect(summary().reason).toBeNull();
  });

  it('ingest falhando em 300 mensagens bem formadas: todas tentadas', async () => {
    ingestInbound.mockRejectedValue(new Error('db down'));
    await run(
      post(
        msgChange(
          Array.from({ length: 300 }, (_, i) => realMessage({ id: `w.${i}` }))
        )
      )
    );

    expect(ingestInbound).toHaveBeenCalledTimes(300);
    expect(lines().length).toBeLessThanOrEqual(21);
    expect(summary()).toMatchObject({ reason: null, failed: 300 });
  });

  it.each<[string, number, () => string]>([
    // Leitura da lista e processamento: 10 + 10.
    [
      'statuses bem formados',
      19,
      () => post(stChange(many(realStatus(), 1000))),
    ],
    ['mensagens que falham sem I/O', 19, () => post(msgChange(many({}, 1000)))],
    [
      'changes fora do escopo do segredo',
      9,
      () => post(...many({ field: 'messages', value: {} }, 1000)),
    ],
    [
      'entry sem trabalho',
      9,
      () => JSON.stringify({ entry: many({ changes: [] }, 1000) }),
    ],
  ])(
    '%s × 1.000: o event loop roda durante o processamento',
    async (_l, minTurns, build) => {
      await POST(
        webhookRequest(build(), { 'x-hub-signature-256': WELL_FORMED_HEADER })
      );
      let turns = 0;
      let running = true;
      const spin = () => {
        turns++;
        if (running) setImmediate(spin);
      };
      setImmediate(spin);
      await afterCallbacks[0]!();
      running = false;

      // Um a cada 100 itens, no mínimo.
      expect(turns).toBeGreaterThanOrEqual(minTurns);
      expect(lines().length).toBeLessThanOrEqual(21);
    }
  );

  it('teto de itens: corta com UM aviso', async () => {
    await run(
      JSON.stringify({
        entry: [
          ...many({ changes: [] }, MAX_ITEMS_PER_POST),
          { id: 'w', changes: [msgChange()] },
        ],
      })
    );

    expect(ingestInbound).not.toHaveBeenCalled();
    expect(lines()).toHaveLength(1);
    expect(summary()).toMatchObject({
      reason: 'item_ceiling',
      items: MAX_ITEMS_PER_POST,
    });
  });

  it('teto de itens dentro de `statuses`: os anteriores são processados', async () => {
    await run(
      JSON.stringify({
        entry: [
          ...many({ changes: [] }, MAX_ITEMS_PER_POST - 5),
          // entry, change e 3 statuses cabem; o 4º é o primeiro fora.
          { id: 'w', changes: [stChange(many(realStatus(), 4))] },
        ],
      })
    );

    expect(messageUpdates()).toBe(3);
    expect(lines()).toHaveLength(1);
    expect(summary().reason).toBe('item_ceiling');
  });

  it('lote máximo da Meta (1.000 atualizações, uma entry cada): tudo processado, nenhuma linha de log', async () => {
    const entry = {
      id: '100000000004821',
      changes: [stChange([realStatus()])],
    };
    await run(
      JSON.stringify(envelopeOf(Array.from({ length: 1000 }, () => entry)))
    );

    expect(messageUpdates()).toBe(1000);
    expect(dispatchWebhookEvent).toHaveBeenCalledTimes(1000);
    expect(lines()).toEqual([]);
  });

  it.each<[string, () => string]>([
    [
      'change fora do escopo',
      () => post(...many({ field: 'messages', value: {} }, 1000)),
    ],
    [
      'evento de template sem id',
      () =>
        post(
          ...many({ field: 'message_template_status_update', value: {} }, 1000)
        ),
    ],
    [
      'components_update de template',
      () =>
        post(
          ...many(
            { field: 'message_template_components_update', value: {} },
            1000
          )
        ),
    ],
    [
      '131042 sem timestamp',
      () =>
        post(
          stChange(
            many(
              { id: 'w', status: 'failed', errors: [{ code: 131042 }] },
              1000
            )
          )
        ),
    ],
  ])('%s × 1.000: as linhas de log também têm teto', async (_l, build) => {
    await run(build());
    expect(lines().length).toBeLessThanOrEqual(21);
    expect(summaries()[0]).toContain('POST processed');
  });

  it('ruído do corpo não cala a falha nossa no mesmo POST', async () => {
    messagesUpdateError = () => ({ code: '57014', message: 'timeout' });
    await run(post(stChange([...many(null, 50), realStatus()])));

    expect(console.error).toHaveBeenCalledTimes(1);
    expect(lines().some((l) => l.includes('Error updating message'))).toBe(
      true
    );
    expect(lines().length).toBeLessThanOrEqual(21);
  });

  it('o log dos itens inválidos leva só a posição, nunca o conteúdo', async () => {
    await run(post(stChange([{ id: 7, recipient_id: '16315551181' }])));

    expect(lines()).toHaveLength(1);
    expect(lines()[0]).toContain(
      '"entry":0,"change":0,"unit":"status","index":0'
    );
    expect(lines()[0]).not.toContain('16315551181');
  });
});
