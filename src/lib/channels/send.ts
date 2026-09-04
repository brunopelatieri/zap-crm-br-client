/**
 * Caminho único de saída (PRD 047 / SPEC 048 §5, fase F2).
 *
 * O que este arquivo resolve
 *
 *   Antes da F2 existiam CINCO implementações de "mandar uma mensagem":
 *   `lib/whatsapp/send-message.ts` (inbox + API pública),
 *   `lib/automations/meta-send.ts`, `lib/flows/meta-send.ts`,
 *   `lib/whatsapp/broadcast-core.ts` e, por tabela, `lib/ai/auto-reply.ts`
 *   (que envia através do motor de flows). Todas repetiam o mesmo
 *   esqueleto: resolver o contato pela conta, carregar `whatsapp_config`,
 *   decriptar o token, tentar as variantes de telefone, corrigir o
 *   telefone que funcionou, gravar em `messages` e atualizar o preview da
 *   conversa. Cinco cópias significam cinco lugares para adicionar o
 *   segundo canal — e cinco lugares para esquecer.
 *
 *   Aqui o esqueleto existe UMA vez, e a chamada ao provedor passa a ser
 *   `getAdapter(type).sendX(ctx, …)`. Nenhuma regra de negócio nova.
 *
 * Extração literal, não refatoração
 *
 *   Cada função abaixo é o código que já rodava, com os mesmos textos de
 *   erro, a mesma semântica de repetição por variante e as mesmas
 *   colunas gravadas. O que os chamadores mantêm é o que NELES difere de
 *   verdade — persistência (`sender_id`, `template_preview`,
 *   `ai_generated`), mapeamento de erro tipado, logs. Uniformizar isso
 *   seria mudança de comportamento disfarçada de limpeza.
 *
 * Onde a credencial oficial é resolvida (SPEC 064 F2)
 *
 *   Não aqui. O cabeçalho anterior dizia que este arquivo não consultava
 *   `channels` porque a 055/057 ainda não estavam em produção — elas
 *   estão, e a 072 tirou o singleton de `whatsapp_config`. Desde então o
 *   ramo Cloud delega a `lib/whatsapp/cloud-channels.ts`, que aplica o
 *   D-7 (canal explícito > padrão do tipo > erro). Aqui ficou só o que
 *   sempre foi deste arquivo: decriptar o token e montar o
 *   `ChannelContext`.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

import { decrypt } from '@/lib/whatsapp/encryption';
import { resolveCloudConfig } from '@/lib/whatsapp/cloud-channels';
import type { WhatsappConfigRow } from '@/lib/whatsapp/cloud-channels';
import { resolveInstanceByChannelId } from '@/lib/evolution/instances';
import { assertAccountNotBlocked } from '@/lib/platform/blocked';
import type { InteractiveMessagePayload } from '@/lib/whatsapp/interactive';
import {
  sanitizePhoneForMeta,
  isValidE164,
  phoneVariants,
  isRecipientNotAllowedError,
} from '@/lib/whatsapp/phone-utils';
import { can, canSendMedia } from './capabilities';
import {
  checkColdSend,
  recordColdSend,
  ColdSendLimitError,
} from './cold-send-wiring';
import { resolveDefaultChannelId } from './default-channel';
import { ChannelNotConfiguredError, ChannelCapabilityError } from './errors';
import { getAdapter } from './registry';
import {
  channelSourceFromId,
  logOutboundSend,
  type ChannelSource,
} from './send-log';
import type {
  Channel,
  ChannelAdapter,
  ChannelContext,
  ChannelType,
} from './types';

/**
 * Reexportados (SPEC 064 F2).
 *
 * As duas classes de erro e o resolvedor de canal padrão saíram deste
 * arquivo para `errors.ts` e `default-channel.ts` — `cloud-channels.ts`
 * precisa dos três e é chamado daqui, e mantê-los aqui fecharia um ciclo
 * de import. Reexportar preserva `@/lib/channels/send` como o endereço
 * de sempre: nenhum dos onze arquivos que os importam mudou, e
 * `instanceof` continua valendo porque a classe é a mesma.
 */
export {
  ChannelNotConfiguredError,
  ChannelCapabilityError,
  resolveDefaultChannelId,
};

/**
 * Canal usado por quem ainda não informa um.
 *
 * Todo chamador de hoje é do canal oficial, e continuará sendo até a
 * 057 dar um `channel_id` à conversa. O parâmetro existe agora para que
 * a F4 não precise reabrir as cinco assinaturas.
 */
export const DEFAULT_CHANNEL_TYPE: ChannelType = 'whatsapp_cloud';

// ------------------------------------------------------------
// Conteúdo de saída
// ------------------------------------------------------------

/**
 * O que se manda, independente de por onde.
 *
 * `template` carrega três campos porque os três caminhos de template do
 * CRM coexistem: `definition` (linha local — obrigatória para header de
 * mídia), `components` (valores estruturados por envio) e
 * `positionalParams` (o legado `{{1}}, {{2}}`). Suprimir qualquer um
 * quebraria um caminho em produção.
 */
export type OutboundContent =
  | { kind: 'text'; text: string }
  | {
      kind: 'media';
      mediaKind: 'image' | 'video' | 'audio' | 'document';
      /** URL que o provedor vai BUSCAR — já assinada quando é nossa. */
      link: string;
      caption?: string;
      filename?: string;
    }
  | {
      kind: 'template';
      templateName: string;
      language?: string;
      definition?: unknown;
      components?: unknown;
      positionalParams?: string[];
    }
  | { kind: 'interactive'; payload: InteractiveMessagePayload };

// ------------------------------------------------------------
// Resolução de canal e de destinatário
// ------------------------------------------------------------

/**
 * Linha de `whatsapp_config` — definida em `cloud-channels.ts`, que é
 * quem a lê desde a SPEC 064 F2. Reexportada porque `ResolvedChannel`
 * (abaixo) a usa e este arquivo é o endereço público da camada.
 */
export type { WhatsappConfigRow };

export interface ResolvedChannel {
  ctx: ChannelContext;
  /**
   * A linha crua, devolvida porque `send-message.ts` ainda precisa dela
   * para o auto-reparo de ciphertext legado (CBC → GCM). Só ele faz
   * isso; embutir o reparo aqui faria os motores passarem a escrever na
   * `whatsapp_config`, o que hoje não acontece.
   */
  configRow: WhatsappConfigRow;
  /**
   * De onde veio este canal (SPEC 065 §11) — para `logOutboundSend`.
   * `resolveChannelContext` decide pelo `channelId` que recebeu:
   * presente = `'resource'` (alguém escolheu), ausente = `'default'`
   * (caiu no padrão da conta). `resolveChannelForConversation` PISA
   * nessa decisão quando o canal veio de `conversations.channel_id` —
   * ver o comentário lá: herdar da conversa não é o recurso escolhendo.
   */
  source: ChannelSource;
}

/**
 * Credenciais do canal da conta, prontas para o adaptador.
 *
 * `db` pode ser o cliente do usuário (sujeito a RLS, caminho do painel)
 * ou o service-role (motores, API pública) — é o mesmo cliente que o
 * chamador já usava, então o alcance da consulta não muda.
 */
export async function resolveChannelContext(
  db: SupabaseClient,
  accountId: string,
  channelType: ChannelType = DEFAULT_CHANNEL_TYPE,
  /**
   * Obrigatório para `whatsapp_qr`, e **honrado também no Cloud** desde
   * a SPEC 064: uma conta pode ter vários números oficiais, e
   * `channelType` sozinho não desambigua qual. Quem chama (a wiring de
   * inbox/motores por conversa — SPEC 049) já sabe o `channels.id` da
   * thread.
   *
   * Ausente no Cloud = canal Cloud padrão da conta (D-11). Ausente no
   * QRCode continua sendo erro: lá não existe "o padrão implícito" que
   * dê para defender — todo caminho QR nasce de uma conversa.
   */
  channelId?: string
): Promise<ResolvedChannel> {
  // SPEC 062 §4.3 ponto 4 — o backstop de envio.
  //
  // Aqui passam automação, flow, envio manual do inbox, reação e
  // transferência: todo caminho de SAÍDA que resolve credencial de
  // canal. É o último ponto antes de a mensagem existir, e por isso
  // vale mesmo quando um dos pontos 1–3 falhou em pular a conta (a
  // lista de bloqueados daquelas varreduras pode degradar para vazia
  // num erro de consulta — ver `loadBlockedAccountIds`).
  //
  // ⚠️ NÃO cobre disparo em massa: `deliverBroadcast` monta o
  // `ChannelContext` direto por `cloudChannelContext()` e nunca chega
  // aqui. O funil equivalente daquele caminho é
  // `assertAccountCanBroadcast` (broadcast-core.ts), que tem a mesma
  // checagem.
  await assertAccountNotBlocked(db, accountId);

  if (channelType === 'whatsapp_qr') {
    if (!channelId) {
      throw new ChannelNotConfiguredError(
        'whatsapp_qr requires an explicit channel id — resolveChannelContext cannot pick one of several instances by type alone'
      );
    }
    const resolved = await resolveInstanceByChannelId(accountId, channelId);
    const { data: channelRow, error: channelErr } = await db
      .from('channels')
      .select('*')
      .eq('id', channelId)
      .eq('account_id', accountId)
      .maybeSingle();
    if (channelErr || !channelRow) {
      throw new ChannelNotConfiguredError();
    }
    return {
      ctx: {
        accountId,
        channel: channelRow as Channel,
        credentials: { instanceToken: resolved.token },
      },
      configRow: resolved,
      // `channelId` é obrigatório neste ramo (ver o throw acima) — QR
      // não tem "padrão implícito", então chegar até aqui já significa
      // que alguém (ou `resolveChannelForConversation`, que corrige para
      // `'conversation'` quando for o caso) escolheu.
      source: 'resource',
    };
  }

  if (channelType !== 'whatsapp_cloud') {
    throw new ChannelNotConfiguredError(
      `channel type "${channelType}" has no credential resolver`
    );
  }

  // SPEC 064 §4.2 — o ramo Cloud passa a honrar o `channelId`.
  //
  // Antes desta fase ele o IGNORAVA e caía num `.single()` sobre
  // `whatsapp_config` por `account_id`. Isso valia enquanto o índice da
  // 055 garantia um canal Cloud por conta; com dois números na mesma
  // conta o `.single()` estoura, e responder uma conversa do número B
  // pelo número A seria pior do que estourar. `resolveCloudConfig`
  // aplica o D-7 (explícito > padrão do tipo > erro) e recusa canal de
  // outra conta, de outro tipo, desativado ou sem credencial — tudo
  // ANTES do `decrypt()`.
  const { channel, config } = await resolveCloudConfig(
    db,
    accountId,
    channelId
  );

  return {
    ctx: cloudChannelContext({
      accountId,
      phoneNumberId: config.phone_number_id,
      accessToken: decrypt(config.access_token),
      channelId: channel.id,
      userId: config.user_id,
      // O telefone do canal (D-9) quando já reconciliado; senão o
      // `phone_number_id`, que é o que o backfill da 055 gravou.
      identifier: channel.identifier ?? config.phone_number_id ?? null,
      connected: channel.status === 'connected',
    }),
    configRow: config,
    // `channelId` presente = alguém escolheu (`'resource'`); ausente =
    // caiu no canal Cloud padrão da conta via D-11 (`'default'`). Mesma
    // ressalva do ramo QR acima sobre `resolveChannelForConversation`.
    source: channelSourceFromId(channelId),
  };
}

/**
 * Credenciais do canal DA CONVERSA (SPEC 048 F4.1).
 *
 * Por que isto existe
 *
 *   `conversations.channel_id` é NOT NULL desde a 059, mas até esta
 *   correção NENHUM caminho de saída o lia: `sendMessageToConversation`
 *   e `sendAndPersistOutbound` chamavam `resolveChannelContext(db,
 *   accountId)` sem tipo, o que cai no padrão `whatsapp_cloud`. Com a F4
 *   fazendo conversas QRCode aparecerem no inbox, isso significava
 *   responder uma thread do WhatsApp QRCode PELO NÚMERO OFICIAL da Meta
 *   — mensagem cobrada, saindo de outro número, fora de qualquer janela
 *   de 24h, e com o `message_id` do wamid que o eco `SEND_MESSAGE` da
 *   Evolution nunca casaria.
 *
 *   Este helper é o único ponto que traduz conversa → canal. Os guards
 *   de capacidade em `sendContentViaChannel` fazem o resto: um template
 *   ou botão pedido numa conversa QR vira `ChannelCapabilityError` com
 *   motivo legível, em vez de um 500 opaco do provedor.
 *
 * Compatibilidade
 *
 *   `channel_id` ausente (conta que nunca passou pelo backfill da 055,
 *   ou projeto onde a 059 ainda não rodou) cai no canal Cloud, que é o
 *   comportamento anterior — nada muda para quem só usa o oficial.
 */
export async function resolveChannelForConversation(
  db: SupabaseClient,
  accountId: string,
  conversationId: string
): Promise<ResolvedChannel> {
  const { data: conversation } = await db
    .from('conversations')
    .select('channel_id')
    .eq('id', conversationId)
    .eq('account_id', accountId)
    .maybeSingle();

  const channelId = conversation?.channel_id as string | undefined;
  if (!channelId) {
    return resolveChannelContext(db, accountId, DEFAULT_CHANNEL_TYPE);
  }

  // Duas queries em vez de um embed `channels!inner(type)`: a 055/059
  // são migrações novas e o cache de schema do PostgREST costuma
  // devolver `PGRST200` para um relacionamento recém-criado (mesma
  // armadilha documentada em `lib/evolution/instances.ts`).
  const { data: channel } = await db
    .from('channels')
    .select('type')
    .eq('id', channelId)
    .eq('account_id', accountId)
    .maybeSingle();

  const channelType = (channel?.type as ChannelType | undefined) ?? undefined;
  if (!channelType) {
    // Canal apagado fora do fluxo normal: melhor falhar com motivo do
    // que enviar pelo canal errado.
    throw new ChannelNotConfiguredError(
      `conversation ${conversationId} points at channel ${channelId}, which no longer exists in this account`
    );
  }

  // SPEC 065 §11 — o canal veio de `conversations.channel_id`, não de
  // uma escolha do recurso que está enviando: `resolveChannelContext`
  // devolveria `'resource'` só porque recebeu um `channelId`, mas quem
  // decidiu foi a CONVERSA (uma resposta numa thread existente), não
  // quem chamou. Sobrescrever aqui é o único jeito de o log distinguir
  // "o recurso escolheu o canal B" de "esta conversa já estava no B".
  const resolved = await resolveChannelContext(
    db,
    accountId,
    channelType,
    channelId
  );
  return { ...resolved, source: 'conversation' };
}

/**
 * `ChannelContext` do canal oficial a partir de credenciais JÁ
 * resolvidas.
 *
 * Existe para o disparo em massa, que carrega `phone_number_id` + token
 * no próprio plano (`BroadcastPlan`) desde antes desta camada e os
 * reaproveita por milhares de destinatários — reabrir a `whatsapp_config`
 * por envio seria uma regressão de desempenho, não uma unificação.
 *
 * O `Channel` devolvido é SINTÉTICO: a tabela `channels` ainda não está
 * em produção (ver o cabeçalho). Nenhum campo além de `id` e `type` é
 * lido pelo adaptador Cloud.
 */
export function cloudChannelContext(input: {
  accountId: string;
  phoneNumberId: string;
  accessToken: string;
  channelId?: string;
  userId?: string;
  identifier?: string | null;
  connected?: boolean;
}): ChannelContext {
  const now = new Date(0).toISOString();
  const channel: Channel = {
    id: input.channelId ?? `cloud:${input.accountId}`,
    account_id: input.accountId,
    user_id: input.userId ?? '',
    type: 'whatsapp_cloud',
    name: 'WhatsApp Oficial',
    identifier: input.identifier ?? null,
    status: input.connected ? 'connected' : 'disconnected',
    status_detail: null,
    is_default: true,
    connected_at: null,
    last_seen_at: null,
    created_at: now,
    updated_at: now,
  };

  return {
    accountId: input.accountId,
    channel,
    credentials: {
      phoneNumberId: input.phoneNumberId,
      accessToken: input.accessToken,
    },
  };
}

export interface OutboundContact {
  id: string;
  /** Telefone como está gravado no contato. */
  phone: string;
  /** Telefone pronto para o provedor. */
  sanitizedPhone: string;
}

/**
 * Contato destinatário, com escopo de CONTA.
 *
 * O filtro por `account_id` é defesa em profundidade e não decoração: os
 * motores usam service-role (RLS desligada), e sem ele um usuário
 * autenticado dispararia as próprias automações contra o UUID de contato
 * de outro inquilino, mandando mensagem pelo número dele. As migrações
 * 017 moveram as duas tabelas para tenancy por conta.
 */
export async function resolveOutboundContact(
  db: SupabaseClient,
  accountId: string,
  contactId: string
): Promise<OutboundContact> {
  const { data: contact, error } = await db
    .from('contacts')
    .select('id, phone')
    .eq('id', contactId)
    .eq('account_id', accountId)
    .maybeSingle();
  if (error || !contact?.phone) {
    throw new Error('contact not found for this account');
  }

  const sanitized = sanitizePhoneForMeta(contact.phone);
  if (!isValidE164(sanitized)) {
    throw new Error(`contact phone invalid: ${contact.phone}`);
  }

  return { id: contact.id, phone: contact.phone, sanitizedPhone: sanitized };
}

// ------------------------------------------------------------
// Envio
// ------------------------------------------------------------

/**
 * Uma tentativa de entrega, pelo adaptador do canal.
 *
 * A capacidade é conferida ANTES da chamada para que a recusa tenha
 * motivo legível — em vez de um `undefined is not a function` vindo de um
 * método opcional que aquele canal não implementa (é o contrato descrito
 * em `types.ts`). No canal Cloud toda checagem passa, então o caminho
 * oficial não muda.
 */
export async function sendContentViaChannel(
  ctx: ChannelContext,
  params: {
    to: string;
    content: OutboundContent;
    quotedProviderMessageId?: string | null;
  }
): Promise<string> {
  const type = ctx.channel.type;
  const adapter = getAdapter(type);
  const { to, content, quotedProviderMessageId } = params;

  switch (content.kind) {
    case 'text': {
      requireCapability(type, can(type, 'text'), 'plain text');
      const r = await adapter.sendText(ctx, {
        to,
        text: content.text,
        quotedProviderMessageId,
      });
      return r.providerMessageId;
    }

    case 'media': {
      requireCapability(
        type,
        canSendMedia(type, content.mediaKind),
        `${content.mediaKind} media`
      );
      const r = await adapter.sendMedia(ctx, {
        to,
        kind: content.mediaKind,
        url: content.link,
        caption: content.caption,
        filename: content.filename,
        quotedProviderMessageId,
      });
      return r.providerMessageId;
    }

    case 'template': {
      requireCapability(type, can(type, 'templates'), 'message templates');
      const sendTemplate = requireMethod(adapter, 'sendTemplate', type);
      const r = await sendTemplate(ctx, {
        to,
        templateName: content.templateName,
        language: content.language,
        definition: content.definition,
        components: content.components,
        positionalParams: content.positionalParams,
        quotedProviderMessageId,
      });
      return r.providerMessageId;
    }

    case 'interactive': {
      const capability =
        content.payload.kind === 'buttons'
          ? 'interactiveButtons'
          : 'interactiveList';
      requireCapability(
        type,
        can(type, capability),
        content.payload.kind === 'buttons'
          ? 'interactive buttons'
          : 'interactive lists'
      );
      const sendInteractive = requireMethod(adapter, 'sendInteractive', type);
      const r = await sendInteractive(ctx, {
        to,
        payload: content.payload,
        quotedProviderMessageId,
      });
      return r.providerMessageId;
    }
  }
}

function requireCapability(
  type: ChannelType,
  supported: boolean,
  what: string
): void {
  if (!supported) {
    throw new ChannelCapabilityError(
      `channel type "${type}" does not support ${what}`
    );
  }
}

/**
 * Segunda metade do guard: a matriz de capacidades e o adaptador são
 * DUAS declarações independentes, e o TypeScript não amarra uma à outra
 * — `sendTemplate` e `sendInteractive` são opcionais na interface.
 *
 * Um canal que declare `templates: true` em `capabilities.ts` e esqueça
 * o método passaria pelo `requireCapability` e estouraria
 * `adapter.sendTemplate is not a function` lá dentro do laço de
 * variantes — que `send-message.ts` traduz para o usuário como
 * "Meta API error: …" com HTTP 502. Exatamente o erro opaco que o
 * cabeçalho de `sendContentViaChannel` promete evitar.
 *
 * O `bind` preserva o `this` do adaptador: o do canal Cloud é um objeto
 * literal que não usa `this`, mas não é obrigação do chamador saber
 * disso a respeito de todo adaptador futuro.
 */
function requireMethod<K extends 'sendTemplate' | 'sendInteractive'>(
  adapter: ChannelAdapter,
  name: K,
  type: ChannelType
): NonNullable<ChannelAdapter[K]> {
  const method = adapter[name];
  if (typeof method !== 'function') {
    throw new ChannelCapabilityError(
      `channel type "${type}" declares the capability but its adapter has no ${name}() — capabilities.ts and the adapter disagree`
    );
  }
  return method.bind(adapter) as NonNullable<ChannelAdapter[K]>;
}

export interface VariantSendResult {
  providerMessageId: string;
  /** A variante que a Meta aceitou — pode diferir da sanitizada. */
  workingPhone: string;
}

/**
 * Envia tentando as variantes do telefone.
 *
 * Números brasileiros registrados com e sem o 9, e o sandbox da Meta,
 * exigem isso para a mensagem cair de forma confiável. A semântica é a
 * dos três caminhos originais e não pode afrouxar: só "destinatário fora
 * da lista permitida" justifica tentar a próxima variante; qualquer
 * outro erro sobe na hora, porque insistir com telefones diferentes
 * diante de, por exemplo, um token inválido só multiplica a falha.
 *
 * O disparo em massa NÃO usa esta função: lá cada destinatário é
 * best-effort e a falha vira uma linha marcada, não uma exceção.
 */
export async function sendWithPhoneVariants(input: {
  ctx: ChannelContext;
  sanitizedPhone: string;
  content: OutboundContent;
  quotedProviderMessageId?: string | null;
  /** Chamado quando uma variante é recusada e ainda há outra a tentar. */
  onVariantRejected?: (variant: string) => void;
}): Promise<VariantSendResult> {
  const variants = phoneVariants(input.sanitizedPhone);
  let workingPhone = input.sanitizedPhone;
  let providerMessageId = '';
  let lastError: unknown = null;

  for (const variant of variants) {
    try {
      providerMessageId = await sendContentViaChannel(input.ctx, {
        to: variant,
        content: input.content,
        quotedProviderMessageId: input.quotedProviderMessageId,
      });
      workingPhone = variant;
      lastError = null;
      break;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!isRecipientNotAllowedError(message)) throw err;
      lastError = err;
      input.onVariantRejected?.(variant);
    }
  }
  if (lastError) throw lastError;

  return { providerMessageId, workingPhone };
}

// ------------------------------------------------------------
// Envio + persistência (motores)
// ------------------------------------------------------------

/**
 * As colunas que cada motor grava de seu jeito.
 *
 * `extra` existe porque as três variantes divergem exatamente aqui —
 * `ai_generated` no auto-reply, `interactive_payload` nos menus,
 * `template_name` + `template_preview` nos templates — e forçar um
 * formato comum mudaria o que vai para o banco em pelo menos um deles.
 */
export interface OutboundPersistSpec {
  /** `bot` em todos os motores; `agent` é envio humano e não passa aqui. */
  senderType: 'bot';
  contentType: string;
  contentText: string | null;
  /** `conversations.last_message_text` — o preview da lista. */
  previewText: string;
  extra?: Record<string, unknown>;
}

/**
 * O caminho completo dos motores (automações, flows, IA): resolve o
 * contato, resolve o canal, envia com repetição por variante, corrige o
 * telefone que funcionou, grava a mensagem e atualiza o preview.
 *
 * Devolve `whatsapp_message_id` — nome mantido porque é o que os
 * chamadores e os testes deles já leem.
 */
export async function sendAndPersistOutbound(input: {
  db: SupabaseClient;
  accountId: string;
  /** Log estruturado (SPEC 064 §11.1) — qual motor disparou este envio. */
  origin: 'automation' | 'flow' | 'ai';
  /**
   * Envia por um canal EXPLÍCITO, ignorando o da conversa.
   *
   * Único chamador legítimo (SPEC 049 §6.1 ponto 1): o desvio por canal
   * das automações (`sendViaFallbackChannel`) — o caso em que sair pelo
   * canal da conversa seria justamente o errado, porque é a janela DELE
   * que fechou. Todo o resto tem de continuar respondendo pelo canal da
   * thread.
   *
   * `type` e `id` viajam JUNTOS por obrigação: `resolveChannelContext`
   * recusa `whatsapp_qr` sem id, já que uma conta pode ter várias
   * instâncias e o tipo sozinho não desambigua (ver L169). Um campo só,
   * em vez de dois soltos, é o que impede a combinação sem sentido
   * "id sem tipo".
   */
  channel?: { type: ChannelType; id?: string };
  conversationId: string;
  contactId: string;
  content: OutboundContent;
  persist: OutboundPersistSpec;
}): Promise<{ whatsapp_message_id: string }> {
  const { db, accountId, conversationId, contactId, content, persist } = input;

  const contact = await resolveOutboundContact(db, accountId, contactId);
  // O canal vem da CONVERSA, não do padrão da conta (F4.1): uma
  // automação disparada por uma mensagem que entrou pelo QRCode tem de
  // responder pelo QRCode. Ver `resolveChannelForConversation`.
  //
  // `channelSource` (SPEC 065 §11): `input.channel` explícito É sempre
  // `'resource'` — é o desvio por canal escolhendo deliberadamente
  // ignorar o da conversa (ver o comentário do campo `channel` acima) —
  // em vez de confiar no que `resolveChannelContext` inferiria sozinho
  // da presença de `id`.
  const { ctx, source: resolvedSource } = input.channel
    ? await resolveChannelContext(
        db,
        accountId,
        input.channel.type,
        input.channel.id
      )
    : await resolveChannelForConversation(db, accountId, conversationId);
  const channelSource: ChannelSource = input.channel
    ? 'resource'
    : resolvedSource;

  // Teto de envio frio (SPEC 049 §6.2, D-1): só em canal sem janela da
  // Meta — ela já regula o resto. `sendAndPersistOutbound` é o único
  // caminho dos motores (automações, flows, IA), então bloquear aqui
  // cobre os três de uma vez. Negar é SKIP, não falha (PRD §10.3): quem
  // chama (o executor de passo/nó) precisa distinguir `ColdSendLimitError`
  // de qualquer outro erro e tratar como adiamento.
  let coldSend: Awaited<ReturnType<typeof checkColdSend>> | null = null;
  if (!can(ctx.channel.type, 'sessionWindow24h')) {
    const { data: conv } = await db
      .from('conversations')
      .select('last_customer_message_at')
      .eq('id', conversationId)
      .maybeSingle();
    coldSend = await checkColdSend(db, {
      channelId: ctx.channel.id,
      channelType: ctx.channel.type,
      accountId,
      lastInboundAt: conv?.last_customer_message_at
        ? new Date(conv.last_customer_message_at)
        : null,
    });
    if (coldSend.decision && !coldSend.decision.allowed) {
      throw new ColdSendLimitError(coldSend.decision);
    }
  }

  const { providerMessageId, workingPhone } = await sendWithPhoneVariants({
    ctx,
    sanitizedPhone: contact.sanitizedPhone,
    content,
  });

  logOutboundSend({
    accountId,
    conversationId,
    channelId: ctx.channel.id,
    channelType: ctx.channel.type,
    phoneNumberId: ctx.credentials.phoneNumberId ?? null,
    origin: input.origin,
    channelSource,
  });

  if (workingPhone !== contact.sanitizedPhone) {
    await db
      .from('contacts')
      .update({ phone: workingPhone })
      .eq('id', contact.id);
  }

  const { error: msgErr } = await db.from('messages').insert({
    conversation_id: conversationId,
    sender_type: persist.senderType,
    content_type: persist.contentType,
    content_text: persist.contentText,
    ...(persist.extra ?? {}),
    message_id: providerMessageId,
    status: 'sent',
    // Selo do canal de desvio (SPEC 049 §6.1 ponto 2, migração 063): só
    // gravado quando o CANAL é explícito — o único caso em que ele
    // diverge do `conversations.channel_id` da própria thread. Nos
    // demais envios a coluna fica NULL, que é o estado "sem selo".
    ...(input.channel ? { channel_id: ctx.channel.id } : {}),
  });
  if (msgErr) {
    // O provedor JÁ tem a mensagem; não se pode fingir que o envio
    // falhou. O motor embrulha isto numa linha de log.
    throw new Error(`sent to Meta but DB insert failed: ${msgErr.message}`);
  }

  await db
    .from('conversations')
    .update({
      last_message_text: persist.previewText,
      last_message_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', conversationId);

  // Gravado DEPOIS da entrega confirmada (§6.1 ponto 4) — contar antes
  // faria uma falha de rede consumir cota que nunca saiu. `recordColdSend`
  // já escala pra supabaseAdmin() internamente (062: só service_role
  // escreve em channel_cold_sends) e nunca lança — best-effort de verdade.
  if (coldSend?.cold) {
    await recordColdSend({
      channelId: ctx.channel.id,
      accountId,
      contactId: contact.id,
      origin: 'engine',
    });
  }

  return { whatsapp_message_id: providerMessageId };
}
