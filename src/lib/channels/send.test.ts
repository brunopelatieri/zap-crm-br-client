/**
 * Testes de PARIDADE do caminho de saída (SPEC 048 §5, fase F2).
 *
 * O foco é o que os cinco caminhos de envio tinham em comum e que agora
 * existe uma vez só: escopo de conta na resolução do contato, semântica
 * da repetição por variante de telefone (quando repetir e quando NÃO
 * repetir), correção do telefone que funcionou, e as colunas gravadas.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import {
  ChannelCapabilityError,
  ChannelNotConfiguredError,
  cloudChannelContext,
  resolveChannelContext,
  resolveChannelForConversation,
  resolveDefaultChannelId,
  resolveOutboundContact,
  sendAndPersistOutbound,
  sendContentViaChannel,
  sendWithPhoneVariants,
} from './send';
import { ColdSendLimitError } from './cold-send-wiring';
import { COLD_SEND_DEFAULTS } from './cold-send-limit';

const sendTextMessage = vi.fn();
const sendMediaMessage = vi.fn();
const sendTemplateMessage = vi.fn();
const sendInteractiveButtons = vi.fn();
const sendInteractiveList = vi.fn();

vi.mock('@/lib/whatsapp/meta-api', () => ({
  sendTextMessage: (...a: unknown[]) => sendTextMessage(...a),
  sendMediaMessage: (...a: unknown[]) => sendMediaMessage(...a),
  sendTemplateMessage: (...a: unknown[]) => sendTemplateMessage(...a),
  sendInteractiveButtons: (...a: unknown[]) => sendInteractiveButtons(...a),
  sendInteractiveList: (...a: unknown[]) => sendInteractiveList(...a),
}));

vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: (v: string) => `decrypted:${v}`,
}));

const resolveInstanceByChannelId = vi.fn();
vi.mock('@/lib/evolution/instances', () => ({
  resolveInstanceByChannelId: (...a: unknown[]) =>
    resolveInstanceByChannelId(...a),
}));

/**
 * SPEC 065 §11 — espiona o log estruturado para confirmar que
 * `sendAndPersistOutbound` repassa o `channelSource` certo, sem
 * depender do formato exato do `console.log` real.
 */
const logOutboundSendSpy = vi.fn();
vi.mock('./send-log', () => ({
  logOutboundSend: (...a: unknown[]) => logOutboundSendSpy(...a),
  // Mesma regra da implementação real (send-log.ts) — mockada aqui só
  // porque o módulo inteiro é mockado; não há comportamento a espionar.
  channelSourceFromId: (channelId: string | null | undefined) =>
    channelId ? 'resource' : 'default',
}));

/**
 * Registro com override por teste.
 *
 * Sem isto, qualquer teste de guard de capacidade passa pelo motivo
 * errado: `getAdapter('whatsapp_qr')` estoura com "no adapter
 * registered" ANTES de a capacidade ser conferida, e a asserção casa com
 * esse erro sem nunca exercitar o guard. O override dá um adaptador
 * registrado ao canal, para a recusa vir de onde ela deve vir.
 */
const { adapterOverrides, adminState } = vi.hoisted(() => ({
  adapterOverrides: new Map<string, unknown>(),
  // `recordColdSend` grava por `supabaseAdmin()` (062: só service_role
  // pode escrever em channel_cold_sends), não pelo `db` de sessão que os
  // testes deste arquivo controlam — precisa do próprio fake, trocado a
  // cada teste em `beforeEach`.
  adminState: { client: undefined as unknown },
}));

vi.mock('@/lib/supabase/admin', () => ({
  supabaseAdmin: () => adminState.client,
}));

/**
 * SPEC 076 RF-07 — o gancho do 131042 síncrono. Espião que, por padrão,
 * chama a implementação REAL (o sinal de verdade roda contra o
 * `adminState.client`; fora de uma requisição o `after()` do Next lança e
 * o agendador cai na execução solta); um teste troca a implementação
 * para provar que o envio não espera o sinal.
 */
const { signalSpy } = vi.hoisted(() => ({ signalSpy: vi.fn() }));
vi.mock('@/lib/whatsapp/billing-signal', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/lib/whatsapp/billing-signal')>();
  signalSpy.mockImplementation(actual.schedulePaymentErrorSignal);
  return {
    ...actual,
    schedulePaymentErrorSignal: (
      ...a: Parameters<typeof actual.schedulePaymentErrorSignal>
    ) => signalSpy(...a),
  };
});

vi.mock('./registry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./registry')>();
  return {
    ...actual,
    getAdapter: (type: string) =>
      adapterOverrides.get(type) ?? actual.getAdapter(type as never),
  };
});

// ------------------------------------------------------------
// Supabase de mentira — mesmo espírito de `ingest.test.ts`.
// ------------------------------------------------------------

interface RecordedOp {
  table: string;
  verb: 'select' | 'insert' | 'update';
  payload?: unknown;
  filters: Array<[string, ...unknown[]]>;
}

interface FakeResult {
  data?: unknown;
  error?: unknown;
  count?: number;
}

/**
 * Resultado fixo OU função da consulta que foi feita.
 *
 * A forma de função entrou na SPEC 064 F2: `channels` passou a receber
 * DUAS perguntas diferentes no mesmo caminho de envio — a lista dos
 * canais ativos (`resolveDefaultChannelId`) e a linha de um id
 * (`resolveCloudConfig`). Um `data` fixo só consegue responder a uma
 * delas, e responder a errada faria o teste passar por um caminho que
 * não é o de produção.
 */
type FakeEntry = FakeResult | ((op: RecordedOp) => FakeResult);

function makeDb(results: Record<string, FakeEntry> = {}) {
  const ops: RecordedOp[] = [];
  // SPEC 062 §4.3 ponto 4: `resolveChannelContext` agora confere
  // `accounts.blocked_at` antes de resolver credencial. O padrão é uma
  // conta existente e NÃO bloqueada; um teste que queira o contrário
  // sobrescreve `accounts.select`.
  const resultMap = new Map<string, FakeEntry>([
    ['accounts.select', { data: { blocked_at: null }, error: null }],
    ...Object.entries(results),
  ]);

  function builder(table: string) {
    const op: RecordedOp = { table, verb: 'select', filters: [] };
    let recorded = false;
    const settle = () => {
      if (!recorded) {
        ops.push(op);
        recorded = true;
      }
      const entry = resultMap.get(`${table}.${op.verb}`);
      if (typeof entry === 'function') return entry(op);
      return entry ?? { data: null, error: null };
    };

    const chain: Record<string, unknown> = {
      then(resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) {
        return Promise.resolve(settle()).then(resolve, reject);
      },
      insert: (payload?: unknown) => {
        op.verb = 'insert';
        op.payload = payload;
        return chain;
      },
      update: (payload?: unknown) => {
        op.verb = 'update';
        op.payload = payload;
        return chain;
      },
      select: (...args: unknown[]) => {
        op.filters.push(['select', ...args]);
        return chain;
      },
      eq: (...args: unknown[]) => {
        op.filters.push(['eq', ...args]);
        return chain;
      },
      neq: (...args: unknown[]) => {
        op.filters.push(['neq', ...args]);
        return chain;
      },
      in: (...args: unknown[]) => {
        op.filters.push(['in', ...args]);
        return chain;
      },
      gte: (...args: unknown[]) => {
        op.filters.push(['gte', ...args]);
        return chain;
      },
      order: (...args: unknown[]) => {
        op.filters.push(['order', ...args]);
        return chain;
      },
      limit: (...args: unknown[]) => {
        op.filters.push(['limit', ...args]);
        return chain;
      },
      single: () => Promise.resolve(settle()),
      maybeSingle: () => Promise.resolve(settle()),
    };
    return chain;
  }

  const client = {
    from: (t: string) => builder(t),
  } as unknown as SupabaseClient;
  // P-15: `resolveCloudConfig` lê a credencial pelo service role. Quando o
  // cenário traz `whatsapp_config`, o fake de sessão também responde pelo
  // admin — é o mesmo "banco" do teste.
  if (resultMap.has('whatsapp_config.select')) adminState.client = client;
  return { client, ops };
}

const CONFIG_ROW = {
  id: 'cfg-1',
  user_id: 'user-1',
  channel_id: 'ch-cloud-1',
  phone_number_id: 'pnid-1',
  access_token: 'cipher',
  status: 'connected',
};

/**
 * Linha de `channels` do número oficial (SPEC 064 F2).
 *
 * Desde a 072 o caminho Cloud passa por `channels`: a credencial é do
 * CANAL, não da conta. Uma fixture que só traga `whatsapp_config` não
 * chega mais ao envio — e é assim em produção também.
 */
const CLOUD_CHANNEL_ROW = {
  id: 'ch-cloud-1',
  account_id: 'acct-1',
  user_id: 'user-1',
  type: 'whatsapp_cloud',
  name: 'WhatsApp Oficial',
  identifier: '5511988887777',
  status: 'connected',
  status_detail: null,
  is_default: true,
  connected_at: null,
  last_seen_at: null,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
};

/**
 * `channels.select` que responde às DUAS perguntas do caminho de envio:
 * a lista de canais ativos (`resolveDefaultChannelId`, sem `eq('id')`) e
 * a linha de um id (`resolveCloudConfig`). Sem essa distinção, o teste
 * receberia um array onde o código espera uma linha — e passaria (ou
 * falharia) por um motivo que produção não tem.
 */
function channelsFixture(rows: Array<Record<string, unknown>>) {
  return (op: RecordedOp) => {
    const byId = op.filters.find((f) => f[0] === 'eq' && f[1] === 'id');
    if (byId) {
      return { data: rows.find((r) => r.id === byId[2]) ?? null, error: null };
    }
    return { data: rows, error: null };
  };
}

function dbWithConfigAndContact(over: Record<string, FakeEntry> = {}) {
  return makeDb({
    'channels.select': channelsFixture([CLOUD_CHANNEL_ROW]),
    'whatsapp_config.select': { data: CONFIG_ROW, error: null },
    'contacts.select': {
      data: { id: 'contact-1', phone: '+55 11 99999-9999' },
      error: null,
    },
    ...over,
  });
}

const CTX = cloudChannelContext({
  accountId: 'acct-1',
  phoneNumberId: 'pnid-1',
  accessToken: 'token-1',
});

/**
 * Adaptador mínimo de um canal QRCode. Só tem o que a matriz de
 * capacidades diz que o canal tem — sem `sendTemplate`, sem
 * `sendInteractive` — porque é essa a forma que o adaptador da F4 terá.
 */
const qrAdapterStub = {
  type: 'whatsapp_qr',
  capabilities: {},
  sendText: vi.fn(async () => ({ providerMessageId: 'evo.1' })),
  sendMedia: vi.fn(async () => ({ providerMessageId: 'evo.1' })),
  normalizeInbound: () => [],
};

/** Fake admin db do teste corrente — trocado a cada `beforeEach` abaixo. */
let adminDb: ReturnType<typeof makeDb>;

beforeEach(() => {
  vi.clearAllMocks();
  adapterOverrides.clear();
  adminDb = makeDb();
  adminState.client = adminDb.client;
  qrAdapterStub.sendText.mockResolvedValue({ providerMessageId: 'evo.1' });
  sendTextMessage.mockResolvedValue({ messageId: 'wamid.out' });
  sendMediaMessage.mockResolvedValue({ messageId: 'wamid.out' });
  sendTemplateMessage.mockResolvedValue({ messageId: 'wamid.out' });
  sendInteractiveButtons.mockResolvedValue({ messageId: 'wamid.out' });
  sendInteractiveList.mockResolvedValue({ messageId: 'wamid.out' });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('resolveChannelContext', () => {
  it('decripta o token e entrega a linha crua para o auto-reparo', async () => {
    const db = dbWithConfigAndContact();

    const { ctx, configRow, source } = await resolveChannelContext(
      db.client,
      'acct-1'
    );

    expect(ctx.credentials).toEqual({
      phoneNumberId: 'pnid-1',
      accessToken: 'decrypted:cipher',
    });
    expect(configRow.access_token).toBe('cipher');
    // Escopo de conta — não de usuário.
    const read = db.ops.find((o) => o.table === 'whatsapp_config')!;
    expect(read.filters).toContainEqual(['eq', 'account_id', 'acct-1']);
    // SPEC 065 §11 — sem `channelId`, caiu no padrão da conta.
    expect(source).toBe('default');
  });

  it('channelId explícito no Cloud → source "resource" (SPEC 065 §11)', async () => {
    const db = makeDb({
      'channels.select': channelsFixture([CLOUD_CHANNEL_ROW]),
      'whatsapp_config.select': { data: CONFIG_ROW, error: null },
    });

    const resolved = await resolveChannelContext(
      db.client,
      'acct-1',
      'whatsapp_cloud',
      CLOUD_CHANNEL_ROW.id
    );

    expect(resolved.source).toBe('resource');
  });

  it('erro tipado quando a conta não tem canal configurado', async () => {
    const db = makeDb({
      'whatsapp_config.select': { data: null, error: { message: 'no rows' } },
    });

    await expect(
      resolveChannelContext(db.client, 'acct-1')
    ).rejects.toBeInstanceOf(ChannelNotConfiguredError);
  });

  it('recusa whatsapp_qr sem channelId explícito (ambíguo entre várias instâncias)', async () => {
    const db = makeDb();
    await expect(
      resolveChannelContext(db.client, 'acct-1', 'whatsapp_qr')
    ).rejects.toBeInstanceOf(ChannelNotConfiguredError);
  });

  it('resolve whatsapp_qr por channelId — credencial é o instanceToken decriptado', async () => {
    resolveInstanceByChannelId.mockResolvedValue({
      instanceId: 'inst-1',
      channelId: 'chan-qr-1',
      accountId: 'acct-1',
      remoteInstanceId: 'remote-1',
      remoteInstanceName: 'zapcrm_acct1_vendas',
      token: 'plain-instance-token',
      channelName: 'Vendas',
    });
    const db = makeDb({
      'channels.select': {
        data: {
          id: 'chan-qr-1',
          account_id: 'acct-1',
          type: 'whatsapp_qr',
          name: 'Vendas',
          status: 'connected',
        },
        error: null,
      },
    });

    const resolved = await resolveChannelContext(
      db.client,
      'acct-1',
      'whatsapp_qr',
      'chan-qr-1'
    );

    expect(resolveInstanceByChannelId).toHaveBeenCalledWith(
      'acct-1',
      'chan-qr-1'
    );
    expect(resolved.ctx.credentials).toEqual({
      instanceToken: 'plain-instance-token',
    });
    expect(resolved.ctx.channel.id).toBe('chan-qr-1');
  });
});

describe('resolveChannelForConversation', () => {
  /**
   * A regressão que este bloco trava (SPEC 048 F4.1, achado #1 da
   * revisão): antes disto TODO caminho de saída resolvia
   * `whatsapp_cloud` fixo, ignorando `conversations.channel_id`. Com a
   * F4 fazendo conversas QRCode aparecerem no inbox, responder uma
   * delas mandava a mensagem pelo NÚMERO OFICIAL da Meta — cobrada,
   * saindo de outro número, e com um wamid que o eco `SEND_MESSAGE` da
   * Evolution nunca casaria.
   */
  it('resolve o canal QRCode quando a conversa aponta para ele', async () => {
    resolveInstanceByChannelId.mockResolvedValue({
      instanceId: 'inst-1',
      channelId: 'chan-qr-1',
      accountId: 'acct-1',
      remoteInstanceId: 'remote-1',
      remoteInstanceName: 'zapcrm_acct1_vendas',
      token: 'plain-instance-token',
      channelName: 'Vendas',
    });
    const db = makeDb({
      'conversations.select': {
        data: { channel_id: 'chan-qr-1' },
        error: null,
      },
      'channels.select': {
        data: {
          id: 'chan-qr-1',
          account_id: 'acct-1',
          type: 'whatsapp_qr',
          name: 'Vendas',
          status: 'connected',
        },
        error: null,
      },
    });

    const resolved = await resolveChannelForConversation(
      db.client,
      'acct-1',
      'conv-qr'
    );

    expect(resolved.ctx.channel.type).toBe('whatsapp_qr');
    expect(resolved.ctx.credentials).toEqual({
      instanceToken: 'plain-instance-token',
    });
    // E nunca tocou a `whatsapp_config` do canal oficial.
    expect(db.ops.some((o) => o.table === 'whatsapp_config')).toBe(false);
    // SPEC 065 §11 — herdado da CONVERSA, nunca `'resource'`: quem
    // resolveu não foi o chamador, foi `conversations.channel_id`.
    expect(resolved.source).toBe('conversation');
  });

  it('resolve o canal oficial quando a conversa aponta para ele', async () => {
    const db = makeDb({
      'conversations.select': {
        data: { channel_id: 'chan-cloud-1' },
        error: null,
      },
      'channels.select': {
        data: { id: 'chan-cloud-1', type: 'whatsapp_cloud' },
        error: null,
      },
      'whatsapp_config.select': { data: CONFIG_ROW, error: null },
    });

    const resolved = await resolveChannelForConversation(
      db.client,
      'acct-1',
      'conv-cloud'
    );

    expect(resolved.ctx.channel.type).toBe('whatsapp_cloud');
    expect(resolved.ctx.credentials.phoneNumberId).toBe('pnid-1');
  });

  it('conversa sem channel_id cai no canal oficial PADRÃO (compat pré-059)', async () => {
    // Sem canal na conversa, quem decide é o D-11: o padrão do tipo
    // Cloud. Antes da 072 era "a única `whatsapp_config` da conta".
    const db = makeDb({
      'conversations.select': { data: { channel_id: null }, error: null },
      'channels.select': channelsFixture([CLOUD_CHANNEL_ROW]),
      'whatsapp_config.select': { data: CONFIG_ROW, error: null },
    });

    const resolved = await resolveChannelForConversation(
      db.client,
      'acct-1',
      'conv-antiga'
    );

    expect(resolved.ctx.channel.type).toBe('whatsapp_cloud');
    // SPEC 065 §11 — sem `channel_id` na conversa, caiu no padrão.
    expect(resolved.source).toBe('default');
  });

  it('falha com motivo quando o canal da conversa não existe mais', async () => {
    // Enviar pelo canal errado é pior que não enviar.
    const db = makeDb({
      'conversations.select': {
        data: { channel_id: 'chan-apagado' },
        error: null,
      },
      'channels.select': { data: null, error: null },
    });

    await expect(
      resolveChannelForConversation(db.client, 'acct-1', 'conv-orfa')
    ).rejects.toBeInstanceOf(ChannelNotConfiguredError);
  });

  it('dois números oficiais: a conversa do canal B sai PELO B (SPEC 064)', async () => {
    // Este é o teste que a F2 existe para fazer passar. No código
    // anterior o ramo Cloud IGNORAVA o `channelId` e caía num
    // `.single()` por `account_id` — a conversa do segundo número
    // responderia pelo primeiro (ou, com duas linhas, estouraria).
    const cloudB = {
      ...CLOUD_CHANNEL_ROW,
      id: 'ch-cloud-2',
      name: 'Suporte',
      identifier: '5511977776666',
      is_default: false,
      created_at: '2026-03-01T00:00:00.000Z',
    };
    const db = makeDb({
      'conversations.select': {
        data: { channel_id: 'ch-cloud-2' },
        error: null,
      },
      'channels.select': channelsFixture([CLOUD_CHANNEL_ROW, cloudB]),
      'whatsapp_config.select': (op) => {
        const byChannel = op.filters.find(
          (f) => f[0] === 'eq' && f[1] === 'channel_id'
        );
        return {
          data:
            byChannel?.[2] === 'ch-cloud-2'
              ? {
                  ...CONFIG_ROW,
                  id: 'cfg-2',
                  channel_id: 'ch-cloud-2',
                  phone_number_id: 'pnid-2',
                  access_token: 'cipher-2',
                }
              : CONFIG_ROW,
          error: null,
        };
      },
    });

    const resolved = await resolveChannelForConversation(
      db.client,
      'acct-1',
      'conv-do-numero-b'
    );

    expect(resolved.ctx.channel.id).toBe('ch-cloud-2');
    expect(resolved.ctx.credentials).toEqual({
      phoneNumberId: 'pnid-2',
      accessToken: 'decrypted:cipher-2',
    });
    // E o identifier do contexto é o TELEFONE do canal B (D-9), não o
    // do padrão nem o `phone_number_id`.
    expect(resolved.ctx.channel.identifier).toBe('5511977776666');
    // SPEC 065 §11 — herdado da conversa, mesmo havendo um `channelId`
    // explícito na chamada interna a `resolveChannelContext`.
    expect(resolved.source).toBe('conversation');
  });

  it('escopa a leitura da conversa por conta', async () => {
    const db = makeDb({
      'conversations.select': { data: { channel_id: null }, error: null },
      'channels.select': channelsFixture([CLOUD_CHANNEL_ROW]),
      'whatsapp_config.select': { data: CONFIG_ROW, error: null },
    });

    await resolveChannelForConversation(db.client, 'acct-1', 'conv-1');

    const read = db.ops.find((o) => o.table === 'conversations')!;
    expect(read.filters).toContainEqual(['eq', 'account_id', 'acct-1']);
  });
});

describe('resolveOutboundContact', () => {
  it('filtra por conta e devolve o telefone sanitizado', async () => {
    const db = dbWithConfigAndContact();

    const contact = await resolveOutboundContact(
      db.client,
      'acct-1',
      'contact-1'
    );

    // `sanitizePhoneForMeta` tira tudo que não é dígito, inclusive o `+`.
    expect(contact.sanitizedPhone).toBe('5511999999999');
    const read = db.ops.find((o) => o.table === 'contacts')!;
    expect(read.filters).toContainEqual(['eq', 'account_id', 'acct-1']);
  });

  it('recusa contato de outra conta com a mensagem histórica', async () => {
    const db = makeDb({ 'contacts.select': { data: null, error: null } });

    await expect(
      resolveOutboundContact(db.client, 'acct-1', 'contact-de-outro')
    ).rejects.toThrow('contact not found for this account');
  });

  it('recusa telefone que não vira E.164', async () => {
    const db = makeDb({
      'contacts.select': { data: { id: 'c', phone: '123' }, error: null },
    });

    await expect(
      resolveOutboundContact(db.client, 'acct-1', 'c')
    ).rejects.toThrow('contact phone invalid: 123');
  });
});

describe('sendContentViaChannel — o canal oficial recebe tudo o que recebia', () => {
  it('texto com citação vira `contextMessageId`', async () => {
    await sendContentViaChannel(CTX, {
      to: '+5511999999999',
      content: { kind: 'text', text: 'oi' },
      quotedProviderMessageId: 'wamid.pai',
    });

    expect(sendTextMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        phoneNumberId: 'pnid-1',
        accessToken: 'token-1',
        to: '+5511999999999',
        text: 'oi',
        contextMessageId: 'wamid.pai',
      })
    );
  });

  it('template leva a linha local, os params estruturados E os posicionais', async () => {
    const templateRow = { id: 'tpl-1', header_type: 'image' };

    await sendContentViaChannel(CTX, {
      to: '+5511999999999',
      content: {
        kind: 'template',
        templateName: 'promo',
        language: 'pt_BR',
        definition: templateRow,
        components: { headerMediaUrl: 'https://signed' },
        positionalParams: ['Ana'],
      },
      quotedProviderMessageId: 'wamid.pai',
    });

    // Perder `template` aqui quebraria todo template com header de
    // mídia; perder `params`, todo envio legado.
    expect(sendTemplateMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        templateName: 'promo',
        language: 'pt_BR',
        template: templateRow,
        messageParams: { headerMediaUrl: 'https://signed' },
        params: ['Ana'],
        contextMessageId: 'wamid.pai',
      })
    );
  });

  it('mídia mapeia url→link e mantém caption/filename/citação', async () => {
    await sendContentViaChannel(CTX, {
      to: '+5511999999999',
      content: {
        kind: 'media',
        mediaKind: 'document',
        link: 'https://signed/doc.pdf',
        caption: 'contrato',
        filename: 'doc.pdf',
      },
      quotedProviderMessageId: 'wamid.pai',
    });

    expect(sendMediaMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'document',
        link: 'https://signed/doc.pdf',
        caption: 'contrato',
        filename: 'doc.pdf',
        contextMessageId: 'wamid.pai',
      })
    );
  });

  it('interativo escolhe botões ou lista pelo payload', async () => {
    await sendContentViaChannel(CTX, {
      to: '+5511999999999',
      content: {
        kind: 'interactive',
        payload: {
          kind: 'buttons',
          body: 'Escolha',
          buttons: [{ id: 'a', title: 'A' }],
        },
      },
    });
    expect(sendInteractiveButtons).toHaveBeenCalled();
    expect(sendInteractiveList).not.toHaveBeenCalled();

    await sendContentViaChannel(CTX, {
      to: '+5511999999999',
      content: {
        kind: 'interactive',
        payload: {
          kind: 'list',
          body: 'Escolha',
          button_label: 'Ver',
          sections: [{ title: 'S', rows: [{ id: 'a', title: 'A' }] }],
        },
      },
    });
    expect(sendInteractiveList).toHaveBeenCalled();
  });

  it('recusa por capacidade, com motivo, antes de tocar no provedor', async () => {
    // Canal QRCode COM adaptador registrado — senão a recusa viria do
    // registro e este teste passaria sem nunca exercitar o guard.
    adapterOverrides.set('whatsapp_qr', qrAdapterStub);
    const qrCtx = {
      ...CTX,
      channel: { ...CTX.channel, type: 'whatsapp_qr' as const },
    };

    // A matriz mede o que foi MEDIDO contra o servidor real: o canal QR
    // não tem template, e botão/lista o WhatsApp recusa com 405.
    await expect(
      sendContentViaChannel(qrCtx, {
        to: '+5511999999999',
        content: { kind: 'template', templateName: 'promo' },
      })
    ).rejects.toThrow(/does not support message templates/);

    await expect(
      sendContentViaChannel(qrCtx, {
        to: '+5511999999999',
        content: {
          kind: 'interactive',
          payload: {
            kind: 'buttons',
            body: 'Escolha',
            buttons: [{ id: 'a', title: 'A' }],
          },
        },
      })
    ).rejects.toThrow(/does not support interactive buttons/);

    expect(sendTemplateMessage).not.toHaveBeenCalled();
    expect(qrAdapterStub.sendText).not.toHaveBeenCalled();
  });

  it('deixa passar o que o canal SUPORTA', async () => {
    // Contraprova do teste acima: se o guard recusasse por engano, o
    // canal QRCode nasceria mudo.
    adapterOverrides.set('whatsapp_qr', qrAdapterStub);
    const qrCtx = {
      ...CTX,
      channel: { ...CTX.channel, type: 'whatsapp_qr' as const },
    };

    const id = await sendContentViaChannel(qrCtx, {
      to: '+5511999999999',
      content: { kind: 'text', text: 'oi' },
    });

    expect(id).toBe('evo.1');
    expect(qrAdapterStub.sendText).toHaveBeenCalledTimes(1);
  });

  it('recusa quando a matriz e o adaptador DISCORDAM', async () => {
    // `capabilities.ts` e o objeto do adaptador são duas declarações
    // independentes, e os métodos são opcionais na interface — o
    // TypeScript não amarra uma à outra. Um canal que declare
    // `templates: true` e esqueça o método precisa falhar com motivo,
    // não com `undefined is not a function` dentro do laço de variantes
    // (que o send-message traduziria como "Meta API error" + HTTP 502).
    const cloudSemTemplate = {
      type: 'whatsapp_cloud',
      capabilities: {},
      sendText: vi.fn(),
      sendMedia: vi.fn(),
      // sendTemplate ausente de propósito
      normalizeInbound: () => [],
    };
    adapterOverrides.set('whatsapp_cloud', cloudSemTemplate);

    await expect(
      sendContentViaChannel(CTX, {
        to: '+5511999999999',
        content: { kind: 'template', templateName: 'promo' },
      })
    ).rejects.toThrow(/adapter has no sendTemplate\(\)/);
  });
});

describe('sendWithPhoneVariants', () => {
  it('tenta a próxima variante quando o destinatário não está na lista', async () => {
    sendTextMessage
      .mockRejectedValueOnce(
        new Error('recipient phone number not in allowed list')
      )
      .mockResolvedValueOnce({ messageId: 'wamid.ok' });
    const onVariantRejected = vi.fn();

    const r = await sendWithPhoneVariants({
      ctx: CTX,
      sanitizedPhone: '+5511999999999',
      content: { kind: 'text', text: 'oi' },
      onVariantRejected,
    });

    expect(r.providerMessageId).toBe('wamid.ok');
    expect(onVariantRejected).toHaveBeenCalledTimes(1);
    expect(sendTextMessage).toHaveBeenCalledTimes(2);
  });

  it('NÃO repete diante de qualquer outro erro', async () => {
    // Insistir com telefones diferentes diante de um token inválido só
    // multiplicaria a falha.
    sendTextMessage.mockRejectedValue(new Error('Invalid OAuth access token'));

    await expect(
      sendWithPhoneVariants({
        ctx: CTX,
        sanitizedPhone: '+5511999999999',
        content: { kind: 'text', text: 'oi' },
      })
    ).rejects.toThrow('Invalid OAuth access token');
    expect(sendTextMessage).toHaveBeenCalledTimes(1);
  });
});

describe('131042 síncrono liga o estado de pagamento (SPEC 076 RF-07)', () => {
  /** O que o `throwMetaError` real produz para um 131042 (HTTP 402). */
  function paymentError(): Error {
    return Object.assign(
      new Error(
        '(#131042) Business eligibility payment issue: There was an error related to your payment method'
      ),
      { name: 'MetaApiError', status: 402, code: 131042 }
    );
  }

  /** `supabaseAdmin()` de mentira: só o que o sinal consulta. */
  function signalAdmin() {
    const rpc = vi.fn(async () => ({ data: true, error: null }));
    const configFilters: unknown[][] = [];
    function from(table: string) {
      const chain = {
        select: () => chain,
        eq: (...a: unknown[]) => {
          if (table === 'whatsapp_config') configFilters.push(a);
          return chain;
        },
        maybeSingle: () =>
          Promise.resolve({
            data:
              table === 'platform_settings'
                ? { whatsapp_billing_monitor_enabled: false }
                : null,
            error: null,
          }),
        then: (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) =>
          Promise.resolve({
            data: [{ account_id: 'acct-1', waba_id: '100000000004821' }],
            error: null,
          }).then(onF, onR),
      };
      return chain;
    }
    return { client: { from, rpc }, rpc, configFilters };
  }

  beforeEach(async () => {
    const { __resetBillingSignalStateForTests } =
      await import('@/lib/whatsapp/billing-signal');
    __resetBillingSignalStateForTests();
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  it('devolve o MESMO erro ao chamador e liga o estado do WABA do número', async () => {
    const admin = signalAdmin();
    adminState.client = admin.client;
    const err = paymentError();
    sendTemplateMessage.mockRejectedValue(err);

    const caught = await sendContentViaChannel(CTX, {
      to: '+5511999999999',
      content: { kind: 'template', templateName: 'promo' },
    }).catch((e: unknown) => e);

    expect(caught).toBe(err);
    expect(signalSpy).toHaveBeenCalledWith({
      accountId: 'acct-1',
      phoneNumberId: 'pnid-1',
      error: err,
    });
    // O sinal é agendado (não aguardado): espera a escrita acontecer.
    await vi.waitFor(() =>
      expect(admin.rpc).toHaveBeenCalledWith(
        'apply_payment_signal',
        expect.objectContaining({
          p_account_id: 'acct-1',
          p_waba_id: '100000000004821',
          p_kind: 'payment_error',
          p_phone_number_id: 'pnid-1',
        })
      )
    );
    // O número é resolvido pela config; a conta é CONFERIDA, não confiada.
    expect(admin.configFilters).toEqual([['phone_number_id', 'pnid-1']]);
  });

  it('não espera o sinal: um sinal que nunca termina não segura o erro', async () => {
    signalSpy.mockImplementationOnce(() => new Promise<void>(() => {}));
    const err = paymentError();
    sendTextMessage.mockRejectedValue(err);

    await expect(
      sendContentViaChannel(CTX, {
        to: '+5511999999999',
        content: { kind: 'text', text: 'oi' },
      })
    ).rejects.toBe(err);
  });

  it('cobre o laço de variantes (inbox, motores, API): o erro sobe intacto', async () => {
    const admin = signalAdmin();
    adminState.client = admin.client;
    const err = paymentError();
    sendTextMessage.mockRejectedValue(err);

    await expect(
      sendWithPhoneVariants({
        ctx: CTX,
        sanitizedPhone: '+5511999999999',
        content: { kind: 'text', text: 'oi' },
      })
    ).rejects.toBe(err);
    expect(signalSpy).toHaveBeenCalledTimes(1);
  });

  it('sucesso, ou erro que não é 131042: nenhuma escrita de cobrança', async () => {
    const admin = signalAdmin();
    adminState.client = admin.client;
    sendTextMessage.mockResolvedValueOnce({ messageId: 'wamid.ok' });
    await sendContentViaChannel(CTX, {
      to: '+5511999999999',
      content: { kind: 'text', text: 'oi' },
    });
    expect(signalSpy).not.toHaveBeenCalled();

    sendTextMessage.mockRejectedValueOnce(
      Object.assign(new Error('(#190) token'), { status: 401, code: 190 })
    );
    await sendContentViaChannel(CTX, {
      to: '+5511999999999',
      content: { kind: 'text', text: 'oi' },
    }).catch(() => {});
    expect(admin.rpc).not.toHaveBeenCalled();
    expect(admin.configFilters).toHaveLength(0);
  });

  it('canal QRCode não tem cobrança da Meta: o gancho nem é chamado', async () => {
    adapterOverrides.set('whatsapp_qr', {
      ...qrAdapterStub,
      sendText: vi.fn().mockRejectedValue(paymentError()),
    });
    const qrCtx = {
      ...CTX,
      channel: { ...CTX.channel, type: 'whatsapp_qr' as const },
    };
    await sendContentViaChannel(qrCtx, {
      to: '+5511999999999',
      content: { kind: 'text', text: 'oi' },
    }).catch(() => {});
    expect(signalSpy).not.toHaveBeenCalled();
  });
});

describe('sendAndPersistOutbound', () => {
  it('grava a mensagem do motor e atualiza o preview da conversa', async () => {
    const db = dbWithConfigAndContact();

    const r = await sendAndPersistOutbound({
      db: db.client,
      accountId: 'acct-1',
      origin: 'automation',
      conversationId: 'conv-1',
      contactId: 'contact-1',
      content: { kind: 'text', text: 'olá' },
      persist: {
        senderType: 'bot',
        contentType: 'text',
        contentText: 'olá',
        previewText: 'olá',
        extra: { ai_generated: true },
      },
    });

    expect(r).toEqual({ whatsapp_message_id: 'wamid.out' });

    const insert = db.ops.find(
      (o) => o.table === 'messages' && o.verb === 'insert'
    )!;
    expect(insert.payload).toEqual({
      conversation_id: 'conv-1',
      sender_type: 'bot',
      content_type: 'text',
      content_text: 'olá',
      ai_generated: true,
      message_id: 'wamid.out',
      status: 'sent',
    });

    const convUpdate = db.ops.find(
      (o) => o.table === 'conversations' && o.verb === 'update'
    )!;
    expect(convUpdate.payload).toMatchObject({ last_message_text: 'olá' });
  });

  it('persiste a variante que funcionou de volta no contato', async () => {
    const db = dbWithConfigAndContact();
    sendTextMessage
      .mockRejectedValueOnce(
        new Error('recipient phone number not in allowed list')
      )
      .mockResolvedValueOnce({ messageId: 'wamid.ok' });

    await sendAndPersistOutbound({
      db: db.client,
      accountId: 'acct-1',
      origin: 'automation',
      conversationId: 'conv-1',
      contactId: 'contact-1',
      content: { kind: 'text', text: 'olá' },
      persist: {
        senderType: 'bot',
        contentType: 'text',
        contentText: 'olá',
        previewText: 'olá',
      },
    });

    // A segunda variante de `phoneVariants` insere um 0 depois do
    // primeiro dígito de país. O que importa aqui é que a variante
    // ACEITA volte para o contato, para o próximo envio ir direto.
    const fix = db.ops.find(
      (o) => o.table === 'contacts' && o.verb === 'update'
    );
    expect(fix?.payload).toEqual({ phone: '50511999999999' });
  });

  it('não finge que o envio falhou quando só o INSERT falhou', async () => {
    const db = dbWithConfigAndContact({
      'messages.insert': { data: null, error: { message: 'constraint' } },
    });

    await expect(
      sendAndPersistOutbound({
        db: db.client,
        accountId: 'acct-1',
        origin: 'automation',
        conversationId: 'conv-1',
        contactId: 'contact-1',
        content: { kind: 'text', text: 'olá' },
        persist: {
          senderType: 'bot',
          contentType: 'text',
          contentText: 'olá',
          previewText: 'olá',
        },
      })
    ).rejects.toThrow(/sent to Meta but DB insert failed/);
  });

  describe('teto de envio frio (SPEC 049 §6.2, D-1) — canal QR', () => {
    function dbWithQrConversation(
      over: Record<
        string,
        { data?: unknown; error?: unknown; count?: number }
      > = {}
    ) {
      return makeDb({
        'conversations.select': {
          data: { channel_id: 'chan-qr-1', last_customer_message_at: null },
          error: null,
        },
        'channels.select': {
          data: {
            id: 'chan-qr-1',
            account_id: 'acct-1',
            type: 'whatsapp_qr',
            name: 'Vendas',
            status: 'connected',
            created_at: '2020-01-01T00:00:00Z',
          },
          error: null,
        },
        'contacts.select': {
          data: { id: 'contact-1', phone: '+55 11 99999-9999' },
          error: null,
        },
        'channel_cold_sends.select': { count: 0, data: null },
        ...over,
      });
    }

    beforeEach(() => {
      adapterOverrides.set('whatsapp_qr', qrAdapterStub);
      resolveInstanceByChannelId.mockResolvedValue({
        instanceId: 'inst-1',
        channelId: 'chan-qr-1',
        accountId: 'acct-1',
        remoteInstanceId: 'remote-1',
        remoteInstanceName: 'zapcrm_acct1_vendas',
        token: 'plain-instance-token',
        channelName: 'Vendas',
      });
    });

    it('nega (ColdSendLimitError) sem tocar o adaptador quando o teto diário estourou', async () => {
      const db = dbWithQrConversation({
        'channel_cold_sends.select': { count: COLD_SEND_DEFAULTS.perDay },
      });

      await expect(
        sendAndPersistOutbound({
          db: db.client,
          accountId: 'acct-1',
          origin: 'automation',
          conversationId: 'conv-1',
          contactId: 'contact-1',
          content: { kind: 'text', text: 'oi' },
          persist: {
            senderType: 'bot',
            contentType: 'text',
            contentText: 'oi',
            previewText: 'oi',
          },
        })
      ).rejects.toBeInstanceOf(ColdSendLimitError);

      expect(qrAdapterStub.sendText).not.toHaveBeenCalled();
      // A leitura da última mensagem do contato acontece; a bolha, não.
      expect(
        db.ops.some((o) => o.table === 'messages' && o.verb === 'insert')
      ).toBe(false);
    });

    it('envio frio dentro do teto: entrega e grava origin=engine em channel_cold_sends', async () => {
      const db = dbWithQrConversation();

      await sendAndPersistOutbound({
        db: db.client,
        accountId: 'acct-1',
        origin: 'automation',
        conversationId: 'conv-1',
        contactId: 'contact-1',
        content: { kind: 'text', text: 'oi' },
        persist: {
          senderType: 'bot',
          contentType: 'text',
          contentText: 'oi',
          previewText: 'oi',
        },
      });

      expect(qrAdapterStub.sendText).toHaveBeenCalledTimes(1);
      // Grava por supabaseAdmin(), não pelo `db` de sessão — 062 proíbe
      // qualquer policy de escrita em channel_cold_sends para o cliente
      // comum (é exatamente o bug real que gerou "new row violates
      // row-level security policy" em produção). `db` ainda LÊ essa
      // tabela (leitura de uso, dentro de checkColdSend) — só o INSERT
      // precisa sair do lado privilegiado.
      expect(
        db.ops.some(
          (o) => o.table === 'channel_cold_sends' && o.verb === 'insert'
        )
      ).toBe(false);
      const record = adminDb.ops.find(
        (o) => o.table === 'channel_cold_sends' && o.verb === 'insert'
      );
      expect(record?.payload).toEqual({
        channel_id: 'chan-qr-1',
        account_id: 'acct-1',
        contact_id: 'contact-1',
        origin: 'engine',
      });
    });

    it('conversa viva (não fria): entrega e NÃO grava consumo', async () => {
      // O caso real do QRCode: `last_customer_message_at` é NULL para
      // sempre (só canal com janela o grava), e o contato escreveu há
      // uma hora. Lido da âncora, isto contava como frio e consumia a
      // cota a cada resposta de automação/flow/IA.
      const db = dbWithQrConversation({
        'messages.select': {
          data: {
            created_at: new Date(Date.now() - 3_600_000).toISOString(),
          },
          error: null,
        },
      });

      await sendAndPersistOutbound({
        db: db.client,
        accountId: 'acct-1',
        origin: 'automation',
        conversationId: 'conv-1',
        contactId: 'contact-1',
        content: { kind: 'text', text: 'oi' },
        persist: {
          senderType: 'bot',
          contentType: 'text',
          contentText: 'oi',
          previewText: 'oi',
        },
      });

      expect(qrAdapterStub.sendText).toHaveBeenCalledTimes(1);
      // O consumo iria por supabaseAdmin() — conferir só `db` passaria
      // mesmo com o bug.
      expect(
        [...db.ops, ...adminDb.ops].some(
          (o) => o.table === 'channel_cold_sends' && o.verb === 'insert'
        )
      ).toBe(false);
      const inbound = db.ops.find(
        (o) => o.table === 'messages' && o.verb === 'select'
      );
      expect(inbound?.filters).toContainEqual([
        'eq',
        'sender_type',
        'customer',
      ]);
    });

    it('contato calado além de silenceHours: frio, e o teto estourado nega', async () => {
      const db = dbWithQrConversation({
        'messages.select': {
          data: {
            created_at: new Date(
              Date.now() - (COLD_SEND_DEFAULTS.silenceHours + 1) * 3_600_000
            ).toISOString(),
          },
          error: null,
        },
        'channel_cold_sends.select': { count: COLD_SEND_DEFAULTS.perDay },
      });

      await expect(
        sendAndPersistOutbound({
          db: db.client,
          accountId: 'acct-1',
          origin: 'automation',
          conversationId: 'conv-1',
          contactId: 'contact-1',
          content: { kind: 'text', text: 'oi' },
          persist: {
            senderType: 'bot',
            contentType: 'text',
            contentText: 'oi',
            previewText: 'oi',
          },
        })
      ).rejects.toBeInstanceOf(ColdSendLimitError);
      expect(qrAdapterStub.sendText).not.toHaveBeenCalled();
    });

    it('canal Cloud: não paga a consulta extra nem toca channel_cold_sends', async () => {
      const db = dbWithConfigAndContact();

      await sendAndPersistOutbound({
        db: db.client,
        accountId: 'acct-1',
        origin: 'automation',
        conversationId: 'conv-1',
        contactId: 'contact-1',
        content: { kind: 'text', text: 'oi' },
        persist: {
          senderType: 'bot',
          contentType: 'text',
          contentText: 'oi',
          previewText: 'oi',
        },
      });

      expect(db.ops.some((o) => o.table === 'channel_cold_sends')).toBe(false);
    });
  });

  describe('selo do canal de desvio (SPEC 049 §6.1 ponto 2, migração 063)', () => {
    it('canal EXPLÍCITO: a bolha carrega channel_id do canal que entregou', async () => {
      // Mesmo cenário de `dbWithQrConversation`, mas SEM `conversations.
      // channel_id` apontar para o QR — a conversa é do oficial; o
      // desvio (`channel` explícito) é o único motivo de o envio sair
      // pelo QR mesmo assim.
      adapterOverrides.set('whatsapp_qr', qrAdapterStub);
      resolveInstanceByChannelId.mockResolvedValue({
        instanceId: 'inst-1',
        channelId: 'chan-qr-1',
        accountId: 'acct-1',
        remoteInstanceId: 'remote-1',
        remoteInstanceName: 'zapcrm_acct1_vendas',
        token: 'plain-instance-token',
        channelName: 'Vendas',
      });
      const db = makeDb({
        'channels.select': {
          data: {
            id: 'chan-qr-1',
            account_id: 'acct-1',
            type: 'whatsapp_qr',
            name: 'Vendas',
            status: 'connected',
            created_at: '2020-01-01T00:00:00Z',
          },
          error: null,
        },
        'contacts.select': {
          data: { id: 'contact-1', phone: '+55 11 99999-9999' },
          error: null,
        },
        'channel_cold_sends.select': { count: 0, data: null },
      });

      await sendAndPersistOutbound({
        db: db.client,
        accountId: 'acct-1',
        origin: 'automation',
        channel: { type: 'whatsapp_qr', id: 'chan-qr-1' },
        conversationId: 'conv-1',
        contactId: 'contact-1',
        content: { kind: 'text', text: 'oi' },
        persist: {
          senderType: 'bot',
          contentType: 'text',
          contentText: 'oi',
          previewText: 'oi',
        },
      });

      const insert = db.ops.find(
        (o) => o.table === 'messages' && o.verb === 'insert'
      );
      expect(insert?.payload).toMatchObject({ channel_id: 'chan-qr-1' });

      // E a `conversations` consultada por `channel_id` NUNCA acontece.
      // (O teto de envio frio lê a última mensagem do contato em
      // `messages`, não a âncora de `conversations` — então nenhuma
      // leitura de `conversations` sobra neste caminho.)
      expect(
        db.ops.some((o) => o.table === 'conversations' && o.verb === 'select')
      ).toBe(false);

      // SPEC 065 §11 — `channel` explícito é sempre `'resource'`: é o
      // desvio ESCOLHENDO ignorar o canal da conversa, não a conversa
      // decidindo por ele.
      expect(logOutboundSendSpy).toHaveBeenCalledWith(
        expect.objectContaining({ channelSource: 'resource' })
      );
    });

    it('canal IMPLÍCITO (o da própria conversa): channel_id fica de fora do INSERT', async () => {
      const db = dbWithConfigAndContact();

      await sendAndPersistOutbound({
        db: db.client,
        accountId: 'acct-1',
        origin: 'automation',
        conversationId: 'conv-1',
        contactId: 'contact-1',
        content: { kind: 'text', text: 'oi' },
        persist: {
          senderType: 'bot',
          contentType: 'text',
          contentText: 'oi',
          previewText: 'oi',
        },
      });

      const insert = db.ops.find(
        (o) => o.table === 'messages' && o.verb === 'insert'
      );
      expect(insert?.payload).not.toHaveProperty('channel_id');

      // SPEC 065 §11 — sem `channel` explícito e sem `conversations.
      // channel_id` na fixture, `resolveChannelForConversation` caiu no
      // canal Cloud padrão.
      expect(logOutboundSendSpy).toHaveBeenCalledWith(
        expect.objectContaining({ channelSource: 'default' })
      );
    });
  });
});

describe('ChannelCapabilityError', () => {
  it('é uma classe de erro própria, para o chamador distinguir', () => {
    expect(new ChannelCapabilityError('x')).toBeInstanceOf(Error);
    expect(new ChannelCapabilityError('x').name).toBe('ChannelCapabilityError');
  });
});

// ---------------------------------------------------------------------
// resolveDefaultChannelId — D-11 (SPEC 064)
//
// A migração 072 trocou `idx_channels_one_default_per_account` (um
// padrão por CONTA) por `..._per_account_type` (um por conta e TIPO).
// A versão anterior desta função casava `account_id + is_default` com
// `.maybeSingle()`: com um Cloud e um QRCode marcados — estado que o
// próprio backfill da 072 cria — isso passou a devolver PGRST116, e
// como o erro era descartado o sintoma não era um 500, era um fallback
// mudo para `whatsapp_config` que quebra junto assim que a conta tem
// dois números.
//
// Cada teste abaixo falha na implementação antiga.
// ---------------------------------------------------------------------
describe('resolveDefaultChannelId — padrão por tipo (SPEC 064 D-11)', () => {
  const cloud = {
    id: 'ch-cloud',
    type: 'whatsapp_cloud',
    is_default: true,
    status: 'connected',
    created_at: '2026-02-01T00:00:00.000Z',
  };
  const qr = {
    id: 'ch-qr',
    type: 'whatsapp_qr',
    is_default: true,
    status: 'connected',
    created_at: '2026-01-01T00:00:00.000Z',
  };

  it('devolve o Cloud quando a conta tem padrão dos DOIS tipos', async () => {
    // O caso que quebrava: duas linhas com is_default = TRUE.
    const { client } = makeDb({
      'channels.select': { data: [qr, cloud], error: null },
    });
    await expect(resolveDefaultChannelId(client, 'acct-1')).resolves.toBe(
      'ch-cloud'
    );
  });

  it('cai no QRCode quando a conta não tem canal Cloud', async () => {
    const { client } = makeDb({
      'channels.select': { data: [qr], error: null },
    });
    await expect(resolveDefaultChannelId(client, 'acct-1')).resolves.toBe(
      'ch-qr'
    );
  });

  it('nunca devolve canal desativado', async () => {
    // `resolveDefaultChannelId` filtra `status <> 'disabled'` no banco;
    // aqui o fake devolve só o que o filtro deixaria passar, e o Cloud
    // desativado simplesmente não está na lista.
    const { client, ops } = makeDb({
      'channels.select': { data: [qr], error: null },
    });
    await expect(resolveDefaultChannelId(client, 'acct-1')).resolves.toBe(
      'ch-qr'
    );
    expect(ops[0].filters).toContainEqual(['neq', 'status', 'disabled']);
  });

  it('restringe ao tipo pedido quando `type` é passado', async () => {
    const { client, ops } = makeDb({
      'channels.select': { data: [qr], error: null },
    });
    await expect(
      resolveDefaultChannelId(client, 'acct-1', 'whatsapp_qr')
    ).resolves.toBe('ch-qr');
    expect(ops[0].filters).toContainEqual(['in', 'type', ['whatsapp_qr']]);
  });

  it('sem canal nenhum, lança ChannelNotConfiguredError', async () => {
    const { client } = makeDb({
      'channels.select': { data: [], error: null },
    });
    await expect(resolveDefaultChannelId(client, 'acct-1')).rejects.toThrow(
      ChannelNotConfiguredError
    );
  });

  it('erro de leitura não vira "conta sem canal" silencioso', async () => {
    // Descartar o erro era metade do problema original: a falha de
    // leitura precisa chegar ao chamador com o motivo, não virar um
    // "não configurado" que manda o operador reconectar à toa.
    const { client } = makeDb({
      'channels.select': { data: null, error: { message: 'PGRST116' } },
    });
    await expect(resolveDefaultChannelId(client, 'acct-1')).rejects.toThrow(
      /PGRST116/
    );
  });

  it('tipo com canal ativo mas sem padrão marcado usa o mais antigo', async () => {
    // Determinístico, o mesmo critério do backfill da 072 — nunca "o
    // primeiro que o Postgres devolver".
    const novo = { ...cloud, id: 'ch-novo', is_default: false };
    const antigo = {
      ...cloud,
      id: 'ch-antigo',
      is_default: false,
      created_at: '2025-12-01T00:00:00.000Z',
    };
    const { client } = makeDb({
      'channels.select': { data: [novo, antigo], error: null },
    });
    await expect(resolveDefaultChannelId(client, 'acct-1')).resolves.toBe(
      'ch-antigo'
    );
  });
});
