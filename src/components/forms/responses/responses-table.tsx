'use client';

// Tabela de respostas (SPEC 085 §4.4): colunas fixas (contato, data, status,
// pontuação, faixa, origem) + colunas escolhidas entre os blocos. A seleção
// em massa só aparece para quem pode exportar/apagar (`admin`+).

import { useFormatter, useTranslations } from 'next-intl';

import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { entryText } from '@/lib/forms/response-display';

import { STATUS_BADGE } from './status-style';
import type { BandMeta, BlockMeta, ResponseRow } from './types';

interface Props {
  rows: ResponseRow[];
  blocks: BlockMeta[];
  /** Chaves de bloco com coluna. */
  visibleKeys: ReadonlySet<string>;
  bands: BandMeta[];
  selectable: boolean;
  selected: ReadonlySet<string>;
  onToggle: (id: string) => void;
  onToggleAll: (checked: boolean) => void;
  onOpen: (row: ResponseRow) => void;
}

export function ResponsesTable({
  rows,
  blocks,
  visibleKeys,
  bands,
  selectable,
  selected,
  onToggle,
  onToggleAll,
  onOpen,
}: Props) {
  const t = useTranslations('Forms.responses');
  const format = useFormatter();
  const labels = { yes: t('values.yes'), no: t('values.no') };
  const shown = blocks.filter((b) => visibleKeys.has(b.key));
  const allSelected = rows.length > 0 && rows.every((r) => selected.has(r.id));
  const someSelected = !allSelected && rows.some((r) => selected.has(r.id));
  const bandLabel = (key: string | null) =>
    key ? (bands.find((b) => b.key === key)?.label ?? key) : t('values.empty');

  return (
    <div className="border-border bg-card rounded-lg border">
      <Table>
        <TableHeader>
          <TableRow>
            {selectable ? (
              <TableHead className="w-10">
                <Checkbox
                  aria-label={t('table.selectAll')}
                  checked={allSelected}
                  indeterminate={someSelected}
                  onCheckedChange={(checked) => onToggleAll(checked === true)}
                />
              </TableHead>
            ) : null}
            <TableHead>{t('columns.contact_name')}</TableHead>
            <TableHead>{t('table.date')}</TableHead>
            <TableHead>{t('columns.status')}</TableHead>
            <TableHead className="text-right">{t('columns.score')}</TableHead>
            <TableHead>{t('columns.band')}</TableHead>
            <TableHead>{t('columns.source')}</TableHead>
            {shown.map((b) => (
              <TableHead key={b.key} className="max-w-[14rem]">
                <span className="block truncate" title={b.label}>
                  {b.label}
                </span>
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => {
            const when = row.completed_at ?? row.started_at;
            return (
              <TableRow
                key={row.id}
                data-state={selected.has(row.id) ? 'selected' : undefined}
                className="hover:bg-muted/50 cursor-pointer"
                onClick={() => onOpen(row)}
              >
                {selectable ? (
                  <TableCell onClick={(e) => e.stopPropagation()}>
                    <Checkbox
                      aria-label={t('table.selectRow')}
                      checked={selected.has(row.id)}
                      onCheckedChange={() => onToggle(row.id)}
                    />
                  </TableCell>
                ) : null}
                <TableCell>
                  <button
                    type="button"
                    className="text-left"
                    aria-label={t('table.openDetail')}
                    onClick={(e) => {
                      e.stopPropagation();
                      onOpen(row);
                    }}
                  >
                    <span className="text-foreground block text-sm font-medium">
                      {row.contacts?.name || t('table.noContactName')}
                    </span>
                    {row.contacts?.phone ? (
                      <span className="text-muted-foreground block text-xs">
                        {row.contacts.phone}
                      </span>
                    ) : null}
                  </button>
                </TableCell>
                <TableCell className="text-sm whitespace-nowrap">
                  {format.dateTime(new Date(when), {
                    dateStyle: 'short',
                    timeStyle: 'short',
                  })}
                </TableCell>
                <TableCell>
                  <Badge variant="outline" className={STATUS_BADGE[row.status]}>
                    {t(`status.${row.status}`)}
                  </Badge>
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {row.score ?? t('values.empty')}
                </TableCell>
                <TableCell className="text-sm">
                  {bandLabel(row.band_key)}
                </TableCell>
                <TableCell className="text-sm">
                  {t(`source.${row.source}`)}
                </TableCell>
                {shown.map((b) => {
                  const entry = row.answers?.[b.key];
                  const text = entry ? entryText(entry, labels) : '';
                  return (
                    <TableCell key={b.key} className="max-w-[14rem]">
                      <span className="block truncate text-sm" title={text}>
                        {text || t('values.empty')}
                      </span>
                    </TableCell>
                  );
                })}
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
