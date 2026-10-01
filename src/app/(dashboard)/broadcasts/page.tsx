'use client';

import { useEffect, useState, useMemo, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import { Broadcast } from '@/types';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Radio, Plus, Loader2, Pencil, FileText } from 'lucide-react';
import { useCan } from '@/hooks/use-can';
import { GatedButton } from '@/components/ui/gated-button';
import { getBroadcastStatus } from '@/lib/broadcast-status';
import { useTranslations } from 'next-intl';
import { useAccountChannels } from '@/lib/channels/use-account-channels';
import { ChannelBadge } from '@/components/channels/channel-badge';

/**
 * Poll cadence while any broadcast is sending. Kept modest so we don't
 * beat on Supabase — the aggregate trigger in migration 003 keeps
 * counts consistent; we just need to surface the freshest snapshot.
 */
const POLL_INTERVAL_MS = 5_000;

function percent(numerator: number, denominator: number): number {
  if (!denominator) return 0;
  return Math.round((numerator / denominator) * 100);
}

/**
 * Chave de calendário LOCAL (não UTC) para agrupar/filtrar por dia.
 * `toISOString().split('T')[0]` bucketaria pelo dia em UTC — para o
 * fuso do Brasil (negativo), um disparo feito à tarde podia cair num
 * dia diferente do que a própria coluna "Data" da tabela mostra
 * (`toLocaleDateString()` na mesma linha, mais abaixo).
 */
function localDateKey(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Reconstrói `localDateKey()` como data LOCAL (não meia-noite UTC) para exibir. */
function formatDateKey(key: string): string {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString();
}

function RateCell({
  value,
  total,
  color,
}: {
  value: number;
  total: number;
  /** Tailwind bg class for the fill, e.g. "bg-primary" */
  color: string;
}) {
  const pct = percent(value, total);
  return (
    <div className="flex items-center gap-2">
      <span className="text-muted-foreground w-10 text-right text-xs tabular-nums">
        {pct}%
      </span>
      <div className="bg-muted h-1.5 w-20 overflow-hidden rounded-full">
        <div
          className={`h-1.5 rounded-full ${color}`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

/**
 * SPEC 055 D-10 — os dois espaços que `/broadcasts` agora mostra.
 * `campaigns` é tudo que NÃO é um funil de webhook (`source !==
 * 'webhook'`): cobre tanto `dashboard` quanto `api`, mesmo que hoje
 * nada além do webhook de entrada grave `source` explicitamente — o
 * `DEFAULT 'dashboard'` da migração 065 já cobre as linhas antigas e
 * qualquer campanha/API futura. `webhooks` é só `source = 'webhook'`.
 */
type BroadcastView = 'campaigns' | 'webhooks';

export default function BroadcastsPage() {
  const router = useRouter();
  const t = useTranslations('Broadcasts.page');
  const tStatus = useTranslations('Broadcasts.status');
  const tAwaitingCheck = useTranslations('Broadcasts.awaitingCheck');
  const tSource = useTranslations('Broadcasts.sourceFilter');
  const canCreate = useCan('send-messages');
  const channels = useAccountChannels();
  const [view, setView] = useState<BroadcastView>('campaigns');
  const [broadcasts, setBroadcasts] = useState<Broadcast[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filterChannel, setFilterChannel] = useState<string>('');
  const [filterTemplate, setFilterTemplate] = useState<string>('');
  const [filterDate, setFilterDate] = useState<string>('');

  // Used to kick off polling only while something is actively sending.
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  async function fetchBroadcasts(currentView: BroadcastView) {
    try {
      const supabase = createClient();
      let query = supabase.from('broadcasts').select('*');
      query =
        currentView === 'webhooks'
          ? query.eq('source', 'webhook')
          : query.neq('source', 'webhook');

      const { data, error: fetchError } = await query.order('created_at', {
        ascending: false,
      });

      if (fetchError) throw fetchError;
      setBroadcasts(data ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('errorLoad'));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    setLoading(true);
    void fetchBroadcasts(view);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view]);

  // Um funil de webhook fica em 'streaming' para sempre (SPEC 055
  // D-5) — não é uma transição limitada que valha ficar reconsultando
  // a cada 5s como uma campanha 'sending' de verdade é. Só o status
  // real de campanha dispara o polling.
  //
  // `awaiting_check` (SPEC 069 R6) ENTRA — ✅ correção de code review:
  // ao contrário de `streaming`, é transitório (o cron avança a
  // campanha a cada ciclo, minutos, não meses) e esta lista já mostra
  // o "checado X de Y" por linha (abaixo); sem pollar, o número fica
  // congelado até o usuário dar F5, mesmo com a campanha progredindo em
  // segundo plano.
  const anySending = useMemo(
    () =>
      broadcasts.some(
        (b) => b.status === 'sending' || b.status === 'awaiting_check'
      ),
    [broadcasts]
  );

  const filteredBroadcasts = useMemo(() => {
    return broadcasts.filter((b) => {
      if (filterChannel && b.channel_id !== filterChannel) return false;
      if (filterTemplate && b.template_name !== filterTemplate) return false;
      if (filterDate) {
        if (localDateKey(b.created_at) !== filterDate) return false;
      }
      return true;
    });
  }, [broadcasts, filterChannel, filterTemplate, filterDate]);

  const uniqueTemplates = useMemo(
    () =>
      [
        ...new Set(broadcasts.map((b) => b.template_name).filter(Boolean)),
      ].sort(),
    [broadcasts]
  );

  const uniqueDates = useMemo(
    () =>
      [...new Set(broadcasts.map((b) => localDateKey(b.created_at)))].sort(
        (a, b) => b.localeCompare(a)
      ),
    [broadcasts]
  );

  useEffect(() => {
    function startPolling() {
      if (pollTimer.current) return;
      pollTimer.current = setInterval(
        () => fetchBroadcasts(view),
        POLL_INTERVAL_MS
      );
    }
    function stopPolling() {
      if (!pollTimer.current) return;
      clearInterval(pollTimer.current);
      pollTimer.current = null;
    }

    // Pause polling while the tab is hidden — keeps Supabase cold when
    // the user is away, and ensures a fresh fetch the moment they
    // refocus so they don't see stale data on return.
    function handleVisibilityChange() {
      if (!anySending) return;
      if (document.visibilityState === 'hidden') {
        stopPolling();
      } else {
        fetchBroadcasts(view);
        startPolling();
      }
    }

    if (anySending && document.visibilityState === 'visible') {
      startPolling();
    } else {
      stopPolling();
    }
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      stopPolling();
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anySending, view]);

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Loader2 className="text-primary h-6 w-6 animate-spin" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-64 flex-col items-center justify-center gap-2">
        <p className="text-sm text-red-400">{error}</p>
        <Button variant="outline" onClick={() => window.location.reload()}>
          {t('retry')}
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Top indeterminate progress bar: only visible while a broadcast
          is mid-send. Pure CSS animation so no extra deps. */}
      {anySending && (
        <div
          role="progressbar"
          aria-label="Broadcast in progress"
          className="broadcast-indeterminate bg-muted fixed inset-x-0 top-0 z-40 h-0.5 overflow-hidden"
        >
          <div className="broadcast-indeterminate-bar bg-primary h-0.5" />
          <style jsx>{`
            .broadcast-indeterminate-bar {
              width: 33%;
              transform: translateX(-100%);
              animation: broadcast-slide 1.6s cubic-bezier(0.4, 0, 0.2, 1)
                infinite;
            }
            @keyframes broadcast-slide {
              0% {
                transform: translateX(-100%);
              }
              100% {
                transform: translateX(400%);
              }
            }
          `}</style>
        </div>
      )}

      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-foreground text-2xl font-bold">{t('title')}</h1>
          <p className="text-muted-foreground mt-1 text-sm">{t('subtitle')}</p>
        </div>
        <GatedButton
          canAct={canCreate}
          gateReason="create broadcasts"
          onClick={() => router.push('/broadcasts/new')}
          className="bg-primary text-primary-foreground hover:bg-primary/90"
        >
          <Plus className="h-4 w-4" />
          {t('newBroadcast')}
        </GatedButton>
      </div>

      {/* SPEC 055 D-10 — Campanhas vs. funis de webhook. A primeira
          campanha de verdade não pode sumir no meio de dezenas de
          funis de origem, então são duas listas, não uma com filtro. */}
      <div className="border-border bg-muted inline-flex rounded-lg border p-0.5">
        {(['campaigns', 'webhooks'] as const).map((v) => (
          <button
            key={v}
            type="button"
            onClick={() => setView(v)}
            className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
              view === v
                ? 'bg-card text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            {tSource(v === 'campaigns' ? 'campaigns' : 'webhooks')}
          </button>
        ))}
      </div>

      {broadcasts.length === 0 ? (
        <div className="border-border bg-card flex h-64 flex-col items-center justify-center rounded-xl border">
          <Radio className="text-muted-foreground mb-3 h-10 w-10" />
          <p className="text-foreground text-sm font-medium">
            {view === 'webhooks' ? tSource('noneYet') : t('noBroadcastsYet')}
          </p>
          <p className="text-muted-foreground mt-1 text-xs">
            {view === 'webhooks' ? tSource('noneYetHint') : t('createFirst')}
          </p>
          {view === 'campaigns' && (
            <GatedButton
              canAct={canCreate}
              gateReason="create broadcasts"
              onClick={() => router.push('/broadcasts/new')}
              className="bg-primary text-primary-foreground hover:bg-primary/90 mt-4"
            >
              <Plus className="h-4 w-4" />
              {t('newBroadcast')}
            </GatedButton>
          )}
        </div>
      ) : (
        <>
          <div className="broadcasts-page-filters grid grid-cols-1 gap-3 md:grid-cols-3">
            <div className="flex flex-col gap-1">
              <label className="text-muted-foreground text-xs font-medium">
                {t('filter.channel')}
              </label>
              <select
                value={filterChannel}
                onChange={(e) => setFilterChannel(e.target.value)}
                className="border-border bg-card text-foreground rounded-md border px-3 py-2 text-sm"
              >
                <option value="">{t('filter.allChannels')}</option>
                {Array.from(channels.byId.values()).map((channel) => (
                  <option key={channel.id} value={channel.id}>
                    {channel.name}
                  </option>
                ))}
              </select>
            </div>

            <div className="flex flex-col gap-1">
              <label className="text-muted-foreground text-xs font-medium">
                {t('filter.template')}
              </label>
              <select
                value={filterTemplate}
                onChange={(e) => setFilterTemplate(e.target.value)}
                className="border-border bg-card text-foreground rounded-md border px-3 py-2 text-sm"
              >
                <option value="">{t('filter.allTemplates')}</option>
                {uniqueTemplates.map((template) => (
                  <option key={template} value={template}>
                    {template}
                  </option>
                ))}
              </select>
            </div>

            <div className="flex flex-col gap-1">
              <label className="text-muted-foreground text-xs font-medium">
                {t('filter.date')}
              </label>
              <select
                value={filterDate}
                onChange={(e) => setFilterDate(e.target.value)}
                className="border-border bg-card text-foreground rounded-md border px-3 py-2 text-sm"
              >
                <option value="">{t('filter.allDates')}</option>
                {uniqueDates.map((date) => (
                  <option key={date} value={date}>
                    {formatDateKey(date)}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {filteredBroadcasts.length === 0 ? (
            <div className="border-border bg-card flex h-32 items-center justify-center rounded-xl border">
              <p className="text-muted-foreground text-sm">
                {t('filter.noResults')}
              </p>
            </div>
          ) : (
            <div className="border-border bg-card overflow-x-auto rounded-xl border">
              <Table>
                <TableHeader>
                  <TableRow className="border-border hover:bg-transparent">
                    <TableHead className="text-muted-foreground">
                      {t('table.name')}
                    </TableHead>
                    {view === 'webhooks' && (
                      <TableHead className="text-muted-foreground hidden text-right sm:table-cell">
                        {tSource('ingested')}
                      </TableHead>
                    )}
                    <TableHead className="text-muted-foreground hidden text-right sm:table-cell">
                      {view === 'webhooks'
                        ? tSource('recipientsSent')
                        : t('table.recipients')}
                    </TableHead>
                    <TableHead className="text-muted-foreground hidden lg:table-cell">
                      {t('table.delivery')}
                    </TableHead>
                    <TableHead className="text-muted-foreground hidden lg:table-cell">
                      {t('table.read')}
                    </TableHead>
                    <TableHead className="text-muted-foreground">
                      {t('table.status')}
                    </TableHead>
                    <TableHead className="text-muted-foreground hidden sm:table-cell">
                      {t('table.date')}
                    </TableHead>
                    {/* SPEC 070 §8.1 — coluna própria, só ocupada em linhas
                    `draft`; nas demais fica vazia, sem cabeçalho, para
                    não sugerir uma ação que não existe ali. */}
                    <TableHead className="text-muted-foreground w-px" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredBroadcasts.map((broadcast) => {
                    const status = getBroadcastStatus(broadcast.status);
                    return (
                      <TableRow
                        key={broadcast.id}
                        className="border-border hover:bg-muted/50 cursor-pointer"
                        onClick={() =>
                          router.push(`/broadcasts/${broadcast.id}`)
                        }
                      >
                        <TableCell className="text-foreground font-medium">
                          <div className="space-y-1">
                            <div className="flex items-center gap-2">
                              <span>{broadcast.name}</span>
                              {broadcast.variant_label && (
                                <span className="border-primary/30 bg-primary/10 text-primary inline-flex shrink-0 items-center rounded-full border px-1.5 py-0.5 text-[10px] font-medium">
                                  {t('variant', {
                                    variant: broadcast.variant_label,
                                  })}
                                </span>
                              )}
                            </div>
                            {channels.count > 1 && broadcast.channel_id && (
                              <div className="flex items-center gap-1.5">
                                <ChannelBadge
                                  channel={channels.byId.get(
                                    broadcast.channel_id
                                  )}
                                />
                              </div>
                            )}
                            {(view !== 'webhooks' ||
                              broadcast.template_name) && (
                              <div className="text-muted-foreground flex items-center gap-1.5 text-xs">
                                <FileText className="h-3.5 w-3.5" />
                                <span className="font-mono">
                                  {view === 'webhooks'
                                    ? broadcast.webhook_id
                                    : broadcast.template_name}
                                </span>
                              </div>
                            )}
                          </div>
                        </TableCell>
                        {view === 'webhooks' && (
                          <TableCell className="text-muted-foreground hidden text-right tabular-nums sm:table-cell">
                            {broadcast.ingested_count ?? 0}
                          </TableCell>
                        )}
                        <TableCell className="text-muted-foreground hidden text-right tabular-nums sm:table-cell">
                          {broadcast.total_recipients}
                        </TableCell>
                        <TableCell className="hidden lg:table-cell">
                          <RateCell
                            value={broadcast.delivered_count}
                            total={broadcast.total_recipients}
                            color="bg-primary"
                          />
                        </TableCell>
                        <TableCell className="hidden lg:table-cell">
                          <RateCell
                            value={broadcast.read_count}
                            total={broadcast.total_recipients}
                            color="bg-blue-500"
                          />
                        </TableCell>
                        <TableCell>
                          <span
                            className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium ${status.classes}`}
                          >
                            {status.pulse && (
                              <span className="relative flex h-1.5 w-1.5">
                                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-yellow-400 opacity-75" />
                                <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-yellow-400" />
                              </span>
                            )}
                            {tStatus(status.label)}
                          </span>
                          {/* SPEC 069 R6 — o progresso é o que distingue uma
                          campanha parada de propósito (esperando cota
                          de checagem) de uma parecida presa por erro. */}
                          {broadcast.status === 'awaiting_check' && (
                            <p className="text-muted-foreground mt-1 text-[10px]">
                              {tAwaitingCheck('progress', {
                                checked: broadcast.checked_count ?? 0,
                                total: broadcast.total_recipients,
                              })}
                            </p>
                          )}
                          {broadcast.scheduled_at &&
                            broadcast.status === 'scheduled' && (
                              <p className="text-muted-foreground mt-1 text-[10px]">
                                {new Date(
                                  broadcast.scheduled_at
                                ).toLocaleString('pt-BR', {
                                  year: 'numeric',
                                  month: '2-digit',
                                  day: '2-digit',
                                  hour: '2-digit',
                                  minute: '2-digit',
                                })}
                              </p>
                            )}
                        </TableCell>
                        <TableCell className="text-muted-foreground hidden sm:table-cell">
                          {new Date(broadcast.created_at).toLocaleDateString()}
                        </TableCell>
                        <TableCell className="text-right">
                          {broadcast.status === 'draft' && (
                            <GatedButton
                              canAct={canCreate}
                              gateReason="edit drafts"
                              variant="outline"
                              size="sm"
                              // A linha inteira já navega para o detalhe
                              // (onClick acima); sem stopPropagation os
                              // dois destinos disparariam juntos.
                              onClick={(e) => {
                                e.stopPropagation();
                                router.push(`/broadcasts/${broadcast.id}/edit`);
                              }}
                              className="border-border text-muted-foreground hover:bg-muted"
                            >
                              <Pencil className="h-3.5 w-3.5" />
                              {t('actions.edit')}
                            </GatedButton>
                          )}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </>
      )}

      {/* Seletor prefixado por `.broadcasts-page-filters` — um bare
          `select, select option` aqui vazaria para QUALQUER <select> da
          página, não só os 3 filtros acima. Não dá para usar
          `<style jsx>` (styled-jsx só aceita um por componente; o outro
          já está no bloco `anySending` acima). */}
      <style>{`
        .broadcasts-page-filters select,
        .broadcasts-page-filters select option {
          font-size: 0.875rem !important;
          padding: 6px 8px;
          line-height: 1.5;
          font-family: inherit;
        }
      `}</style>
    </div>
  );
}
