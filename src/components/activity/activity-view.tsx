'use client';

// ============================================================
// A página `/activity` (SPEC 075 F7).
//
// Layout no molde de `/contacts` — barra de filtros no topo, lista
// densa, paginação no rodapé — e não no de `/settings`: isto não é
// configuração, é a trilha de auditoria da conta (§7.2/D-14).
//
// Três decisões que a tela precisa deixar visíveis, e não só obedecer:
//
//   1. **D-10** — filtrar por canal esconde contato, negócio e plano,
//      que não têm canal nenhum. Sem o aviso, o operador conclui que o
//      contato criado hoje sumiu. O contador de ocultos vem da própria
//      consulta (`hidden_by_channel_filter`).
//   2. **D-12** — o log pode ter buracos, porque uma falha ao registrar
//      nunca derruba a ação registrada. Um log que se apresenta como
//      completo sendo incompleto é pior que um que avisa.
//   3. **D-4** — o registro começa na instalação. "Nada aqui" não é
//      "nada aconteceu na conta"; é "nada aconteceu desde que este
//      recurso existe".
// ============================================================

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useTranslations, useLocale } from 'next-intl';
import { format } from 'date-fns';
import { AlertTriangle, EyeOff, Info, Loader2, ScrollText } from 'lucide-react';

import { getDateFnsLocale } from '@/lib/i18n/date-fns-locale';
import { useAccountChannels } from '@/lib/channels/use-account-channels';
import { toFeedEntry, type ActivityFeedEntry } from '@/lib/activity/feed';
import type { ActivityRow } from '@/lib/activity/query';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import {
  ActivityFilters,
  DEFAULT_ACTIVITY_FILTERS,
  periodStartIso,
  type ActivityUiFilters,
  type FilterOption,
} from './activity-filters';
import { KIND_THEME, useActivityText } from './activity-presentation';

interface ApiResponse {
  items: ActivityRow[];
  next_cursor: string | null;
  hidden_by_channel_filter: number | null;
}

interface MemberRow {
  user_id: string;
  full_name: string;
}

/** Espera entre a última tecla e a busca ir para o servidor. */
const SEARCH_DEBOUNCE_MS = 350;

/** Os quatro papéis de `account_role_enum` (017). Um valor fora disto
 *  não tem tradução e é mostrado cru. */
const KNOWN_ROLES = new Set(['owner', 'admin', 'agent', 'viewer']);

function buildQuery(filters: ActivityUiFilters, cursor: string | null): string {
  const params = new URLSearchParams();
  params.set('from', periodStartIso(filters.period));
  // O fuso do navegador acompanha a data: quem corta em UTC é o
  // servidor, mas o "dia" é o do operador (§7.3).
  params.set('time_zone', Intl.DateTimeFormat().resolvedOptions().timeZone);
  if (filters.actor !== 'all') params.set('actor_user_id', filters.actor);
  if (filters.type !== 'all') params.set('resource_type', filters.type);
  if (filters.channel !== 'all') params.set('channel_id', filters.channel);
  if (filters.search.trim()) params.set('search', filters.search.trim());
  if (cursor) params.set('cursor', cursor);
  params.set('limit', '50');
  return params.toString();
}

export function ActivityView() {
  const t = useTranslations('Activity');
  const activityText = useActivityText();
  const dateFnsLocale = getDateFnsLocale(useLocale());
  const { byId: channelsById } = useAccountChannels();

  const [filters, setFilters] = useState<ActivityUiFilters>(
    DEFAULT_ACTIVITY_FILTERS
  );
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [entries, setEntries] = useState<ActivityFeedEntry[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [hiddenByChannel, setHiddenByChannel] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState(false);
  const [users, setUsers] = useState<FilterOption[]>([]);

  // Só a busca é debounced: os `Select` mudam de uma vez, e esperar
  // 350ms depois de escolher um período seria latência sem motivo.
  useEffect(() => {
    const id = setTimeout(
      () => setDebouncedSearch(filters.search),
      SEARCH_DEBOUNCE_MS
    );
    return () => clearTimeout(id);
  }, [filters.search]);

  const effectiveFilters = useMemo(
    () => ({ ...filters, search: debouncedSearch }),
    [filters, debouncedSearch]
  );

  // Uma requisição em voo por vez: trocar de filtro rápido não pode
  // deixar a resposta ANTIGA chegar depois e sobrescrever a nova.
  const requestSeq = useRef(0);

  const load = useCallback(
    async (nextCursor: string | null) => {
      const seq = ++requestSeq.current;
      if (nextCursor) setLoadingMore(true);
      else setLoading(true);
      setError(false);

      try {
        const res = await fetch(
          `/api/account/activity?${buildQuery(effectiveFilters, nextCursor)}`
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = (await res.json()) as ApiResponse;
        if (seq !== requestSeq.current) return;

        const mapped = json.items.map(toFeedEntry);
        setEntries((prev) =>
          nextCursor ? [...(prev ?? []), ...mapped] : mapped
        );
        setCursor(json.next_cursor);
        setHiddenByChannel(json.hidden_by_channel_filter);
      } catch (err) {
        if (seq !== requestSeq.current) return;
        console.error('[activity] load failed:', err);
        setError(true);
        if (!nextCursor) {
          setEntries([]);
          // O banner "N ocultos pelo filtro" descreve a resposta
          // anterior — sem isto ele ficaria obsoleto ao lado do painel
          // de erro, apontando para dados que não estão mais na tela.
          setHiddenByChannel(0);
        }
      } finally {
        if (seq === requestSeq.current) {
          setLoading(false);
          setLoadingMore(false);
        }
      }
    },
    [effectiveFilters]
  );

  useEffect(() => {
    load(null);
  }, [load]);

  useEffect(() => {
    let alive = true;
    void fetch('/api/account/members')
      .then((r) => (r.ok ? r.json() : { members: [] }))
      .then((json: { members?: MemberRow[] }) => {
        if (!alive) return;
        setUsers(
          (json.members ?? []).map((m) => ({
            value: m.user_id,
            label: m.full_name || m.user_id,
          }))
        );
      })
      .catch(() => {
        // O filtro de usuário some; a página continua útil sem ele.
      });
    return () => {
      alive = false;
    };
  }, []);

  const channelOptions: FilterOption[] = useMemo(
    () =>
      Array.from(channelsById.values()).map((c) => ({
        value: c.id,
        label: c.name,
      })),
    [channelsById]
  );

  const hasFilters =
    effectiveFilters.actor !== 'all' ||
    effectiveFilters.type !== 'all' ||
    effectiveFilters.channel !== 'all' ||
    effectiveFilters.search !== '' ||
    effectiveFilters.period !== DEFAULT_ACTIVITY_FILTERS.period;

  return (
    <div className="space-y-4">
      <header className="space-y-1">
        <h1 className="text-foreground flex items-center gap-2 text-xl font-semibold">
          <ScrollText className="size-5" />
          {t('page.title')}
        </h1>
        <p className="text-muted-foreground text-sm">{t('page.subtitle')}</p>
      </header>

      <ActivityFilters
        filters={filters}
        onChange={setFilters}
        users={users}
        channels={channelOptions}
      />

      {/* D-10 — o filtro de canal esconde tudo que não tem canal. */}
      {hiddenByChannel && hiddenByChannel > 0 ? (
        <p className="text-muted-foreground bg-muted/40 flex items-center gap-2 rounded-lg px-3 py-2 text-xs">
          <EyeOff className="size-3.5 flex-shrink-0" />
          {t('page.hiddenByChannel', { count: hiddenByChannel })}
        </p>
      ) : null}

      {error ? (
        <div className="border-border bg-card flex flex-col items-center gap-3 rounded-xl border py-12 text-center">
          <AlertTriangle className="text-muted-foreground size-6" />
          <p className="text-muted-foreground text-sm">{t('page.error')}</p>
          <Button variant="outline" size="sm" onClick={() => load(null)}>
            {t('page.retry')}
          </Button>
        </div>
      ) : loading ? (
        <div className="border-border bg-card flex items-center justify-center gap-2 rounded-xl border py-16">
          <Loader2 className="text-muted-foreground size-4 animate-spin" />
          <span className="text-muted-foreground text-sm">
            {t('page.loading')}
          </span>
        </div>
      ) : !entries || entries.length === 0 ? (
        <div className="border-border bg-card flex flex-col items-center gap-2 rounded-xl border px-6 py-16 text-center">
          <ScrollText className="text-muted-foreground size-6" />
          <p className="text-foreground text-sm font-medium">
            {hasFilters ? t('page.emptyFiltered.title') : t('page.empty.title')}
          </p>
          <p className="text-muted-foreground max-w-md text-xs">
            {hasFilters ? t('page.emptyFiltered.hint') : t('page.empty.hint')}
          </p>
        </div>
      ) : (
        <div className="border-border bg-card overflow-hidden rounded-xl border">
          <ul className="divide-border divide-y">
            {entries.map((entry, i) => (
              <ActivityRowItem
                key={entry.id}
                entry={entry}
                text={activityText(entry)}
                // O papel vem cru do banco ('admin'); a linha mostra
                // traduzido. Um papel fora dos quatro conhecidos (uma
                // migração que amplie o enum sem passar por aqui) cai no
                // valor cru em vez de sumir da tela.
                roleLabel={
                  entry.actorRole && KNOWN_ROLES.has(entry.actorRole)
                    ? t(`roles.${entry.actorRole}`)
                    : entry.actorRole
                }
                channelName={
                  entry.channelId
                    ? (channelsById.get(entry.channelId)?.name ?? null)
                    : null
                }
                dateFnsLocale={dateFnsLocale}
                striped={i % 2 !== 0}
                detailsLabel={t('page.details')}
              />
            ))}
          </ul>

          <footer className="border-border flex flex-wrap items-center justify-between gap-2 border-t px-4 py-3">
            <span className="text-muted-foreground text-xs tabular-nums">
              {t('page.counter', {
                shown: entries.length,
                period: t(`periods.${filters.period}`),
              })}
            </span>
            {cursor ? (
              <Button
                variant="outline"
                size="sm"
                onClick={() => load(cursor)}
                disabled={loadingMore}
              >
                {loadingMore ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : null}
                {t('page.loadMore')}
              </Button>
            ) : null}
          </footer>
        </div>
      )}

      {/* D-12, na cara: o log pode ter buracos, e dizer isso é parte do
          contrato de honestidade da tela. */}
      <p className="text-muted-foreground flex items-start gap-2 text-xs">
        <Info className="mt-0.5 size-3.5 flex-shrink-0" />
        {t('page.incomplete')}
      </p>
    </div>
  );
}

interface RowProps {
  entry: ActivityFeedEntry;
  text: string;
  roleLabel: string | null;
  channelName: string | null;
  dateFnsLocale: ReturnType<typeof getDateFnsLocale>;
  striped: boolean;
  detailsLabel: string;
}

function ActivityRowItem({
  entry,
  text,
  roleLabel,
  channelName,
  dateFnsLocale,
  striped,
  detailsLabel,
}: RowProps) {
  const theme = KIND_THEME[entry.kind];
  const Icon = theme.icon;
  const when = new Date(entry.at);

  const body = (
    <div className="flex items-start gap-3 px-4 py-3">
      <span
        className={cn(
          'mt-0.5 flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full',
          theme.badge
        )}
      >
        <Icon className="h-3.5 w-3.5" />
      </span>

      <div className="min-w-0 flex-1">
        <p className="text-foreground text-sm">{text}</p>
        <div className="text-muted-foreground mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs">
          <time dateTime={entry.at} className="tabular-nums">
            {Number.isNaN(when.getTime())
              ? ''
              : format(when, 'dd/MM HH:mm', { locale: dateFnsLocale })}
          </time>
          {roleLabel ? <span>· {roleLabel}</span> : null}
          {channelName ? <span>· {channelName}</span> : null}
          {/* O ponteiro para a tabela especializada (D-2): a linha do
              feed guarda a frase, o detalhe mora lá. Ainda não há tela
              para abrir cada uma, então isto é um rótulo, não um link
              que não levaria a lugar nenhum. */}
          {entry.source ? (
            <span className="text-muted-foreground/70">
              · {detailsLabel}: {entry.source.table}
            </span>
          ) : null}
        </div>
      </div>
    </div>
  );

  return (
    <li
      className={cn(
        striped ? 'bg-muted/40' : 'bg-transparent',
        'hover:bg-muted/60 transition-colors'
      )}
    >
      {entry.href ? (
        <Link href={entry.href} className="block">
          {body}
        </Link>
      ) : (
        body
      )}
    </li>
  );
}
