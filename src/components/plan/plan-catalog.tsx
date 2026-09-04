'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { Check, Loader2 } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { yearlyPriceCents, yearlySavingsCents } from '@/lib/plans/billing';
import {
  formatLimit,
  formatPlanPrice,
  planChangeErrorKey,
} from '@/lib/plans/format';
import { FEATURE_KEYS, USAGE_QUOTA_KEYS } from '@/lib/plans/types';
import type { PlanCatalogEntry } from '@/hooks/use-account-plan';
import { PlanCycleDialog } from './plan-cycle-dialog';

/**
 * Cartões do catálogo público (SPEC 059 §7.1). Dois caminhos a partir
 * de "Escolher este plano" (SPEC 062 §6.1, D-3):
 *
 *   - `selfServiceEnabled` ligado → abre `PlanCycleDialog`, que troca
 *     NA HORA (`POST /api/account/plan/change`);
 *   - desligado → volta ao fluxo antigo (SPEC 059 D-8): grava
 *     `plan_change_requests` e espera o operador. O botão some
 *     enquanto existe uma solicitação pendente, independentemente de
 *     qual plano foi pedido — mas o autosserviço IGNORA esse estado
 *     (é uma troca imediata, não uma fila).
 */
export function PlanCatalog({
  catalog,
  currentPlanId,
  canRequest,
  hasPendingRequest,
  selfServiceEnabled,
  defaultYearlyDiscountPercent,
  currentUsage,
  onRequested,
}: {
  catalog: PlanCatalogEntry[];
  currentPlanId: string;
  canRequest: boolean;
  hasPendingRequest: boolean;
  selfServiceEnabled: boolean;
  defaultYearlyDiscountPercent: number;
  currentUsage: Partial<Record<string, number>>;
  onRequested: () => void;
}) {
  const t = useTranslations('Plan');
  const tQuota = useTranslations('Plan.quotaLabel');
  const tFeature = useTranslations('Plan.featureLabel');
  const locale = useLocale();
  const [requesting, setRequesting] = useState<string | null>(null);
  const [cyclePlan, setCyclePlan] = useState<PlanCatalogEntry | null>(null);

  async function handleRequest(planId: string) {
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

  /**
   * O Grátis não tem ciclo para escolher (`priceCents === 0` — o
   * `computePeriodEnd` de qualquer forma devolve `null` para ele) —
   * pular direto o modal seria só uma pergunta sem resposta útil.
   * Todo outro plano público passa pelo `PlanCycleDialog`.
   */
  async function handleChoose(plan: PlanCatalogEntry) {
    if (!selfServiceEnabled) {
      await handleRequest(plan.id);
      return;
    }
    if (plan.priceCents === 0) {
      setRequesting(plan.id);
      try {
        const res = await fetch('/api/account/plan/change', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ planId: plan.id, billingCycle: 'monthly' }),
        });
        if (!res.ok) {
          const payload = await res.json().catch(() => ({}));
          // Achado de code review: este atalho (plano Grátis pula o
          // diálogo) chama a MESMA rota que `PlanCycleDialog`, mas até
          // aqui não tinha o mapeamento de `code` — inclusive
          // `account_past_due` caía sempre no texto cru em inglês da
          // API. `t` já está namespaced em `Plan`, então a chave
          // (dentro de `Plan.cycle.*`) precisa do prefixo.
          const key = planChangeErrorKey(payload.code as string | undefined);
          toast.error(
            key ? t(`cycle.${key}`) : payload.error || t('requestFailed')
          );
          return;
        }
        toast.success(t('cycle.changeSuccess', { plan: plan.name }));
        onRequested();
      } finally {
        setRequesting(null);
      }
      return;
    }
    // Achado de code review: `currentUsage` (o aviso de overage no
    // downgrade, §7.6) é a foto do último fetch — se a conta importou
    // contatos numa outra aba enquanto esta ficava aberta, o diálogo
    // abriria com um número velho. `onRequested` é o mesmo `refetch`
    // que qualquer outra ação já dispara aqui (não tem efeito colateral
    // além de recarregar); chamá-lo agora deixa o número atualizar por
    // baixo do diálogo assim que a resposta chegar — `currentUsage` é
    // dependência do `useMemo` de `PlanCycleDialog`, então o aviso
    // recalcula sozinho sem esperar o usuário reabrir nada. A
    // aplicação real da quota (na escrita) nunca dependeu disto —
    // isto só deixa o AVISO mais preciso.
    onRequested();
    setCyclePlan(plan);
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
              {/* Preço anual derivado (§3.4, D-5/D-6) — só para plano
                  pago com ciclo mensal; o Grátis e o sob-medida não
                  têm o que comparar. */}
              {plan.priceCents > 0 && plan.billingPeriod === 'monthly' ? (
                <p className="text-muted-foreground text-xs">
                  {t('orYearly', {
                    price: formatPlanPrice(
                      yearlyPriceCents(plan, defaultYearlyDiscountPercent),
                      plan.currency,
                      locale
                    ),
                    savings: formatPlanPrice(
                      yearlySavingsCents(plan, defaultYearlyDiscountPercent),
                      plan.currency,
                      locale
                    ),
                  })}
                </p>
              ) : null}
              {plan.description ? (
                <p className="text-muted-foreground text-xs">
                  {plan.description}
                </p>
              ) : null}
            </CardHeader>
            <CardContent className="flex flex-1 flex-col gap-3">
              <ul className="flex flex-col gap-1.5 text-sm">
                {USAGE_QUOTA_KEYS.map((key) => (
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
                {isCurrent ? null : !canRequest ? null : !selfServiceEnabled &&
                  hasPendingRequest ? (
                  <Button type="button" variant="outline" size="sm" disabled>
                    {t('requestSent')}
                  </Button>
                ) : (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={requesting !== null}
                    onClick={() => handleChoose(plan)}
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

      {cyclePlan ? (
        <PlanCycleDialog
          plan={cyclePlan}
          defaultYearlyDiscountPercent={defaultYearlyDiscountPercent}
          currentUsage={currentUsage}
          onClose={() => setCyclePlan(null)}
          onChanged={() => {
            setCyclePlan(null);
            onRequested();
          }}
        />
      ) : null}
    </div>
  );
}
