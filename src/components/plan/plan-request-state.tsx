'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Loader2 } from 'lucide-react';
import type { PendingPlanRequest } from '@/hooks/use-account-plan';

/**
 * Estado "solicitação enviada" (SPEC 059 D-8/§7.1): o botão de escolha
 * vira este estado até o operador resolver. Cancelar é auto-atendimento
 * (RLS `plan_change_requests_cancel_own`, migração 067); aprovar/rejeitar
 * não é — isso só acontece em `/api/admin/plan-requests`.
 */
export function PlanRequestState({
  request,
  planName,
  canCancel,
  onCanceled,
}: {
  request: PendingPlanRequest;
  planName: string;
  canCancel: boolean;
  onCanceled: () => void;
}) {
  const t = useTranslations('Plan');
  const [canceling, setCanceling] = useState(false);

  async function handleCancel() {
    setCanceling(true);
    try {
      const res = await fetch('/api/account/plan/request', {
        method: 'DELETE',
      });
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        toast.error(payload.error || t('requestCancelFailed'));
        return;
      }
      toast.success(t('requestCanceled'));
      onCanceled();
    } finally {
      setCanceling(false);
    }
  }

  return (
    <Card className="border-primary/30 bg-primary-soft/40">
      <CardContent className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-foreground text-sm font-medium">
            {t('requestPending', { plan: planName })}
          </p>
          <p className="text-muted-foreground mt-0.5 text-xs">
            {t('requestPendingSince', {
              date: new Date(request.createdAt).toLocaleDateString(),
            })}
          </p>
        </div>
        {canCancel ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={canceling}
            onClick={handleCancel}
          >
            {canceling ? <Loader2 className="size-4 animate-spin" /> : null}
            {t('requestCancel')}
          </Button>
        ) : null}
      </CardContent>
    </Card>
  );
}
