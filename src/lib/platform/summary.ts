/**
 * Agregação da visão geral do console (SPEC 062 §5.2, §7.1).
 *
 * Puro: recebe linhas JÁ LIDAS (a rota `/api/platform/summary` faz a
 * ida ao banco) e só soma. Reaproveita `isExpired`/`daysUntil` de
 * `@/lib/plans/billing` — mesma definição de "vencido" em toda a
 * plataforma, para o card daqui e a rota de vencimento (§8) nunca
 * divergirem sobre o mesmo dado.
 */

import { daysUntil, isExpired } from '@/lib/plans/billing';
import type { AccountPlanStatus } from '@/lib/plans/types';

export interface AccountSummaryRow {
  accountId: string;
  blockedAt: string | null;
  status: AccountPlanStatus;
  currentPeriodEnd: string | null;
  /** Verdadeiro quando ao menos uma quota está acima do limite (já resolvido pelo chamador). */
  isOverage: boolean;
}

export interface PlatformSummary {
  accountsTotal: number;
  accountsActive: number;
  accountsBlocked: number;
  /** Vence dentro da janela, ainda não vencida (borda inclusiva — ver `expiringWindowDays`). */
  expiringSoon: number;
  /** Já passou de `currentPeriodEnd`. */
  expired: number;
  pendingRequests: number;
  accountsOverage: number;
}

const DEFAULT_EXPIRING_WINDOW_DAYS = 7;

/**
 * `expiringWindowDays` é INCLUSIVO na borda: uma conta que vence
 * exatamente em N dias entra em "vencendo em N dias" (o card do §7.1
 * promete "vencendo em 7 dias" — no dia 7 exato ela some da lista sem
 * aviso seria o tipo de furo que ninguém nota até o cliente ligar).
 * Conta sem vencimento (`currentPeriodEnd === null`) nunca entra em
 * nenhum dos dois — ela não vence.
 */
export function computePlatformSummary(
  accounts: AccountSummaryRow[],
  pendingRequestsCount: number,
  now: Date,
  expiringWindowDays: number = DEFAULT_EXPIRING_WINDOW_DAYS
): PlatformSummary {
  let accountsActive = 0;
  let accountsBlocked = 0;
  let expiringSoon = 0;
  let expired = 0;
  let accountsOverage = 0;

  for (const account of accounts) {
    if (account.blockedAt !== null) {
      accountsBlocked++;
    } else if (account.status === 'active' || account.status === 'trialing') {
      accountsActive++;
    }

    if (account.isOverage) accountsOverage++;

    if (account.currentPeriodEnd !== null) {
      if (isExpired(account.currentPeriodEnd, now)) {
        expired++;
      } else {
        const days = daysUntil(account.currentPeriodEnd, now);
        if (days !== null && days <= expiringWindowDays) {
          expiringSoon++;
        }
      }
    }
  }

  return {
    accountsTotal: accounts.length,
    accountsActive,
    accountsBlocked,
    expiringSoon,
    expired,
    pendingRequests: pendingRequestsCount,
    accountsOverage,
  };
}
