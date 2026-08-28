// ============================================================
// Envio do template de um POST de ingestão (SPEC 055 D-9 / F5).
//
// Orquestra, na ordem: `assertAccountCanBroadcast` (SPEC 049 §5.3 —
// nenhum número QRCode dispara campanha) → busca do template pelo
// UUID `message_templates.id` da conta → `checkTemplateApproval`
// (achado E — não existia guarda nenhuma) → `cloudChannelContext` +
// `sendWithPhoneVariants` (SPEC 048/PRD 047, o mesmo caminho de saída
// que todo envio único do app já usa) → carimba a linha de
// `broadcast_recipients` que `funnel.ts` já criou.
//
// Nunca cria nem apaga o contato — isso já aconteceu antes de chegar
// aqui. Uma falha em qualquer etapa vira `IngestSendError` (ou deixa
// passar o `BroadcastError` de `assertAccountCanBroadcast`), que a
// rota mapeia para o código de `webhook_ingest_logs` (SPEC 055 §5.3).
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import { assertAccountCanBroadcast } from '@/lib/whatsapp/broadcast-core';
import {
  cloudChannelContext,
  sendWithPhoneVariants,
} from '@/lib/channels/send';
import { ChannelNotConfiguredError } from '@/lib/channels/errors';
import { resolveCloudConfig } from '@/lib/whatsapp/cloud-channels';
import { decrypt } from '@/lib/whatsapp/encryption';
import { createHeaderMediaResolver } from '@/lib/whatsapp/header-media';
import { isMessageTemplate } from '@/lib/whatsapp/template-row-guard';
import { checkTemplateApproval } from '@/lib/whatsapp/template-approval';
import type { MessageTemplate, MessageTemplateStatus } from '@/types';

export type IngestSendErrorCode =
  | 'template_not_found'
  | 'template_not_approved'
  | 'channel_not_capable'
  | 'send_failed';

export class IngestSendError extends Error {
  readonly code: IngestSendErrorCode;
  readonly status?: MessageTemplateStatus;
  constructor(
    code: IngestSendErrorCode,
    message: string,
    status?: MessageTemplateStatus
  ) {
    super(message);
    this.name = 'IngestSendError';
    this.code = code;
    this.status = status;
  }
}

export interface SendIngestTemplateParams {
  accountId: string;
  /** Dígitos-only, com DDI, sem `+` — já normalizado pela SPEC 050. */
  phone: string;
  templateId: string;
  templateParams: string[];
  /** Linha de `broadcast_recipients` já criada por `addFunnelRecipient`. */
  recipientRowId: string;
  /**
   * Por qual número oficial disparar (SPEC 064 D-7). Ausente = canal
   * Cloud padrão da conta.
   *
   * O webhook de entrada da SPEC 055 ainda não guarda canal — o
   * `webhook_id` é só um rótulo no corpo do POST —, então hoje todo
   * chamador cai no padrão. O parâmetro existe para que escolher o
   * número, quando a origem passar a saber qual é, não exija reabrir
   * esta assinatura.
   */
  channelId?: string | null;
}

/**
 * Envia o template de um POST de ingestão para um único destinatário
 * e carimba a linha do destinatário (`sent`/`failed`). Lança
 * `BroadcastError('channel_not_capable', …)` (de
 * `assertAccountCanBroadcast`) ou `IngestSendError` em qualquer outra
 * falha — a linha do destinatário já está marcada `failed` quando o
 * erro é de envio (`send_failed`); nas falhas anteriores ao envio
 * (template não encontrado/aprovado, canal incapaz) a linha
 * permanece `pending`, porque o disparo nem chegou a ser tentado.
 */
export async function sendIngestTemplate(
  db: SupabaseClient,
  params: SendIngestTemplateParams
): Promise<{ messageId: string }> {
  const {
    accountId,
    phone,
    templateId,
    templateParams,
    recipientRowId,
    channelId,
  } = params;

  // SPEC 049 §5.3 — lança BroadcastError('channel_not_capable', …, 400)
  // quando NENHUM canal da conta sabe fazer broadcast (ex.: só QRCode).
  await assertAccountCanBroadcast(db, accountId);

  const { data: templateRow } = await db
    .from('message_templates')
    .select('*')
    .eq('id', templateId)
    .eq('account_id', accountId)
    .maybeSingle();

  const row =
    templateRow && isMessageTemplate(templateRow)
      ? (templateRow as MessageTemplate)
      : null;

  const approval = checkTemplateApproval(row);
  if (!approval.ok) {
    if (approval.reason === 'not_found') {
      throw new IngestSendError(
        'template_not_found',
        `Template '${templateId}' was not found in this account`
      );
    }
    throw new IngestSendError(
      'template_not_approved',
      `Template '${templateId}' is not approved (status: ${approval.status ?? 'unknown'})`,
      approval.status
    );
  }
  const template = approval.template;

  // SPEC 064 F3 — credencial pelo CANAL, nunca por `account_id`.
  let channel;
  let config;
  try {
    ({ channel, config } = await resolveCloudConfig(db, accountId, channelId));
  } catch (err) {
    if (!(err instanceof ChannelNotConfiguredError)) throw err;
    // `assertAccountCanBroadcast` já confirmou que ALGUM canal desta
    // conta é capaz de broadcast; se ainda assim não há número oficial
    // utilizável, o canal Cloud especificamente não está configurado
    // (ou o escolhido está desativado / é de outro tipo). §5.3 não
    // reserva um código próprio para esse caso — cai no mesmo
    // `channel_not_capable` que a guarda de canal usa, com a mensagem
    // do resolvedor, que nomeia o motivo para quem lê o log.
    throw new IngestSendError('channel_not_capable', err.message);
  }

  const channelCtx = cloudChannelContext({
    accountId,
    phoneNumberId: config.phone_number_id,
    accessToken: decrypt(config.access_token),
    channelId: channel.id,
    userId: config.user_id,
    identifier: channel.identifier ?? config.phone_number_id ?? null,
    connected: channel.status === 'connected',
  });

  const resolveHeaderParams = createHeaderMediaResolver(db, template);
  const messageParams = await resolveHeaderParams();

  let providerMessageId: string;
  try {
    const result = await sendWithPhoneVariants({
      ctx: channelCtx,
      sanitizedPhone: phone,
      content: {
        kind: 'template',
        templateName: template.name,
        language: template.language,
        definition: template,
        components: messageParams,
        positionalParams: templateParams,
      },
    });
    providerMessageId = result.providerMessageId;
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    await db
      .from('broadcast_recipients')
      .update({ status: 'failed', error_message: message })
      .eq('id', recipientRowId);
    throw new IngestSendError('send_failed', message);
  }

  await db
    .from('broadcast_recipients')
    .update({
      status: 'sent',
      sent_at: new Date().toISOString(),
      whatsapp_message_id: providerMessageId,
      error_message: null,
    })
    .eq('id', recipientRowId);

  return { messageId: providerMessageId };
}
