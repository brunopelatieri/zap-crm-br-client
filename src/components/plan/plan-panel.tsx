'use client';

import { useTranslations, useLocale } from 'next-intl';
import { Loader2 } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
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
  const canRequest = accountRole !== null && canEditSettings(accountRole);

  if (loading) {
    return (
      <div className="text-muted-foreground flex items-center gap-2 py-10 text-sm">
        <Loader2 className="size-4 animate-spin" />
        {t('loading')}
      </div>
    );
  }

  if (error || !data) {
    return <p className="text-destructive py-10 text-sm">{t('loadFailed')}</p>;
  }

  const requestedPlan = data.pendingRequest
    ? data.catalog.find((p) => p.id === data.pendingRequest?.requestedPlanId)
    : null;

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
            onRequested={refetch}
          />
        </div>
      ) : null}
    </div>
  );
}
