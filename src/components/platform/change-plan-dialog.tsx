'use client';

// ============================================================
// ChangePlanDialog — trocar plano / conceder exceção / mudar status
// (SPEC 062 §7.3)
//
// Um diálogo só para os três, porque é a MESMA chamada de servidor
// (`changeAccountPlan`, via PUT /api/platform/accounts/[id]/plan) —
// três telas para uma chamada só criaria a ilusão de que são ações
// independentes quando o efeito colateral (o evento gravado) é único.
// ============================================================

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import type { AccountPlanStatus } from '@/lib/plans/types';

interface PlanOption {
  code: string;
  name: string;
}

const STATUSES: AccountPlanStatus[] = [
  'trialing',
  'active',
  'past_due',
  'suspended',
  'canceled',
];

export function ChangePlanDialog({
  accountId,
  accountName,
  currentPlanCode,
  currentStatus,
  onClose,
  onChanged,
}: {
  accountId: string;
  accountName: string;
  currentPlanCode: string;
  currentStatus: AccountPlanStatus;
  onClose: () => void;
  onChanged: () => void;
}) {
  const t = useTranslations('Platform.accountDetail');
  const tPlan = useTranslations('Plan');
  const tBlock = useTranslations('Platform.block');
  const [plans, setPlans] = useState<PlanOption[]>([]);
  const [planCode, setPlanCode] = useState(currentPlanCode);
  const [status, setStatus] = useState<AccountPlanStatus>(currentStatus);
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetch('/api/platform/plans', { cache: 'no-store' })
      .then((res) => (res.ok ? res.json() : { plans: [] }))
      .then((data: { plans: PlanOption[] }) => setPlans(data.plans))
      .catch(() => setPlans([]));
  }, []);

  async function handleSave() {
    setSaving(true);
    try {
      const res = await fetch(`/api/platform/accounts/${accountId}/plan`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          planCode: planCode !== currentPlanCode ? planCode : undefined,
          status: status !== currentStatus ? status : undefined,
          reason: reason || null,
        }),
      });
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        toast.error(payload.error || t('changePlanFailed'));
        return;
      }
      toast.success(t('changePlanSuccess'));
      onChanged();
    } catch (err) {
      console.error('[ChangePlanDialog] save failed:', err);
      toast.error(t('changePlanFailed'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="border-border bg-popover sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-popover-foreground">
            {t('changePlanTitle', { account: accountName })}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label>{t('changePlanNewPlan')}</Label>
            <Select
              value={planCode}
              onValueChange={(v) => setPlanCode(v ?? currentPlanCode)}
            >
              <SelectTrigger className="border-border bg-muted text-foreground w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="border-border bg-popover">
                {plans.map((plan) => (
                  <SelectItem key={plan.code} value={plan.code}>
                    {plan.name} ({plan.code})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label>{t('changePlanNewStatus')}</Label>
            <Select
              value={status}
              onValueChange={(v) => setStatus(v as AccountPlanStatus)}
            >
              <SelectTrigger className="border-border bg-muted text-foreground w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="border-border bg-popover">
                {STATUSES.map((s) => (
                  <SelectItem key={s} value={s}>
                    {tPlan(`status.${s}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label>{t('changePlanReason')}</Label>
            <Textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={2}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            {tBlock('cancel')}
          </Button>
          <Button onClick={handleSave} disabled={saving}>
            {saving ? <Loader2 className="animate-spin" /> : null}
            {t('changePlan')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
