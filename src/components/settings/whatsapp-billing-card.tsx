'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { formatDistanceToNow } from 'date-fns';
import { ExternalLink, Info, Loader2, RefreshCw } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { toast } from 'sonner';

import { Button, buttonVariants } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { cn } from '@/lib/utils';
import { getDateFnsLocale } from '@/lib/i18n/date-fns-locale';
import {
  fetchChannelBilling,
  postPaymentAck,
  refreshAdvanced,
  type BillingFetchResult,
} from '@/lib/whatsapp/billing-client';
import type { ChannelBillingDto } from '@/lib/whatsapp/billing-dto';
import {
  formatClock,
  formatDateTime,
  formatMoney,
  formatPeriodMonth,
  formatVolume,
  isKnownPricingCategory,
} from '@/lib/whatsapp/billing-format';

import { BillingStateBadge } from './whatsapp-billing-state-badge';

interface WhatsAppBillingCardProps {
  channelId: string;
  /** admin+: vê consumo, "Atualizar" e "Já regularizei" (SPEC 076 §11.5). */
  canEditSettings: boolean;
}

/**
 * Card "Status de envio e consumo" do detalhe de um número oficial
 * (SPEC 076 §11.2).
 *
 *   - Flag desligado (404 da rota): o card some, sem erro (§11.5).
 *   - Falha da rota: erro inline com "Tentar de novo", sem toast — a aba
 *     é aberta toda hora.
 *   - Falha da META não é erro da rota: o DTO vem com `stale`/`error` e o
 *     card mostra o último retrato com o aviso.
 *   - agent/viewer: só o bloco de status, sem botões (o DTO já não traz o
 *     consumo para eles).
 */
export function WhatsAppBillingCard({
  channelId,
  canEditSettings,
}: WhatsAppBillingCardProps) {
  const t = useTranslations('Settings.whatsapp.billing');
  const locale = useLocale();
  const dateFnsLocale = getDateFnsLocale(locale);

  const [data, setData] = useState<ChannelBillingDto | null>(null);
  const [hidden, setHidden] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  /**
   * Resposta 429 do próprio "Atualizar" (limite por usuário ou 1 leitura
   * forçada por WABA a cada 60 s — nossos, não da Meta): até quando esperar.
   * Some sozinho quando o horário passa.
   */
  const [throttledUntil, setThrottledUntil] = useState<string | null>(null);
  useEffect(() => {
    if (!throttledUntil) return;
    const ms = Date.parse(throttledUntil) - Date.now();
    const timer = setTimeout(
      () => setThrottledUntil(null),
      Number.isFinite(ms) ? Math.max(0, ms) : 0
    );
    return () => clearTimeout(timer);
  }, [throttledUntil]);
  const [ackOpen, setAckOpen] = useState(false);
  const [acking, setAcking] = useState(false);

  // Resposta que chega depois do desmonte (ou de uma busca mais nova) não
  // pode escrever estado.
  const seq = useRef(0);
  useEffect(
    () => () => {
      seq.current += 1;
    },
    []
  );

  /** Aplica um resultado de leitura. Devolve `true` se virou dado novo. */
  const apply = useCallback(
    (
      res: BillingFetchResult<ChannelBillingDto>
    ): res is { status: 'ok'; data: ChannelBillingDto } => {
      if (res.status === 'ok') {
        setData(res.data);
        setLoadError(false);
        return true;
      }
      if (res.status === 'disabled') {
        setHidden(true);
        return false;
      }
      // `error` (e `throttled`, que só existe com refresh): mantém o último
      // retrato; sem retrato, mostra o erro inline.
      setLoadError(true);
      return false;
    },
    []
  );

  useEffect(() => {
    const mine = ++seq.current;
    fetchChannelBilling(channelId).then((res) => {
      if (mine === seq.current) apply(res);
    });
  }, [channelId, apply]);

  async function handleRetry() {
    const mine = ++seq.current;
    setLoadError(false);
    const res = await fetchChannelBilling(channelId);
    if (mine === seq.current) apply(res);
  }

  async function handleRefresh() {
    const mine = ++seq.current;
    setRefreshing(true);
    setThrottledUntil(null);
    const res = await fetchChannelBilling(channelId, { refresh: true });
    // Antes do teste de `seq`: uma busca mais nova (ex.: a releitura do
    // "Já regularizei") descarta ESTA resposta, mas o botão não pode ficar
    // preso em "Atualizando…".
    setRefreshing(false);
    if (mine !== seq.current) return;
    if (res.status === 'throttled') {
      setThrottledUntil(
        new Date(Date.now() + res.retryAfterSeconds * 1000).toISOString()
      );
      return;
    }
    const prev = data;
    if (!apply(res)) {
      if (res.status === 'error') toast.error(t('loadFailed'));
      return;
    }
    // 200 nem sempre é leitura nova: em recuo, ou com a Meta falhando, a
    // rota devolve o retrato anterior.
    if (refreshAdvanced(prev, res.data)) {
      toast.success(t('refreshed'));
    } else {
      toast.info(t('refreshNotUpdated'));
    }
  }

  async function handleAck() {
    setAcking(true);
    const res = await postPaymentAck(channelId);
    setAcking(false);
    if (res.status === 'disabled') {
      setHidden(true);
      return;
    }
    if (res.status !== 'ok') {
      toast.error(t('ackPaymentFailed'));
      return;
    }
    setAckOpen(false);
    toast.success(
      res.data.cleared ? t('ackPaymentSuccess') : t('ackPaymentNothing')
    );
    // O estado muda (sai de "pagamento pendente"): relê o painel.
    const mine = ++seq.current;
    const next = await fetchChannelBilling(channelId);
    if (mine === seq.current) apply(next);
  }

  if (hidden) return null;

  const ago = (iso: string | null | undefined) =>
    iso
      ? formatDistanceToNow(new Date(iso), {
          addSuffix: true,
          locale: dateFnsLocale,
        })
      : '';

  // ── Carregando / erro da rota (sem retrato nenhum) ─────────────────
  if (!data) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-foreground">{t('title')}</CardTitle>
        </CardHeader>
        <CardContent>
          {loadError ? (
            <div className="flex flex-wrap items-center gap-3">
              <p className="text-destructive text-sm">{t('loadFailed')}</p>
              <Button variant="outline" size="sm" onClick={handleRetry}>
                {t('retry')}
              </Button>
            </div>
          ) : (
            <div className="space-y-3" aria-busy="true">
              <div className="bg-muted h-5 w-1/3 animate-pulse rounded" />
              <div className="bg-muted h-4 w-2/3 animate-pulse rounded" />
              <div className="bg-muted h-24 w-full animate-pulse rounded" />
            </div>
          )}
        </CardContent>
      </Card>
    );
  }

  const { spend } = data;
  const checkedAt = data.send_status.checked_at;
  const metaRateLimitedAt =
    data.error?.kind === 'rate_limit' ? data.next_retry_at : null;
  const paymentDate = formatDateTime(
    data.payment.last_error_at ?? data.payment.since,
    dateFnsLocale
  );
  const spendCategories = spend?.by_category ?? [];
  const totalVolume = spendCategories.reduce((sum, c) => sum + c.volume, 0);
  const periodMonth = formatPeriodMonth(spend?.period_start, dateFnsLocale);
  const money = (value: number | null) =>
    value === null ? '—' : formatMoney(locale, spend?.currency, value);

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1">
            <CardTitle className="text-foreground">{t('title')}</CardTitle>
            <CardDescription
              className="text-muted-foreground"
              aria-live="polite"
            >
              {checkedAt
                ? t('updatedAgo', { ago: ago(checkedAt) })
                : t('neverChecked')}
            </CardDescription>
          </div>
          {canEditSettings && (
            <Button
              variant="outline"
              size="sm"
              onClick={handleRefresh}
              disabled={refreshing}
              className="border-border text-foreground hover:bg-muted bg-transparent"
            >
              {refreshing ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <RefreshCw className="size-3.5" />
              )}
              {refreshing ? t('refreshing') : t('refresh')}
            </Button>
          )}
        </div>
      </CardHeader>

      <CardContent className="space-y-6">
        {/* ── Status de envio ───────────────────────────────────────── */}
        <section className="space-y-3">
          <h3 className="text-foreground text-sm font-semibold">
            {t('sendStatus')}
          </h3>
          <BillingStateBadge state={data.state} />

          {data.payment.pending && (
            <p className="text-muted-foreground text-sm">
              {paymentDate
                ? t('paymentHint', { date: paymentDate })
                : t('paymentHintNoDate')}
            </p>
          )}

          {throttledUntil ? (
            <p className="text-sm text-amber-600 dark:text-amber-300">
              {t('refreshThrottled', {
                time: formatClock(throttledUntil, dateFnsLocale),
              })}
            </p>
          ) : metaRateLimitedAt ? (
            <p className="text-sm text-amber-600 dark:text-amber-300">
              {t('rateLimited', {
                time: formatClock(metaRateLimitedAt, dateFnsLocale),
              })}
            </p>
          ) : (
            data.stale && (
              <p className="text-sm text-amber-600 dark:text-amber-300">
                {t('stale', { ago: ago(checkedAt) })}
              </p>
            )
          )}
          {data.error?.message && (
            <p className="text-muted-foreground text-xs">
              {data.error.message}
            </p>
          )}

          {data.send_status.problems.length > 0 && (
            <div className="space-y-1.5">
              <p className="text-foreground text-xs font-medium">
                {t('problemsTitle')}
              </p>
              <ul className="text-muted-foreground space-y-1.5 text-xs">
                {data.send_status.problems.map((p, i) => (
                  <li key={`${p.entity_type}-${p.id ?? i}`}>
                    <code>{p.entity_type}</code>
                    {p.id ? ` ${p.id}` : ''}
                    {[
                      ...p.errors.flatMap((e) => [
                        e.error_description,
                        e.possible_solution,
                      ]),
                      ...p.additional_info,
                    ]
                      .filter((line): line is string => Boolean(line))
                      .map((line, j) => (
                        <span key={j} className="block pl-3">
                          {line}
                        </span>
                      ))}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2">
            {data.billing_url && (
              <a
                href={data.billing_url}
                target="_blank"
                rel="noopener noreferrer"
                className={cn(
                  buttonVariants({ variant: 'outline', size: 'sm' }),
                  'border-border text-foreground hover:bg-muted bg-transparent'
                )}
              >
                <ExternalLink className="size-3.5" aria-hidden />
                {t('openBilling')}
                <span className="sr-only"> {t('opensInNewTab')}</span>
              </a>
            )}
            {canEditSettings && data.payment.pending && (
              <Button size="sm" onClick={() => setAckOpen(true)}>
                {t('ackPayment')}
              </Button>
            )}
          </div>
        </section>

        {/* ── Consumo estimado (admin+) ─────────────────────────────── */}
        {spend && (
          <section className="space-y-3">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h3 className="text-foreground text-sm font-semibold">
                {t('monthlySpend')}
              </h3>
              {periodMonth && (
                <span className="text-muted-foreground text-xs">
                  {t('periodLabel', { month: periodMonth })}
                </span>
              )}
            </div>

            {!spend.available ? (
              <p className="text-muted-foreground text-sm">
                {t('spendUnavailable')}
              </p>
            ) : spendCategories.length === 0 ? (
              <p className="text-muted-foreground text-sm">{t('noSpend')}</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead scope="col">{t('tableCategory')}</TableHead>
                    <TableHead scope="col" className="text-right">
                      {t('tableMessages')}
                    </TableHead>
                    <TableHead scope="col" className="text-right">
                      {t('tableValue')}
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {spendCategories.map((c) => (
                    <TableRow key={c.category}>
                      <TableCell>
                        {isKnownPricingCategory(c.category)
                          ? t(`category.${c.category}`)
                          : c.category}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatVolume(locale, c.volume)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {money(c.cost)}
                      </TableCell>
                    </TableRow>
                  ))}
                  <TableRow className="font-semibold">
                    <TableCell>{t('total')}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatVolume(locale, totalVolume)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {money(spend.total)}
                    </TableCell>
                  </TableRow>
                </TableBody>
              </Table>
            )}

            {spend.currency_changed && (
              <p className="text-sm text-amber-600 dark:text-amber-300">
                {t('currencyChanged')}
              </p>
            )}
            <p className="text-muted-foreground flex items-start gap-1.5 text-xs">
              <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
              {t('disclaimer')}
            </p>
            {data.shared_with_channels > 1 && (
              <p className="text-muted-foreground text-xs">
                {t('sharedWaba', { count: data.shared_with_channels })}
              </p>
            )}
          </section>
        )}
      </CardContent>

      <Dialog
        open={ackOpen}
        onOpenChange={(open) => !acking && setAckOpen(open)}
      >
        <DialogContent className="border-border bg-popover sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-popover-foreground">
              {t('ackPaymentTitle')}
            </DialogTitle>
            <DialogDescription className="text-muted-foreground">
              {t('ackPaymentConfirm')}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setAckOpen(false)}
              disabled={acking}
            >
              {t('ackPaymentCancel')}
            </Button>
            <Button onClick={handleAck} disabled={acking}>
              {acking && <Loader2 className="size-4 animate-spin" />}
              {t('ackPaymentSubmit')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
