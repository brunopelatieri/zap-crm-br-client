'use client';

import Image from 'next/image';
import { useState } from 'react';
import { cn } from '@/lib/utils';
import type { Message, MessageReaction } from '@/types';
import type { Channel } from '@/lib/channels/types';
import {
  Clock,
  Check,
  CheckCheck,
  XCircle,
  FileText,
  MapPin,
  LayoutTemplate,
  ImageOff,
  CornerDownLeft,
  Sparkles,
  Maximize2,
  QrCode,
  BadgeCheck,
  Star,
  Ban,
  RotateCcw,
} from 'lucide-react';
import { format } from 'date-fns';
import { ReplyQuote } from './reply-quote';
import { MessageReactions } from './message-reactions';
import { InteractivePreview } from '@/components/interactive/interactive-preview';
import { TemplatePreview } from '@/components/interactive/template-preview';
import { DownloadIconButton, useMediaSrc } from './media-download';
import { resolveMediaRef } from '@/lib/storage/media-url';
import { useTranslations } from 'next-intl';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';

interface MessageBubbleProps {
  message: Message;
  /** Pre-computed quote info for messages that reply to another. */
  reply?: { authorLabel: string; preview: string } | null;
  reactions?: MessageReaction[];
  currentUserId?: string;
  onToggleReaction?: (emoji: string) => void;
  /** Agent/bot name (outgoing) or contact name (incoming), shown atop the bubble. */
  senderName?: string;
  /** Abre o lightbox nesta mensagem — só passado para image/video. */
  onOpenMedia?: (messageId: string) => void;
  /**
   * Canal que REALMENTE entregou esta mensagem, quando é diferente do
   * canal da conversa (`message.channel_id`, migração 063 — SPEC 049
   * §6.1 ponto 2). `null`/`undefined` no caso comum, resolvido pelo
   * chamador via `useAccountChannels().byId` — nunca um embed, pelo
   * mesmo motivo do selo de thread (`use-account-channels.ts`).
   */
  channelBadge?: Channel | null;
  /**
   * Nome de quem apagou (`message.deleted_by`), resolvido pelo chamador
   * a partir da lista de membros — o balão não tem acesso a `profiles`.
   * Só é lido quando `message.deletion_actor === 'agent'`.
   */
  deletedByName?: string | null;
  /** "Tentar de novo" (SPEC 074 §6) — só renderizado quando
   *  `message.deletion_scope === 'revoke_failed'`. */
  onRetryRevoke?: () => void;
  /** Horário em que esta mensagem (apagada) foi reenviada, quando existe
   *  uma mensagem filha com `resent_from_message_id` apontando para ela. */
  resentAt?: string | null;
  /** Esta própria mensagem É o reenvio de outra — selo discreto "reenviada". */
  isResend?: boolean;
}

function StatusIcon({
  status,
  errorMessage,
  fallbackLabel,
}: {
  status: Message['status'];
  errorMessage?: string | null;
  fallbackLabel: string;
}) {
  switch (status) {
    case 'sending':
      return <Clock className="text-muted-foreground h-3 w-3" />;
    case 'sent':
      return <Check className="text-muted-foreground h-3 w-3" />;
    case 'delivered':
      return <CheckCheck className="text-muted-foreground h-3 w-3" />;
    case 'read':
      return <CheckCheck className="h-3 w-3 text-blue-400" />;
    case 'failed':
      return (
        <Tooltip>
          <TooltipTrigger
            render={<XCircle className="h-3 w-3 shrink-0 text-red-400" />}
          />
          <TooltipContent>{errorMessage || fallbackLabel}</TooltipContent>
        </Tooltip>
      );
    default:
      return null;
  }
}

function MediaUnavailable({
  label,
  t,
  reason = 'unavailable',
}: {
  label: string;
  t: ReturnType<typeof useTranslations>;
  /**
   * `unavailable` — nunca existiu uma referência de mídia nesta linha
   * (verificação com a Meta falhou no ingest). `expired` — a referência
   * existe, mas o fetch falhou: para mídia recebida antes do download
   * eager (SPEC — ver histórico de 2026-08-18), a Meta já apagou o
   * arquivo e não há como recuperá-lo.
   */
  reason?: 'unavailable' | 'expired';
}) {
  return (
    <div className="bg-muted/40 text-muted-foreground flex items-center gap-2 rounded-lg px-3 py-2 text-xs">
      <ImageOff className="text-muted-foreground h-4 w-4 shrink-0" />
      <span>{t(reason, { label })}</span>
    </div>
  );
}

// ------------------------------------------------------------------
// Wrappers de mídia.
//
// Desde a migração 040 nenhuma origem de mídia é utilizável direto do
// que está gravado na linha: objeto nosso precisa de URL assinada
// (bucket privado), mídia recebida precisa de fetch autenticado na
// rota-proxy. Só URL externa continua servindo como está.
//
// `useMediaSrc` resolve os três casos, mas é um hook — por isso cada
// tipo de mídia ganha seu componentezinho, em vez de um `switch` com
// hooks dentro.
// ------------------------------------------------------------------

/**
 * Tem mídia utilizável nesta linha?
 *
 * A pergunta NÃO é "`media_url` está preenchido". São três colunas
 * possíveis e `resolveMediaRef` é quem sabe a precedência entre elas —
 * `media_path` (objeto nosso, migração 040), `media_url` (histórico e
 * link externo) e a rota-proxy da Meta embutida na URL.
 *
 * O canal WhatsApp QRCode preenche **só `media_path`**: o webhook baixa
 * a mídia da Evolution e sobe ao bucket, sem nunca ter uma URL pública
 * (SPEC 048 §6.5). Enquanto o gate era `!!message.media_url`, toda foto
 * e todo áudio recebidos por esse canal caíam em "Foto indisponível" /
 * "Áudio indisponível" — com o arquivo íntegro no bucket, a poucos
 * caracteres de distância. Os wrappers abaixo já recebiam `path` e
 * sabiam resolvê-lo; o gate é que nunca os deixava tentar.
 */
function hasUsableMedia(message: Message): boolean {
  return resolveMediaRef(message.media_url, message.media_path).kind !== 'none';
}

function MediaImage({
  url,
  path,
  alt,
  label,
  t,
}: {
  url: string | null | undefined;
  path?: string | null;
  alt: string;
  label: string;
  t: ReturnType<typeof useTranslations>;
}) {
  const { src, loading, error } = useMediaSrc(url, path);
  // Erro do fetch (proxy) e erro de render do <img> (URL pública que
  // carrega mas não decodifica) são duas falhas distintas — a segunda
  // só é detectável depois que o hook já devolveu um `src`.
  const [renderError, setRenderError] = useState(false);

  if (error || renderError) {
    return (
      <div className="flex h-40 w-60 items-center justify-center">
        <MediaUnavailable label={label} t={t} reason="expired" />
      </div>
    );
  }

  if (loading) {
    return (
      <div className="bg-muted flex h-40 w-60 items-center justify-center rounded-lg">
        <div className="border-primary h-5 w-5 animate-spin rounded-full border-2 border-t-transparent" />
      </div>
    );
  }

  return (
    // `src` vem de useMediaSrc: pode ser URL assinada, blob: de proxy ou
    // URL externa arbitrária — o otimizador do next/image só aceita
    // hosts em `images.remotePatterns`.
    <Image
      src={src ?? ''}
      alt={alt}
      width={240}
      height={256}
      unoptimized
      className="max-h-64 max-w-60 rounded-lg object-cover"
      onError={() => setRenderError(true)}
    />
  );
}

function MediaVideo({
  url,
  path,
  label,
  t,
}: {
  url: string | null | undefined;
  path?: string | null;
  label: string;
  t: ReturnType<typeof useTranslations>;
}) {
  const { src, loading, error } = useMediaSrc(url, path);

  if (error) {
    return (
      <div className="flex h-40 w-60 items-center justify-center">
        <MediaUnavailable label={label} t={t} reason="expired" />
      </div>
    );
  }
  if (loading || !src) {
    return (
      <div className="bg-muted flex h-40 w-60 items-center justify-center rounded-lg">
        <div className="border-primary h-5 w-5 animate-spin rounded-full border-2 border-t-transparent" />
      </div>
    );
  }
  return <video src={src} controls className="max-h-64 max-w-60 rounded-lg" />;
}

function MediaAudio({
  url,
  path,
  label,
  t,
}: {
  url: string | null | undefined;
  path?: string | null;
  label: string;
  t: ReturnType<typeof useTranslations>;
}) {
  const { src, loading, error } = useMediaSrc(url, path);

  if (error) return <MediaUnavailable label={label} t={t} reason="expired" />;
  if (loading || !src) {
    return (
      <div className="bg-muted flex h-10 w-60 items-center justify-center rounded-lg">
        <div className="border-primary h-4 w-4 animate-spin rounded-full border-2 border-t-transparent" />
      </div>
    );
  }
  return <audio src={src} controls className="max-w-60" />;
}

/**
 * Link "abrir documento". Precisa resolver antes de virar `href`: um
 * `<a>` apontando para a URL pública de um bucket privado abriria uma
 * aba com erro do Storage.
 *
 * Enquanto resolve, o link fica desabilitado (`aria-disabled` + sem
 * `href`) em vez de sumir — o cartão não deve pular de layout.
 */
function DocumentLink({
  url,
  path,
  label,
  t,
}: {
  url: string | null | undefined;
  path?: string | null;
  label: string;
  t: ReturnType<typeof useTranslations>;
}) {
  const { src, error } = useMediaSrc(url, path);

  if (error) {
    return <MediaUnavailable label={label} t={t} reason="expired" />;
  }

  return (
    <a
      href={src ?? undefined}
      aria-disabled={!src}
      target="_blank"
      rel="noopener noreferrer"
      className={cn(
        'flex min-w-0 flex-1 items-center gap-2',
        !src && 'pointer-events-none opacity-70'
      )}
    >
      <FileText className="text-muted-foreground h-5 w-5 shrink-0" />
      <span className="min-w-0 flex-1 truncate">{label}</span>
    </a>
  );
}

/**
 * Corpo do balão apagado (SPEC 074 §7.1 D-2): o registro continua
 * legível — texto riscado com opacidade reduzida — mas mídia NUNCA
 * renderiza a miniatura; entra a moldura vermelha com o rótulo do tipo.
 * Abrir o lightbox de algo que se acabou de apagar é ruído.
 */
function DeletedMessageContent({
  message,
  t,
}: {
  message: Message;
  t: ReturnType<typeof useTranslations>;
}) {
  const mediaLabel: Record<string, string> = {
    image: t('photo'),
    video: t('video'),
    audio: t('audio'),
    document: t('document'),
  };
  const label = mediaLabel[message.content_type];

  if (label) {
    return (
      <div className="border-destructive/40 bg-destructive/10 text-muted-foreground flex items-center gap-2 rounded-lg border px-3 py-2 text-xs">
        <Ban className="text-destructive/70 h-4 w-4 shrink-0" />
        <span>[{label}]</span>
      </div>
    );
  }

  return (
    <p className="text-sm break-words whitespace-pre-wrap line-through opacity-60">
      {message.content_text || t('unsupported')}
    </p>
  );
}

function MessageContent({
  message,
  t,
  onOpenMedia,
}: {
  message: Message;
  t: ReturnType<typeof useTranslations>;
  onOpenMedia?: (messageId: string) => void;
}) {
  if (message.deleted_at) {
    return <DeletedMessageContent message={message} t={t} />;
  }

  switch (message.content_type) {
    case 'text':
      return (
        <p className="text-sm break-words whitespace-pre-wrap">
          {message.content_text}
        </p>
      );

    case 'image': {
      // Botão de download só na mídia RECEBIDA (sender_type='customer')
      // — o que o agente envia já é o próprio arquivo que ele escolheu
      // no computador dele; não há nada novo para salvar.
      const canDownload =
        message.sender_type === 'customer' && hasUsableMedia(message);
      return (
        <div>
          {hasUsableMedia(message) ? (
            <div
              className={cn(
                'relative inline-block',
                onOpenMedia && 'cursor-zoom-in'
              )}
              onClick={() => onOpenMedia?.(message.id)}
            >
              <MediaImage
                url={message.media_url}
                path={message.media_path}
                alt="Shared image"
                label={t('photo')}
                t={t}
              />
              {canDownload && (
                <DownloadIconButton
                  url={message.media_url}
                  path={message.media_path}
                  filename={null}
                  fallbackId={message.id}
                  className="absolute top-1.5 right-1.5"
                />
              )}
            </div>
          ) : (
            <MediaUnavailable label={t('photo')} t={t} />
          )}
          {message.content_text && (
            <p className="mt-1 text-sm break-words whitespace-pre-wrap">
              {message.content_text}
            </p>
          )}
        </div>
      );
    }

    case 'video': {
      const canDownload =
        message.sender_type === 'customer' && hasUsableMedia(message);
      return (
        <div>
          {hasUsableMedia(message) ? (
            <div className="relative inline-block">
              <MediaVideo
                url={message.media_url}
                path={message.media_path}
                label={t('video')}
                t={t}
              />
              {/* Botão explícito (não a área toda) — o clique em cima do
                  <video> precisa continuar chegando aos controles nativos
                  (play/pause/seek) sem abrir o lightbox por engano. */}
              {onOpenMedia && (
                <button
                  type="button"
                  onClick={() => onOpenMedia(message.id)}
                  title={t('expand')}
                  aria-label={t('expand')}
                  className="absolute top-1.5 left-1.5 inline-flex items-center justify-center rounded-full bg-black/50 p-1.5 text-white transition-colors hover:bg-black/70"
                >
                  <Maximize2 className="h-3.5 w-3.5" />
                </button>
              )}
              {canDownload && (
                <DownloadIconButton
                  url={message.media_url}
                  path={message.media_path}
                  filename={null}
                  fallbackId={message.id}
                  className="absolute top-1.5 right-1.5"
                />
              )}
            </div>
          ) : (
            <MediaUnavailable label={t('video')} t={t} />
          )}
          {message.content_text && (
            <p className="mt-1 text-sm break-words whitespace-pre-wrap">
              {message.content_text}
            </p>
          )}
        </div>
      );
    }

    case 'audio': {
      const canDownload =
        message.sender_type === 'customer' && hasUsableMedia(message);
      return (
        <div className="flex items-center gap-2">
          {hasUsableMedia(message) ? (
            <>
              <MediaAudio
                url={message.media_url}
                path={message.media_path}
                label={t('audio')}
                t={t}
              />
              {canDownload && (
                <DownloadIconButton
                  url={message.media_url}
                  path={message.media_path}
                  filename={null}
                  fallbackId={message.id}
                  className="bg-muted-foreground/20 text-foreground hover:bg-muted-foreground/30 shrink-0"
                />
              )}
            </>
          ) : (
            <MediaUnavailable label={t('audio')} t={t} />
          )}
        </div>
      );
    }

    case 'document': {
      if (!hasUsableMedia(message)) {
        return (
          <MediaUnavailable
            label={message.content_text || t('document')}
            t={t}
          />
        );
      }
      const canDownload = message.sender_type === 'customer';
      // `<a>` e `<button>` são dois elementos interativos — não podem
      // ficar um dentro do outro (HTML inválido, o parser fecharia a
      // tag errado). O link de "abrir" e o botão de "baixar" ficam
      // lado a lado dentro do mesmo cartão, não aninhados.
      return (
        <div className="bg-muted/50 hover:bg-muted flex items-center gap-2 rounded-lg px-3 py-2 text-sm">
          <DocumentLink
            url={message.media_url}
            path={message.media_path}
            label={message.content_text || t('document')}
            t={t}
          />
          {canDownload && (
            <DownloadIconButton
              url={message.media_url}
              path={message.media_path}
              filename={message.content_text}
              fallbackId={message.id}
              className="bg-muted-foreground/20 text-foreground hover:bg-muted-foreground/30 shrink-0"
            />
          )}
        </div>
      );
    }

    case 'template':
      return (
        <div>
          <span className="bg-primary/20 text-primary mb-1 inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium">
            <LayoutTemplate className="h-3 w-3" />
            {t('template')}
          </span>
          {message.template_preview ? (
            // Full fidelity: header/body/footer/buttons rendered like the
            // template appears on the recipient's phone (migration 037).
            <TemplatePreview preview={message.template_preview} />
          ) : (
            // Older sends predate migration 037 (or the template row
            // wasn't found locally at send time) — fall back to plain text.
            message.content_text && (
              <p className="mt-1 text-sm break-words whitespace-pre-wrap">
                {message.content_text}
              </p>
            )
          )}
          {message.broadcast_id && (
            // SPEC 057 F6 — rastreabilidade: esta bolha foi hidratada
            // retroativamente quando o cliente respondeu a um disparo
            // (D-4). `message.broadcast` só existe quando o join da
            // busca de mensagens o trouxe — uma mensagem que chega pelo
            // canal realtime (INSERT cru do Postgres) nunca carrega o
            // embed, só as colunas da própria linha. `template_name`
            // (sempre presente numa mensagem de campanha) é o fallback
            // até o próximo refetch trazer o embed com o nome real;
            // `t('template')` só entra se nem isso existir.
            <p className="text-muted-foreground mt-1 text-[11px]">
              {t('broadcastOrigin', {
                name:
                  message.broadcast?.name ??
                  message.template_name ??
                  t('template'),
              })}
              {' · '}
              {t('broadcastOriginDate', {
                date: format(new Date(message.created_at), 'dd/MM'),
              })}
            </p>
          )}
        </div>
      );

    case 'location':
      return (
        <div className="flex items-center gap-2 text-sm">
          <MapPin className="text-muted-foreground h-4 w-4 shrink-0" />
          <span>{message.content_text || t('locationShared')}</span>
        </div>
      );

    case 'interactive': {
      // Three cases share content_type='interactive':
      //  - OUTBOUND with payload (composer / automation / Flow send after
      //    migration 035): render the buttons/list as they appear on the phone.
      //  - INBOUND tap (customer chose an option, sender_type='customer'):
      //    no payload; show the tapped option's title with a reply affordance
      //    so agents can tell it's a tap, not the customer typing.
      //  - OUTBOUND with NO payload (legacy bot/Flow sends from before
      //    migration 035 backfilled the column): show the body text plainly —
      //    it is our own message, NOT a customer tap.
      if (message.interactive_payload) {
        return <InteractivePreview payload={message.interactive_payload} />;
      }
      if (message.sender_type === 'customer') {
        return (
          <div className="flex flex-col gap-0.5">
            <span className="text-muted-foreground inline-flex items-center gap-1 text-[10px] font-medium tracking-wide uppercase">
              <CornerDownLeft className="h-3 w-3" />
              {t('buttonReply')}
            </span>
            <p className="text-sm break-words whitespace-pre-wrap">
              {message.content_text || t('interactiveReply')}
            </p>
          </div>
        );
      }
      return (
        <p className="text-sm break-words whitespace-pre-wrap">
          {message.content_text || t('interactiveReply')}
        </p>
      );
    }

    default:
      return (
        <p className="text-sm break-words whitespace-pre-wrap">
          {message.content_text || t('unsupported')}
        </p>
      );
  }
}

/**
 * Texto do rodapé de apagamento (SPEC 074 §7.1) — quatro desfechos, na
 * ordem do §1.3: revogada, apagada-no-CRM, revogação falhou, ou apagada
 * pelo PRÓPRIO CONTATO (que sobrepõe os três anteriores, qualquer que
 * seja `deletion_scope`).
 */
function deletionFooterText(
  message: Message,
  tDelete: ReturnType<typeof useTranslations>,
  deletedByName?: string | null
): string {
  if (message.deletion_actor === 'contact') return tDelete('badgeByContact');

  const time = message.deleted_at
    ? format(new Date(message.deleted_at), 'HH:mm')
    : '';
  const who = deletedByName || '—';

  switch (message.deletion_scope) {
    case 'revoked':
      return `${tDelete('badgeRevoked')} — ${tDelete('deletedBy', { name: who, time })}`;
    case 'revoke_failed':
      return tDelete('badgeRevokeFailed', {
        reason: message.deletion_error || '',
      });
    case 'not_supported':
    default:
      return `${tDelete('badgeNotSupported')} — ${tDelete('badgeNotSupportedHint')}`;
  }
}

export function MessageBubble({
  message,
  reply,
  reactions,
  currentUserId,
  onToggleReaction,
  senderName,
  onOpenMedia,
  channelBadge,
  deletedByName,
  onRetryRevoke,
  resentAt,
  isResend,
}: MessageBubbleProps) {
  const t = useTranslations('Inbox.bubble');
  const tDelete = useTranslations('Inbox.delete');

  const isAgent =
    message.sender_type === 'agent' || message.sender_type === 'bot';
  const isDeleted = !!message.deleted_at;
  const time = format(new Date(message.created_at), 'HH:mm');
  // Balão apagado troca o preenchimento colorido por um tom neutro com
  // tinta vermelha (D-2) — os textos "claros sobre verde"/"claros sobre
  // cinza" de baixo precisam de UMA cor segura contra esse fundo novo,
  // em vez da distinção isAgent de sempre.
  const mutedTextClass = isDeleted
    ? 'text-muted-foreground'
    : isAgent
      ? 'text-neutral-900/60'
      : 'text-muted-foreground';
  const badgeClass = isDeleted
    ? 'bg-muted text-muted-foreground'
    : isAgent
      ? 'bg-neutral-900/10 text-neutral-900'
      : 'bg-primary-foreground/20 text-primary-foreground';

  // Row alignment + width cap are owned by <MessageActions> so its hover
  // group matches the bubble's content area, not the full row.
  return (
    <div className={cn('flex flex-col', isAgent ? 'items-end' : 'items-start')}>
      <div
        className={cn(
          'relative rounded-2xl px-3 py-2',
          isDeleted
            ? cn(
                'border-destructive/60 bg-destructive/5 text-foreground border',
                isAgent ? 'rounded-br-md' : 'rounded-bl-md'
              )
            : // Outgoing bubbles use a fixed pale-green fill (not the themed
              // `--primary`) so agent messages are always visually distinct
              // from the accent color. Text/timestamp/badge below are all
              // dark neutrals chosen for contrast against that light fill.
              isAgent
              ? 'rounded-br-md bg-[#E1F7C9] text-neutral-900'
              : 'bg-muted text-foreground rounded-bl-md'
        )}
      >
        {senderName && (
          <p
            className={cn(
              'mb-0.5 truncate text-xs font-semibold',
              isDeleted
                ? 'text-foreground/70'
                : isAgent
                  ? 'text-neutral-900/70'
                  : 'text-foreground/70'
            )}
          >
            {senderName}
          </p>
        )}
        {reply && (
          <ReplyQuote
            authorLabel={reply.authorLabel}
            preview={reply.preview}
            onPrimary={isAgent}
          />
        )}
        <MessageContent message={message} t={t} onOpenMedia={onOpenMedia} />
        <div
          className={cn(
            'mt-1 flex items-center gap-1',
            isAgent ? 'justify-end' : 'justify-start'
          )}
        >
          {/* Selo de favorita (SPEC 060 §8.1) — sem ele, sair da barra
              de ações apaga a única evidência de que a mensagem está
              protegida da limpeza de retenção. */}
          {message.is_favorite && (
            <Star
              className="h-3 w-3 shrink-0 text-amber-500"
              fill="currentColor"
              aria-label={t('favorited')}
            >
              <title>{t('favorited')}</title>
            </Star>
          )}
          {/* AI badge — only on replies the auto-reply bot generated
              (always outbound, so it sits on the primary fill). Lets
              agents tell an AI reply from their own / a Flow's at a
              glance. */}
          {message.ai_generated && (
            <span
              className={cn(
                'inline-flex items-center gap-0.5 rounded-full px-1.5 py-px text-[9px] leading-none font-semibold tracking-wide uppercase',
                badgeClass
              )}
              title={t('aiBadgeTitle')}
            >
              <Sparkles className="h-2.5 w-2.5" />
              {t('aiBadge')}
            </span>
          )}
          {/* Selo do canal de desvio (SPEC 049 §6.1 ponto 2, migração
              063) — só existe em mensagem de saída, e só quando o
              chamador resolveu `message.channel_id` para um canal (ele
              só vem preenchido quando o envio saiu por um número
              diferente do desta conversa). */}
          {isAgent && channelBadge && (
            <span
              className={cn(
                'inline-flex items-center gap-0.5 rounded-full px-1.5 py-px text-[9px] leading-none font-semibold',
                badgeClass
              )}
              title={t('channelBadgeTitle', { channel: channelBadge.name })}
            >
              {channelBadge.type === 'whatsapp_qr' ? (
                <QrCode className="h-2.5 w-2.5" />
              ) : (
                <BadgeCheck className="h-2.5 w-2.5" />
              )}
              {channelBadge.name}
            </span>
          )}
          {/* Selo "reenviada" (§8) — esta mensagem NASCEU de um reenvio;
              o discreto aqui, o "reenviada às {hora}" fica na ORIGINAL
              apagada (rodapé de apagamento, abaixo). */}
          {isAgent && isResend && (
            <span
              className={cn(
                'inline-flex items-center gap-0.5 rounded-full px-1.5 py-px text-[9px] leading-none font-semibold',
                badgeClass
              )}
              title={tDelete('resentBadge')}
            >
              <RotateCcw className="h-2.5 w-2.5" />
              {tDelete('resentBadge')}
            </span>
          )}
          <span
            className={cn(
              'text-[10px]',
              // Outbound bubbles sit on the fixed pale-green fill, so the
              // timestamp must read against that (not the neutral
              // foreground) — otherwise it goes low-contrast in light
              // mode. Inbound bubbles use the muted surface.
              mutedTextClass
            )}
          >
            {time}
          </span>
          {isAgent && (
            <StatusIcon
              status={message.status}
              errorMessage={message.error_message}
              fallbackLabel={t('deliveryFailed')}
            />
          )}
        </div>
        {/* Rodapé de apagamento (SPEC 074 §7.1) — mesma posição, mesmo
            horário, mesmo status de entrega acima; só a moldura e este
            rodapé mudam. */}
        {isDeleted && (
          <div
            className={cn(
              'mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 border-t pt-1',
              isAgent ? 'border-neutral-900/10' : 'border-border'
            )}
          >
            <p className={cn('text-[10px]', mutedTextClass)}>
              {deletionFooterText(message, tDelete, deletedByName)}
            </p>
            {message.deletion_scope === 'revoke_failed' &&
              message.deletion_actor === 'agent' &&
              onRetryRevoke && (
                <button
                  type="button"
                  onClick={onRetryRevoke}
                  className="text-[10px] font-semibold text-blue-500 underline-offset-2 hover:underline"
                >
                  {tDelete('retryRevoke')}
                </button>
              )}
          </div>
        )}
        {isDeleted && resentAt && (
          <p className={cn('mt-0.5 text-[10px]', mutedTextClass)}>
            {tDelete('resentAt', { time: format(new Date(resentAt), 'HH:mm') })}
          </p>
        )}
      </div>
      {reactions && reactions.length > 0 && onToggleReaction && (
        <MessageReactions
          reactions={reactions}
          currentUserId={currentUserId}
          onToggle={onToggleReaction}
        />
      )}
    </div>
  );
}
