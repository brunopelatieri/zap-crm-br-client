'use client';

import { useState } from 'react';
import { useTranslations, useLocale } from 'next-intl';
import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { useAccountPlanContext } from '@/hooks/use-account-plan-context';
import { useAuth } from '@/hooks/use-auth';
import { canEditSettings } from '@/lib/auth/roles';
import { formatPlanPrice } from '@/lib/plans/format';
import { PlanUsageBars } from './plan-usage-bars';
import { PlanCatalog } from './plan-catalog';
import { PlanRequestState } from './plan-request-state';

const STATUS_VARIANT: Record<string, 'default' | 'secondary' | 'destructive'> =
  {
    active: 'secondary',
    trialing: 'secondary',
    past_due: 'destructive',
    suspended: 'destructive',
    canceled: 'destructive',
  };

/** Página "Plano e uso" (SPEC 059 §7.1) — standalone, fora de Configurações. */
export function PlanPanel() {
  const t = useTranslations('Plan');
  const locale = useLocale();
  const { accountRole } = useAuth();
  const { data, loading, error, refetch } = useAccountPlanContext();
  const [cancelBusy, setCancelBusy] = useState(false);
  const canRequest = accountRole !== null && canEditSettings(accountRole);

  // Achado de code review: gatear em `!data` (não em `loading`/`error`
  // isolados) é o que faz esta tela sobreviver a um refetch que falha
  // (ex.: hiccup de rede logo depois de abrir o diálogo de ciclo).
  // Uma vez que `data` existe (a carga inicial já teve sucesso alguma
  // vez), a árvore inteira — incluindo o `PlanCatalog` e o estado local
  // do diálogo de troca de plano — nunca mais é desmontada por causa de
  // `loading`/`error` reaparecerem num refetch subsequente.
  if (!data) {
    if (loading) {
      return (
        <div className="text-muted-foreground flex items-center gap-2 py-10 text-sm">
          <Loader2 className="size-4 animate-spin" />
          {t('loading')}
        </div>
      );
    }
    if (error) {
      return (
        <p className="text-destructive py-10 text-sm">{t('loadFailed')}</p>
      );
    }
    return null;
  }

  const requestedPlan = data.pendingRequest
    ? data.catalog.find((p) => p.id === data.pendingRequest?.requestedPlanId)
    : null;

  const currentUsage = Object.fromEntries(
    data.usage.buckets.map((b) => [b.key, b.used])
  );

  async function handleCancelToggle(schedule: boolean) {
    setCancelBusy(true);
    try {
      const res = await fetch('/api/account/plan/cancel', {
        method: schedule ? 'POST' : 'DELETE',
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(
          payload.code === 'no_period_end'
            ? t('cancel.errorNoPeriodEnd')
            : payload.error || t('cancel.errorGeneric')
        );
        return;
      }
      toast.success(
        schedule ? t('cancel.scheduleSuccess') : t('cancel.resumeSuccess')
      );
      refetch();
    } catch (err) {
      console.error('[PlanPanel] cancel toggle failed:', err);
      toast.error(t('cancel.errorGeneric'));
    } finally {
      setCancelBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardContent className="flex flex-col gap-5">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="flex items-center gap-2">
                <h3 className="text-foreground text-base font-semibold">
                  {data.plan.name}
                </h3>
                <Badge
                  variant={
                    STATUS_VARIANT[data.accountPlan.status] ?? 'secondary'
                  }
                >
                  {t(`status.${data.accountPlan.status}`)}
                </Badge>
              </div>
              <p className="text-muted-foreground text-sm">
                {data.plan.priceCents === 0
                  ? t('free')
                  : formatPlanPrice(
                      data.plan.priceCents,
                      data.plan.currency,
                      locale
                    )}
              </p>
            </div>
          </div>

          {data.accountPlan.status === 'suspended' ? (
            <p className="bg-destructive/10 text-destructive rounded-lg px-3 py-2 text-sm">
              {t('suspendedNotice')}
            </p>
          ) : null}

          {/* Bloco de assinatura (SPEC 062 §7.6): ciclo, adesão,
              vencimento e o estado de cancelamento agendado — só
              aparece quando o plano realmente vence (um plano
              `billing_period: 'none'`/`'custom'` não tem nada disto
              para mostrar). */}
          {data.accountPlan.currentPeriodEnd ? (
            <div className="border-border grid gap-1.5 border-t pt-4 text-sm">
              <div className="text-muted-foreground flex justify-between gap-2">
                <span>{t('cycleLabel')}</span>
                <span className="text-foreground">
                  {t(`billingPeriod.${data.accountPlan.billingCycle}`)}
                </span>
              </div>
              <div className="text-muted-foreground flex justify-between gap-2">
                <span>{t('startedAtLabel')}</span>
                <span className="text-foreground">
                  {new Date(data.accountPlan.startedAt).toLocaleDateString(
                    locale,
                    { dateStyle: 'medium' }
                  )}
                </span>
              </div>
              <div className="text-muted-foreground flex justify-between gap-2">
                <span>{t('renewsAtLabel')}</span>
                <span className="text-foreground">
                  {new Date(
                    data.accountPlan.currentPeriodEnd
                  ).toLocaleDateString(locale, { dateStyle: 'medium' })}
                </span>
              </div>

              {data.accountPlan.cancelAtPeriodEnd ? (
                <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                  <p className="text-amber-600 dark:text-amber-400">
                    {t('cancel.scheduledFor', {
                      date: new Date(
                        data.accountPlan.currentPeriodEnd
                      ).toLocaleDateString(locale, { dateStyle: 'medium' }),
                    })}
                  </p>
                  {canRequest ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={cancelBusy}
                      onClick={() => handleCancelToggle(false)}
                    >
                      {cancelBusy ? (
                        <Loader2 className="size-3.5 animate-spin" />
                      ) : null}
                      {t('cancel.resumeButton')}
                    </Button>
                  ) : null}
                </div>
              ) : canRequest ? (
                <div className="mt-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="text-muted-foreground"
                    disabled={cancelBusy}
                    onClick={() => handleCancelToggle(true)}
                  >
                    {cancelBusy ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    ) : null}
                    {t('cancel.cancelButton')}
                  </Button>
                </div>
              ) : null}
            </div>
          ) : null}

          <PlanUsageBars buckets={data.usage.buckets} />
        </CardContent>
      </Card>

      {data.pendingRequest ? (
        <PlanRequestState
          request={data.pendingRequest}
          planName={requestedPlan?.name ?? '—'}
          canCancel={canRequest}
          onCanceled={refetch}
        />
      ) : null}

      {data.catalog.length > 0 ? (
        <div>
          <h3 className="text-foreground mb-3 text-base font-semibold">
            {t('catalogTitle')}
          </h3>
          <PlanCatalog
            catalog={data.catalog}
            currentPlanId={data.plan.id}
            canRequest={canRequest}
            hasPendingRequest={data.pendingRequest !== null}
            selfServiceEnabled={data.selfServiceEnabled}
            defaultYearlyDiscountPercent={data.defaultYearlyDiscountPercent}
            currentUsage={currentUsage}
            onRequested={refetch}
          />
        </div>
      ) : null}
    </div>
  );
}
