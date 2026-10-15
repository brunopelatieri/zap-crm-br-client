'use client';

// ============================================================
// EditUserIdentityDialog — editar nome e e-mail de um usuário
// (SPEC 078 §5, §9.3)
//
// Chama PATCH /api/platform/users/[id] mandando SÓ o que mudou: o
// servidor recusa `email_unchanged`, e um nome igual ao atual não gera
// escrita. A troca de e-mail é imediata e já confirmada (D-10) — os
// avisos do diálogo existem porque não há segunda chance depois do
// clique: o novo e-mail passa a ser o login na hora, e as sessões
// abertas NÃO caem (§5.4; para cortar acesso, bloquear o usuário).
// ============================================================

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';

import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { EMAIL_RE, normalizeEmail } from '@/lib/auth/email';
import { validateFullName } from '@/lib/platform/user-identity';

import { useConsoleErrorMessage } from './use-console-error';

export interface EditableMember {
  userId: string;
  fullName: string | null;
  email: string;
  role: string;
}

export function EditUserIdentityDialog({
  member,
  isPlatformOwner,
  onClose,
  onChanged,
}: {
  member: EditableMember;
  /** O alvo é o proprietário da plataforma: o e-mail dele fica travado. */
  isPlatformOwner: boolean;
  onClose: () => void;
  onChanged: () => void;
}) {
  const t = useTranslations('Platform.userIdentity');
  const tBlock = useTranslations('Platform.block');
  const errorMessage = useConsoleErrorMessage();

  const [fullName, setFullName] = useState(member.fullName ?? '');
  const [email, setEmail] = useState(member.email);
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);

  const nameChanged = fullName.trim() !== (member.fullName ?? '').trim();
  const emailChanged =
    !isPlatformOwner && normalizeEmail(email) !== normalizeEmail(member.email);

  const nameCheck = nameChanged ? validateFullName(fullName) : null;
  const nameError = nameCheck && !nameCheck.ok;
  const emailError = emailChanged && !EMAIL_RE.test(normalizeEmail(email));
  const canSubmit =
    (nameChanged || emailChanged) && !nameError && !emailError && !saving;

  async function handleSave() {
    setSaving(true);
    try {
      const res = await fetch(`/api/platform/users/${member.userId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fullName: nameChanged ? fullName.trim() : undefined,
          email: emailChanged ? normalizeEmail(email) : undefined,
          reason: reason.trim() || null,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        if (body.code === 'partial_update') {
          // O e-mail JÁ mudou: fecha e recarrega para mostrar o que ficou.
          toast.error(t('partial'));
          onChanged();
          return;
        }
        toast.error(errorMessage(body.code, t('failed')));
        return;
      }
      const body = await res.json().catch(() => ({}));
      toast.success(t('success'));
      // O e-mail mudou, mas o aviso ao endereço antigo não saiu (SMTP
      // com erro). `skipped` (SMTP desligado) é silencioso de propósito.
      if (body.oldEmailNotice === 'failed') toast.warning(t('noticeFailed'));
      onChanged();
    } catch (err) {
      console.error('[EditUserIdentityDialog] save failed:', err);
      toast.error(t('failed'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="border-border bg-popover sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-popover-foreground">
            {t('title', { name: member.fullName || t('unnamed') })}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="identity-name">{t('nameLabel')}</Label>
            <Input
              id="identity-name"
              value={fullName}
              maxLength={120}
              onChange={(e) => setFullName(e.target.value)}
              aria-invalid={nameError ? true : undefined}
            />
            {nameError ? (
              <p className="text-destructive text-xs">
                {errorMessage('name_invalid', '')}
              </p>
            ) : null}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="identity-email">{t('emailLabel')}</Label>
            <Input
              id="identity-email"
              type="email"
              value={email}
              disabled={isPlatformOwner}
              onChange={(e) => setEmail(e.target.value)}
              aria-invalid={emailError ? true : undefined}
            />
            {emailError ? (
              <p className="text-destructive text-xs">
                {errorMessage('email_invalid', '')}
              </p>
            ) : null}
            {isPlatformOwner ? (
              <p className="text-muted-foreground text-xs">
                {t('platformOwnerEmail')}
              </p>
            ) : null}
          </div>

          {emailChanged ? (
            <Alert className="border-amber-500/30 bg-amber-500/5">
              <AlertDescription className="space-y-1">
                {member.role === 'owner' ? (
                  <p className="font-medium">{t('ownerWarning')}</p>
                ) : null}
                <p>{t('immediateWarning')}</p>
                <p>{t('oldEmailSpamWarning')}</p>
                <p>{t('sessionsWarning')}</p>
              </AlertDescription>
            </Alert>
          ) : null}

          <div className="space-y-1.5">
            <Label>{t('reasonLabel')}</Label>
            <Textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={2}
              maxLength={500}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            {tBlock('cancel')}
          </Button>
          <Button
            onClick={handleSave}
            disabled={!canSubmit}
            title={
              !nameChanged && !emailChanged ? t('nothingChanged') : undefined
            }
          >
            {saving ? <Loader2 className="animate-spin" /> : null}
            {t('submit')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
