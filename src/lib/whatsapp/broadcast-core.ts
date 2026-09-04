// ============================================================
// Public-API broadcast core.
//
// Splits a broadcast into two phases so the HTTP route can persist +
// acknowledge fast and fan out afterwards (in `after()`):
//
//   createBroadcast()  — validate, resolve contacts, insert the
//                        `broadcasts` row + `broadcast_recipients`
//                        rows (status 'pending'), return a plan.
//   deliverBroadcast() — send each recipient's template via Meta
//                        (phone-variant retry), stamp each recipient
//                        row + the aggregate counts, finalize status.
//
// Recipient rows carry `whatsapp_message_id`, so the inbound webhook's
// status handler (which matches on that column) updates delivered/read
// for API broadcasts exactly as it does for dashboard ones.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import {
  cloudChannelContext,
  sendContentViaChannel,
} from '@/lib/channels/send';
import { loadAccountChannelTypes } from '@/lib/channels/account-channel-types';
import { accountCapabilityCoverage } from '@/lib/channels/capabilities';
import { ChannelNotConfiguredError } from '@/lib/channels/errors';
import { isAccountBlocked } from '@/lib/platform/blocked';
import { decrypt } from '@/lib/whatsapp/encryption';
import { resolveCloudConfig } from '@/lib/whatsapp/cloud-channels';
import {
  channelSourceFromId,
  logOutboundSend,
  type NonConversationChannelSource,
} from '@/lib/channels/send-log';
import {
  assertTemplateChannelCompatible,
  findTemplateRowForWaba,
  TemplateChannelMismatchError,
  type ChannelWabaId,
} from '@/lib/whatsapp/template-waba';
import {
  sanitizePhoneForMeta,
  isValidE164,
  phoneVariants,
  isRecipientNotAllowedError,
} from '@/lib/whatsapp/phone-utils';
import { isMessageTemplate } from '@/lib/whatsapp/template-row-guard';
import { createHeaderMediaResolver } from '@/lib/whatsapp/header-media';
import type { MessageTemplate } from '@/types';
import { findOrCreateContact } from '@/lib/api/v1/contacts';
import { detectDeadNumberOnFailure } from '@/lib/contacts/whatsapp-status';

/**
 * `resolveCloudConfig` fala a língua da camada de canais
 * (`ChannelNotConfiguredError`); o disparo fala `BroadcastError`. Esta
 * função é o único ponto de tradução, usada tanto na criação quanto no
 * replanejamento do cron — sem ela, as duas cópias divergiriam no dia em
 * que alguém ajustasse só uma (SPEC 064 D-3, canal desativado depois do
 * agendamento).
 */
export function toBroadcastChannelError(
  e: ChannelNotConfiguredError
): BroadcastError {
  if (e.reason === 'no_channel') {
    return new BroadcastError(
      'whatsapp_not_configured',
      'WhatsApp not configured. Please set up your WhatsApp integration first.',
      400
    );
  }
  // `read_failed` NÃO é "canal indisponível" — é a consulta que falhou,
  // não o canal que sumiu (ver o comentário de `ChannelNotConfiguredReason`
  // em `channels/errors.ts`). Misturar os dois manda o operador tentar
  // reconectar um número que nunca teve problema nenhum, escondendo o
  // soluço de infraestrutura de verdade atrás de um 409 acionável.
  if (e.reason === 'read_failed') {
    return new BroadcastError(
      'internal',
      'Failed to resolve the WhatsApp channel — this looks like a transient error, try again.',
      500
    );
  }
  // Canal explícito que sumiu, foi desativado, ou trocou de conta desde
  // a criação/agendamento — nunca cai de volta no padrão sozinho (§9
  // armadilha 1: isso seria "enviar pelo número errado" disfarçado de
  // resiliência).
  return new BroadcastError(
    'channel_unavailable',
    'The WhatsApp number this broadcast uses is not available right now (disconnected or removed) — reconnect it or choose another number.',
    409
  );
}

/** Thrown by createBroadcast on a caller-visible failure; route maps it. */
export class BroadcastError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = 'BroadcastError';
    this.code = code;
    this.status = status;
  }
}

/**
 * A guarda do D-3 (SPEC 065), na forma de erro que o disparo já fala.
 *
 * Os três caminhos de campanha — planejamento (`broadcast-core`),
 * disparo (`broadcast-dispatch`, inclusive o agendado que o cron
 * acorda) e teste de envio (`broadcast-test-send`) — precisam da mesma
 * recusa com o mesmo código. Filtrar a lista de templates na tela
 * resolve só o caminho feliz: o rascunho de três dias atrás, a chamada
 * de API e a campanha agendada cujo template foi recriado em outro WABA
 * passam por aqui, e não pela tela.
 *
 * Converte para `BroadcastError` porque é o que as rotas de campanha já
 * mapeiam para HTTP — o código (`template_waba_mismatch`) e o status
 * (400) são os mesmos, então a UI vê um código estável venha de onde
 * vier.
 */
export async function assertBroadcastTemplateChannel(
  db: SupabaseClient,
  params: {
    accountId: string;
    channelId: string | null | undefined;
    templateName: string;
    templateLanguage: string;
    /** Já resolvido pelo chamador — ver o mesmo campo em `assertTemplateChannelCompatible`. */
    channelWabaId?: ChannelWabaId;
  }
): Promise<void> {
  try {
    await assertTemplateChannelCompatible(db, params);
  } catch (e) {
    if (e instanceof TemplateChannelMismatchError) {
      throw new BroadcastError(e.code, e.message, e.status);
    }
    throw e;
  }
}

export interface BroadcastRecipientInput {
  /** E.164 phone. */
  to: string;
  /** Positional body params for the template ({{1}}, {{2}}…). */
  params?: string[];
}

export interface CreateBroadcastParams {
  name?: string | null;
  templateName: string;
  templateLanguage?: string | null;
  recipients: BroadcastRecipientInput[];
  /**
   * Número oficial que envia esta campanha (SPEC 064 D-3). Ausente =
   * canal Cloud padrão, resolvido e GRAVADO agora — nunca recalculado no
   * disparo, para que trocar o padrão da conta não desvie uma campanha
   * já criada.
   */
  channelId?: string | null;
}

interface PlannedRecipient {
  recipientRowId: string;
  /** Dono da linha — precisa acompanhar a falha para a §6.4 poder agir. */
  contactId: string;
  phone: string;
  params: string[];
}

export interface BroadcastPlan {
  broadcastId: string;
  /**
   * Tenancy. Adicionado na F2 (PRD 047): o `ChannelContext` que o
   * adaptador consome é sempre carimbado com a conta dona do envio, e o
   * plano é o único lugar de `deliverBroadcast` que sabe qual é.
   */
  accountId: string;
  /** Canal que efetivamente envia (SPEC 064 D-3) — gravado em `broadcasts.channel_id`. */
  channelId: string;
  /**
   * De onde veio `channelId` (SPEC 065 §11) — `'resource'` quando
   * `params.channelId` veio explícito no corpo, `'default'` quando caiu
   * no canal Cloud padrão da conta. Uma campanha nunca é `'conversation'`:
   * não há conversa a herdar, é sempre disparo em massa.
   */
  channelSource: NonConversationChannelSource;
  templateName: string;
  templateLanguage: string;
  phoneNumberId: string;
  accessToken: string;
  templateRow: MessageTemplate | null;
  planned: PlannedRecipient[];
  /** Phones rejected up front (invalid E.164) — counted as failed. */
  rejected: number;
}

/**
 * Teto de destinatários POR REQUISIÇÃO da API pública.
 *
 * É um contrato documentado de `/api/v1/broadcasts`, não um limite do
 * motor: quem chama a API divide audiências maiores em requisições. O
 * disparo do painel não passa por `createBroadcast` — ele resolve os
 * contatos por conta própria (SPEC 044 §6.1) e tem o próprio teto, que
 * é a cota de 24 h da Meta.
 */
const MAX_RECIPIENTS = 1000;

/**
 * SPEC 049 §5.3 — a broadcast is Cloud-by-construction (§1.9): only
 * `whatsapp_cloud` declares `capabilities.broadcast`, on purpose — a
 * QR code instance blasting hundreds of messages is the fastest path to
 * a ban. Every entry point that can start a send (the public API, the
 * dashboard wizard, its scheduler) calls this FIRST, so an account whose
 * only channel is QR gets the real reason instead of "WhatsApp not
 * configured" (which reads as "nothing is set up", not "what you set up
 * doesn't support this").
 *
 * `'some'` and `'all'` both pass silently: a mixed account still resolves
 * to the Cloud channel via `whatsapp_config` below, unchanged from
 * today. Only `'none'` — no channel in the account can ever broadcast —
 * throws here, before the generic config lookup gets a chance to.
 */
export async function assertAccountCanBroadcast(
  db: SupabaseClient,
  accountId: string
): Promise<void> {
  // SPEC 062 §4.3 ponto 4, ramo do disparo em massa.
  //
  // Esta é a única checagem de bloqueio no caminho de campanha:
  // `deliverBroadcast` monta o `ChannelContext` por
  // `cloudChannelContext()` e NÃO passa por `resolveChannelContext`, de
  // modo que o backstop de `channels/send.ts` não alcança daqui.
  // Todo ponto de partida de campanha — API pública, assistente do
  // painel, agendador, `ingest/send.ts` — chama esta função (direta ou
  // via `loadWhatsappConfig`), então é aqui que a campanha de uma conta
  // bloqueada morre, ANTES de a linha em `broadcasts` ser criada.
  if (await isAccountBlocked(db, accountId)) {
    throw new BroadcastError(
      'account_blocked',
      'This account is blocked and cannot send broadcasts.',
      403
    );
  }

  const types = await loadAccountChannelTypes(db, accountId);
  if (accountCapabilityCoverage(types, 'broadcast') === 'none') {
    throw new BroadcastError(
      'channel_not_capable',
      'Bulk broadcast is only available on WhatsApp Oficial — QR code instances cannot send campaigns. This is the rule that most protects the number from being banned.',
      400
    );
  }
}

/**
 * Validate + persist a broadcast, resolving each recipient to a
 * contact. Returns a plan for {@link deliverBroadcast}. Throws
 * {@link BroadcastError} on bad input / missing config / a malformed
 * template / a DB failure — nothing is sent in this phase.
 */
export async function createBroadcast(
  db: SupabaseClient,
  accountId: string,
  auditUserId: string,
  params: CreateBroadcastParams
): Promise<BroadcastPlan> {
  const { name, templateName, recipients } = params;
  const templateLanguage = params.templateLanguage || 'en_US';

  if (!templateName) {
    throw new BroadcastError('bad_request', "'template_name' is required", 400);
  }
  if (!Array.isArray(recipients) || recipients.length === 0) {
    throw new BroadcastError(
      'bad_request',
      "'recipients' must be a non-empty array of { to, params? }",
      400
    );
  }
  if (recipients.length > MAX_RECIPIENTS) {
    throw new BroadcastError(
      'bad_request',
      `A broadcast is capped at ${MAX_RECIPIENTS} recipients per request; split larger sends`,
      400
    );
  }

  await assertAccountCanBroadcast(db, accountId);

  // Canal (SPEC 064 D-3): explícito no corpo, senão o Cloud padrão —
  // resolvido AGORA e gravado abaixo, nunca recalculado no fan-out. Meta
  // send needs phone_number_id + decrypted token.
  let channel: Awaited<ReturnType<typeof resolveCloudConfig>>['channel'];
  let config: Awaited<ReturnType<typeof resolveCloudConfig>>['config'];
  try {
    ({ channel, config } = await resolveCloudConfig(
      db,
      accountId,
      params.channelId ?? null
    ));
  } catch (e) {
    if (e instanceof ChannelNotConfiguredError)
      throw toBroadcastChannelError(e);
    throw e;
  }
  const accessToken = decrypt(config.access_token);

  // SPEC 065 D-3 — antes de planejar qualquer destinatário. O canal já
  // está resolvido acima, então esta é a última chance de recusar em
  // NOSSO idioma o par que a Meta devolveria como
  // `(#132001) Template name does not exist in the translation`, uma
  // mensagem por destinatário.
  await assertBroadcastTemplateChannel(db, {
    accountId,
    channelId: channel.id,
    templateName,
    templateLanguage,
    // `resolveCloudConfig` já devolveu o WABA acima (achado de code
    // review) — evita reconsultar `whatsapp_config`.
    channelWabaId: config.waba_id ?? null,
  });

  // Template row (once) for header/button components; guard a
  // malformed local row rather than N identical opaque failures. Scoped
  // to the WABA of the resolved channel (SPEC 064 D-2/F5): the same
  // name+language legitimately exists once per WABA, so a plain
  // `.maybeSingle()` throws the moment a second WABA gets a same-named
  // template.
  const rawTemplateRow = await findTemplateRowForWaba(db, {
    accountId,
    name: templateName,
    language: templateLanguage,
    wabaId: config.waba_id ?? null,
  });
  if (rawTemplateRow && !isMessageTemplate(rawTemplateRow)) {
    throw new BroadcastError(
      'template_malformed',
      'Template row is malformed locally — run "Sync from Meta" in Settings to repair it before broadcasting.',
      500
    );
  }
  const templateRow = (rawTemplateRow as MessageTemplate | null) ?? null;

  // Resolve each recipient to a contact. Invalid phones are dropped
  // (counted as rejected) rather than aborting the whole broadcast.
  const resolved: { contactId: string; phone: string; params: string[] }[] = [];
  let rejected = 0;
  for (const r of recipients) {
    const sanitized = sanitizePhoneForMeta(
      typeof r.to === 'string' ? r.to : ''
    );
    if (!isValidE164(sanitized)) {
      rejected++;
      continue;
    }
    const { id } = await findOrCreateContact(db, accountId, auditUserId, {
      phone: sanitized,
    });
    resolved.push({
      contactId: id,
      phone: sanitized,
      params: Array.isArray(r.params)
        ? r.params.filter((p): p is string => typeof p === 'string')
        : [],
    });
  }

  // Collapse recipients that resolved to the SAME contact (the caller
  // listed a phone twice, or two numbers fuzzy-matched to one contact).
  // Keep the first occurrence so the contact is messaged once and its
  // params aren't silently overwritten by a later duplicate — and so
  // the row↔params pairing below (keyed by contact_id) is unambiguous.
  const seenContact = new Set<string>();
  const deduped = resolved.filter((r) => {
    if (seenContact.has(r.contactId)) return false;
    seenContact.add(r.contactId);
    return true;
  });

  if (deduped.length === 0) {
    throw new BroadcastError(
      'bad_request',
      'No recipients had a valid E.164 phone number',
      400
    );
  }

  // Persist the broadcast + its recipients. The count columns
  // (sent/delivered/read/replied/failed) are owned by the DB aggregate
  // trigger (migrations 003/005) and derived purely from
  // broadcast_recipients rows — we deliberately do NOT seed them here
  // (a manual value would be clobbered by the trigger on the first
  // recipient change). `rejected` phones have no recipient row, so they
  // are reported to the caller in the POST response, not in these
  // persisted counts.
  const { data: broadcast, error: bErr } = await db
    .from('broadcasts')
    .insert({
      account_id: accountId,
      user_id: auditUserId,
      name: name || `API broadcast (${templateName})`,
      template_name: templateName,
      template_language: templateLanguage,
      // SPEC 064 D-3: gravado NA CRIAÇÃO, inclusive para a API pública
      // sem `channel_id` explícito (que grava o padrão resolvido acima).
      channel_id: channel.id,
      // SPEC 065 §11 — mesma coluna que o agendamento (migração 076)
      // grava, aqui calculada a partir do parâmetro ORIGINAL do pedido
      // (`params.channelId`), não do `channel.id` já resolvido.
      channel_source: channelSourceFromId(params.channelId),
      status: 'sending',
      total_recipients: deduped.length,
    })
    .select('id')
    .single();
  if (bErr || !broadcast) {
    console.error('[broadcast-core] create broadcast error:', bErr);
    throw new BroadcastError('internal', 'Failed to create broadcast', 500);
  }

  const { data: recipientRows, error: rErr } = await db
    .from('broadcast_recipients')
    .insert(
      deduped.map((r) => ({
        broadcast_id: broadcast.id,
        contact_id: r.contactId,
        status: 'pending' as const,
      }))
    )
    .select('id, contact_id');
  if (rErr || !recipientRows) {
    console.error('[broadcast-core] create recipients error:', rErr);
    throw new BroadcastError('internal', 'Failed to create broadcast', 500);
  }

  // Pair each inserted recipient row back to its phone/params by
  // contact_id — unambiguous now that duplicates are collapsed.
  const byContact = new Map(deduped.map((r) => [r.contactId, r]));
  const planned: PlannedRecipient[] = recipientRows.map((row) => {
    const r = byContact.get(row.contact_id as string)!;
    return {
      recipientRowId: row.id as string,
      contactId: r.contactId,
      phone: r.phone,
      params: r.params,
    };
  });

  return {
    broadcastId: broadcast.id,
    accountId,
    channelId: channel.id,
    channelSource: channelSourceFromId(params.channelId),
    templateName,
    templateLanguage,
    phoneNumberId: config.phone_number_id,
    accessToken,
    templateRow,
    planned,
    rejected,
  };
}

export interface DeliverOptions {
  /**
   * Pausa `delayMs` a cada `batchSize` envios, para o disparo ficar
   * abaixo do limite de taxa por número da Meta.
   *
   * Omitido = sem pausa, que é o comportamento histórico da API
   * pública: ela já é limitada a {@link MAX_RECIPIENTS} por requisição
   * e roda dentro do `maxDuration` da rota, então uma pausa a cada
   * lote só aproximaria o corte por timeout. O disparo do painel
   * (SPEC 044 §6.1) não tem esse teto e passa a pausa explicitamente.
   */
  batchSize?: number;
  delayMs?: number;
  /**
   * Escrever o status TERMINAL (`sent`/`failed`) na campanha ao fim do
   * fan-out. Padrão `true` — é o comportamento de sempre.
   *
   * `false` no disparo PARCIAL (SPEC 069 R6): ali esta função entrega
   * UMA FATIA de uma campanha que vai receber outras depois, e carimbar
   * `sent` no fim da primeira fatia encerraria a campanha com a maior
   * parte da audiência nunca checada e nunca enviada — em silêncio, que
   * é exatamente como o R6 pode dar errado (§4.10). Quem decide o
   * status naquele caminho é `decidePartialSend`, que é quem sabe se
   * ainda falta alguém na fila de checagem.
   */
  finalizeStatus?: boolean;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Fan out a {@link BroadcastPlan}: send each recipient's template
 * (phone-variant retry) and stamp its `broadcast_recipients` row.
 * Best-effort per recipient — one failure never aborts the rest.
 * Designed to run inside `after()`.
 *
 * The per-status count columns on `broadcasts` are owned by the DB
 * aggregate trigger (migrations 003/005): each recipient-row update
 * below advances them automatically, and later Meta delivery/read
 * webhooks keep advancing them. We therefore never write those columns
 * here — only the terminal `status` — otherwise a manual value would
 * race and clobber the trigger-maintained counts.
 */
export async function deliverBroadcast(
  db: SupabaseClient,
  plan: BroadcastPlan,
  options: DeliverOptions = {}
): Promise<void> {
  let sentCount = 0;
  const { batchSize = 0, delayMs = 0, finalizeStatus = true } = options;
  const paced = batchSize > 0 && delayMs > 0;
  let sinceLastPause = 0;

  // Header de mídia: o bucket virou privado na migração 040, então a URL
  // do template precisa ser assinada. Um broadcast longo ultrapassaria a
  // validade de uma assinatura única, então o resolvedor reassina
  // sozinho antes de vencer — ver `header-media.ts`.
  const resolveHeaderParams = createHeaderMediaResolver(db, plan.templateRow);

  // Contexto do canal montado UMA vez, a partir das credenciais que o
  // plano já carrega desde antes da camada de canais (PRD 047 / SPEC 048
  // §5). Reabrir a `whatsapp_config` por destinatário seria regressão de
  // desempenho num fan-out de milhares — ver `cloudChannelContext`.
  //
  // O laço abaixo NÃO usa `sendWithPhoneVariants`: aqui cada
  // destinatário é best-effort e uma falha vira linha marcada como
  // `failed`, nunca exceção que aborte o resto da audiência.
  const channelCtx = cloudChannelContext({
    accountId: plan.accountId,
    phoneNumberId: plan.phoneNumberId,
    accessToken: plan.accessToken,
    channelId: plan.channelId,
  });

  // SPEC 064 §11.1 — UMA vez por campanha, não por destinatário: todo
  // campo logado (canal, telefone, origem) é o mesmo em toda a
  // audiência, e repeti-lo a cada envio só infla o volume de log num
  // fan-out de milhares sem acrescentar informação nenhuma. Sem
  // `conversationId`: um destinatário de disparo em massa é resolvido
  // por `contact_id`, não por conversa.
  logOutboundSend({
    accountId: plan.accountId,
    conversationId: null,
    channelId: plan.channelId,
    channelType: 'whatsapp_cloud',
    phoneNumberId: plan.phoneNumberId,
    origin: 'broadcast',
    channelSource: plan.channelSource,
  });

  for (const recipient of plan.planned) {
    const messageParams = await resolveHeaderParams();

    const variants = phoneVariants(recipient.phone);
    let sentMessageId: string | null = null;
    let lastError: string | null = null;

    for (const variant of variants) {
      try {
        sentMessageId = await sendContentViaChannel(channelCtx, {
          to: variant,
          content: {
            kind: 'template',
            templateName: plan.templateName,
            language: plan.templateLanguage,
            definition: plan.templateRow ?? undefined,
            components: messageParams,
            positionalParams: recipient.params,
          },
        });
        lastError = null;
        break;
      } catch (error) {
        const message =
          error instanceof Error ? error.message : 'Unknown error';
        lastError = message;
        // Only a "recipient not allowed" error is worth another variant.
        if (!isRecipientNotAllowedError(message)) break;
      }
    }

    if (sentMessageId) {
      sentCount++;
      await db
        .from('broadcast_recipients')
        .update({
          status: 'sent',
          sent_at: new Date().toISOString(),
          whatsapp_message_id: sentMessageId,
          error_message: null,
        })
        .eq('id', recipient.recipientRowId);
    } else {
      const errorMessage = lastError || 'Unknown error';
      await db
        .from('broadcast_recipients')
        .update({
          status: 'failed',
          error_message: errorMessage,
        })
        .eq('id', recipient.recipientRowId);

      // Auto-limpeza de números mortos (§6.4) — best-effort, nunca
      // aborta o fan-out do resto da audiência.
      await detectDeadNumberOnFailure(db, {
        contactId: recipient.contactId,
        errorMessage,
      });
    }

    if (paced) {
      sinceLastPause++;
      if (sinceLastPause >= batchSize) {
        sinceLastPause = 0;
        await sleep(delayMs);
      }
    }
  }

  // Terminal status only — counts are trigger-owned (see the note
  // above). If nothing sent, the broadcast failed outright; a partial
  // send is still 'sent' (per-recipient failures show in failed_count).
  //
  // SPEC 069 R6: uma FATIA de disparo parcial não encerra a campanha —
  // ver `DeliverOptions.finalizeStatus`.
  if (finalizeStatus) {
    await db
      .from('broadcasts')
      .update({
        status: sentCount > 0 ? 'sent' : 'failed',
        updated_at: new Date().toISOString(),
      })
      .eq('id', plan.broadcastId);
  }
}
