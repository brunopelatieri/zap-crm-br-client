'use client';

// ============================================================
// ChangePeriodEndDialog — alterar a data de vencimento (SPEC 078 §3, §9.1)
//
// Chama PUT /api/platform/accounts/[id]/billing/period-end. A data é um
// DIA no calendário de São Paulo (D-2); a conversão para o instante
// 23:59:59 acontece no banco. O `<input type="date">` já limita a faixa
// com a mesma regra do servidor (`periodEndRange`), e a validação local
// usa a mesma função da rota — o diálogo nunca oferece um dia que o
// servidor vai recusar.
// ============================================================

import { useMemo, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';

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
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import {
  periodEndRange,
  todayInSaoPaulo,
  validatePeriodEndInput,
} from '@/lib/plans/manual-billing';
import type { AccountPlanStatus, BillingCycle } from '@/lib/plans/types';

import { formatIsoDay, formatSpDate } from './console-format';
import { useConsoleErrorMessage } from './use-console-error';

export function ChangePeriodEndDialog({
  accountId,
  accountName,
  currentPeriodEnd,
  billingCycle,
  status,
  cancelAtPeriodEnd,
  onClose,
  onChanged,
}: {
  accountId: string;
  accountName: string;
  currentPeriodEnd: string | null;
  billingCycle: BillingCycle;
  status: AccountPlanStatus;
  cancelAtPeriodEnd: boolean;
  onClose: () => void;
  onChanged: () => void;
}) {
  const t = useTranslations('Platform.periodEnd');
  const tBlock = useTranslations('Platform.block');
  const errorMessage = useConsoleErrorMessage();
  const locale = useLocale();

  const todaySp = useMemo(() => todayInSaoPaulo(new Date()), []);
  const range = useMemo(() => periodEndRange(todaySp), [todaySp]);

  // Começa no dia do vencimento atual (se ainda couber na faixa) — o
  // caso comum é empurrar a data a partir dela.
  const [date, setDate] = useState(() => {
    if (!range) return '';
    const current = currentPeriodEnd
      ? todayInSaoPaulo(new Date(currentPeriodEnd))
      : range.min;
    return current < range.min
      ? range.min
      : current > range.max
        ? range.max
        : current;
  });
  const [cycle, setCycle] = useState<BillingCycle>(billingCycle);
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);

  const validation = validatePeriodEndInput({
    date,
    billingCycle: cycle,
    todaySp,
  });
  const dateError =
    date !== '' && !validation.ok ? errorMessage(validation.code, '') : null;

  async function handleSave() {
    if (!validation.ok) return;
    setSaving(true);
    try {
      const res = await fetch(
        `/api/platform/accounts/${accountId}/billing/period-end`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            date,
            billingCycle: cycle !== billingCycle ? cycle : undefined,
            reason: reason.trim() || null,
          }),
        }
      );
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        toast.error(errorMessage(payload.code, t('failed')));
        return;
      }
      toast.success(t('success'));
      onChanged();
    } catch (err) {
      console.error('[ChangePeriodEndDialog] save failed:', err);
      toast.error(t('failed'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="border-border bg-popover sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-popover-foreground">
            {t('title', { account: accountName })}
          </DialogTitle>
          <DialogDescription>{t('description')}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label>{t('currentLabel')}</Label>
            <p className="text-foreground text-sm">
              {currentPeriodEnd
                ? formatSpDate(currentPeriodEnd, locale)
                : t('noCurrent')}
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="period-end-date">{t('dateLabel')}</Label>
            <Input
              id="period-end-date"
              type="date"
              value={date}
              min={range?.min}
              max={range?.max}
              onChange={(e) => setDate(e.target.value)}
              aria-invalid={dateError ? true : undefined}
            />
            <p className="text-muted-foreground text-xs">{t('dateHint')}</p>
            {dateError ? (
              <p className="text-destructive text-xs">{dateError}</p>
            ) : null}
          </div>

          <div className="space-y-1.5">
            <Label>{t('cycleLabel')}</Label>
            <Select
              value={cycle}
              onValueChange={(v) => setCycle((v as BillingCycle) ?? cycle)}
            >
              <SelectTrigger className="border-border bg-muted text-foreground w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="border-border bg-popover">
                <SelectItem value="monthly">{t('cycleMonthly')}</SelectItem>
                <SelectItem value="yearly">{t('cycleYearly')}</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-muted-foreground text-xs">{t('cycleHint')}</p>
          </div>

          {validation.ok ? (
            <p className="text-foreground text-sm font-medium">
              {t('preview', {
                from: currentPeriodEnd
                  ? formatSpDate(currentPeriodEnd, locale)
                  : t('noCurrent'),
                to: formatIsoDay(date, locale),
              })}
            </p>
          ) : null}

          {status === 'past_due' ? (
            <Alert>
              <AlertDescription>{t('leavesPastDue')}</AlertDescription>
            </Alert>
          ) : null}
          {cancelAtPeriodEnd ? (
            <Alert className="border-amber-500/30 bg-amber-500/5">
              <AlertDescription>{t('cancelScheduled')}</AlertDescription>
            </Alert>
          ) : null}

          <div className="space-y-1.5">
            <Label>{t('reasonLabel')}</Label>
            <Textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={2}
              maxLength={500}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            {tBlock('cancel')}
          </Button>
          <Button onClick={handleSave} disabled={saving || !validation.ok}>
            {saving ? <Loader2 className="animate-spin" /> : null}
            {t('submit')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
