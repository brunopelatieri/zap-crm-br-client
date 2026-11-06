// ============================================================
// Entrega do código de acesso pelo WhatsApp da conta (SPEC 083 §7, PRD 082 §6).
//
// Uma conversa, um canal, um caminho de saída: tudo passa por
// `sendAndPersistOutbound` (`channels/send.ts`), com `origin:
// 'contact_portal'` no log. O que é DESTA camada:
//
//   1. Texto livre × template. Canal QRCode ou janela de 24 h aberta →
//      texto livre com código e link. Cloud API fora da janela →
//      template AUTHENTICATION aprovado; sem ele, `needs_template` (a
//      UI avisa e a J2 continua valendo — PRD 082 R-3).
//   2. O código NUNCA fica em claro no banco do inbox. O provedor recebe
//      a mensagem real; `messages.content_text` e o preview da conversa
//      recebem `redactedBody`. O eco `fromMe` da Evolution, que no
//      QRCode chega ANTES do nosso INSERT, é descartado em `ingest.ts`
//      (`looksLikePortalCodeMessage`, pelo marcador): não é gravado.
//   3. Log sem telefone, sem código, sem texto: só o nome do erro.
//
// O link leva o código no FRAGMENTO (`#c=`), não na query: fragmento
// não vai ao servidor, então não aparece em log de acesso do proxy.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';
import { createTranslator } from 'next-intl';

import { ColdSendLimitError } from '@/lib/channels/cold-send-wiring';
import { resolveDefaultChannelId } from '@/lib/channels/default-channel';
import {
  sendAndPersistOutbound,
  type OutboundContent,
} from '@/lib/channels/send';
import { resolveSessionWindow } from '@/lib/channels/session-window';
import type { ChannelType } from '@/lib/channels/types';
import { getDeploymentLocale } from '@/lib/i18n/deployment-locale';
import { buildAuthenticationSendComponents } from '@/lib/whatsapp/template-send-builder';
import { findOrCreateConversation } from '@/lib/whatsapp/resolve-conversation';

import { PORTAL_LIMITS } from './limits';

/**
 * Começo fixo de toda mensagem de código em texto livre. Fora da
 * tradução de propósito: é por ele que o eco `fromMe` é reconhecido, e
 * um tradutor não pode removê-lo sem querer.
 */
export const PORTAL_CODE_MARKER = '🔐';

export type DeliveryKind = 'code' | 'invite';
export type DeliveryMode = 'text' | 'template' | 'needs_template';

export type DeliveryOutcome =
  | { ok: true; via: 'text' | 'template' }
  | {
      ok: false;
      reason: 'no_channel' | 'needs_template' | 'cold_limit' | 'send_failed';
    };

export interface AuthTemplateRef {
  name: string;
  language: string;
}

/**
 * O template de `settings.auth_template_id`, só se ainda servir: da
 * conta, categoria Authentication e APROVADO pela Meta. Qualquer outra
 * coisa é `null` — e fora da janela vira `needs_template`, que a tela
 * explica, em vez de um 400 da Meta no meio do pedido do contato.
 */
export async function loadAuthTemplate(
  db: SupabaseClient,
  accountId: string,
  templateId: string | null
): Promise<AuthTemplateRef | null> {
  if (!templateId) return null;
  const { data } = await db
    .from('message_templates')
    .select('name, language, category, status')
    .eq('id', templateId)
    .eq('account_id', accountId)
    .maybeSingle();
  if (
    !data ||
    data.category !== 'Authentication' ||
    data.status !== 'APPROVED'
  ) {
    return null;
  }
  return {
    name: data.name as string,
    language: (data.language as string) ?? 'pt_BR',
  };
}

export function chooseDeliveryMode(input: {
  channelType: ChannelType;
  lastCustomerMessageAt: Date | null;
  hasAuthTemplate: boolean;
  now?: Date;
}): DeliveryMode {
  const window = resolveSessionWindow(
    input.channelType,
    input.lastCustomerMessageAt,
    input.now
  );
  // Canal sem regra de janela (QRCode) volta `isOpen: true`.
  if (window.isOpen) return 'text';
  return input.hasAuthTemplate ? 'template' : 'needs_template';
}

/** `null` sem origem pública conhecida: a mensagem sai sem link. */
export function accessLink(
  origin: string | null | undefined,
  publicCode: string,
  code: string
): string | null {
  const base = origin?.trim().replace(/\/+$/, '');
  if (!base) return null;
  return `${base}/area/c/${encodeURIComponent(publicCode)}/codigo#c=${code}`;
}

type PortalTranslator = (
  key: string,
  values?: Record<string, string | number>
) => string;

async function portalTranslator(): Promise<PortalTranslator> {
  const locale = getDeploymentLocale();
  const messages = (await import(`../../../messages/${locale}.json`)).default;
  return createTranslator({
    locale,
    messages,
    namespace: 'ContactPortal.whatsapp',
  }) as unknown as PortalTranslator;
}

export function composeCodeText(
  t: PortalTranslator,
  input: {
    kind: DeliveryKind;
    code: string;
    accountName: string;
    link: string | null;
  }
): string {
  const body =
    input.kind === 'invite'
      ? t('inviteMessage', {
          account: input.accountName,
          code: input.code,
          hours: Math.round(PORTAL_LIMITS.invite_code_ttl_s / 3600),
        })
      : t('codeMessage', {
          account: input.accountName,
          code: input.code,
          minutes: Math.round(PORTAL_LIMITS.code_ttl_s / 60),
        });
  const link = input.link ? `\n\n${t('signInLink', { url: input.link })}` : '';
  return `${PORTAL_CODE_MARKER} ${body}${link}`;
}

/** A mensagem tem cara de código da área (marcador + 6 dígitos)? */
export function looksLikePortalCodeMessage(
  text: string | null | undefined
): boolean {
  if (!text) return false;
  return (
    text.trimStart().startsWith(PORTAL_CODE_MARKER) && /\b\d{6}\b/.test(text)
  );
}

export async function deliverAccessCode(input: {
  db: SupabaseClient;
  accountId: string;
  accountName: string;
  contactId: string;
  code: string;
  kind: DeliveryKind;
  publicCode: string;
  /** `settings.channel_id`; `null` cai no canal padrão da conta. */
  channelId: string | null;
  /** J2: a conversa onde a palavra-chave chegou — responde nela. */
  conversationId?: string;
  authTemplate: AuthTemplateRef | null;
  siteOrigin?: string | null;
}): Promise<DeliveryOutcome> {
  const { db, accountId } = input;

  let conversationId = input.conversationId;
  try {
    if (!conversationId) {
      const channelId =
        input.channelId ?? (await resolveDefaultChannelId(db, accountId));
      const { data: account } = await db
        .from('accounts')
        .select('owner_user_id')
        .eq('id', accountId)
        .maybeSingle();
      if (!account?.owner_user_id) return { ok: false, reason: 'no_channel' };
      conversationId = await findOrCreateConversation(
        db,
        accountId,
        input.contactId,
        channelId,
        account.owner_user_id as string
      );
    }
  } catch (err) {
    logFailure('channel', err);
    return { ok: false, reason: 'no_channel' };
  }

  const { data: conversation } = await db
    .from('conversations')
    .select('channel_id, last_customer_message_at')
    .eq('id', conversationId)
    .eq('account_id', accountId)
    .maybeSingle();
  const { data: channel } = conversation?.channel_id
    ? await db
        .from('channels')
        .select('type')
        .eq('id', conversation.channel_id)
        .eq('account_id', accountId)
        .maybeSingle()
    : { data: null };
  if (!channel?.type) return { ok: false, reason: 'no_channel' };

  const mode = chooseDeliveryMode({
    channelType: channel.type as ChannelType,
    lastCustomerMessageAt: conversation?.last_customer_message_at
      ? new Date(conversation.last_customer_message_at as string)
      : null,
    hasAuthTemplate: input.authTemplate !== null,
  });
  if (mode === 'needs_template') return { ok: false, reason: 'needs_template' };

  const t = await portalTranslator();
  const redacted = t('redactedBody');

  let content: OutboundContent;
  if (mode === 'template' && input.authTemplate) {
    content = {
      kind: 'template',
      templateName: input.authTemplate.name,
      language: input.authTemplate.language,
      rawComponents: buildAuthenticationSendComponents(input.code),
    };
  } else {
    content = {
      kind: 'text',
      text: composeCodeText(t, {
        kind: input.kind,
        code: input.code,
        accountName: input.accountName,
        link: accessLink(input.siteOrigin, input.publicCode, input.code),
      }),
    };
  }

  try {
    await sendAndPersistOutbound({
      db,
      accountId,
      origin: 'contact_portal',
      conversationId,
      contactId: input.contactId,
      content,
      persist: {
        senderType: 'bot',
        contentType: mode === 'template' ? 'template' : 'text',
        contentText: redacted,
        previewText: redacted,
        extra:
          mode === 'template' && input.authTemplate
            ? { template_name: input.authTemplate.name }
            : undefined,
      },
    });
    return { ok: true, via: mode === 'template' ? 'template' : 'text' };
  } catch (err) {
    if (err instanceof ColdSendLimitError) {
      return { ok: false, reason: 'cold_limit' };
    }
    logFailure('send', err);
    return { ok: false, reason: 'send_failed' };
  }
}

/**
 * Só o nome do erro: a mensagem de erro de envio pode citar o telefone
 * (`resolveOutboundContact`), e o texto enviado tem o código.
 */
function logFailure(stage: 'channel' | 'send', err: unknown): void {
  const name = err instanceof Error ? err.name : typeof err;
  console.error(`[contact-portal] code delivery failed at ${stage} (${name})`);
}
