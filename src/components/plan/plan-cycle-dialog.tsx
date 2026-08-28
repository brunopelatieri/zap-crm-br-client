'use client';

// ============================================================
// PlanCycleDialog — modal do PRD §3.2 / SPEC 062 §7.6 (F8)
//
//   Escolha de ciclo (mensal/anual), vencimento resultante, aviso de
//   overage no downgrade e o texto de que o período recomeça HOJE, sem
//   pró-rata. Confirmar chama `POST /api/account/plan/change` — a
//   troca é IMEDIATA (D-3), diferente de `PlanCatalog`'s fluxo antigo
//   de solicitação, que grava e espera o operador.
//
//   `describeCycleChange` (puro, `@/lib/plans/billing.ts`) já resolve
//   o vencimento e o overage — este componente só exibe.
// ============================================================

import { useMemo, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { AlertTriangle, Loader2 } from 'lucide-react';

import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import {
  describeCycleChange,
  yearlyPriceCents,
  yearlySavingsCents,
  type BillingCycle,
} from '@/lib/plans/billing';
import { formatPlanPrice, planChangeErrorKey } from '@/lib/plans/format';
import type { PlanCatalogEntry } from '@/hooks/use-account-plan';

export function PlanCycleDialog({
  plan,
  defaultYearlyDiscountPercent,
  currentUsage,
  onClose,
  onChanged,
}: {
  plan: PlanCatalogEntry;
  defaultYearlyDiscountPercent: number;
  /** `{ quotaKey: used }` — para o aviso de overage no downgrade (§7.6). */
  currentUsage: Partial<Record<string, number>>;
  onClose: () => void;
  onChanged: () => void;
}) {
  const t = useTranslations('Plan.cycle');
  const tQuota = useTranslations('Plan.quotaLabel');
  const locale = useLocale();
  const [cycle, setCycle] = useState<BillingCycle>('monthly');
  const [saving, setSaving] = useState(false);

  const now = useMemo(() => new Date(), []);
  const description = useMemo(
    () => describeCycleChange(plan, cycle, now, currentUsage),
    [plan, cycle, now, currentUsage]
  );

  const discount = plan.yearlyDiscountPercent ?? defaultYearlyDiscountPercent;
  const yearlyCents = yearlyPriceCents(plan, defaultYearlyDiscountPercent);
  const savingsCents = yearlySavingsCents(plan, defaultYearlyDiscountPercent);
  const priceCents = cycle === 'yearly' ? yearlyCents : plan.priceCents;

  async function handleConfirm() {
    setSaving(true);
    try {
      const res = await fetch('/api/account/plan/change', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ planId: plan.id, billingCycle: cycle }),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        const key = planChangeErrorKey(payload.code as string | undefined);
        toast.error(key ? t(key) : payload.error || t('errorGeneric'));
        return;
      }
      toast.success(t('changeSuccess', { plan: plan.name }));
      onChanged();
    } catch (err) {
      console.error('[PlanCycleDialog] change failed:', err);
      toast.error(t('errorGeneric'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('title', { plan: plan.name })}</DialogTitle>
          <DialogDescription>{t('noProration')}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <RadioGroup
            value={cycle}
            onValueChange={(v) => setCycle(v as BillingCycle)}
          >
            <Label className="border-border flex cursor-pointer items-center justify-between gap-3 rounded-lg border p-3">
              <span className="flex items-center gap-2">
                <RadioGroupItem value="monthly" />
                {t('monthly')}
              </span>
              <span className="text-foreground font-medium">
                {formatPlanPrice(plan.priceCents, plan.currency, locale)}
              </span>
            </Label>
            <Label className="border-border flex cursor-pointer items-center justify-between gap-3 rounded-lg border p-3">
              <span className="flex items-center gap-2">
                <RadioGroupItem value="yearly" />
                {t('yearly')}
              </span>
              <span className="flex flex-col items-end">
                <span className="text-foreground font-medium">
                  {formatPlanPrice(yearlyCents, plan.currency, locale)}
                </span>
                {discount > 0 ? (
                  <span className="text-primary text-xs">
                    {t('savings', {
                      amount: formatPlanPrice(
                        savingsCents,
                        plan.currency,
                        locale
                      ),
                    })}
                  </span>
                ) : null}
              </span>
            </Label>
          </RadioGroup>

          <p className="text-muted-foreground text-sm">
            {description.newPeriodEnd
              ? t('renewsOn', {
                  date: description.newPeriodEnd.toLocaleDateString(locale, {
                    dateStyle: 'long',
                  }),
                })
              : t('noExpiration')}
          </p>

          {description.hasOverageWarning ? (
            <Alert variant="destructive">
              <AlertTriangle />
              <AlertDescription>
                {t('overageWarning', {
                  keys: description.overageKeys
                    .map((k) => tQuota(k))
                    .join(', '),
                })}
              </AlertDescription>
            </Alert>
          ) : null}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            {t('cancel')}
          </Button>
          <Button onClick={handleConfirm} disabled={saving}>
            {saving ? <Loader2 className="animate-spin" /> : null}
            {t('confirm', {
              price: formatPlanPrice(priceCents, plan.currency, locale),
            })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
