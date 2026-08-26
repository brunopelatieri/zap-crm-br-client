/**
 * Formatação de preço e limite para a UI. O app já formata moeda em
 * `src/lib/currency.ts` (`formatCurrency`, usado para negócios/deals);
 * aqui o formato é o mesmo `Intl.NumberFormat`, mas com locale
 * explícito, porque o preço do plano aparece nos dois idiomas da UI
 * (pt-BR/en), não na moeda escolhida pela conta.
 */

const PT_LOCALES = new Set(['pt-BR', 'pt']);

function isPt(locale: string): boolean {
  return PT_LOCALES.has(locale) || locale.startsWith('pt');
}

export function formatPlanPrice(
  priceCents: number,
  currency: string,
  locale: string
): string {
  const value = priceCents / 100;
  try {
    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency,
      minimumFractionDigits: 0,
      maximumFractionDigits: 2,
    }).format(value);
  } catch {
    return `${currency} ${value.toFixed(2)}`;
  }
}

/** `null` -> "Ilimitado"/"Unlimited"; `0` -> "Não incluído"/"Not included". */
export function formatLimit(value: number | null, locale: string): string {
  if (value === null) return isPt(locale) ? 'Ilimitado' : 'Unlimited';
  if (value === 0) return isPt(locale) ? 'Não incluído' : 'Not included';
  try {
    return new Intl.NumberFormat(locale).format(value);
  } catch {
    return String(value);
  }
}
