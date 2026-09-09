'use client';

import { useState, type ReactNode } from 'react';
import {
  CornerUpLeft,
  Copy,
  RotateCcw,
  SmilePlus,
  Star,
  Trash2,
} from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import type { Message } from '@/types';
import type { AccountRole } from '@/lib/auth/roles';
import type { ChannelType } from '@/lib/channels/types';
import { canResendMessage, planDeletion } from '@/lib/messages/delete';
import { DeleteMessageDialog } from './delete-message-dialog';
import { useTranslations } from 'next-intl';

// WhatsApp's own quick-reaction bar starts with these six. Picking the same
// set keeps the affordance familiar without pulling in a 300KB emoji library.
const QUICK_EMOJIS = ['👍', '❤️', '😂', '😮', '😢', '🙏'];

interface MessageActionsProps {
  message: Message;
  onReply: () => void;
  onReact: (emoji: string) => void;
  /**
   * Ausente numa mensagem `temp-` (ainda sem id real) — o botão da
   * estrela some enquanto o envio otimista não confirma, mesma regra
   * que `handleCopy`/`onReact` já seguem para conteúdo que ainda não
   * existe no servidor (SPEC 060 §8.1).
   */
  onToggleFavorite?: () => void;
  /**
   * Papel do usuário e canal DESTA mensagem (message.channel_id quando
   * preenchido, senão o da conversa) — o mínimo que `planDeletion`
   * precisa para decidir se "Apagar"/"Excluir do sistema" aparece
   * (SPEC 074 §4). Ausentes = a barra nunca mostra a opção (ex.: mensagem
   * ainda otimista, sem canal resolvido).
   */
  role?: AccountRole;
  channelType?: ChannelType;
  /** Ausente numa mensagem `temp-`, mesma regra de `onToggleFavorite`. */
  onDelete?: (purge: boolean) => Promise<void>;
  /** Reenviar (§8) — só quando `canResendMessage(message)` for `true`. */
  onResend?: () => void;
  children: ReactNode;
}

/**
 * Hover/long-press toolbar wrapper around a `<MessageBubble>`. The bubble
 * itself stays a pure presenter — this component owns the action surface so
 * the bubble's render path is unaffected when the toolbar isn't visible.
 */
export function MessageActions({
  message,
  onReply,
  onReact,
  onToggleFavorite,
  role,
  channelType,
  onDelete,
  onResend,
  children,
}: MessageActionsProps) {
  const t = useTranslations('Inbox.actions');
  const tDelete = useTranslations('Inbox.delete');

  // Touch devices have no hover. Long-press fires `contextmenu`; we capture
  // it, suppress the native menu, and pin the toolbar open until the user
  // interacts elsewhere.
  const [touchOpen, setTouchOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  // Instantâneo de "agora", capturado uma vez (nunca `Date.now()` direto
  // no corpo do render — regra de pureza do react-hooks). Preciso o
  // bastante para decidir o aviso de 48h (D-5): não precisa reatualizar
  // a cada render.
  const [nowMs] = useState(() => Date.now());

  const isAgent =
    message.sender_type === 'agent' || message.sender_type === 'bot';
  const isDeleted = !!message.deleted_at;
  const isOptimistic = message.id.startsWith('temp-');

  // SPEC 074 §4/§7 — a mesma regra pura que a rota usa decide se a barra
  // oferece "Apagar" (mensagem fresca) ou "Excluir do sistema" (já
  // marcada, só admin+). `role`/`channelType`/`onDelete` ausentes = a
  // barra nunca mostra a opção (mensagem otimista, canal ainda não
  // resolvido, ou o chamador não passou os callbacks).
  const deletePlan =
    !isOptimistic && role && channelType && onDelete
      ? planDeletion({
          channelType,
          senderType: message.sender_type,
          status: message.status,
          providerMessageId: message.message_id ?? null,
          deletedAt: message.deleted_at ?? null,
          ageHours:
            (nowMs - new Date(message.created_at).getTime()) / 3_600_000,
          role,
        })
      : null;
  const canOfferDelete = deletePlan?.action === 'delete';
  const canRevokeForDialog =
    deletePlan?.action === 'delete' ? deletePlan.revoke : false;
  const warnStalenessForDialog =
    deletePlan?.action === 'delete' ? deletePlan.warnStaleness : false;

  const showResend = isDeleted && !!onResend && canResendMessage(message);

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    setTouchOpen(true);
  };

  const handleCopy = async () => {
    const text = message.content_text ?? '';
    if (!text) {
      toast.error(t('nothingToCopy'));
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      toast.success(t('copied'));
    } catch {
      toast.error(t('copyFailed'));
    }
    setTouchOpen(false);
  };

  const handlePickEmoji = (emoji: string) => {
    onReact(emoji);
    setPickerOpen(false);
    setTouchOpen(false);
  };

  const handleReply = () => {
    onReply();
    setTouchOpen(false);
  };

  const handleToggleFavorite = () => {
    onToggleFavorite?.();
    setTouchOpen(false);
  };

  const handleResend = () => {
    onResend?.();
    setTouchOpen(false);
  };

  const handleDeleteClick = () => {
    setDeleteDialogOpen(true);
    setTouchOpen(false);
  };

  const handleConfirmDelete = async (purge: boolean) => {
    await onDelete?.(purge);
  };

  // Row alignment lives here (not in MessageBubble) so the `group/actions`
  // hover region matches the bubble's content width — hovering empty space
  // in the row no longer reveals the toolbar.
  return (
    <div
      className={cn('flex w-full', isAgent ? 'justify-end' : 'justify-start')}
      onContextMenu={handleContextMenu}
      onBlur={() => setTouchOpen(false)}
    >
      {/* `min-w-0` lets this flex child actually respect the 75% cap.
       *  Default `min-width: auto` lets content (a long quote preview,
       *  an unbroken URL) push past the cap and shove the row past
       *  100%, which used to bleed across into the contact-sidebar
       *  area. See issue #165. */}
      <div className="group/actions relative max-w-[75%] min-w-0">
        {children}
        <div
          data-touch-open={touchOpen || pickerOpen ? 'true' : undefined}
          className={cn(
            'border-border bg-popover/95 absolute -top-3 z-10 flex h-7 items-center gap-0.5 rounded-full border px-1 shadow-md backdrop-blur-sm transition-opacity',
            'opacity-0 group-focus-within/actions:opacity-100 group-hover/actions:opacity-100',
            'data-[touch-open=true]:opacity-100',
            isAgent ? 'right-3' : 'left-3'
          )}
        >
          {/* Reagir/Responder somem no balão apagado (SPEC 074 §7.1) —
              não há o que reagir/responder num registro que só existe
              para memória. */}
          {!isDeleted && (
            <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
              <PopoverTrigger
                className="text-popover-foreground hover:bg-muted hover:text-foreground flex h-5 w-5 items-center justify-center rounded-full"
                aria-label={t('react')}
              >
                <SmilePlus className="h-3.5 w-3.5" />
              </PopoverTrigger>
              <PopoverContent
                className="flex w-auto flex-row gap-1 p-1.5"
                sideOffset={6}
              >
                {QUICK_EMOJIS.map((e) => (
                  <button
                    key={e}
                    type="button"
                    onClick={() => handlePickEmoji(e)}
                    className="hover:bg-muted flex h-8 w-8 items-center justify-center rounded-full text-lg leading-none transition-transform hover:scale-125"
                    aria-label={t('reactWith', { emoji: e })}
                  >
                    {e}
                  </button>
                ))}
              </PopoverContent>
            </Popover>
          )}
          {!isDeleted && (
            <button
              type="button"
              onClick={handleReply}
              className="text-popover-foreground hover:bg-muted hover:text-foreground flex h-5 w-5 items-center justify-center rounded-full"
              aria-label={t('reply')}
            >
              <CornerUpLeft className="h-3.5 w-3.5" />
            </button>
          )}
          {onToggleFavorite && (
            <button
              type="button"
              onClick={handleToggleFavorite}
              className={cn(
                'flex h-5 w-5 items-center justify-center rounded-full',
                message.is_favorite
                  ? 'hover:bg-muted text-amber-500'
                  : 'text-popover-foreground hover:bg-muted hover:text-foreground'
              )}
              aria-label={message.is_favorite ? t('unfavorite') : t('favorite')}
            >
              <Star
                className="h-3.5 w-3.5"
                fill={message.is_favorite ? 'currentColor' : 'none'}
              />
            </button>
          )}
          <button
            type="button"
            onClick={handleCopy}
            className="text-popover-foreground hover:bg-muted hover:text-foreground flex h-5 w-5 items-center justify-center rounded-full"
            aria-label={t('copyText')}
          >
            <Copy className="h-3.5 w-3.5" />
          </button>
          {/* Reenviar (§8) — só quando o conteúdo original permite
              (canResendMessage) e o chamador ofereceu o callback. */}
          {showResend && (
            <button
              type="button"
              onClick={handleResend}
              className="text-popover-foreground hover:bg-muted hover:text-foreground flex h-5 w-5 items-center justify-center rounded-full"
              aria-label={tDelete('resend')}
              title={tDelete('resend')}
            >
              <RotateCcw className="h-3.5 w-3.5" />
            </button>
          )}
          {/* "Apagar" (mensagem fresca) ou "Excluir do sistema" (já
              marcada, só admin+) — a MESMA regra (`planDeletion`) que a
              rota usa decide se este botão existe (SPEC 074 §7.3): botão
              que erra ao clicar é o que a matriz de capacidades existe
              para evitar. */}
          {canOfferDelete && (
            <button
              type="button"
              onClick={handleDeleteClick}
              className="text-popover-foreground hover:bg-muted hover:text-destructive flex h-5 w-5 items-center justify-center rounded-full"
              aria-label={
                isDeleted ? tDelete('confirmPurge') : tDelete('action')
              }
              title={isDeleted ? tDelete('confirmPurge') : tDelete('action')}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </div>
      {canOfferDelete && (
        <DeleteMessageDialog
          open={deleteDialogOpen}
          onOpenChange={setDeleteDialogOpen}
          canRevoke={canRevokeForDialog}
          warnStaleness={warnStalenessForDialog}
          canPurge={
            deletePlan?.action === 'delete' ? deletePlan.canPurge : false
          }
          alreadyMarked={isDeleted}
          onConfirm={handleConfirmDelete}
        />
      )}
    </div>
  );
}
