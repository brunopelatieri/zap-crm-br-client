'use client';

// ============================================================
// DeleteAccountDialog — exclusão da conta pelo titular (SPEC 073 §6).
//
// O botão final só habilita com as três condições, nesta ordem de
// apresentação:
//   1. inventário lido (prop `inventory`, vem do painel);
//   2. caixa "já exportei o que precisava" marcada;
//   3. nome exato digitado E senha preenchida.
//
// Sucesso → signOut() → redireciona para /login?deleted=1.
// ============================================================

import { useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Loader2, Trash2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
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
import { useAuth } from '@/hooks/use-auth';
import { createClient } from '@/lib/supabase/client';
import type { AccountInventory } from './danger-zone';

export function DeleteAccountDialog({
  inventory,
  onOpenChange,
}: {
  inventory: AccountInventory | null;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations('Settings.danger');
  const router = useRouter();
  const { account } = useAuth();
  const accountName = account?.name ?? '';

  const [exported, setExported] = useState(false);
  const [confirmName, setConfirmName] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const inventoryReady = inventory !== null;
  const nameOk = confirmName === accountName;
  const canSubmit = inventoryReady && exported && nameOk && password.length > 0;
  const membersCount = inventory?.members ?? 0;

  async function handleDelete() {
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      const res = await fetch('/api/account/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirmName, password }),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        const code = payload?.code as string | undefined;
        const key =
          code === 'name_mismatch'
            ? 'errorNameMismatch'
            : code === 'bad_password'
              ? 'errorBadPassword'
              : code === 'not_owner'
                ? 'errorNotOwner'
                : 'errorGeneric';
        toast.error(t(key));
        return;
      }
      toast.success(t('success'));
      await createClient().auth.signOut();
      router.replace('/login?deleted=1');
    } catch (err) {
      console.error('[DeleteAccountDialog] delete error:', err);
      toast.error(t('errorGeneric'));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="border-border bg-popover sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-popover-foreground">
            {t('dialogTitle')}
          </DialogTitle>
          <DialogDescription className="text-muted-foreground">
            {t('irreversible')}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {membersCount > 0 ? (
            <p className="rounded-md bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-200">
              {t('membersWarning', { count: membersCount })}
            </p>
          ) : null}

          <div className="flex items-start gap-2">
            <Checkbox
              id="danger-exported-ack"
              checked={exported}
              onCheckedChange={(v) => setExported(v === true)}
            />
            <Label
              htmlFor="danger-exported-ack"
              className="text-muted-foreground text-sm leading-snug font-normal"
            >
              {t('exportedAck')}
            </Label>
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-1 pl-6 text-sm">
            <a href="/contacts" className="text-primary hover:underline">
              {t('exportContacts')}
            </a>
            <a href="/inbox" className="text-primary hover:underline">
              {t('exportConversations')}
            </a>
          </div>
          <p className="text-muted-foreground pl-6 text-xs">
            {t('exportHint')}
          </p>

          <div className="space-y-1.5">
            <Label
              htmlFor="danger-confirm-name"
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
              id="danger-confirm-name"
              value={confirmName}
              onChange={(e) => setConfirmName(e.target.value)}
              placeholder={accountName}
              autoComplete="off"
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="danger-password" className="text-muted-foreground">
              {t('passwordLabel')}
            </Label>
            <Input
              id="danger-password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
            />
          </div>
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            className="border-border text-muted-foreground hover:bg-muted"
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
  );
}
