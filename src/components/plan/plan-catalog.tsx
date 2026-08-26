'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { Check, Loader2 } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { formatLimit, formatPlanPrice } from '@/lib/plans/format';
import { FEATURE_KEYS, QUOTA_KEYS } from '@/lib/plans/types';
import type { PlanCatalogEntry } from '@/hooks/use-account-plan';

/**
 * Cartões do catálogo público (SPEC 059 §7.1). O clique em "Escolher
 * este plano" só grava `plan_change_requests` (D-8) — não troca nada
 * na hora, por isso some assim que existe uma solicitação pendente
 * (`hasPendingRequest`), independentemente de qual plano foi pedido.
 */
export function PlanCatalog({
  catalog,
  currentPlanId,
  canRequest,
  hasPendingRequest,
  onRequested,
}: {
  catalog: PlanCatalogEntry[];
  currentPlanId: string;
  canRequest: boolean;
  hasPendingRequest: boolean;
  onRequested: () => void;
}) {
  const t = useTranslations('Plan');
  const tQuota = useTranslations('Plan.quotaLabel');
  const tFeature = useTranslations('Plan.featureLabel');
  const locale = useLocale();
  const [requesting, setRequesting] = useState<string | null>(null);

  async function handleChoose(planId: string) {
    setRequesting(planId);
    try {
      const res = await fetch('/api/account/plan/request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ planId }),
      });
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        toast.error(payload.error || t('requestFailed'));
        return;
      }
      toast.success(t('requestSent'));
      onRequested();
    } finally {
      setRequesting(null);
    }
  }

  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {catalog.map((plan) => {
        const isCurrent = plan.id === currentPlanId;
        return (
          <Card
            key={plan.id}
            className={cn('flex flex-col', isCurrent && 'ring-primary ring-2')}
          >
            <CardHeader>
              <div className="flex items-center justify-between">
                <span className="text-foreground font-semibold">
                  {plan.name}
                </span>
                {isCurrent ? (
                  <Badge variant="secondary">{t('currentPlan')}</Badge>
                ) : null}
              </div>
              <span className="text-foreground text-2xl font-bold">
                {plan.priceCents === 0
                  ? t('free')
                  : formatPlanPrice(plan.priceCents, plan.currency, locale)}
                {plan.priceCents > 0 ? (
                  <span className="text-muted-foreground text-sm font-normal">
                    {' '}
                    /{t(`billingPeriod.${plan.billingPeriod}`)}
                  </span>
                ) : null}
              </span>
              {plan.description ? (
                <p className="text-muted-foreground text-xs">
                  {plan.description}
                </p>
              ) : null}
            </CardHeader>
            <CardContent className="flex flex-1 flex-col gap-3">
              <ul className="flex flex-col gap-1.5 text-sm">
                {QUOTA_KEYS.map((key) => (
                  <li
                    key={key}
                    className="text-muted-foreground flex justify-between gap-2"
                  >
                    <span>{tQuota(key)}</span>
                    <span className="text-foreground font-medium">
                      {formatLimit(plan.limits[key] ?? null, locale)}
                    </span>
                  </li>
                ))}
              </ul>
              <ul className="flex flex-col gap-1 text-sm">
                {FEATURE_KEYS.filter((key) => plan.features[key]).map((key) => (
                  <li
                    key={key}
                    className="text-foreground flex items-center gap-1.5"
                  >
                    <Check className="text-primary size-3.5 shrink-0" />
                    {tFeature(key)}
                  </li>
                ))}
              </ul>
              <div className="mt-auto pt-2">
                {isCurrent ? null : !canRequest ? null : hasPendingRequest ? (
                  <Button type="button" variant="outline" size="sm" disabled>
                    {t('requestSent')}
                  </Button>
                ) : (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={requesting !== null}
                    onClick={() => handleChoose(plan.id)}
                  >
                    {requesting === plan.id ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : null}
                    {t('choosePlan')}
                  </Button>
                )}
              </div>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
