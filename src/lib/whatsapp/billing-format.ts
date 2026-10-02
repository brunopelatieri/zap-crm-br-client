/**
 * Formatação e classificação do monitor de cobrança para a UI
 * (SPEC 076 §11.4). Funções PURAS e seguras para o navegador — sem I/O,
 * sem import de servidor — para serem testadas sem DOM.
 */

import { format, type Locale } from 'date-fns';

import type { SendState } from './billing-monitor';

/**
 * Estados que significam "há um problema de envio" para o tile do overview
 * e para o selo. `unknown` e `no_credentials` NÃO entram: não são falha da
 * Meta (mesmo critério de `worstState` em `billing-dto.ts`).
 */
const PROBLEM_STATES: ReadonlySet<SendState> = new Set([
  'payment_blocked',
  'blocked',
  'auth_error',
  'limited',
]);

export function isBillingProblem(state: SendState | null | undefined): boolean {
  return state != null && PROBLEM_STATES.has(state);
}

/**
 * Valor monetário na moeda DA META (`Intl.NumberFormat`, §11.4). Em pt-BR,
 * USD sai "US$ 7,06" e BRL "R$ 7,06". Moeda inválida (o construtor lança
 * `RangeError`) cai em "7,06 CÓDIGO" — nunca quebra a tela. Sem moeda
 * conhecida, só o número.
 *
 * Deliberadamente NÃO usa `lib/currency.ts`: aquela é a moeda dos negócios
 * do CRM, não a da cobrança da Meta.
 */
export function formatMoney(
  locale: string,
  currency: string | null | undefined,
  value: number
): string {
  const plain = () =>
    new Intl.NumberFormat(locale, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(value);

  if (!currency) return plain();
  try {
    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency,
    }).format(value);
  } catch {
    console.warn('[billing] currency inválida para formatação:', currency);
    return `${plain()} ${currency}`;
  }
}

/** Volume de mensagens: separador de milhar do idioma. */
export function formatVolume(locale: string, value: number): string {
  return new Intl.NumberFormat(locale).format(value);
}

/**
 * "outubro/2026" a partir do dia 1 do mês local do WABA (`YYYY-MM-DD`).
 * O `Date` é montado por componentes (não por `new Date('2026-10-01')`,
 * que é UTC e recuaria um dia em fusos negativos). Entrada ilegível → `''`.
 */
export function formatPeriodMonth(
  periodStart: string | null | undefined,
  dateFnsLocale: Locale
): string {
  const m = periodStart ? /^(\d{4})-(\d{2})/.exec(periodStart) : null;
  if (!m) return '';
  return format(new Date(Number(m[1]), Number(m[2]) - 1, 1), 'LLLL/yyyy', {
    locale: dateFnsLocale,
  });
}

/** Data e hora curtas ("01/10/2026 10:58") no idioma; ilegível → `''`. */
export function formatDateTime(
  iso: string | null | undefined,
  dateFnsLocale: Locale
): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return format(d, 'P p', { locale: dateFnsLocale });
}

/** Hora curta ("14:35") para "tente novamente após {time}". */
export function formatClock(
  iso: string | null | undefined,
  dateFnsLocale: Locale
): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return format(d, 'p', { locale: dateFnsLocale });
}

/**
 * Categorias de preço que a UI sabe traduzir (`category.<X>`). Qualquer
 * outra volta crua da Meta (`category.unknown`, §11.3) — uma categoria
 * nova nunca vira chave de tradução ausente.
 */
export const KNOWN_PRICING_CATEGORIES = [
  'MARKETING',
  'UTILITY',
  'AUTHENTICATION',
  'AUTHENTICATION_INTERNATIONAL',
  'SERVICE',
] as const;

export type KnownPricingCategory = (typeof KNOWN_PRICING_CATEGORIES)[number];

export function isKnownPricingCategory(
  category: string
): category is KnownPricingCategory {
  return (KNOWN_PRICING_CATEGORIES as readonly string[]).includes(category);
}
