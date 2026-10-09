'use client';

// ============================================================
// RecordPaymentDialog — registrar pagamento manual (SPEC 078 §4, §9.1)
//
// Chama POST /api/platform/accounts/[id]/billing/payments.
//
// **O identificador é gerado quando o diálogo ABRE** (`useState` com
// inicializador), não no clique nem na rota (§4.2): clique duplo e nova
// tentativa por rede lenta reenviam o MESMO `console:<uuid>`, e a
// constraint UNIQUE(payment_ref) do banco absorve. Para sobreviver a um
// F5 (o estado do React se perde), o valor também fica em
// `sessionStorage`, por conta, até o pagamento ser aplicado — daí em
// diante o próximo diálogo gera um novo. Se o operador digita um identificador próprio (ID Pix, boleto…), ele
// vai literal, sem prefixo — é o que impede o mesmo dinheiro de entrar
// duas vezes quando um sistema externo também o reporta.
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
  MAX_PAYMENT_PERIODS,
  PAYMENT_METHODS,
  newConsolePaymentRef,
  paidAtRange,
  parseMoneyToCents,
  previewManualPayment,
  todayInSaoPaulo,
  validateManualPaymentInput,
  type PaymentMethod,
} from '@/lib/plans/manual-billing';
import type { BillingCycle } from '@/lib/plans/types';

import { formatSpDate } from './console-format';
import { useConsoleErrorMessage } from './use-console-error';

const REF_STORAGE_KEY = (accountId: string) => `zap:payment-ref:${accountId}`;

/** `sessionStorage` pode lançar (modo privado, bloqueio): nunca é requisito. */
function loadOrCreateGeneratedRef(accountId: string): string {
  const fresh = newConsolePaymentRef(crypto.randomUUID());
  try {
    const key = REF_STORAGE_KEY(accountId);
    const saved = window.sessionStorage.getItem(key);
    if (saved) return saved;
    window.sessionStorage.setItem(key, fresh);
  } catch {
    // sem persistência: vale só enquanto o diálogo estiver aberto
  }
  return fresh;
}

function clearGeneratedRef(accountId: string): void {
  try {
    window.sessionStorage.removeItem(REF_STORAGE_KEY(accountId));
  } catch {
    // ignora
  }
}

export function RecordPaymentDialog({
  accountId,
  accountName,
  currentPeriodEnd,
  billingCycle,
  accountBlocked,
  cancelAtPeriodEnd,
  onClose,
  onChanged,
}: {
  accountId: string;
  accountName: string;
  currentPeriodEnd: string | null;
  billingCycle: BillingCycle;
  accountBlocked: boolean;
  cancelAtPeriodEnd: boolean;
  onClose: () => void;
  onChanged: () => void;
}) {
  const t = useTranslations('Platform.payments');
  const tBlock = useTranslations('Platform.block');
  const errorMessage = useConsoleErrorMessage();
  const locale = useLocale();

  const todaySp = useMemo(() => todayInSaoPaulo(new Date()), []);
  const range = useMemo(() => paidAtRange(todaySp), [todaySp]);
  const [generatedRef] = useState(() => loadOrCreateGeneratedRef(accountId));

  const [paidAt, setPaidAt] = useState(todaySp);
  const [periods, setPeriods] = useState('1');
  const [method, setMethod] = useState<PaymentMethod>('pix');
  const [amount, setAmount] = useState('');
  const [reference, setReference] = useState('');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);

  const periodsNumber = Number(periods);
  const amountCents = amount.trim() === '' ? null : parseMoneyToCents(amount);
  const amountInvalid = amount.trim() !== '' && amountCents === null;

  const validation = validateManualPaymentInput({
    paidAt,
    periods: periodsNumber,
    method,
    amountCents,
    paymentRef: reference.trim() || generatedRef,
    note,
    todaySp,
  });
  const canSubmit = validation.ok && !amountInvalid;

  const preview =
    Number.isInteger(periodsNumber) &&
    periodsNumber >= 1 &&
    periodsNumber <= MAX_PAYMENT_PERIODS
      ? previewManualPayment(
          currentPeriodEnd,
          billingCycle,
          periodsNumber,
          new Date()
        )
      : null;

  async function handleSave() {
    if (!validation.ok || amountInvalid) return;
    setSaving(true);
    try {
      const res = await fetch(
        `/api/platform/accounts/${accountId}/billing/payments`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            paymentRef: validation.value.paymentRef,
            paidAt,
            periods: periodsNumber,
            method,
            amountCents,
            note: note.trim() || null,
          }),
        }
      );
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(errorMessage(payload.code, t('failed')));
        return;
      }
      // Aplicado (ou reconhecido como já aplicado): a chave cumpriu o
      // papel; o próximo diálogo precisa de uma nova.
      clearGeneratedRef(accountId);
      if (payload.status === 'already_applied') {
        toast.info(t('alreadyApplied'));
      } else {
        toast.success(
          t('success', {
            date: formatSpDate(payload.accountPlan?.currentPeriodEnd, locale),
          })
        );
        // §4.3: pagamento não desbloqueia — o operador precisa saber.
        if (payload.accountBlocked) toast.warning(t('successStillBlocked'));
      }
      onChanged();
    } catch (err) {
      console.error('[RecordPaymentDialog] save failed:', err);
      toast.error(t('failed'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="border-border bg-popover max-h-[90vh] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-popover-foreground">
            {t('dialogTitle', { account: accountName })}
          </DialogTitle>
          <DialogDescription>{t('dialogDescription')}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="payment-paid-at">{t('paidAtLabel')}</Label>
              <Input
                id="payment-paid-at"
                type="date"
                value={paidAt}
                min={range?.min}
                max={range?.max}
                onChange={(e) => setPaidAt(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="payment-periods">{t('periodsLabel')}</Label>
              <Input
                id="payment-periods"
                type="number"
                inputMode="numeric"
                min={1}
                max={MAX_PAYMENT_PERIODS}
                step={1}
                value={periods}
                onChange={(e) => setPeriods(e.target.value)}
              />
              <p className="text-muted-foreground text-xs">
                {billingCycle === 'yearly'
                  ? t('periodsHintYearly')
                  : t('periodsHintMonthly')}
              </p>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>{t('methodLabel')}</Label>
              <Select
                value={method}
                onValueChange={(v) => setMethod((v as PaymentMethod) ?? method)}
              >
                <SelectTrigger className="border-border bg-muted text-foreground w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="border-border bg-popover">
                  {PAYMENT_METHODS.map((m) => (
                    <SelectItem key={m} value={m}>
                      {t(`methods.${m}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="payment-amount">{t('amountLabel')}</Label>
              <Input
                id="payment-amount"
                inputMode="decimal"
                placeholder={t('amountPlaceholder')}
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                aria-invalid={amountInvalid ? true : undefined}
              />
              {amountInvalid ? (
                <p className="text-destructive text-xs">
                  {errorMessage('amount_invalid', '')}
                </p>
              ) : null}
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="payment-reference">{t('referenceLabel')}</Label>
            <Input
              id="payment-reference"
              value={reference}
              maxLength={200}
              onChange={(e) => setReference(e.target.value)}
            />
            <p className="text-muted-foreground text-xs">
              {t('referenceHint')}
            </p>
          </div>

          <div className="space-y-1.5">
            <Label>{t('noteLabel')}</Label>
            <Textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={2}
              maxLength={500}
            />
          </div>

          {preview ? (
            <div className="space-y-0.5">
              <p className="text-foreground text-sm font-medium">
                {t('preview', {
                  from: formatSpDate(preview.previousPeriodEnd, locale),
                  to: formatSpDate(preview.newPeriodEnd, locale),
                })}
              </p>
              <p className="text-muted-foreground text-xs">
                {t('previewApprox')}
              </p>
            </div>
          ) : null}

          {!validation.ok && paidAt !== '' ? (
            <p className="text-destructive text-xs">
              {errorMessage(validation.code, '')}
            </p>
          ) : null}

          {accountBlocked ? (
            <Alert className="border-amber-500/30 bg-amber-500/5">
              <AlertDescription>{t('blockedWarning')}</AlertDescription>
            </Alert>
          ) : null}
          {cancelAtPeriodEnd ? (
            <Alert className="border-amber-500/30 bg-amber-500/5">
              <AlertDescription>{t('cancelScheduledWarning')}</AlertDescription>
            </Alert>
          ) : null}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            {tBlock('cancel')}
          </Button>
          <Button onClick={handleSave} disabled={saving || !canSubmit}>
            {saving ? <Loader2 className="animate-spin" /> : null}
            {t('submit')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
