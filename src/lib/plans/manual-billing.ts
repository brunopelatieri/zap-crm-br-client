/**
 * Validação e prévia das duas operações manuais do console (SPEC 078
 * §3 e §4): alterar o vencimento e registrar um pagamento.
 *
 * Puro, sem I/O — as rotas `/api/platform/**` validam com isto antes de
 * chamar o banco, e os diálogos do console calculam a prévia "vencimento
 * atual → resultante" com as MESMAS funções (um número na tela, outro no
 * banco é o bug que esta separação existe para evitar).
 *
 * A validação de faixa aqui é a primeira linha de defesa e dá mensagem
 * de erro estável; a fonte de verdade continua sendo o banco
 * (`set_plan_period_end` / `apply_plan_renewal`, migração 089), que
 * repete as mesmas regras sob o lock da linha.
 *
 * **Dia, não instante** (D-2): todas as datas de entrada são `YYYY-MM-DD`
 * no calendário de São Paulo. A conversão para `timestamptz` do
 * VENCIMENTO acontece no Postgres (`AT TIME ZONE`), nunca aqui — o fuso
 * do servidor Node (a VPS pode estar em UTC) não pode decidir em qual dia
 * o plano vence. Por isso `todaySp` é parâmetro: `todayInSaoPaulo(now)`
 * calcula, e os testes fixam.
 */

import { advancePeriod } from './billing';
import type { BillingCycle } from './billing';

export const PAYMENT_METHODS = [
  'pix',
  'boleto',
  'card',
  'transfer',
  'cash',
  'other',
] as const;

export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

/** D-3: o vencimento manual vai de hoje até hoje + 3 anos. */
export const PERIOD_END_MAX_YEARS = 3;
/** §4.1: o pagamento pode ter até 365 dias de atraso no registro. */
export const PAID_AT_MAX_AGE_DAYS = 365;
/** §4.1: períodos pagos de uma vez. */
export const MAX_PAYMENT_PERIODS = 12;
export const MAX_PAYMENT_NOTE_LENGTH = 500;
export const MAX_PAYMENT_REF_LENGTH = 200;
/** `account_plan_payments.amount_cents` é `INTEGER` (int4). */
const MAX_AMOUNT_CENTS = 2_147_483_647;

/**
 * Âncora do "dia do pagamento" como instante: meio-dia em São Paulo.
 * Meio-dia, não meia-noite — dá folga de 12 h para os dois lados, então o
 * dia não vira em UTC nem em São Paulo quando alguém exibe `paid_at` com
 * o fuso errado. O Brasil não tem horário de verão desde 2019.
 */
const PAID_AT_ANCHOR = 'T12:00:00-03:00';

type Result<T, C extends string> =
  { ok: true; value: T } | { ok: false; code: C };

// ── Datas (calendário puro, sem fuso) ────────────────────────────────

const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

interface CalendarDate {
  year: number;
  month: number; // 1–12
  day: number;
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** `null` para formato errado ou dia que não existe (`2026-02-30`). */
function parseIsoDate(value: unknown): CalendarDate | null {
  if (typeof value !== 'string') return null;
  const match = ISO_DATE_RE.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > daysInMonth(year, month)) return null;
  return { year, month, day };
}

/** Número de dias desde 1970-01-01 — para comparar e subtrair datas. */
function toDayNumber(date: CalendarDate): number {
  return Math.round(
    Date.UTC(date.year, date.month - 1, date.day) / (24 * 60 * 60 * 1000)
  );
}

/**
 * `date + years`, com o dia limitado ao último do mês — a MESMA regra do
 * Postgres (`'2028-02-29'::date + INTERVAL '3 years'` = `2031-02-28`) que
 * `set_plan_period_end` aplica ao teto.
 */
function addYears(date: CalendarDate, years: number): CalendarDate {
  const year = date.year + years;
  return {
    year,
    month: date.month,
    day: Math.min(date.day, daysInMonth(year, date.month)),
  };
}

/** O dia de hoje em São Paulo (`YYYY-MM-DD`) — o `todaySp` das validações. */
export function todayInSaoPaulo(now: Date): string {
  // `en-CA` formata como `YYYY-MM-DD`.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

function formatIsoDate(date: CalendarDate): string {
  const pad = (n: number, size: number) => String(n).padStart(size, '0');
  return `${pad(date.year, 4)}-${pad(date.month, 2)}-${pad(date.day, 2)}`;
}

function fromDayNumber(day: number): CalendarDate {
  const d = new Date(day * 24 * 60 * 60 * 1000);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
  };
}

export interface DateRange {
  /** `YYYY-MM-DD`, inclusivo — vai direto para `min`/`max` de `<input type="date">`. */
  min: string;
  max: string;
}

/** Faixa do vencimento manual (D-3): de hoje até hoje + 3 anos. */
export function periodEndRange(todaySp: string): DateRange | null {
  const today = parseIsoDate(todaySp);
  if (!today) return null;
  return {
    min: formatIsoDate(today),
    max: formatIsoDate(addYears(today, PERIOD_END_MAX_YEARS)),
  };
}

/** Faixa do dia do pagamento (§4.1): de hoje − 365 dias até hoje. */
export function paidAtRange(todaySp: string): DateRange | null {
  const today = parseIsoDate(todaySp);
  if (!today) return null;
  return {
    min: formatIsoDate(
      fromDayNumber(toDayNumber(today) - PAID_AT_MAX_AGE_DAYS)
    ),
    max: formatIsoDate(today),
  };
}

/**
 * Valor em reais digitado pelo operador → centavos, sem passar por
 * ponto flutuante. Aceita "349", "349,90", "1.349,90", "R$ 349,90" e
 * "349.90"; `null` para qualquer coisa que não seja um valor monetário
 * (mais de duas casas, texto, negativo). Vazio é problema do chamador
 * (campo opcional → não chamar).
 */
export function parseMoneyToCents(input: string): number | null {
  const cleaned = input.replace(/R\$/gi, '').replace(/\s/g, '');
  if (cleaned === '') return null;

  let normalized: string;
  if (cleaned.includes(',')) {
    // Estilo pt-BR: ponto separa milhar, vírgula separa centavos.
    if (!/^\d{1,3}(\.\d{3})*(,\d{1,2})?$|^\d+(,\d{1,2})?$/.test(cleaned)) {
      return null;
    }
    normalized = cleaned.replace(/\./g, '').replace(',', '.');
  } else {
    if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null;
    normalized = cleaned;
  }

  const [whole, fraction = ''] = normalized.split('.');
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  return Number.isSafeInteger(cents) && cents <= MAX_AMOUNT_CENTS
    ? cents
    : null;
}

// ── Alterar vencimento (§3) ──────────────────────────────────────────

export type PeriodEndErrorCode =
  'period_end_invalid' | 'period_end_out_of_range' | 'invalid_billing_cycle';

export interface ValidatedPeriodEnd {
  /** `YYYY-MM-DD` — vai como `p_date` para `set_plan_period_end`. */
  date: string;
  /** `null` = manter o ciclo atual da conta (D-4). */
  billingCycle: BillingCycle | null;
}

export function validatePeriodEndInput(input: {
  date: unknown;
  billingCycle?: unknown;
  todaySp: string;
}): Result<ValidatedPeriodEnd, PeriodEndErrorCode> {
  const date = parseIsoDate(input.date);
  const today = parseIsoDate(input.todaySp);
  if (!date || !today) return { ok: false, code: 'period_end_invalid' };

  const cycle = input.billingCycle ?? null;
  if (cycle !== null && cycle !== 'monthly' && cycle !== 'yearly') {
    return { ok: false, code: 'invalid_billing_cycle' };
  }

  const day = toDayNumber(date);
  if (
    day < toDayNumber(today) ||
    day > toDayNumber(addYears(today, PERIOD_END_MAX_YEARS))
  ) {
    return { ok: false, code: 'period_end_out_of_range' };
  }

  return {
    ok: true,
    value: { date: input.date as string, billingCycle: cycle },
  };
}

// ── Pagamento manual (§4) ────────────────────────────────────────────

export type ManualPaymentErrorCode =
  | 'paid_at_invalid'
  | 'paid_at_in_future'
  | 'paid_at_too_old'
  | 'periods_invalid'
  | 'method_invalid'
  | 'amount_invalid'
  | 'payment_ref_required'
  | 'payment_ref_too_long'
  | 'note_too_long';

export interface ValidatedManualPayment {
  /** Instante ISO (meio-dia de São Paulo do dia informado) — `p_paid_at`. */
  paidAt: string;
  periods: number;
  method: PaymentMethod;
  amountCents: number | null;
  /** Já aparado — vai literal para `payment_ref` (§4.2, sem prefixo). */
  paymentRef: string;
  note: string | null;
}

export function validateManualPaymentInput(input: {
  /** `YYYY-MM-DD`, o dia em que o dinheiro entrou. */
  paidAt: unknown;
  periods: unknown;
  method: unknown;
  amountCents?: unknown;
  paymentRef?: unknown;
  note?: unknown;
  todaySp: string;
}): Result<ValidatedManualPayment, ManualPaymentErrorCode> {
  const paidDate = parseIsoDate(input.paidAt);
  const today = parseIsoDate(input.todaySp);
  if (!paidDate || !today) return { ok: false, code: 'paid_at_invalid' };

  const paidDay = toDayNumber(paidDate);
  const todayDay = toDayNumber(today);
  if (paidDay > todayDay) return { ok: false, code: 'paid_at_in_future' };
  if (paidDay < todayDay - PAID_AT_MAX_AGE_DAYS) {
    return { ok: false, code: 'paid_at_too_old' };
  }

  const periods = input.periods;
  if (
    typeof periods !== 'number' ||
    !Number.isInteger(periods) ||
    periods < 1 ||
    periods > MAX_PAYMENT_PERIODS
  ) {
    return { ok: false, code: 'periods_invalid' };
  }

  const method = input.method;
  if (
    typeof method !== 'string' ||
    !(PAYMENT_METHODS as readonly string[]).includes(method)
  ) {
    return { ok: false, code: 'method_invalid' };
  }

  let amountCents: number | null = null;
  if (input.amountCents !== undefined && input.amountCents !== null) {
    const amount = input.amountCents;
    if (
      typeof amount !== 'number' ||
      !Number.isInteger(amount) ||
      amount < 0 ||
      amount > MAX_AMOUNT_CENTS
    ) {
      return { ok: false, code: 'amount_invalid' };
    }
    amountCents = amount;
  }

  const paymentRef =
    typeof input.paymentRef === 'string' ? input.paymentRef.trim() : '';
  if (paymentRef === '') return { ok: false, code: 'payment_ref_required' };
  if (paymentRef.length > MAX_PAYMENT_REF_LENGTH) {
    return { ok: false, code: 'payment_ref_too_long' };
  }

  let note: string | null = null;
  if (typeof input.note === 'string' && input.note.trim() !== '') {
    note = input.note.trim();
    if (note.length > MAX_PAYMENT_NOTE_LENGTH) {
      return { ok: false, code: 'note_too_long' };
    }
  }

  return {
    ok: true,
    value: {
      paidAt: new Date(
        `${input.paidAt as string}${PAID_AT_ANCHOR}`
      ).toISOString(),
      periods,
      method: method as PaymentMethod,
      amountCents,
      paymentRef,
      note,
    },
  };
}

export interface ManualPaymentPreview {
  previousPeriodEnd: Date | null;
  newPeriodEnd: Date;
}

/**
 * "Vencimento atual → resultante" que o diálogo mostra ANTES de
 * confirmar. Parte do vencimento ATUAL, não de hoje (SPEC 062 §6.2 passo
 * 2 — renovar atrasado não pode encurtar o período do cliente); sem
 * vencimento gravado, a base é `now`, como em `apply_plan_renewal`.
 */
export function previewManualPayment(
  currentPeriodEnd: Date | string | null,
  cycle: BillingCycle,
  periods: number,
  now: Date
): ManualPaymentPreview {
  const previous =
    currentPeriodEnd === null
      ? null
      : typeof currentPeriodEnd === 'string'
        ? new Date(currentPeriodEnd)
        : currentPeriodEnd;
  return {
    previousPeriodEnd: previous,
    newPeriodEnd: advancePeriod(previous ?? now, cycle, periods),
  };
}

/**
 * Chave de idempotência quando o operador não informa um identificador
 * (§4.2). O `uuid` é gerado quando o diálogo ABRE — clique duplo,
 * retentativa por rede lenta e F5 enviam o mesmo valor e a constraint
 * `UNIQUE(payment_ref)` absorve; gerar no clique faria cada clique um
 * pagamento novo.
 */
export function newConsolePaymentRef(uuid: string): string {
  return `console:${uuid}`;
}
