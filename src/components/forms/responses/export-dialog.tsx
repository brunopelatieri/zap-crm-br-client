'use client';

// Exportar respostas (SPEC 085 §4.4): CSV ou XLSX, escopo = filtros atuais ou
// as linhas marcadas, colunas = perguntas escolhidas. A rota é `admin`+ e
// grava a trilha em `contact_exports`; aqui só dispara o download.

import { Loader2 } from 'lucide-react';
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';

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

import { filenameFromDisposition } from '@/lib/forms/response-export';

import type { BlockMeta } from './types';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  formId: string;
  blocks: BlockMeta[];
  /** `scope.filter` da rota: os filtros atuais da tela. */
  filter: Record<string, string>;
  selectedIds: string[];
}

export function ExportDialog({
  open,
  onOpenChange,
  formId,
  blocks,
  filter,
  selectedIds,
}: Props) {
  const t = useTranslations('Forms.responses.export');
  const [format, setFormat] = useState<'csv' | 'xlsx'>('xlsx');
  const [scope, setScope] = useState<'filter' | 'selection'>(
    selectedIds.length > 0 ? 'selection' : 'filter'
  );
  const [chosen, setChosen] = useState<string[] | null>(null); // null = todas
  const [busy, setBusy] = useState(false);

  const effectiveScope = selectedIds.length > 0 ? scope : 'filter';
  const isChecked = (key: string) => chosen === null || chosen.includes(key);

  function toggle(key: string, on: boolean) {
    const base = chosen ?? blocks.map((b) => b.key);
    const next = on
      ? [...new Set([...base, key])]
      : base.filter((k) => k !== key);
    setChosen(next.length === blocks.length ? null : next);
  }

  async function submit() {
    setBusy(true);
    try {
      const res = await fetch(`/api/forms/${formId}/responses/export`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          format,
          scope:
            effectiveScope === 'selection'
              ? { mode: 'selection', ids: selectedIds }
              : { mode: 'filter', filter },
          ...(chosen ? { columns: chosen } : {}),
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          error?: string;
          total?: number;
        };
        toast.error(
          body.error === 'export_too_large'
            ? t('tooLarge', { total: body.total ?? 0 })
            : t('error')
        );
        return;
      }
      const count = Number(res.headers.get('X-Export-Row-Count') ?? 0);
      const blob = await res.blob();
      const name = filenameFromDisposition(
        res.headers.get('Content-Disposition'),
        `${t('filenamePrefix')}.${format}`
      );
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      toast.success(t('success', { count }));
      onOpenChange(false);
    } catch (err) {
      console.error(err);
      toast.error(t('error'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !busy && onOpenChange(v)}>
      <DialogContent className="bg-popover text-popover-foreground sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
          <DialogDescription>{t('description')}</DialogDescription>
        </DialogHeader>

        <fieldset className="grid gap-2">
          <legend className="text-muted-foreground mb-1 text-sm">
            {t('format')}
          </legend>
          <div className="flex gap-4">
            {(['xlsx', 'csv'] as const).map((f) => (
              <label key={f} className="flex items-center gap-2 text-sm">
                <input
                  type="radio"
                  name="export-format"
                  checked={format === f}
                  onChange={() => setFormat(f)}
                />
                {t(f)}
              </label>
            ))}
          </div>
        </fieldset>

        {selectedIds.length > 0 ? (
          <fieldset className="grid gap-2">
            <legend className="text-muted-foreground mb-1 text-sm">
              {t('scope')}
            </legend>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="radio"
                name="export-scope"
                checked={effectiveScope === 'selection'}
                onChange={() => setScope('selection')}
              />
              {t('scopeSelection', { count: selectedIds.length })}
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="radio"
                name="export-scope"
                checked={effectiveScope === 'filter'}
                onChange={() => setScope('filter')}
              />
              {t('scopeFilter')}
            </label>
          </fieldset>
        ) : (
          <p className="text-sm">{t('scopeFilter')}</p>
        )}

        {blocks.length > 0 ? (
          <fieldset className="grid gap-2">
            <legend className="text-muted-foreground mb-1 text-sm">
              {t('columns')}
            </legend>
            <label className="flex items-center gap-2 text-sm font-medium">
              <Checkbox
                checked={chosen === null}
                onCheckedChange={(on) => setChosen(on ? null : [])}
              />
              {t('allColumns')}
            </label>
            <div className="border-border max-h-40 space-y-1.5 overflow-y-auto rounded-md border p-2">
              {blocks.map((b) => (
                <label key={b.key} className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={isChecked(b.key)}
                    onCheckedChange={(on) => toggle(b.key, on === true)}
                  />
                  <span className="truncate">{b.label}</span>
                </label>
              ))}
            </div>
          </fieldset>
        ) : null}

        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={busy}
          >
            {t('cancel')}
          </Button>
          <Button onClick={() => void submit()} disabled={busy}>
            {busy ? <Loader2 className="animate-spin" /> : null}
            {busy ? t('exporting') : t('submit')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
