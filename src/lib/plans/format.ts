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

/**
 * O `code` que `POST /api/account/plan/change` devolve no corpo de
 * erro → a chave dentro de `Plan.cycle.*` (achado de code review:
 * `plan-cycle-dialog.tsx` e o atalho de plano Grátis em
 * `plan-catalog.tsx` chamam a MESMA rota, mas só o diálogo tinha o
 * mapeamento — o atalho caía sempre no texto cru em inglês da API,
 * inclusive para `account_past_due`).
 *
 * Devolve só a CHAVE, não a string traduzida: cada chamador já tem seu
 * próprio `t` (`useTranslations('Plan.cycle')` no diálogo,
 * `useTranslations('Plan')` no catálogo — que por sua vez resolve
 * chaves aninhadas como `t('cycle.changeSuccess')`), e este módulo não
 * pode depender de `next-intl` (é importado por lógica pura também).
 * `null` = código desconhecido ou ausente; o chamador cai para
 * `payload.error` (inglês, vindo do servidor) ou seu próprio genérico.
 */
export function planChangeErrorKey(code: string | undefined): string | null {
  switch (code) {
    case 'self_service_disabled':
      return 'errorSelfServiceDisabled';
    case 'plan_not_available':
      return 'errorPlanNotAvailable';
    case 'account_past_due':
      return 'errorAccountPastDue';
    default:
      return null;
  }
}
