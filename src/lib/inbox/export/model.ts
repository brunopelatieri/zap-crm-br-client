/**
 * Modelo puro do transcrito de exportação de conversa (SPEC 067 §3).
 *
 * Fronteira entre a coleta (`fetch-thread.ts`, F4) e o render — o
 * renderizador de PDF (F5) não precisa saber o que é `interactive_payload`
 * ou `template_preview`, e este módulo é testável sem abrir um PDF.
 * `Message[]` entra, uma lista de blocos declarativos sai.
 */

import type {
  Channel,
  Contact,
  Conversation,
  Message,
  MessageReaction,
} from '@/types';
import { resolveMediaRef, type MediaRef } from '@/lib/storage/media-url';

export interface ThreadExportData {
  conversation: Conversation;
  contact: Contact;
  channel: Channel | null;
  /** user_id → nome, para nomear o remetente `agent`. */
  agentNames: Map<string, string>;
  messages: Message[];
  reactions: MessageReaction[];
  /** true se o teto de mensagens cortou a leitura. */
  truncated: boolean;
  total: number;
}

export type TranscriptBlock =
  { kind: 'day'; label: string } | { kind: 'bubble'; bubble: TranscriptBubble };

export interface TranscriptBubble {
  messageId: string;
  side: 'left' | 'right';
  senderLabel: string;
  timeLabel: string;
  statusLabel: string | null;
  /** Parágrafos já normalizados (\r\n → \n, tab → espaço). */
  text: string[];
  badges: string[];
  quote: { senderLabel: string; snippet: string } | null;
  reactions: string[];
  buttons: string[];
  attachment: TranscriptAttachment | null;
  errorText: string | null;
}

export interface TranscriptAttachment {
  messageId: string;
  contentType: 'image' | 'video' | 'audio' | 'document' | 'sticker';
  /** O que `resolveMediaRef` devolveu, sem os bytes. */
  ref: MediaRef;
  /** Nome que o usuário reconhece — ver `deriveMediaFilename`. */
  displayName: string;
  caption: string | null;
  /**
   * `created_at` da mensagem, em ISO. Vira o `mtime` da entrada no zip
   * (descompactar preserva a cronologia no gerenciador de arquivos) e a
   * coluna `data_hora` do manifesto. É o instante CRU, não o rótulo
   * formatado de `timeLabel` — este é para desenhar, aquele é dado.
   */
  createdAt: string;
  /**
   * Canal a que esta mídia pertence — é dele que sai o token quando o
   * download é `proxy` (SPEC 064: o handle da Meta só é baixável com a
   * credencial do número dono; o token do outro número devolve 404 da
   * Graph API).
   *
   * `messages.channel_id` só é gravado no DESVIO de canal de SAÍDA
   * (migração 063); toda mídia RECEBIDA o deixa nulo (`ingest.ts` não o
   * grava), e para ela o número dono é o da CONVERSA. Daí a ordem
   * `mensagem → conversa`, e não o canal padrão da conta.
   */
  channelId: string | null;
}

export interface TranscriptLabels {
  /** `(name) => "Maria (cliente)"` */
  customerSender: (contactName: string) => string;
  /** Rótulo isolado, usado em reações: "cliente". */
  customerWord: string;
  /** "Bot (IA)" — remetente `bot`. */
  bot: string;
  /** Agente removido da conta. */
  unknownAgent: string;
  statusSent: string;
  statusDelivered: string;
  statusRead: string;
  statusFailed: string;
  favoriteBadge: string;
  aiBadge: string;
  campaignBadge: (broadcastName: string) => string;
  templateBadge: (templateName: string) => string;
  channelDeviationBadge: string;
  buttonReply: string;
  locationLabel: string;
}

const MAX_FILENAME_LENGTH = 100;
const MAX_QUOTE_SNIPPET_LENGTH = 120;
const DOCUMENT_FILENAME_PATTERN = /^[^\n]{1,120}\.[a-z0-9]{1,8}$/i;

function normalizeText(text: string | null | undefined): string[] {
  if (!text) return [];
  const normalized = text.replace(/\r\n/g, '\n').replace(/\t/g, ' ');
  return normalized.split('\n');
}

/** Sanitização obrigatória de nome de arquivo (SPEC 067 §8): sem `/`, `\`,
 *  `..`, sem caractere de controle, ≤ 100 caracteres. */
export function sanitizeFilename(name: string): string {
  const withoutControlChars = Array.from(name)
    .filter((ch) => {
      const code = ch.codePointAt(0) ?? 0;
      return code >= 0x20 && code !== 0x7f;
    })
    .join('');
  const withoutSeparators = withoutControlChars.replace(/[/\\]/g, '-');
  const withoutTraversal = withoutSeparators.replace(/\.\.+/g, '.');
  const trimmed = withoutTraversal.trim();
  const truncated =
    trimmed.length > MAX_FILENAME_LENGTH
      ? trimmed.slice(0, MAX_FILENAME_LENGTH)
      : trimmed;
  return truncated.length > 0 ? truncated : 'arquivo';
}

function refSource(ref: MediaRef): string | null {
  switch (ref.kind) {
    case 'storage':
      return ref.path;
    case 'proxy':
    case 'external':
      return ref.url;
    case 'none':
      return null;
  }
}

function basenameFromRef(ref: MediaRef): string | null {
  const source = refSource(ref);
  if (!source) return null;
  const clean = source.split('?')[0].split('#')[0];
  const basename = clean.split(/[/\\]/).pop();
  return basename && basename.length > 0 ? basename : null;
}

/** Extensão a partir do basename do objeto — nenhum MIME real existe
 *  antes do download (F4), então `bin` é o último recurso aqui. */
export function guessExtensionFromRef(ref: MediaRef): string {
  const basename = basenameFromRef(ref);
  if (!basename) return 'bin';
  const match = /\.([a-z0-9]{1,8})$/i.exec(basename);
  return match ? match[1].toLowerCase() : 'bin';
}

/**
 * Nome de mídia reconhecível pelo usuário (SPEC 067 §3). Não existe coluna
 * de nome de arquivo em `messages`: o webhook grava
 * `document.caption || document.filename` em `content_text`, então nome
 * de documento e legenda ocupam o mesmo campo.
 *
 * 1. Documento com `content_text` de uma linha só, com extensão plausível
 *    → é o nome do arquivo.
 * 2. Senão, basename de `media_path`/`media_url`.
 * 3. Senão, `<tipo>-<8 primeiros do messageId>.<extensão adivinhada>`.
 */
export function deriveMediaFilename(
  contentType: TranscriptAttachment['contentType'],
  contentText: string | null | undefined,
  ref: MediaRef,
  messageId: string
): string {
  const trimmedCaption = contentText?.trim();
  if (
    contentType === 'document' &&
    trimmedCaption &&
    DOCUMENT_FILENAME_PATTERN.test(trimmedCaption)
  ) {
    return sanitizeFilename(trimmedCaption);
  }

  const basename = basenameFromRef(ref);
  if (basename) {
    return sanitizeFilename(basename);
  }

  const ext = guessExtensionFromRef(ref);
  return sanitizeFilename(
    `${contentType}-${messageId.replace(/-/g, '').slice(0, 8)}.${ext}`
  );
}

function attachmentContentType(
  contentType: Message['content_type']
): TranscriptAttachment['contentType'] | null {
  switch (contentType) {
    case 'image':
    case 'video':
    case 'audio':
    case 'document':
      return contentType;
    default:
      return null;
  }
}

function buildAttachment(
  message: Message,
  kind: TranscriptAttachment['contentType'],
  conversationChannelId: string | null
): TranscriptAttachment {
  const ref = resolveMediaRef(message.media_url, message.media_path);
  return {
    messageId: message.id,
    contentType: kind,
    ref,
    displayName: deriveMediaFilename(
      kind,
      message.content_text,
      ref,
      message.id
    ),
    caption: message.content_text?.trim() || null,
    createdAt: message.created_at,
    channelId: message.channel_id ?? conversationChannelId,
  };
}

function statusLabelFor(
  status: Message['status'],
  labels: TranscriptLabels
): string | null {
  switch (status) {
    case 'sent':
      return labels.statusSent;
    case 'delivered':
      return labels.statusDelivered;
    case 'read':
      return labels.statusRead;
    case 'failed':
      return labels.statusFailed;
    case 'sending':
      return null;
  }
}

function senderLabelFor(
  message: Message,
  data: ThreadExportData,
  labels: TranscriptLabels
): string {
  if (message.sender_type === 'customer') {
    return labels.customerSender(data.contact.name || data.contact.phone);
  }
  if (message.sender_type === 'bot') {
    return labels.bot;
  }
  const agentName = message.sender_id
    ? data.agentNames.get(message.sender_id)
    : undefined;
  return agentName ?? labels.unknownAgent;
}

function bodyForMessage(
  message: Message,
  labels: TranscriptLabels
): {
  text: string[];
  buttons: string[];
} {
  switch (message.content_type) {
    case 'text':
      return { text: normalizeText(message.content_text), buttons: [] };

    case 'image':
    case 'video':
    case 'audio':
    case 'document':
      return { text: [], buttons: [] };

    case 'template': {
      if (message.template_preview) {
        const { header, body, footer, buttons } = message.template_preview;
        return {
          text: [
            ...normalizeText(header),
            ...normalizeText(body),
            ...normalizeText(footer),
          ],
          buttons: (buttons ?? []).map((button) => button.text),
        };
      }
      return { text: normalizeText(message.content_text), buttons: [] };
    }

    case 'interactive': {
      if (message.sender_type === 'customer') {
        const parts = [labels.buttonReply];
        if (message.content_text) parts.push(message.content_text);
        let line = parts.join(': ');
        if (message.interactive_reply_id) {
          line += ` (${message.interactive_reply_id})`;
        }
        return { text: [line], buttons: [] };
      }
      if (message.interactive_payload) {
        const payload = message.interactive_payload;
        const buttons =
          payload.kind === 'buttons'
            ? payload.buttons.map((button) => button.title)
            : payload.sections.flatMap((section) =>
                section.rows.map((row) => row.title)
              );
        return {
          text: [
            ...normalizeText(payload.header),
            ...normalizeText(payload.body),
            ...normalizeText(payload.footer),
          ],
          buttons,
        };
      }
      return { text: normalizeText(message.content_text), buttons: [] };
    }

    case 'location':
      return {
        text: [`${labels.locationLabel}: ${message.content_text ?? ''}`],
        buttons: [],
      };
  }
}

function badgesForMessage(
  message: Message,
  data: ThreadExportData,
  labels: TranscriptLabels
): string[] {
  const badges: string[] = [];
  if (message.is_favorite) badges.push(labels.favoriteBadge);
  if (message.ai_generated) badges.push(labels.aiBadge);
  if (message.broadcast?.name) {
    badges.push(labels.campaignBadge(message.broadcast.name));
  }
  if (
    message.channel_id &&
    data.conversation.channel_id &&
    message.channel_id !== data.conversation.channel_id
  ) {
    badges.push(labels.channelDeviationBadge);
  }
  if (message.content_type === 'template' && message.template_name) {
    badges.push(labels.templateBadge(message.template_name));
  }
  return badges;
}

function quoteFor(
  message: Message,
  messagesById: Map<string, Message>,
  data: ThreadExportData,
  labels: TranscriptLabels
): { senderLabel: string; snippet: string } | null {
  if (!message.reply_to_message_id) return null;
  const quoted = messagesById.get(message.reply_to_message_id);
  if (!quoted) return null;

  const { text } = bodyForMessage(quoted, labels);
  const raw = text.join(' ').trim() || quoted.content_text?.trim() || '';
  const snippet =
    raw.length > MAX_QUOTE_SNIPPET_LENGTH
      ? raw.slice(0, MAX_QUOTE_SNIPPET_LENGTH)
      : raw;

  return { senderLabel: senderLabelFor(quoted, data, labels), snippet };
}

function reactionsFor(
  message: Message,
  reactionsByMessage: Map<string, MessageReaction[]>,
  data: ThreadExportData,
  labels: TranscriptLabels
): string[] {
  const reactions = reactionsByMessage.get(message.id) ?? [];
  return reactions.map((reaction) => {
    const actorLabel =
      reaction.actor_type === 'customer'
        ? labels.customerWord
        : ((reaction.actor_id
            ? data.agentNames.get(reaction.actor_id)
            : undefined) ?? labels.unknownAgent);
    return `${reaction.emoji} ${actorLabel}`;
  });
}

function dayLabelFor(iso: string, formatDateTime: FormatDateTime): string {
  return formatDateTime(iso, 'day');
}

export type FormatDateTime = (iso: string, style: 'day' | 'time') => string;

export function buildTranscript(
  data: ThreadExportData,
  labels: TranscriptLabels,
  formatDateTime: FormatDateTime
): TranscriptBlock[] {
  const messagesById = new Map(data.messages.map((m) => [m.id, m]));
  const reactionsByMessage = new Map<string, MessageReaction[]>();
  for (const reaction of data.reactions) {
    const list = reactionsByMessage.get(reaction.message_id) ?? [];
    list.push(reaction);
    reactionsByMessage.set(reaction.message_id, list);
  }

  const blocks: TranscriptBlock[] = [];
  let lastDayLabel: string | null = null;

  for (const message of data.messages) {
    const dayLabel = dayLabelFor(message.created_at, formatDateTime);
    if (dayLabel !== lastDayLabel) {
      blocks.push({ kind: 'day', label: dayLabel });
      lastDayLabel = dayLabel;
    }

    const attachmentKind = attachmentContentType(message.content_type);
    const { text, buttons } = bodyForMessage(message, labels);

    const bubble: TranscriptBubble = {
      messageId: message.id,
      side: message.sender_type === 'customer' ? 'left' : 'right',
      senderLabel: senderLabelFor(message, data, labels),
      timeLabel: formatDateTime(message.created_at, 'time'),
      statusLabel: statusLabelFor(message.status, labels),
      text,
      badges: badgesForMessage(message, data, labels),
      quote: quoteFor(message, messagesById, data, labels),
      reactions: reactionsFor(message, reactionsByMessage, data, labels),
      buttons,
      attachment: attachmentKind
        ? buildAttachment(
            message,
            attachmentKind,
            data.conversation.channel_id ?? null
          )
        : null,
      errorText:
        message.status === 'failed' ? (message.error_message ?? null) : null,
    };

    blocks.push({ kind: 'bubble', bubble });
  }

  return blocks;
}
