'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { History, Loader2 } from 'lucide-react';
import { format, parseISO } from 'date-fns';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { getDateFnsLocale } from '@/lib/i18n/date-fns-locale';
import { diffLines, type PromptVersion } from '@/lib/ai/prompt-versions';

/** Sentinels for the "compare with" select (a version id is a uuid). */
const CURRENT = '__current__';
const PREVIOUS = '__previous__';

/**
 * Prompt history dialog (SPEC 089 F1): list the versions, compare one
 * with the live prompt (or with the previous version) and restore it.
 * Restoring goes through the API, which appends a new version.
 */
export function AiPromptVersionsDialog({
  open,
  onOpenChange,
  currentPrompt,
  hasUnsavedEdits,
  onRestored,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The saved prompt text (what is live for the agent). */
  currentPrompt: string;
  /** The prompt field has edits that are not saved yet. */
  hasUnsavedEdits: boolean;
  /** Called after a successful restore so the screen reloads the config. */
  onRestored: () => void;
}) {
  const t = useTranslations('Agents.promptVersions');
  const dateFnsLocale = getDateFnsLocale(useLocale());

  const [loading, setLoading] = useState(false);
  const [versions, setVersions] = useState<PromptVersion[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [compareWith, setCompareWith] = useState<string>(CURRENT);
  const [restoring, setRestoring] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/ai/prompt-versions', {
        cache: 'no-store',
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !Array.isArray(data?.versions)) {
        toast.error(data?.error ?? t('loadFailed'));
        setVersions([]);
        return;
      }
      setVersions(data.versions as PromptVersion[]);
    } catch {
      toast.error(t('loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    if (!open) return;
    setSelectedId(null);
    setCompareWith(CURRENT);
    void load();
  }, [open, load]);

  const label = (v: PromptVersion) =>
    format(parseISO(v.created_at), 'PPp', { locale: dateFnsLocale });

  const selectedIndex = versions.findIndex((v) => v.id === selectedId);
  const selected = selectedIndex >= 0 ? versions[selectedIndex] : null;

  // What the selected version is compared AGAINST (shown as the "from").
  const base = useMemo(() => {
    if (!selected) return null;
    if (compareWith === CURRENT) return currentPrompt.trim();
    if (compareWith === PREVIOUS) {
      // Versions are newest-first, so the previous one is the next index.
      return versions[selectedIndex + 1]?.system_prompt ?? '';
    }
    return versions.find((v) => v.id === compareWith)?.system_prompt ?? '';
  }, [selected, compareWith, currentPrompt, versions, selectedIndex]);

  const diff = useMemo(
    () =>
      selected && base !== null ? diffLines(base, selected.system_prompt) : [],
    [selected, base]
  );
  const hasDifferences = diff.some((l) => l.type !== 'same');

  const handleRestore = async () => {
    if (!selected) return;
    setRestoring(true);
    try {
      const res = await fetch(
        `/api/ai/prompt-versions/${selected.id}/restore`,
        { method: 'POST' }
      );
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        toast.error(data?.error ?? t('restoreFailed'));
        return;
      }
      toast.success(
        data?.changed === false ? t('restoredNoChange') : t('restored')
      );
      onRestored();
      onOpenChange(false);
    } catch {
      toast.error(t('restoreFailed'));
    } finally {
      setRestoring(false);
    }
  };

  const noteText = (v: PromptVersion) =>
    v.note?.startsWith('restore:') ? t('restoreNote') : (v.note ?? '');

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <History className="h-4 w-4" /> {t('title')}
          </DialogTitle>
          <DialogDescription>{t('description')}</DialogDescription>
        </DialogHeader>

        {hasUnsavedEdits && (
          <p className="border-border bg-muted/40 text-muted-foreground rounded-md border px-3 py-2 text-xs">
            {t('unsavedWarning')}
          </p>
        )}

        {loading ? (
          <div className="text-muted-foreground flex items-center justify-center py-10">
            <Loader2 className="h-4 w-4 animate-spin" />
          </div>
        ) : versions.length === 0 ? (
          <p className="text-muted-foreground py-8 text-center text-sm">
            {t('empty')}
          </p>
        ) : (
          <div className="grid gap-4 md:grid-cols-[14rem_1fr]">
            <ul className="border-border divide-border max-h-80 divide-y overflow-y-auto rounded-md border">
              {versions.map((v) => (
                <li key={v.id}>
                  <button
                    type="button"
                    onClick={() => setSelectedId(v.id)}
                    className={`hover:bg-muted/60 w-full px-3 py-2 text-left text-sm ${
                      v.id === selectedId ? 'bg-muted' : ''
                    }`}
                  >
                    <span className="text-foreground block font-medium">
                      {label(v)}
                    </span>
                    <span className="text-muted-foreground block text-xs">
                      {v.source === 'api' ? t('sourceApi') : t('sourcePanel')}
                      {noteText(v) ? ` · ${noteText(v)}` : ''}
                    </span>
                  </button>
                </li>
              ))}
            </ul>

            <div className="min-w-0 space-y-3">
              {!selected ? (
                <p className="text-muted-foreground py-8 text-center text-sm">
                  {t('pickOne')}
                </p>
              ) : (
                <>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-muted-foreground text-xs">
                      {t('compareWith')}
                    </span>
                    <Select
                      value={compareWith}
                      onValueChange={(v) => v && setCompareWith(v)}
                    >
                      <SelectTrigger className="w-56">
                        <SelectValue>
                          {() =>
                            compareWith === CURRENT
                              ? t('compareCurrent')
                              : compareWith === PREVIOUS
                                ? t('compareOlder')
                                : (() => {
                                    const v = versions.find(
                                      (x) => x.id === compareWith
                                    );
                                    return v
                                      ? t('versionLabel', { date: label(v) })
                                      : '';
                                  })()
                          }
                        </SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={CURRENT}>
                          {t('compareCurrent')}
                        </SelectItem>
                        <SelectItem value={PREVIOUS}>
                          {t('compareOlder')}
                        </SelectItem>
                        {versions
                          .filter((v) => v.id !== selected.id)
                          .map((v) => (
                            <SelectItem key={v.id} value={v.id}>
                              {t('versionLabel', { date: label(v) })}
                            </SelectItem>
                          ))}
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="border-border max-h-64 overflow-y-auto rounded-md border font-mono text-xs">
                    {!hasDifferences ? (
                      <p className="text-muted-foreground p-3">
                        {selected.system_prompt === ''
                          ? t('emptyPrompt')
                          : t('noDifferences')}
                      </p>
                    ) : (
                      diff.map((l, i) => (
                        <div
                          key={i}
                          className={
                            l.type === 'added'
                              ? 'bg-emerald-500/10 px-3 py-0.5 whitespace-pre-wrap text-emerald-700 dark:text-emerald-300'
                              : l.type === 'removed'
                                ? 'bg-red-500/10 px-3 py-0.5 whitespace-pre-wrap text-red-700 line-through dark:text-red-300'
                                : 'text-muted-foreground px-3 py-0.5 whitespace-pre-wrap'
                          }
                        >
                          {l.type === 'added'
                            ? '+ '
                            : l.type === 'removed'
                              ? '- '
                              : '  '}
                          {l.text}
                        </div>
                      ))
                    )}
                  </div>

                  <div className="flex justify-end">
                    <Button onClick={handleRestore} disabled={restoring}>
                      {restoring && (
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      )}
                      {restoring ? t('restoring') : t('restore')}
                    </Button>
                  </div>
                </>
              )}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
