'use client';

// ============================================================
// Cartão compacto "Formulários" do painel do inbox (SPEC 085 §4.4, F4): a
// ÚLTIMA resposta concluída do contato, com os 3 primeiros blocos. O botão
// "Enviar formulário" NÃO mora aqui: é da SPEC 086.
//
// Conta sem o item no plano (403 `FEATURE_NOT_IN_PLAN`) ou erro de carga
// de papel: o cartão simplesmente não aparece — o inbox não ganha aviso de
// recurso que a conta não tem.
// ============================================================

import { ClipboardList } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { useFormatter, useTranslations } from 'next-intl';

import { ResponseDetailSheet } from '@/components/forms/responses/response-detail';
import type {
  ContactResponsesPayload,
  ResponseRow,
} from '@/components/forms/responses/types';
import { firstEntries } from '@/lib/forms/response-display';

type State =
  | { contactId: string; kind: 'ok'; data: ContactResponsesPayload }
  | { contactId: string; kind: 'hidden' }
  | { contactId: string; kind: 'error' };

export function ContactFormsCard({ contactId }: { contactId: string }) {
  const t = useTranslations('Inbox.formsCard');
  const tr = useTranslations('Forms.responses');
  const format = useFormatter();
  const [state, setState] = useState<State | null>(null);
  const [open, setOpen] = useState<ResponseRow | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    (async () => {
      try {
        const res = await fetch(
          `/api/contacts/${contactId}/form-responses?status=completed&limit=1`,
          { signal: controller.signal }
        );
        if (res.status === 403) {
          setState({ contactId, kind: 'hidden' });
          return;
        }
        if (!res.ok) throw new Error(String(res.status));
        setState({
          contactId,
          kind: 'ok',
          data: (await res.json()) as ContactResponsesPayload,
        });
      } catch (err) {
        if ((err as Error).name === 'AbortError') return;
        console.error(err);
        setState({ contactId, kind: 'error' });
      }
    })();
    return () => controller.abort();
  }, [contactId]);

  const labels = useMemo(
    () => ({ yes: tr('values.yes'), no: tr('values.no') }),
    [tr]
  );

  const current = state && state.contactId === contactId ? state : null;
  // Nada enquanto o estado não é conhecido: conta sem o item no plano (403)
  // não vê o cartão piscar a cada conversa.
  if (!current || current.kind === 'hidden') return null;

  const last = current?.kind === 'ok' ? current.data.responses[0] : undefined;
  const order =
    current?.kind === 'ok' && last
      ? (current.data.fieldOrders[last.form_id] ?? [])
      : [];
  const preview = last ? firstEntries(last.answers, order, 3, labels) : [];

  return (
    <section
      aria-label={t('title')}
      className="border-border bg-card rounded-lg border p-3"
    >
      <div className="text-muted-foreground flex items-center gap-2 text-xs font-medium tracking-wider uppercase">
        <ClipboardList className="h-3 w-3" aria-hidden />
        {t('title')}
      </div>

      {current.kind === 'error' ? (
        <p className="text-destructive mt-2 text-xs" role="alert">
          {t('loadError')}
        </p>
      ) : !last ? (
        <p className="text-muted-foreground mt-2 text-xs">{t('empty')}</p>
      ) : (
        <div className="mt-2">
          <button
            type="button"
            onClick={() => setOpen(last)}
            className="hover:bg-muted -mx-1 w-[calc(100%+0.5rem)] rounded-md px-1 py-1 text-left transition-colors"
          >
            <span className="text-foreground block truncate text-sm font-medium">
              {last.forms?.name ?? tr('detail.form')}
            </span>
            <span className="text-muted-foreground block text-xs">
              {t('answeredWhen', {
                when: format.relativeTime(
                  new Date(last.completed_at ?? last.started_at)
                ),
              })}
              {last.score !== null
                ? ` · ${t('score', { score: last.score })}`
                : ''}
            </span>
            {preview.length > 0 ? (
              <dl className="mt-1.5 space-y-0.5">
                {preview.map((p) => (
                  <div key={p.key} className="text-xs">
                    <dt className="text-muted-foreground inline">
                      {p.label}:{' '}
                    </dt>
                    <dd className="text-foreground inline break-words">
                      {p.text}
                    </dd>
                  </div>
                ))}
              </dl>
            ) : null}
          </button>
          <Link
            href={`/contacts?contact=${contactId}&tab=forms`}
            className="text-primary mt-1 inline-block text-xs font-medium hover:underline"
          >
            {t('viewAll')}
          </Link>
        </div>
      )}

      {open ? (
        <ResponseDetailSheet
          open
          onOpenChange={(v) => {
            if (!v) setOpen(null);
          }}
          response={open}
          fieldOrder={
            current?.kind === 'ok'
              ? (current.data.fieldOrders[open.form_id] ?? [])
              : []
          }
          showForm
          description={open.forms?.name}
        />
      ) : null}
    </section>
  );
}
