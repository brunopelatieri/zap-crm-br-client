'use client';

// Apagar respostas (SPEC 085 §4.4): selecionadas ou todas, com confirmação
// digitando o NOME do formulário. Definitivo: apaga também os arquivos.
// O servidor confere o nome de novo (`confirm_name`).

import { Loader2 } from 'lucide-react';
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';

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

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  formId: string;
  formName: string;
  /** `null` = todas as respostas do formulário. */
  ids: string[] | null;
  onDeleted: (count: number) => void;
}

export function DeleteResponsesDialog({
  open,
  onOpenChange,
  formId,
  formName,
  ids,
  onDeleted,
}: Props) {
  const t = useTranslations('Forms.responses.delete');
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const matches = typed.trim() === formName.trim();

  async function submit() {
    if (!matches) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/forms/${formId}/responses/delete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...(ids ? { ids } : { all: true }),
          confirm_name: typed.trim(),
        }),
      });
      if (!res.ok) {
        toast.error(t('error'));
        return;
      }
      const body = (await res.json()) as { deleted: number };
      toast.success(t('success', { count: body.deleted }));
      setTyped('');
      onDeleted(body.deleted);
      onOpenChange(false);
    } catch (err) {
      console.error(err);
      toast.error(t('error'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (busy) return;
        if (!v) setTyped('');
        onOpenChange(v);
      }}
    >
      <DialogContent className="bg-popover text-popover-foreground sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
          <DialogDescription>
            {ids
              ? t('descriptionSelected', { count: ids.length })
              : t('descriptionAll')}
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-1.5">
          <label
            className="text-muted-foreground text-sm"
            htmlFor="delete-confirm"
          >
            {t('confirmLabel', { name: formName })}
          </label>
          <Input
            id="delete-confirm"
            value={typed}
            autoComplete="off"
            placeholder={t('confirmPlaceholder')}
            onChange={(e) => setTyped(e.target.value)}
          />
        </div>

        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={busy}
          >
            {t('cancel')}
          </Button>
          <Button
            variant="destructive"
            onClick={() => void submit()}
            disabled={!matches || busy}
          >
            {busy ? <Loader2 className="animate-spin" /> : null}
            {busy ? t('deleting') : t('submit')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
