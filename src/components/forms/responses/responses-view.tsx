'use client';

// ============================================================
// `/forms/[id]/respostas` (SPEC 085 §4.4, F4): tabela paginada no servidor,
// filtros, painel lateral de detalhe, exportar e apagar (`admin`+).
// `viewer` e `agent` só leem.
//
// Carregamento: um único efeito por "chave" (filtros + página + recarga);
// `loading` é derivado (a chave da última resposta difere da atual), sem
// `setState` síncrono dentro do efeito.
// ============================================================

import { ArrowLeft, Columns3, Download, Loader2, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';

import { Button, buttonVariants } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { useCan } from '@/hooks/use-can';
import { isUuid } from '@/lib/api/uuid';

import { NativeSelect } from '../form-builder/ui';
import { DeleteResponsesDialog } from './delete-dialog';
import { ExportDialog } from './export-dialog';
import {
  DEFAULT_FILTERS,
  filtersToParams,
  filtersToRecord,
  totalPages,
  type FilterState,
} from '@/lib/forms/responses-filters';
import { ResponseDetailSheet } from './response-detail';
import { ResponseFilters } from './response-filters';
import { ResponsesTable } from './responses-table';
import type { ResponseRow, ResponsesPage } from './types';

const PAGE_SIZES = [25, 50, 100];
const DEBOUNCE_MS = 350;

type Loaded =
  | { key: string; status: 'ok'; data: ResponsesPage }
  | { key: string; status: 'error' };

function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return debounced;
}

export function ResponsesView({ formId }: { formId: string }) {
  const t = useTranslations('Forms.responses');
  const canManage = useCan('edit-settings'); // admin+
  const searchParams = useSearchParams();
  const deepLinkId = searchParams.get('r');

  const [filters, setFilters] = useState<FilterState>(DEFAULT_FILTERS);
  const applied = useDebounced(filters, DEBOUNCE_MS);
  // A página volta a 1 junto com o filtro APLICADO (não o digitado): resetar
  // antes do debounce buscaria a página 1 com os filtros antigos.
  const filterKey = JSON.stringify(filtersToRecord(applied));
  const [pageState, setPageState] = useState({ page: 1, filterKey });
  const page = pageState.filterKey === filterKey ? pageState.page : 1;
  const setPage = (next: number | ((p: number) => number)) =>
    setPageState((prev) => {
      const current = prev.filterKey === filterKey ? prev.page : 1;
      return {
        filterKey,
        page: typeof next === 'function' ? next(current) : next,
      };
    });
  const [pageSize, setPageSize] = useState(25);
  const [reload, setReload] = useState(0);
  const [loaded, setLoaded] = useState<Loaded | null>(null);

  const [visible, setVisible] = useState<ReadonlySet<string> | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [detail, setDetail] = useState<ResponseRow | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [deleteIds, setDeleteIds] = useState<string[] | null | undefined>(
    undefined // undefined = fechado; null = todas
  );
  const [deepLink, setDeepLink] = useState<{
    id: string;
    row: ResponseRow | null;
  } | null>(null);

  const key = JSON.stringify([
    formId,
    filtersToRecord(applied),
    page,
    pageSize,
    reload,
  ]);

  useEffect(() => {
    const controller = new AbortController();
    (async () => {
      try {
        const res = await fetch(
          `/api/forms/${formId}/responses?${filtersToParams(applied, page, pageSize)}`,
          { signal: controller.signal }
        );
        if (!res.ok) throw new Error(String(res.status));
        const data = (await res.json()) as ResponsesPage;
        setLoaded({ key, status: 'ok', data });
      } catch (err) {
        if ((err as Error).name === 'AbortError') return;
        console.error(err);
        setLoaded({ key, status: 'error' });
      }
    })();
    return () => controller.abort();
    // `key` resume todas as dependências de dados.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  // Link profundo da notificação (`?r=<id da resposta>`): busca só essa
  // resposta (filtro `response`) e abre o painel, uma vez.
  useEffect(() => {
    if (!deepLinkId || !isUuid(deepLinkId)) return;
    const controller = new AbortController();
    (async () => {
      try {
        const res = await fetch(
          `/api/forms/${formId}/responses?response=${deepLinkId}&pageSize=1`,
          { signal: controller.signal }
        );
        if (!res.ok) throw new Error(String(res.status));
        const data = (await res.json()) as ResponsesPage;
        setDeepLink({ id: deepLinkId, row: data.responses[0] ?? null });
      } catch (err) {
        if ((err as Error).name !== 'AbortError') {
          console.error(err);
          setDeepLink({ id: deepLinkId, row: null });
        }
      }
    })();
    return () => controller.abort();
  }, [formId, deepLinkId]);

  const current = loaded && loaded.key === key ? loaded : null;
  const lastOk = loaded?.status === 'ok' ? loaded.data : null;
  const loading = !current;
  const data = lastOk;
  const failed = current?.status === 'error';

  // Colunas de bloco: padrão = as 3 primeiras perguntas que não são arquivo.
  const blocks = useMemo(() => data?.fields ?? [], [data?.fields]);
  const visibleKeys = useMemo<ReadonlySet<string>>(
    () =>
      visible ??
      new Set(
        blocks
          .filter((b) => b.type !== 'file_upload')
          .slice(0, 3)
          .map((b) => b.key)
      ),
    [visible, blocks]
  );
  const fieldOrder = useMemo(() => blocks.map((b) => b.key), [blocks]);
  const knownKeys = useMemo(() => new Set(fieldOrder), [fieldOrder]);

  function changeFilters(next: FilterState) {
    setFilters(next);
    setSelected(new Set());
  }

  function toggleColumn(k: string, on: boolean) {
    const next = new Set(visibleKeys);
    if (on) next.add(k);
    else next.delete(k);
    setVisible(next);
  }

  const rows = data?.responses ?? [];
  const pages = data ? totalPages(data.total, data.pageSize) : 1;
  const selectedIds = [...selected];
  const detailRow = detail ?? deepLink?.row ?? null;
  const detailOpen = detail !== null || (deepLink?.row ?? null) !== null;

  function bandLabelOf(row: ResponseRow): string | null {
    if (!row.band_key) return null;
    return data?.bands.find((b) => b.key === row.band_key)?.label ?? null;
  }

  return (
    <div className="space-y-4 p-2 sm:p-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <Link
            href={`/forms/${formId}`}
            className={buttonVariants({ variant: 'ghost', size: 'sm' })}
          >
            <ArrowLeft className="size-4" />
            {t('back')}
          </Link>
          <h1 className="text-foreground mt-1 text-2xl font-semibold">
            {t('title')}
          </h1>
          {data ? (
            <p className="text-muted-foreground mt-0.5 truncate text-sm">
              {t('subtitle', { name: data.form.name })} ·{' '}
              {t('total', { count: data.total })}
            </p>
          ) : null}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <details className="relative">
            <summary
              className={`${buttonVariants({ variant: 'outline', size: 'sm' })} cursor-pointer list-none`}
            >
              <Columns3 className="size-4" />
              {t('table.chooseColumns')}
            </summary>
            <div className="border-border bg-popover absolute right-0 z-20 mt-1 max-h-72 w-64 space-y-1.5 overflow-y-auto rounded-lg border p-3 shadow-lg">
              <p className="text-muted-foreground text-xs">
                {t('table.fixedColumns')}
              </p>
              <p className="text-muted-foreground mb-2 text-xs">
                {t('table.blockColumns')}
              </p>
              {blocks.map((b) => (
                <label key={b.key} className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={visibleKeys.has(b.key)}
                    onCheckedChange={(on) => toggleColumn(b.key, on === true)}
                  />
                  <span className="truncate">{b.label}</span>
                </label>
              ))}
            </div>
          </details>

          {canManage ? (
            <>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setExportOpen(true)}
                disabled={!data || data.total === 0}
              >
                <Download className="size-4" />
                {selectedIds.length > 0
                  ? t('actions.exportSelected')
                  : t('actions.export')}
              </Button>
              {selectedIds.length > 0 ? (
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={() => setDeleteIds(selectedIds)}
                >
                  <Trash2 className="size-4" />
                  {t('actions.deleteSelected')} ({selectedIds.length})
                </Button>
              ) : (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setDeleteIds(null)}
                  disabled={!data || data.total === 0}
                >
                  <Trash2 className="size-4" />
                  {t('actions.deleteAll')}
                </Button>
              )}
            </>
          ) : null}
        </div>
      </header>

      {!canManage ? (
        <p className="text-muted-foreground text-xs">{t('viewerNote')}</p>
      ) : null}

      {data ? (
        <ResponseFilters
          value={filters}
          onChange={changeFilters}
          fields={data.fields}
          bands={data.bands}
        />
      ) : null}

      {failed && !data ? (
        <div className="flex flex-col items-center gap-3 py-16" role="alert">
          <p className="text-destructive text-sm">{t('loadError')}</p>
          <Button variant="outline" onClick={() => setReload((n) => n + 1)}>
            {t('retry')}
          </Button>
        </div>
      ) : !data ? (
        <div className="flex justify-center py-16">
          <Loader2 className="text-muted-foreground h-6 w-6 animate-spin" />
        </div>
      ) : rows.length === 0 && !loading ? (
        <div className="border-border bg-card/50 rounded-lg border border-dashed px-6 py-14 text-center">
          <p className="text-foreground text-sm font-medium">
            {data.total === 0 &&
            JSON.stringify(filtersToRecord(applied)) ===
              JSON.stringify(filtersToRecord(DEFAULT_FILTERS))
              ? t('empty')
              : t('noMatches')}
          </p>
          <p className="text-muted-foreground mt-1 text-xs">{t('emptyHint')}</p>
        </div>
      ) : (
        <div
          className={loading ? 'opacity-60 transition-opacity' : undefined}
          aria-busy={loading}
        >
          {failed ? (
            <p className="text-destructive mb-2 text-sm" role="alert">
              {t('loadError')}
            </p>
          ) : null}
          <ResponsesTable
            rows={rows}
            blocks={blocks}
            visibleKeys={visibleKeys}
            bands={data.bands}
            selectable={canManage}
            selected={selected}
            onToggle={(id) =>
              setSelected((prev) => {
                const next = new Set(prev);
                if (next.has(id)) next.delete(id);
                else next.add(id);
                return next;
              })
            }
            onToggleAll={(checked) =>
              setSelected(checked ? new Set(rows.map((r) => r.id)) : new Set())
            }
            onOpen={setDetail}
          />

          <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-sm">
            <div className="text-muted-foreground flex items-center gap-3">
              <NativeSelect
                aria-label={t('total', { count: pageSize })}
                value={pageSize}
                className="w-auto"
                onChange={(e) => {
                  setPageSize(Number(e.target.value));
                  setPage(1);
                  setSelected(new Set());
                }}
              >
                {PAGE_SIZES.map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </NativeSelect>
              {selectedIds.length > 0 ? (
                <span>
                  {t('table.selected', { count: selectedIds.length })}
                </span>
              ) : null}
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={page <= 1 || loading}
                onClick={() => {
                  setPage((p) => p - 1);
                  setSelected(new Set());
                }}
              >
                {t('table.previous')}
              </Button>
              <span
                className="text-muted-foreground text-xs"
                aria-live="polite"
              >
                {t('table.pagination', { page, pages })}
              </span>
              <Button
                variant="outline"
                size="sm"
                disabled={page >= pages || loading}
                onClick={() => {
                  setPage((p) => p + 1);
                  setSelected(new Set());
                }}
              >
                {t('table.next')}
              </Button>
            </div>
          </div>
        </div>
      )}

      {detailRow ? (
        <ResponseDetailSheet
          open={detailOpen}
          onOpenChange={(open) => {
            if (!open) {
              setDetail(null);
              setDeepLink(null);
            }
          }}
          response={detailRow}
          fieldOrder={fieldOrder}
          knownKeys={knownKeys}
          bandLabel={bandLabelOf(detailRow)}
          description={data?.form.name}
        />
      ) : null}

      {exportOpen && data ? (
        <ExportDialog
          open
          onOpenChange={setExportOpen}
          formId={formId}
          blocks={data.fields}
          filter={filtersToRecord(applied)}
          selectedIds={selectedIds}
        />
      ) : null}

      {deleteIds !== undefined && data ? (
        <DeleteResponsesDialog
          open
          onOpenChange={(open) => {
            if (!open) setDeleteIds(undefined);
          }}
          formId={formId}
          formName={data.form.name}
          ids={deleteIds}
          onDeleted={() => {
            setSelected(new Set());
            setPage(1);
            setReload((n) => n + 1);
          }}
        />
      ) : null}
    </div>
  );
}
