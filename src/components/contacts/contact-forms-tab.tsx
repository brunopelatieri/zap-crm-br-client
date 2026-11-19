'use client';

// ============================================================
// Aba "Formulários" da ficha do contato (SPEC 085 §4.4, F4): as respostas do
// contato em TODOS os formulários, com o mesmo painel de detalhe da tela de
// respostas. `viewer`+ lê; conta sem o item no plano recebe 403
// `FEATURE_NOT_IN_PLAN` da rota e vê o aviso.
// ============================================================

import { ClipboardList, Loader2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useFormatter, useTranslations } from 'next-intl';

import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { ResponseDetailSheet } from '@/components/forms/responses/response-detail';
import { STATUS_BADGE } from '@/components/forms/responses/status-style';
import type {
  ContactResponsesPayload,
  ResponseRow,
} from '@/components/forms/responses/types';
import { firstEntries } from '@/lib/forms/response-display';

type State =
  | { key: string; kind: 'ok'; data: ContactResponsesPayload }
  | { key: string; kind: 'not_in_plan' }
  | { key: string; kind: 'error' };

export function ContactFormsTab({ contactId }: { contactId: string }) {
  const t = useTranslations('Contacts.formsTab');
  const tr = useTranslations('Forms.responses');
  const format = useFormatter();
  const [includeIncomplete, setIncludeIncomplete] = useState(false);
  const [state, setState] = useState<State | null>(null);
  const [open, setOpen] = useState<ResponseRow | null>(null);

  const key = `${contactId}:${includeIncomplete}`;

  useEffect(() => {
    const controller = new AbortController();
    (async () => {
      try {
        const status = includeIncomplete
          ? 'completed,partial,abandoned'
          : 'completed';
        const res = await fetch(
          `/api/contacts/${contactId}/form-responses?status=${status}&limit=50`,
          { signal: controller.signal }
        );
        if (res.status === 403) {
          const body = (await res.json().catch(() => ({}))) as {
            error?: string;
          };
          setState({
            key,
            kind:
              body.error === 'FEATURE_NOT_IN_PLAN' ? 'not_in_plan' : 'error',
          });
          return;
        }
        if (!res.ok) throw new Error(String(res.status));
        setState({
          key,
          kind: 'ok',
          data: (await res.json()) as ContactResponsesPayload,
        });
      } catch (err) {
        if ((err as Error).name === 'AbortError') return;
        console.error(err);
        setState({ key, kind: 'error' });
      }
    })();
    return () => controller.abort();
    // `key` resume contactId e includeIncomplete.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const current = state && state.key === key ? state : null;
  const labels = useMemo(
    () => ({ yes: tr('values.yes'), no: tr('values.no') }),
    [tr]
  );

  if (!current) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="text-primary size-5 animate-spin" />
      </div>
    );
  }
  if (current.kind === 'not_in_plan') {
    return <p className="text-muted-foreground text-sm">{t('notInPlan')}</p>;
  }
  if (current.kind === 'error') {
    return (
      <p className="text-destructive text-sm" role="alert">
        {t('loadError')}
      </p>
    );
  }

  const { responses, fieldOrders } = current.data;

  return (
    <div className="space-y-3">
      <label className="text-muted-foreground flex items-center gap-2 text-xs">
        <Checkbox
          checked={includeIncomplete}
          onCheckedChange={(on) => setIncludeIncomplete(on === true)}
        />
        {t('showIncomplete')}
      </label>

      {responses.length === 0 ? (
        <div className="flex flex-col items-center gap-2 py-8 text-center">
          <ClipboardList className="text-muted-foreground size-6" aria-hidden />
          <p className="text-muted-foreground text-sm">{t('empty')}</p>
        </div>
      ) : (
        <ul className="space-y-2">
          {responses.map((r) => {
            const when = format.relativeTime(
              new Date(r.completed_at ?? r.started_at)
            );
            const preview = firstEntries(
              r.answers,
              fieldOrders[r.form_id] ?? [],
              2,
              labels
            );
            return (
              <li key={r.id}>
                <button
                  type="button"
                  onClick={() => setOpen(r)}
                  className="border-border bg-card hover:border-primary/40 w-full rounded-lg border p-3 text-left transition-colors"
                >
                  <div className="flex items-start justify-between gap-2">
                    <span className="text-foreground truncate text-sm font-medium">
                      {r.forms?.name ?? tr('detail.form')}
                    </span>
                    <Badge
                      variant="outline"
                      className={`shrink-0 text-[10px] ${STATUS_BADGE[r.status]}`}
                    >
                      {tr(`status.${r.status}`)}
                    </Badge>
                  </div>
                  <p className="text-muted-foreground mt-0.5 text-xs">
                    {r.status === 'completed'
                      ? t('answeredWhen', { when })
                      : t('startedWhen', { when })}
                    {r.score !== null ? ` · ${r.score}` : ''}
                  </p>
                  {preview.length > 0 ? (
                    <p className="text-muted-foreground mt-1.5 truncate text-xs">
                      {preview.map((p) => `${p.label}: ${p.text}`).join(' · ')}
                    </p>
                  ) : null}
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {open ? (
        <ResponseDetailSheet
          open
          onOpenChange={(v) => {
            if (!v) setOpen(null);
          }}
          response={open}
          fieldOrder={fieldOrders[open.form_id] ?? []}
          showForm
          description={open.forms?.name}
        />
      ) : null}
    </div>
  );
}
