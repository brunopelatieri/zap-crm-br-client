// Centralised date helpers for the dashboard so every chart / card
// agrees on what "today", "day boundary", and "day of week" mean.
// All boundaries are computed in the user's LOCAL timezone — which is
// what a business user intuitively expects when they say "today".

import { format } from 'date-fns';
import { getDateFnsLocale } from '@/lib/i18n/date-fns-locale';

export function startOfLocalDay(d: Date = new Date()): Date {
  const out = new Date(d);
  out.setHours(0, 0, 0, 0);
  return out;
}

export function daysAgoStart(days: number): Date {
  const out = startOfLocalDay();
  out.setDate(out.getDate() - days);
  return out;
}

/** Date-only key (YYYY-MM-DD) for bucketing rows by local calendar day. */
export function localDayKey(d: Date | string): string {
  const date = typeof d === 'string' ? new Date(d) : d;
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * Inclusive list of local-day keys spanning the last `n` days, in
 * chronological order. Useful for seeding chart buckets so days with
 * zero activity still render a 0-point in the line.
 */
export function lastNDayKeys(n: number): string[] {
  const keys: string[] = [];
  const start = daysAgoStart(n - 1);
  for (let i = 0; i < n; i++) {
    const d = new Date(start);
    d.setDate(d.getDate() + i);
    keys.push(localDayKey(d));
  }
  return keys;
}

/**
 * ISO day-of-week where 0 = Monday … 6 = Sunday. JavaScript's native
 * getDay() uses 0 = Sunday which is awkward for most business charts.
 */
export function mondayIndex(d: Date): number {
  const jsDow = d.getDay(); // 0..6 with Sunday=0
  return (jsDow + 6) % 7;
}

export const DOW_SHORT_MON_FIRST = [
  'Mon',
  'Tue',
  'Wed',
  'Thu',
  'Fri',
  'Sat',
  'Sun',
] as const;

// 2024-01-01 is a Monday — an arbitrary but stable reference date used
// only to walk `format(..., 'EEE')` through a Monday-first week. The
// actual calendar year is irrelevant; only the day-of-week sequence is.
const REFERENCE_MONDAY = new Date(2024, 0, 1);

/**
 * Monday-first short weekday labels ("seg"/"Mon"…) in the given app
 * locale, for chart axes that show `DOW_SHORT_MON_FIRST`-shaped data
 * to the user. Unlike the static English array above, this renders in
 * whichever language the account has chosen.
 *
 * date-fns's own "abbreviated" width (`EEE`) isn't actually short for
 * pt-BR — it spells out "segunda", "terça-feira"'s sibling in full
 * (only its "short" width trims to "seg"/"ter", but that width drops
 * accents: "sab" instead of "sáb"). Slicing the abbreviated form to 3
 * chars sidesteps both: English is already 3 letters (`Mon`.slice(0,3)
 * is a no-op) and Portuguese keeps its accents ("sábado" → "sáb").
 */
export function localizedShortWeekdays(locale: string): string[] {
  const dateFnsLocale = getDateFnsLocale(locale);
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(REFERENCE_MONDAY);
    d.setDate(d.getDate() + i);
    return format(d, 'EEE', { locale: dateFnsLocale }).slice(0, 3);
  });
}
