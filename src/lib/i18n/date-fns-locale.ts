import { ptBR, enUS } from 'date-fns/locale';
import type { Locale } from 'date-fns';
import { DEFAULT_LOCALE } from './locales';

/**
 * Maps the app's next-intl locale codes (see `SUPPORTED_LOCALES` in
 * `./locales`) to their date-fns `Locale` objects. Every `format` /
 * `formatDistanceToNow` call that renders weekday names, month names,
 * or "time ago" phrasing must pass `{ locale: getDateFnsLocale(locale) }`
 * — without it date-fns falls back to hardcoded English ("Mon",
 * "about 10 hours") regardless of the app's chosen language.
 */
const DATE_FNS_LOCALES: Record<string, Locale> = {
  'pt-BR': ptBR,
  en: enUS,
};

export function getDateFnsLocale(locale: string): Locale {
  return DATE_FNS_LOCALES[locale] ?? DATE_FNS_LOCALES[DEFAULT_LOCALE];
}
