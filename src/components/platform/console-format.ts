/**
 * Formatação de datas e valores do console do proprietário (SPEC 078 §9).
 *
 * Vencimentos são "dia no calendário de São Paulo" (D-2): `current_period_end`
 * é gravado como 23:59:59 de SP, que em UTC já é o dia seguinte. Exibir com
 * o fuso do navegador mostraria o dia errado para quem opera de fora do
 * Brasil, e divergiria do que o diálogo de vencimento confirma. Por isso
 * tudo aqui fixa `America/Sao_Paulo`.
 */

const SAO_PAULO = 'America/Sao_Paulo';

/** ISO (instante) → data legível no calendário de São Paulo. */
export function formatSpDate(
  iso: string | Date | null | undefined,
  locale: string
): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString(locale, {
    dateStyle: 'medium',
    timeZone: SAO_PAULO,
  });
}

/**
 * `YYYY-MM-DD` (já um dia de calendário, sem fuso) → data legível. Passa
 * por UTC dos dois lados para o dia nunca deslocar.
 */
export function formatIsoDay(day: string, locale: string): string {
  const [year, month, date] = day.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, date)).toLocaleDateString(locale, {
    dateStyle: 'medium',
    timeZone: 'UTC',
  });
}

export function formatBrl(cents: number, locale: string): string {
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: 'BRL',
  }).format(cents / 100);
}
