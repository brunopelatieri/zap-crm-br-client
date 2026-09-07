'use client';

// ============================================================
// DeleteAccountButton — Zona de risco do console (SPEC 073, extensão
// administrativa). Confirmação por digitar o nome exato da conta —
// sem senha do titular, porque o operador não a tem; a autorização é
// `requirePlatformOwner()` na rota (`/api/platform/accounts/[id]/delete`).
// ============================================================

import { useState, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Loader2, Trash2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

export function DeleteAccountButton({
  accountId,
  accountName,
  ownerEmail,
  size = 'sm',
  onDeleted,
}: {
  accountId: string;
  accountName: string;
  ownerEmail: string | null;
  size?: 'default' | 'sm';
  onDeleted: () => void;
}) {
  const t = useTranslations('Platform.deleteAccount');
  const [open, setOpen] = useState(false);
  const [confirmName, setConfirmName] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const canSubmit = confirmName === accountName;

  async function handleDelete() {
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      const res = await fetch(`/api/platform/accounts/${accountId}/delete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirmName }),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(
          typeof payload?.error === 'string' ? payload.error : t('failed')
        );
        return;
      }
      toast.success(t('success', { name: accountName }));
      setOpen(false);
      onDeleted();
    } catch (err) {
      console.error('[DeleteAccountButton] delete error:', err);
      toast.error(t('networkError'));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      <Button variant="destructive" size={size} onClick={() => setOpen(true)}>
        <Trash2 />
        {t('button')}
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="border-border bg-popover sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-popover-foreground">
              {t('dialogTitle', { name: accountName })}
            </DialogTitle>
            <DialogDescription className="text-muted-foreground">
              {t('irreversible')}
            </DialogDescription>
          </DialogHeader>

          {ownerEmail ? (
            <p className="text-muted-foreground text-sm">
              {t('ownerLabel', { email: ownerEmail })}
            </p>
          ) : null}

          <div className="space-y-1.5">
            <Label
              htmlFor="platform-delete-confirm"
              className="text-muted-foreground"
            >
              {t.rich('confirmNameLabel', {
                name: accountName,
                bold: (chunks: ReactNode) => (
                  <span className="text-foreground font-medium">{chunks}</span>
                ),
              })}
            </Label>
            <Input
              id="platform-delete-confirm"
              value={confirmName}
              onChange={(e) => setConfirmName(e.target.value)}
              placeholder={accountName}
              autoComplete="off"
            />
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setOpen(false)}
              className="border-border text-muted-foreground hover:bg-muted"
              disabled={submitting}
            >
              {t('cancel')}
            </Button>
            <Button
              onClick={handleDelete}
              disabled={!canSubmit || submitting}
              className="bg-red-600 text-white hover:bg-red-700"
            >
              {submitting ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Trash2 className="size-4" />
              )}
              {submitting ? t('deleting') : t('button')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
