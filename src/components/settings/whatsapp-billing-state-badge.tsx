'use client';

import {
  AlertTriangle,
  CheckCircle2,
  CircleHelp,
  CreditCard,
  KeyRound,
  XCircle,
  type LucideIcon,
} from 'lucide-react';
import { useTranslations } from 'next-intl';

import type { SendState } from '@/lib/whatsapp/billing-monitor';

import { SettingsChip, type ChipVariant } from './settings-chip';

const RED = 'border-red-500/40 bg-red-500/10 text-red-600 dark:text-red-300';

/**
 * Ícone + variante por estado de envio (SPEC 076 §11.6: o selo nunca é só
 * cor — sempre ícone + texto). Os vermelhos não existem em `SettingsChip`
 * (que só tem semânticos de papel/ok/atenção), por isso o `className`.
 */
const STATE_STYLE: Record<
  SendState,
  { Icon: LucideIcon; variant: ChipVariant; className?: string }
> = {
  ok: { Icon: CheckCircle2, variant: 'ok' },
  limited: { Icon: AlertTriangle, variant: 'warn' },
  blocked: { Icon: XCircle, variant: 'muted', className: RED },
  payment_blocked: { Icon: CreditCard, variant: 'muted', className: RED },
  auth_error: { Icon: KeyRound, variant: 'warn' },
  no_credentials: { Icon: KeyRound, variant: 'muted' },
  unknown: { Icon: CircleHelp, variant: 'muted' },
};

/** Ícone do estado, para quem monta o próprio layout (o card do detalhe). */
export function billingStateIcon(state: SendState): LucideIcon {
  return STATE_STYLE[state].Icon;
}

/** Selo compacto do estado de envio (lista de números, SPEC 076 §11.1). */
export function BillingStateBadge({ state }: { state: SendState }) {
  const t = useTranslations('Settings.whatsapp.billing');
  const { Icon, variant, className } = STATE_STYLE[state];
  return (
    <SettingsChip variant={variant} className={className}>
      <Icon aria-hidden />
      {t(`state.${state}`)}
    </SettingsChip>
  );
}
