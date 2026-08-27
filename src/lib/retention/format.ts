/**
 * Formatação para o painel de Retenção e para a prévia (SPEC 060 §8.2,
 * §5). Mesma técnica de locale explícito de `@/lib/plans/format.ts` —
 * o rótulo aparece nos dois idiomas da UI, não na moeda/locale da conta.
 */

import type { RetentionValueSource } from './types';

const PT_LOCALES = new Set(['pt-BR', 'pt']);

function isPt(locale: string): boolean {
  return PT_LOCALES.has(locale) || locale.startsWith('pt');
}

/** `null` → "Sem limite"/"No limit". Número → formatado por locale. */
export function formatRetentionLimit(
  value: number | null,
  locale: string
): string {
  if (value === null) return isPt(locale) ? 'Sem limite' : 'No limit';
  try {
    return new Intl.NumberFormat(locale).format(value);
  } catch {
    return String(value);
  }
}

export function formatRetentionDays(
  value: number | null,
  locale: string
): string {
  if (value === null) return isPt(locale) ? 'Sem limite' : 'No limit';
  if (isPt(locale)) return `${value} dia${value === 1 ? '' : 's'}`;
  return `${value} day${value === 1 ? '' : 's'}`;
}

function wrapSystemDefault(formatted: string, locale: string): string {
  return isPt(locale)
    ? `Padrão do sistema (${formatted})`
    : `System default (${formatted})`;
}

/**
 * "Padrão do sistema (5.000)" quando herdado, "" quando o valor veio de
 * política explícita (nada a acrescentar) — §8.2 ponto 3: herdado ×
 * explícito precisa ser visualmente distinto, senão o número muda
 * sozinho depois de um deploy sem explicação nenhuma na tela.
 */
export function formatRetentionSource(
  source: RetentionValueSource,
  resolvedValue: number | null,
  locale: string
): string {
  if (source === 'policy') return '';
  return wrapSystemDefault(formatRetentionLimit(resolvedValue, locale), locale);
}

/** Mesma ideia de `formatRetentionSource`, mas para `retentionDays` — "30 dias", não "30". */
export function formatRetentionDaysSource(
  source: RetentionValueSource,
  resolvedValue: number | null,
  locale: string
): string {
  if (source === 'policy') return '';
  return wrapSystemDefault(formatRetentionDays(resolvedValue, locale), locale);
}
