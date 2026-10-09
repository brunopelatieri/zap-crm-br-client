'use client';

// ============================================================
// PaymentsCard — o histórico de pagamentos da conta e o "Desfazer"
// (SPEC 078 §4.4, §4.5, §9.2)
//
// Recebe os 20 últimos pagamentos do próprio detalhe da conta (GET
// /api/platform/accounts/[id]) — a lista e o `currentPeriodEnd` que
// decide o "Desfazer" vêm da MESMA leitura, sem segunda ida ao servidor.
// O botão "Desfazer" só vale na linha elegível — a decisão é de
// `resolvePaymentReversibility`, a mesma regra de `reverse_plan_payment`;
// nas demais ele fica desabilitado COM o motivo. O banco continua sendo
// a garantia (409).
// ============================================================

import { useMemo, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import {
  resolvePaymentReversibility,
  type AccountPayment,
  type PaymentReversibility,
} from '@/lib/plans/payments';

import { formatBrl, formatSpDate } from './console-format';
import { useConsoleErrorMessage } from './use-console-error';

const DISABLED_REASON_KEY: Partial<Record<PaymentReversibility, string>> = {
  not_latest: 'undoNotLatest',
  period_changed: 'undoPeriodChanged',
  not_reversible: 'undoNotReversible',
};

export function PaymentsCard({
  accountId,
  currentPeriodEnd,
  payments,
  onChanged,
}: {
  accountId: string;
  currentPeriodEnd: string | null;
  /** `null` = a leitura da lista falhou no servidor. */
  payments: AccountPayment[] | null;
  onChanged: () => void;
}) {
  const t = useTranslations('Platform.payments');
  const locale = useLocale();

  const [reversing, setReversing] = useState<AccountPayment | null>(null);

  const reversibility = useMemo(
    () => resolvePaymentReversibility(payments ?? [], currentPeriodEnd),
    [payments, currentPeriodEnd]
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('section')}</CardTitle>
      </CardHeader>
      <CardContent>
        {payments === null ? (
          <p className="text-destructive text-sm">{t('loadFailed')}</p>
        ) : payments.length === 0 ? (
          <p className="text-muted-foreground text-sm">{t('empty')}</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('colPaidAt')}</TableHead>
                <TableHead>{t('colMethod')}</TableHead>
                <TableHead>{t('colAmount')}</TableHead>
                <TableHead>{t('colPeriods')}</TableHead>
                <TableHead>{t('colDueChange')}</TableHead>
                <TableHead>{t('colRecordedBy')}</TableHead>
                <TableHead>{t('colReference')}</TableHead>
                <TableHead>{t('colStatus')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {payments.map((payment) => {
                const state = reversibility.get(payment.id);
                const disabledKey = state ? DISABLED_REASON_KEY[state] : null;
                return (
                  <TableRow key={payment.id}>
                    <TableCell>
                      {formatSpDate(payment.paidAt, locale)}
                    </TableCell>
                    <TableCell>
                      {payment.method ? t(`methods.${payment.method}`) : '—'}
                    </TableCell>
                    <TableCell>
                      {payment.amountCents !== null
                        ? formatBrl(payment.amountCents, locale)
                        : t('noAmount')}
                    </TableCell>
                    <TableCell>{payment.periods}</TableCell>
                    <TableCell className="whitespace-nowrap">
                      {formatSpDate(payment.previousPeriodEnd, locale)} →{' '}
                      {formatSpDate(payment.newPeriodEnd, locale)}
                    </TableCell>
                    <TableCell className="max-w-40 truncate">
                      {payment.recordedBy ?? '—'}
                    </TableCell>
                    <TableCell
                      className="max-w-40 truncate font-mono text-xs"
                      title={payment.note ?? payment.paymentRef}
                    >
                      {payment.paymentRef}
                    </TableCell>
                    <TableCell>
                      {payment.reversedAt ? (
                        <Badge
                          variant="destructive"
                          title={payment.reversalReason ?? undefined}
                        >
                          {t('reversedOn', {
                            date: formatSpDate(payment.reversedAt, locale),
                          })}
                        </Badge>
                      ) : state === 'reversible' ? (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => setReversing(payment)}
                        >
                          {t('undo')}
                        </Button>
                      ) : (
                        // `title` num botão desabilitado não aparece
                        // (pointer-events-none): o motivo vai no wrapper.
                        <span title={disabledKey ? t(disabledKey) : undefined}>
                          <Button size="sm" variant="outline" disabled>
                            {t('undo')}
                          </Button>
                        </span>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </CardContent>

      {reversing ? (
        <ReversePaymentDialog
          accountId={accountId}
          payment={reversing}
          onClose={() => setReversing(null)}
          onReversed={() => {
            setReversing(null);
            onChanged();
          }}
        />
      ) : null}
    </Card>
  );
}

function ReversePaymentDialog({
  accountId,
  payment,
  onClose,
  onReversed,
}: {
  accountId: string;
  payment: AccountPayment;
  onClose: () => void;
  onReversed: () => void;
}) {
  const t = useTranslations('Platform.payments');
  const tBlock = useTranslations('Platform.block');
  const errorMessage = useConsoleErrorMessage();
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);

  async function handleConfirm() {
    setSaving(true);
    try {
      const res = await fetch(
        `/api/platform/accounts/${accountId}/billing/payments/${payment.id}/reverse`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ reason: reason.trim() || null }),
        }
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        toast.error(errorMessage(body.code, t('reverseFailed')));
        // 409: o estado mudou desde que a lista carregou — atualiza.
        if (res.status === 409) onReversed();
        return;
      }
      toast.success(t('reverseSuccess'));
      onReversed();
    } catch (err) {
      console.error('[ReversePaymentDialog] failed:', err);
      toast.error(t('reverseFailed'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="border-border bg-popover sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-popover-foreground">
            {t('reverseTitle')}
          </DialogTitle>
          <DialogDescription>{t('reverseBody')}</DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <p className="text-muted-foreground font-mono text-xs break-all">
            {payment.paymentRef}
          </p>
          <p className="text-muted-foreground text-xs">
            {t('reverseReference')}
          </p>
          <div className="space-y-1.5">
            <Label>{t('reverseReasonLabel')}</Label>
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
          <Button
            variant="destructive"
            onClick={handleConfirm}
            disabled={saving}
          >
            {saving ? <Loader2 className="animate-spin" /> : null}
            {t('reverseConfirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
