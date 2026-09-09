'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { AlertTriangle, Loader2 } from 'lucide-react';

import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';

interface DeleteMessageDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** O canal revoga "para todos" nesta mensagem — decide qual dos dois
   *  textos de corpo (§1.3/§7.2) aparece. */
  canRevoke: boolean;
  /** D-5: mais de 48h — o WhatsApp pode não remover do aparelho. */
  warnStaleness: boolean;
  /** Admin/owner: a escolha extra do D-14. Agente nunca vê isto — para
   *  ele, apagar sempre marca. */
  canPurge: boolean;
  /**
   * A mensagem JÁ está marcada — este diálogo foi aberto pelo item
   * "Excluir do sistema" da barra de ações (§7.1), não pelo primeiro
   * "Apagar". Não há mais escolha "manter marcada": a única ação aqui é
   * excluir (a retomada de revogação tem botão próprio, "Tentar de
   * novo", no rodapé do balão).
   */
  alreadyMarked?: boolean;
  onConfirm: (purge: boolean) => Promise<void>;
}

/**
 * O diálogo único de "Apagar mensagem" (SPEC 074 §7.2). Um gesto só
 * (D-1): não existe modo "apagar só no CRM" — o texto muda conforme o
 * canal revoga ou não, e é isso que decide o que vai acontecer, não uma
 * escolha do operador. A escolha que EXISTE (D-14) é só para admin/owner,
 * e é sobre o que fazer com o REGISTRO depois de marcado — manter
 * visível ou excluir do sistema —, nunca sobre revogar ou não.
 */
export function DeleteMessageDialog({
  open,
  onOpenChange,
  canRevoke,
  warnStaleness,
  canPurge,
  alreadyMarked = false,
  onConfirm,
}: DeleteMessageDialogProps) {
  const t = useTranslations('Inbox.delete');
  const [option, setOption] = useState<'mark' | 'purge'>(
    alreadyMarked ? 'purge' : 'mark'
  );
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (open) setOption(alreadyMarked ? 'purge' : 'mark');
  }, [open, alreadyMarked]);

  // Já marcada: a única escolha possível aqui é excluir — não existe
  // "voltar a marcar" (a retomada de revogação é o botão "Tentar de
  // novo", fora deste diálogo).
  const showChoice = canPurge && !alreadyMarked;
  const willPurge = canPurge && (alreadyMarked || option === 'purge');

  const handleConfirm = async () => {
    if (submitting) return;
    setSubmitting(true);
    try {
      await onConfirm(willPurge);
      onOpenChange(false);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => !submitting && onOpenChange(next)}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('dialogTitle')}</DialogTitle>
        </DialogHeader>

        <p className="text-muted-foreground text-sm">
          {alreadyMarked
            ? t('optionPurgeHint')
            : canRevoke
              ? t('bodyRevoke')
              : t('bodyNoRevoke')}
        </p>

        {!alreadyMarked && warnStaleness && (
          <div className="flex items-start gap-2 rounded-lg bg-amber-500/10 px-3 py-2">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-400" />
            <p className="text-xs text-amber-400">{t('stalenessWarning')}</p>
          </div>
        )}

        {showChoice && (
          <RadioGroup
            value={option}
            onValueChange={(value) => setOption(value as 'mark' | 'purge')}
            className="gap-3 pt-1"
          >
            <label className="flex cursor-pointer items-start gap-2">
              <RadioGroupItem value="mark" className="mt-0.5" />
              <span className="text-sm">
                <span className="text-foreground font-medium">
                  {t('optionMark')}
                </span>{' '}
                <span className="text-muted-foreground">
                  — {t('optionMarkHint')}
                </span>
              </span>
            </label>
            <label className="flex cursor-pointer items-start gap-2">
              <RadioGroupItem value="purge" className="mt-0.5" />
              <span className="text-sm">
                <span className="text-destructive font-medium">
                  {t('optionPurge')}
                </span>{' '}
                <span className="text-muted-foreground">
                  — {t('optionPurgeHint')}
                </span>
              </span>
            </label>
          </RadioGroup>
        )}

        {/* A garantia pedida: o endpoint é disparado quando couber,
            independente da escolha acima. Não repete para a mensagem já
            marcada — o canal já foi anunciado no primeiro apagamento. */}
        {!alreadyMarked && (
          <p className="text-muted-foreground text-xs">
            {canRevoke ? t('channelNoteRevoke') : t('channelNoteNoRevoke')}
          </p>
        )}

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={submitting}
          >
            {t('cancel')}
          </Button>
          <Button
            variant={willPurge ? 'destructive' : 'default'}
            onClick={handleConfirm}
            disabled={submitting}
          >
            {submitting && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
            {willPurge ? t('confirmPurge') : t('confirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
