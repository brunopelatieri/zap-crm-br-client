'use client';

import { useEffect, useRef, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Loader2 } from 'lucide-react';

interface ModelSuggestion {
  id: string;
  name: string;
  contextLength: number | null;
  supportsTools: boolean;
  promptPricePerM: number | null;
  completionPricePerM: number | null;
}

const DEBOUNCE_MS = 300;

/** Shown where the catalog has no value (not translatable text). */
const UNKNOWN = '\u2014';

function compact(n: number, locale: string): string {
  return new Intl.NumberFormat(locale, {
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(n);
}

function price(n: number | null): string {
  return n === null ? UNKNOWN : `$${n}`;
}

/**
 * Suggestions from the OpenRouter public catalog for the model field
 * (SPEC 089 D-2). Purely a convenience: picking one fills the field, but
 * the field itself stays free text and nothing here is an allow-list.
 * Fetches through `GET /api/ai/models` (cached an hour server-side).
 */
export function AiModelSuggest({
  query,
  disabled,
  onPick,
}: {
  /** Current text of the model field. */
  query: string;
  disabled?: boolean;
  onPick: (modelId: string) => void;
}) {
  const t = useTranslations('Agents.config');
  const locale = useLocale();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [models, setModels] = useState<ModelSuggestion[]>([]);
  const seq = useRef(0);

  useEffect(() => {
    if (!open || disabled) return;
    const mine = ++seq.current;
    // Show "searching" from the first keystroke, not only once the
    // debounce fires, so the empty state never flashes in between.
    setLoading(true);
    const timer = setTimeout(async () => {
      setFailed(false);
      try {
        const res = await fetch(
          `/api/ai/models?provider=openrouter&q=${encodeURIComponent(query.trim())}`
        );
        const data = await res.json().catch(() => null);
        if (mine !== seq.current) return; // a newer query superseded this one
        if (!res.ok || !Array.isArray(data?.models)) {
          setFailed(true);
          setModels([]);
        } else {
          setModels(data.models as ModelSuggestion[]);
        }
      } catch {
        if (mine === seq.current) {
          setFailed(true);
          setModels([]);
        }
      } finally {
        if (mine === seq.current) setLoading(false);
      }
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [open, query, disabled]);

  return (
    <div className="space-y-2">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        disabled={disabled}
        aria-expanded={open}
        className="text-primary text-xs font-medium hover:underline disabled:opacity-50"
      >
        {t('modelSearchHint')}
      </button>

      {open && (
        <div className="border-border rounded-md border">
          {loading && (
            <p className="text-muted-foreground flex items-center gap-2 px-3 py-2 text-xs">
              <Loader2 className="h-3 w-3 animate-spin" />
              {t('modelsLoading')}
            </p>
          )}
          {!loading && failed && (
            <p className="text-muted-foreground px-3 py-2 text-xs">
              {t('modelsFailed')}
            </p>
          )}
          {!loading && !failed && models.length === 0 && (
            <p className="text-muted-foreground px-3 py-2 text-xs">
              {t('modelsNone')}
            </p>
          )}
          {!loading && models.length > 0 && (
            <ul className="divide-border max-h-64 divide-y overflow-y-auto">
              {models.map((m) => (
                <li key={m.id}>
                  <button
                    type="button"
                    onClick={() => {
                      onPick(m.id);
                      setOpen(false);
                    }}
                    className="hover:bg-muted/60 w-full px-3 py-2 text-left"
                  >
                    <span className="flex items-center justify-between gap-2">
                      <span className="text-foreground truncate text-sm font-medium">
                        {m.id}
                      </span>
                      <span
                        className={
                          m.supportsTools
                            ? 'text-primary flex-shrink-0 text-[10px] font-medium uppercase'
                            : 'text-muted-foreground flex-shrink-0 text-[10px] uppercase'
                        }
                      >
                        {m.supportsTools ? t('toolsBadge') : t('noToolsBadge')}
                      </span>
                    </span>
                    <span className="text-muted-foreground block truncate text-xs">
                      {m.name}
                      {' — '}
                      {t('modelMeta', {
                        context:
                          m.contextLength === null
                            ? UNKNOWN
                            : compact(m.contextLength, locale),
                        prompt: price(m.promptPricePerM),
                        completion: price(m.completionPricePerM),
                      })}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
