'use client';

/**
 * Diálogo de exportação de conversa (SPEC 067 §10). Molde de
 * `contacts/export-modal.tsx` (Dialog, RadioGroup, fetch→blob→download,
 * toast) — a diferença de fundo é que aqui não há painel de resultado
 * dentro do modal: em caso de sucesso o modal fecha e o navegador já
 * está baixando o arquivo.
 *
 * "Resumo" (nº de mensagens/anexos) vem do que a thread JÁ tem em
 * memória (`messages`), sem chamada extra — é só uma prévia; a rota
 * conta de novo antes de gerar.
 */

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Download, FileArchive, FileText, Loader2 } from 'lucide-react';

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import type { Message } from '@/types';

type ExportFormat = 'pdf' | 'zip';
type PeriodMode = 'all' | 'range';

const ATTACHMENT_CONTENT_TYPES = new Set([
  'image',
  'video',
  'audio',
  'document',
]);

interface ExportConversationDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  conversationId: string;
  /** Já em memória na thread — a prévia não custa uma chamada extra. */
  messages: Message[];
}

/** `<input type="date">` devolve `AAAA-MM-DD` puro — a rota expande
 *  isso para o dia inteiro NO FUSO informado (D-7), então não há nada
 *  a converter aqui além de mandar o fuso do navegador junto. */
function todayLocalDate(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export function ExportConversationDialog({
  open,
  onOpenChange,
  conversationId,
  messages,
}: ExportConversationDialogProps) {
  const t = useTranslations('Inbox.exportConversation');

  const [format, setFormat] = useState<ExportFormat>('pdf');
  const [periodMode, setPeriodMode] = useState<PeriodMode>('all');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    if (!open) return;
    setFormat('pdf');
    setPeriodMode('all');
    const today = todayLocalDate();
    setFrom(today);
    setTo(today);
    setExporting(false);
  }, [open]);

  const attachmentCount = messages.filter((m) =>
    ATTACHMENT_CONTENT_TYPES.has(m.content_type)
  ).length;

  function handleOpenChange(next: boolean) {
    if (!exporting) onOpenChange(next);
  }

  async function handleExport() {
    if (exporting) return;
    if (periodMode === 'range' && from && to && from > to) {
      toast.error(t('errorGeneric'));
      return;
    }

    setExporting(true);
    try {
      const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const res = await fetch(
        `/api/inbox/conversations/${conversationId}/export`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            format,
            timeZone,
            ...(periodMode === 'range' && from ? { from } : {}),
            ...(periodMode === 'range' && to ? { to } : {}),
          }),
        }
      );

      if (!res.ok) {
        if (res.status === 413) {
          toast.error(t('errorTooLarge'));
        } else if (res.status === 429) {
          const data = (await res.json().catch(() => null)) as {
            retry_after_seconds?: number;
          } | null;
          const minutes = Math.ceil((data?.retry_after_seconds ?? 60) / 60);
          toast.error(t('errorRateLimited', { minutes }));
        } else {
          toast.error(t('errorGeneric'));
        }
        return;
      }

      const disposition = res.headers.get('Content-Disposition') ?? '';
      const filenameMatch = /filename="([^"]+)"/.exec(disposition);
      const filename = filenameMatch?.[1] ?? `conversa.${format}`;
      const missingCount = Number(
        res.headers.get('X-Export-Media-Missing') ?? '0'
      );

      const blob = await res.blob();
      const url = URL.createObjectURL(blob);

      // O anchor precisa estar no documento para o click() disparar o
      // download no Firefox — não basta criar o elemento solto.
      const link = document.createElement('a');
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();

      // Revogar na próxima tarefa: revogar em seguida ao clique cancela
      // o download que o navegador ainda não começou a ler.
      setTimeout(() => URL.revokeObjectURL(url), 0);

      if (missingCount > 0) {
        toast.success(t('successWithMissing', { count: missingCount }));
      } else {
        toast.success(t('success'));
      }
      handleOpenChange(false);
    } catch {
      toast.error(t('networkError'));
    } finally {
      setExporting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="border-border/80 bg-popover text-popover-foreground sm:max-w-md">
        <DialogHeader className="gap-1.5">
          <DialogTitle className="text-popover-foreground text-lg">
            {t('title')}
          </DialogTitle>
          <DialogDescription className="text-muted-foreground leading-relaxed">
            {t('description')}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5 py-2">
          {/* Formato */}
          <div className="space-y-2">
            <p className="text-muted-foreground text-[11px] font-semibold tracking-[0.14em] uppercase">
              {t('formatLabel')}
            </p>
            <RadioGroup
              value={format}
              onValueChange={(value) => setFormat(value as ExportFormat)}
              className="grid grid-cols-1 gap-2 sm:grid-cols-2"
            >
              <label className="border-border hover:bg-muted/40 flex cursor-pointer items-start gap-2 rounded-lg border p-3">
                <RadioGroupItem value="pdf" className="mt-0.5" />
                <span className="flex items-center gap-1.5 text-sm font-medium">
                  <FileText className="text-primary size-3.5" />
                  {t('formatPdf')}
                </span>
              </label>
              <label className="border-border hover:bg-muted/40 flex cursor-pointer items-start gap-2 rounded-lg border p-3">
                <RadioGroupItem value="zip" className="mt-0.5" />
                <span className="flex items-center gap-1.5 text-sm font-medium">
                  <FileArchive className="text-primary size-3.5" />
                  {t('formatZip')}
                  {attachmentCount > 0 && (
                    <span className="text-muted-foreground font-normal">
                      ({attachmentCount})
                    </span>
                  )}
                </span>
              </label>
            </RadioGroup>
          </div>

          {/* Período */}
          <div className="space-y-2">
            <p className="text-muted-foreground text-[11px] font-semibold tracking-[0.14em] uppercase">
              {t('periodLabel')}
            </p>
            <RadioGroup
              value={periodMode}
              onValueChange={(value) => setPeriodMode(value as PeriodMode)}
              className="gap-1.5"
            >
              <label className="flex cursor-pointer items-center gap-2 text-sm">
                <RadioGroupItem value="all" />
                <span className="text-popover-foreground">
                  {t('periodAllOption')}
                </span>
              </label>
              <label className="flex cursor-pointer items-center gap-2 text-sm">
                <RadioGroupItem value="range" />
                <span className="text-popover-foreground">
                  {t('periodRangeOption')}
                </span>
              </label>
            </RadioGroup>

            {periodMode === 'range' && (
              <div className="grid grid-cols-2 gap-3 pt-1 pl-6">
                <div className="space-y-1">
                  <Label
                    htmlFor="export-conversation-from"
                    className="text-muted-foreground text-xs"
                  >
                    {t('from')}
                  </Label>
                  <Input
                    id="export-conversation-from"
                    type="date"
                    value={from}
                    max={to || undefined}
                    onChange={(e) => setFrom(e.target.value)}
                    className="border-border bg-muted text-foreground"
                  />
                </div>
                <div className="space-y-1">
                  <Label
                    htmlFor="export-conversation-to"
                    className="text-muted-foreground text-xs"
                  >
                    {t('to')}
                  </Label>
                  <Input
                    id="export-conversation-to"
                    type="date"
                    value={to}
                    min={from || undefined}
                    onChange={(e) => setTo(e.target.value)}
                    className="border-border bg-muted text-foreground"
                  />
                </div>
              </div>
            )}
          </div>

          <p className="text-muted-foreground text-xs">
            {t('summary', {
              messages: messages.length,
              attachments: attachmentCount,
            })}
          </p>
        </div>

        <DialogFooter className="gap-2 sm:justify-end">
          <Button
            type="button"
            variant="outline"
            onClick={() => handleOpenChange(false)}
            disabled={exporting}
            className="border-border text-muted-foreground hover:bg-muted"
          >
            {t('cancel')}
          </Button>
          <Button
            type="button"
            disabled={exporting}
            onClick={handleExport}
            className="bg-primary hover:bg-primary/90 text-primary-foreground"
          >
            {exporting ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Download className="size-4" />
            )}
            {exporting ? t('generating') : t('submit')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
