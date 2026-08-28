'use client';

// ============================================================
// BlockToggle — o botão de bloquear/desbloquear do console
// (SPEC 062 §7.2, §7.3)
//
// Um componente para os dois alvos (conta e pessoa) porque a mecânica é
// idêntica — só mudam a URL, o texto do diálogo e a mensagem de
// sucesso. Duas cópias divergiriam na primeira correção.
//
// **Bloquear pede confirmação; desbloquear não.** Bloquear tira o
// acesso de todo mundo de uma vez; desbloquear devolve. Só um dos dois
// merece um diálogo, e pedir confirmação para o inofensivo treina a
// pessoa a clicar "confirmar" sem ler — justamente o hábito que faz o
// diálogo do lado perigoso não funcionar.
//
// O autobloqueio é barrado aqui E na rota (§4.4). Este botão
// desabilitado é conveniência; a garantia é o 400 do servidor.
// ============================================================

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Loader2, Lock, LockOpen } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';

export interface BlockToggleProps {
  target: 'account' | 'user';
  /** `accountId` quando target='account'; `userId` quando target='user'. */
  id: string;
  blocked: boolean;
  /** Barra o autobloqueio na UI — a rota barra de novo. */
  disabledReason?: string | null;
  /** Mostra o aviso de "conta ficará sem dono ativo" (§4.4). */
  isAccountOwner?: boolean;
  size?: 'default' | 'sm';
  onChanged: () => void;
}

export function BlockToggle({
  target,
  id,
  blocked,
  disabledReason,
  isAccountOwner,
  size = 'sm',
  onChanged,
}: BlockToggleProps) {
  const t = useTranslations('Platform.block');
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [pending, setPending] = useState(false);

  const endpoint =
    target === 'account'
      ? `/api/platform/accounts/${id}/block`
      : `/api/platform/users/${id}/block`;

  async function submit(nextBlocked: boolean) {
    setPending(true);
    try {
      const res = await fetch(endpoint, {
        method: nextBlocked ? 'POST' : 'DELETE',
        headers: nextBlocked ? { 'Content-Type': 'application/json' } : {},
        body: nextBlocked
          ? JSON.stringify({ reason: reason || null })
          : undefined,
      });
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        toast.error(payload.error || t('blockFailed'));
        return;
      }
      toast.success(
        target === 'account'
          ? nextBlocked
            ? t('blockedAccountSuccess')
            : t('unblockedAccountSuccess')
          : nextBlocked
            ? t('blockedUserSuccess')
            : t('unblockedUserSuccess')
      );
      setOpen(false);
      setReason('');
      onChanged();
    } catch (err) {
      console.error('[BlockToggle] request failed:', err);
      toast.error(t('networkError'));
    } finally {
      setPending(false);
    }
  }

  if (blocked) {
    return (
      <Button
        variant="outline"
        size={size}
        disabled={pending}
        onClick={() => submit(false)}
      >
        {pending ? <Loader2 className="animate-spin" /> : <LockOpen />}
        {target === 'account' ? t('unblockAccount') : t('unblockUser')}
      </Button>
    );
  }

  const isDisabled = Boolean(disabledReason);

  return (
    <>
      <Button
        variant="destructive"
        size={size}
        disabled={isDisabled || pending}
        title={disabledReason ?? undefined}
        onClick={() => setOpen(true)}
      >
        <Lock />
        {target === 'account' ? t('blockAccount') : t('blockUser')}
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="border-border bg-popover sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-popover-foreground">
              {target === 'account'
                ? t('confirmBlockAccountTitle')
                : t('confirmBlockUserTitle')}
            </DialogTitle>
            <DialogDescription className="text-muted-foreground">
              {target === 'account'
                ? t('confirmBlockAccountBody')
                : t('confirmBlockUserBody')}
            </DialogDescription>
          </DialogHeader>

          {target === 'user' && isAccountOwner ? (
            <p className="text-destructive text-sm">
              {t('confirmBlockOwnerWarning')}
            </p>
          ) : null}

          <div className="space-y-2">
            <Label htmlFor="block-reason">{t('reasonLabel')}</Label>
            <Textarea
              id="block-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder={t('reasonPlaceholder')}
              rows={3}
            />
          </div>

          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => setOpen(false)}
              disabled={pending}
            >
              {t('cancel')}
            </Button>
            <Button
              variant="destructive"
              onClick={() => submit(true)}
              disabled={pending}
            >
              {pending ? <Loader2 className="animate-spin" /> : null}
              {t('confirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
