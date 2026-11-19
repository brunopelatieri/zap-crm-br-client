'use client';

// ============================================================
// Detalhe de uma resposta (SPEC 085 §4.4, F4): todos os blocos com o
// RÓTULO DO INSTANTÂNEO (editar o formulário depois não muda o que foi
// respondido), arquivos (rota que redireciona para URL assinada de 10 min,
// sempre como download), contato, negócio criado e origem.
//
// `ResponseDetailBody` é só o conteúdo; `ResponseDetailSheet` o embrulha
// num painel lateral. A tela de respostas e a aba `forms` da ficha do
// contato usam os dois.
// ============================================================

import { Download, ExternalLink, FileText } from 'lucide-react';
import Link from 'next/link';
import { useFormatter, useTranslations } from 'next-intl';

import { Badge } from '@/components/ui/badge';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import {
  entryText,
  listResponseFiles,
  orderedEntries,
} from '@/lib/forms/response-display';

import { STATUS_BADGE } from './status-style';
import type { ResponseRow } from './types';

export interface ResponseDetailProps {
  response: ResponseRow;
  /** Chaves dos blocos por posição (o JSONB não guarda a ordem). */
  fieldOrder: readonly string[];
  /** Rótulo atual da faixa (cai na chave se a faixa foi removida). */
  bandLabel?: string | null;
  /** Chaves dos blocos que ainda existem; ausente = não sinaliza removidos. */
  knownKeys?: ReadonlySet<string>;
  /** Mostra o formulário de origem (aba da ficha do contato). */
  showForm?: boolean;
}

function Meta({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="min-w-0">
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd className="text-foreground mt-0.5 text-sm break-words">{children}</dd>
    </div>
  );
}

export function ResponseDetailBody({
  response,
  fieldOrder,
  bandLabel,
  knownKeys,
  showForm = false,
}: ResponseDetailProps) {
  const t = useTranslations('Forms.responses');
  const format = useFormatter();
  const labels = { yes: t('values.yes'), no: t('values.no') };
  const dt = (iso: string | null) =>
    iso
      ? format.dateTime(new Date(iso), {
          dateStyle: 'short',
          timeStyle: 'short',
        })
      : t('values.empty');

  const entries = orderedEntries(response.answers, fieldOrder);
  const files = listResponseFiles(response.answers);
  const filesByKey = new Map<string, typeof files>();
  for (const f of files) {
    filesByKey.set(f.key, [...(filesByKey.get(f.key) ?? []), f]);
  }
  const contact = response.contacts;
  const utm = Object.entries(response.utm ?? {});

  return (
    <div className="space-y-5">
      <section aria-label={t('detail.contact')}>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-3">
          <Meta label={t('detail.contact')}>
            <span className="font-medium">
              {contact?.name || t('table.noContactName')}
            </span>
            {contact?.phone ? (
              <span className="text-muted-foreground block text-xs">
                {contact.phone}
              </span>
            ) : null}
            {contact?.id ? (
              <Link
                href={`/contacts?contact=${contact.id}&tab=forms`}
                className="text-primary mt-1 inline-flex items-center gap-1 text-xs hover:underline"
              >
                {t('detail.openContact')}
                <ExternalLink className="size-3" aria-hidden />
              </Link>
            ) : null}
          </Meta>
          {showForm && response.forms ? (
            <Meta label={t('detail.form')}>
              <span className="font-medium">{response.forms.name}</span>
              <Link
                href={`/forms/${response.forms.id}/respostas?r=${response.id}`}
                className="text-primary mt-1 flex items-center gap-1 text-xs hover:underline"
              >
                {t('detail.openForm')}
                <ExternalLink className="size-3" aria-hidden />
              </Link>
            </Meta>
          ) : null}
          <Meta label={t('detail.status')}>
            <Badge variant="outline" className={STATUS_BADGE[response.status]}>
              {t(`status.${response.status}`)}
            </Badge>
          </Meta>
          <Meta label={t('detail.source')}>
            {t(`source.${response.source}`)}
          </Meta>
          <Meta label={t('detail.started')}>{dt(response.started_at)}</Meta>
          <Meta label={t('detail.completed')}>{dt(response.completed_at)}</Meta>
          <Meta label={t('detail.score')}>
            {response.score === null ? t('values.empty') : response.score}
          </Meta>
          <Meta label={t('detail.band')}>
            {response.band_key
              ? (bandLabel ?? response.band_key)
              : t('values.empty')}
          </Meta>
          {response.deals ? (
            <Meta label={t('detail.deal')}>
              <span className="font-medium">{response.deals.title}</span>
              <Link
                href="/pipelines"
                className="text-primary mt-1 flex items-center gap-1 text-xs hover:underline"
              >
                {t('detail.openDeal')}
                <ExternalLink className="size-3" aria-hidden />
              </Link>
            </Meta>
          ) : null}
        </dl>
      </section>

      <section aria-label={t('detail.answers')}>
        <h3 className="text-foreground mb-2 text-sm font-semibold">
          {t('detail.answers')}
        </h3>
        {entries.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            {t('detail.noAnswer')}
          </p>
        ) : (
          <ul className="divide-border border-border divide-y rounded-lg border">
            {entries.map(({ key, entry }) => {
              const fileItems = filesByKey.get(key) ?? [];
              const text = entryText(entry, labels);
              return (
                <li key={key} className="px-3 py-2.5">
                  <p className="text-muted-foreground text-xs">
                    {entry.label}
                    {knownKeys && !knownKeys.has(key) ? (
                      <span className="ml-1.5 italic">
                        · {t('detail.removedBlock')}
                      </span>
                    ) : null}
                  </p>
                  {entry.type === 'file_upload' ? (
                    <ul className="mt-1 space-y-1">
                      {fileItems.map((f) => (
                        <li key={f.index}>
                          <a
                            href={`/api/forms/${response.form_id}/responses/${response.id}/files/${f.index}`}
                            rel="noreferrer"
                            className="text-primary inline-flex max-w-full items-center gap-1.5 text-sm hover:underline"
                          >
                            <FileText
                              className="size-3.5 shrink-0"
                              aria-hidden
                            />
                            <span className="truncate">{f.file.name}</span>
                            <span className="sr-only">
                              {t('detail.download')}
                            </span>
                            <Download
                              className="size-3.5 shrink-0"
                              aria-hidden
                            />
                          </a>
                        </li>
                      ))}
                      {fileItems.length === 0 ? (
                        <li className="text-muted-foreground text-sm">
                          {t('values.empty')}
                        </li>
                      ) : null}
                    </ul>
                  ) : (
                    <p className="text-foreground mt-0.5 text-sm break-words whitespace-pre-wrap">
                      {text || t('values.empty')}
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {utm.length > 0 ? (
        <section aria-label={t('detail.utm')}>
          <h3 className="text-foreground mb-2 text-sm font-semibold">
            {t('detail.utm')}
          </h3>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2">
            {utm.map(([k, v]) => (
              <Meta key={k} label={k}>
                {String(v)}
              </Meta>
            ))}
          </dl>
        </section>
      ) : null}

      <p className="text-muted-foreground text-xs">
        {t('detail.version', { version: response.form_version })}
      </p>
    </div>
  );
}

export function ResponseDetailSheet({
  open,
  onOpenChange,
  description,
  ...body
}: ResponseDetailProps & {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  description?: string;
}) {
  const t = useTranslations('Forms.responses');
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-lg">
        <SheetHeader>
          <SheetTitle>{t('detail.title')}</SheetTitle>
          {description ? (
            <SheetDescription>{description}</SheetDescription>
          ) : null}
        </SheetHeader>
        <div className="px-4 pb-6">
          <ResponseDetailBody {...body} />
        </div>
      </SheetContent>
    </Sheet>
  );
}
