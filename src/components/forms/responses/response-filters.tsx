'use client';

// Filtros da tela de respostas (SPEC 085 §4.4): busca por contato, status,
// faixa, origem, período e "pergunta X = valor". Controlado pelo pai; o
// pai aplica com debounce.

import { Search, X } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { RESPONSE_SOURCES, RESPONSE_STATUSES } from '@/lib/forms/types';

import { NativeSelect } from '../form-builder/ui';
import {
  DEFAULT_FILTERS,
  FILTERABLE_BLOCK_TYPES,
  hasActiveFilters,
  type FilterState,
} from '@/lib/forms/responses-filters';
import type { BandMeta, BlockMeta } from './types';

interface Props {
  value: FilterState;
  onChange: (next: FilterState) => void;
  fields: BlockMeta[];
  bands: BandMeta[];
}

export function ResponseFilters({ value, onChange, fields, bands }: Props) {
  const t = useTranslations('Forms.responses');
  const set = (patch: Partial<FilterState>) => onChange({ ...value, ...patch });

  const filterable = fields.filter((f) =>
    FILTERABLE_BLOCK_TYPES.includes(f.type)
  );
  const block = filterable.find((f) => f.key === value.blockKey);

  return (
    <div
      role="search"
      aria-label={t('filters.label')}
      className="border-border bg-card grid gap-3 rounded-lg border p-3 sm:grid-cols-2 lg:grid-cols-4"
    >
      <label className="relative sm:col-span-2">
        <span className="sr-only">{t('filters.search')}</span>
        <Search
          className="text-muted-foreground pointer-events-none absolute top-2 left-2.5 size-4"
          aria-hidden
        />
        <Input
          value={value.q}
          maxLength={80}
          placeholder={t('filters.searchPlaceholder')}
          onChange={(e) => set({ q: e.target.value })}
          className="h-8 pl-8"
        />
      </label>

      <label className="grid gap-1">
        <span className="text-muted-foreground text-xs">
          {t('filters.status')}
        </span>
        <NativeSelect
          value={value.status}
          onChange={(e) =>
            set({ status: e.target.value as FilterState['status'] })
          }
        >
          <option value="">{t('filters.allStatuses')}</option>
          {RESPONSE_STATUSES.map((s) => (
            <option key={s} value={s}>
              {t(`status.${s}`)}
            </option>
          ))}
        </NativeSelect>
      </label>

      <label className="grid gap-1">
        <span className="text-muted-foreground text-xs">
          {t('filters.source')}
        </span>
        <NativeSelect
          value={value.source}
          onChange={(e) =>
            set({ source: e.target.value as FilterState['source'] })
          }
        >
          <option value="">{t('filters.allSources')}</option>
          {RESPONSE_SOURCES.map((s) => (
            <option key={s} value={s}>
              {t(`source.${s}`)}
            </option>
          ))}
        </NativeSelect>
      </label>

      {bands.length > 0 ? (
        <label className="grid gap-1">
          <span className="text-muted-foreground text-xs">
            {t('filters.band')}
          </span>
          <NativeSelect
            value={value.band}
            onChange={(e) => set({ band: e.target.value })}
          >
            <option value="">{t('filters.allBands')}</option>
            {bands.map((b) => (
              <option key={b.key} value={b.key}>
                {b.label}
              </option>
            ))}
          </NativeSelect>
        </label>
      ) : null}

      <label className="grid gap-1">
        <span className="text-muted-foreground text-xs">
          {t('filters.from')}
        </span>
        <Input
          type="date"
          value={value.from}
          max={value.to || undefined}
          onChange={(e) => set({ from: e.target.value })}
          className="h-8"
        />
      </label>
      <label className="grid gap-1">
        <span className="text-muted-foreground text-xs">{t('filters.to')}</span>
        <Input
          type="date"
          value={value.to}
          min={value.from || undefined}
          onChange={(e) => set({ to: e.target.value })}
          className="h-8"
        />
      </label>

      {filterable.length > 0 ? (
        <div className="grid gap-1 sm:col-span-2">
          <span className="text-muted-foreground text-xs">
            {t('filters.block')}
          </span>
          <div className="flex gap-2">
            <NativeSelect
              aria-label={t('filters.block')}
              value={value.blockKey}
              onChange={(e) =>
                set({ blockKey: e.target.value, blockValue: '' })
              }
            >
              <option value="">{t('filters.blockAny')}</option>
              {filterable.map((f) => (
                <option key={f.key} value={f.key}>
                  {f.label}
                </option>
              ))}
            </NativeSelect>
            {block ? (
              <BlockValueInput
                block={block}
                value={value.blockValue}
                onChange={(v) => set({ blockValue: v })}
              />
            ) : null}
          </div>
        </div>
      ) : null}

      {hasActiveFilters(value) ? (
        <div className="flex items-end sm:col-span-2 lg:col-span-4 lg:justify-end">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onChange(DEFAULT_FILTERS)}
          >
            <X className="size-4" />
            {t('filters.clear')}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function BlockValueInput({
  block,
  value,
  onChange,
}: {
  block: BlockMeta;
  value: string;
  onChange: (v: string) => void;
}) {
  const t = useTranslations('Forms.responses');
  const label = t('filters.blockValue');

  if (block.type === 'yes_no' || block.type === 'consent') {
    return (
      <NativeSelect
        aria-label={label}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="">{label}</option>
        <option value="yes">{t('values.yes')}</option>
        <option value="no">{t('values.no')}</option>
      </NativeSelect>
    );
  }
  if (block.options.length > 0) {
    return (
      <NativeSelect
        aria-label={label}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="">{label}</option>
        {block.options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.label}
          </option>
        ))}
      </NativeSelect>
    );
  }
  return (
    <Input
      aria-label={label}
      className="h-8"
      type={
        block.type === 'number' || block.type === 'rating'
          ? 'number'
          : block.type === 'date'
            ? 'date'
            : 'text'
      }
      value={value}
      maxLength={200}
      placeholder={t('filters.blockValuePlaceholder')}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}
