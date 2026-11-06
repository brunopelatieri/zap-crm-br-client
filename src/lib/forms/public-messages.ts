// ============================================================
// Textos de sistema da página pública (PRD 084 D-8, SPEC 085 E-10).
//
// O idioma vem de `forms.locale`, não do cookie do visitante: o owner
// sabe para quem o link vai. Mesmo mecanismo da área do contato
// (`contact-portal/delivery.ts`): `createTranslator` do next-intl sobre o
// dicionário daquele locale, namespace `PublicForm`.
//
// Só servidor (import dinâmico do JSON). O cliente recebe as strings já
// resolvidas no payload da página (F3).
// ============================================================

import { createTranslator } from 'next-intl';

import {
  DEFAULT_LOCALE,
  isAppLocale,
  type AppLocale,
} from '@/lib/i18n/locales';

export const PUBLIC_FORM_NAMESPACE = 'PublicForm';

/**
 * Chaves que a página pública usa (SPEC 085 §10.1). O teste co-locado
 * confere que TODAS existem nos dois dicionários e compilam em ICU.
 */
export const PUBLIC_FORM_MESSAGE_KEYS = [
  'start',
  'continue',
  'ok',
  'back',
  'submit',
  'submitting',
  'required',
  'invalidEmail',
  'invalidPhone',
  'invalidNumber',
  'invalidDate',
  'invalidOption',
  'minChoices',
  'maxChoices',
  'maxLength',
  'minValue',
  'maxValue',
  'tooManyFiles',
  'invalidFile',
  'fileTooLarge',
  'fileTypeNotAllowed',
  'consentRequired',
  'alreadyAnswered',
  'unavailable.title',
  'unavailable.body',
  'thankYou.default',
  'thankYou.whatsapp',
  'footer.madeWith',
  'estimatedTime',
  'pressEnter',
  'uploading',
  'retry',
  'yes',
  'no',
  'optional',
  'chooseFile',
  'removeFile',
  'progress',
  'networkError',
] as const;

export type PublicFormMessageKey = (typeof PUBLIC_FORM_MESSAGE_KEYS)[number];

export type PublicFormTranslator = (
  key: PublicFormMessageKey,
  values?: Record<string, string | number | Date>
) => string;

export function resolveFormLocale(
  locale: string | null | undefined
): AppLocale {
  return isAppLocale(locale) ? locale : DEFAULT_LOCALE;
}

/** Tradutor do namespace `PublicForm` para o idioma do formulário. */
export async function loadPublicFormTranslator(
  locale: string | null | undefined
): Promise<PublicFormTranslator> {
  const resolved = resolveFormLocale(locale);
  const messages = (await import(`../../../messages/${resolved}.json`)).default;
  return createTranslator({
    locale: resolved,
    messages,
    namespace: PUBLIC_FORM_NAMESPACE,
  }) as unknown as PublicFormTranslator;
}

/**
 * Mapa chave → mensagem ICU CRUA (para mandar ao cliente de uma vez).
 * Lê o dicionário direto, sem passar pelo tradutor: os placeholders
 * (`{min}`, `{total}`…) ficam intactos para o cliente formatar, e o
 * next-intl não registra erro de valor ausente. Chave que faltar vira o
 * próprio nome da chave — nunca lança na renderização da página.
 */
export async function loadPublicFormMessages(
  locale: string | null | undefined
): Promise<Record<PublicFormMessageKey, string>> {
  const resolved = resolveFormLocale(locale);
  const messages = (await import(`../../../messages/${resolved}.json`))
    .default as Record<string, unknown>;
  const namespace = messages[PUBLIC_FORM_NAMESPACE];
  const out = {} as Record<PublicFormMessageKey, string>;
  for (const key of PUBLIC_FORM_MESSAGE_KEYS) {
    const raw = key.split('.').reduce<unknown>((node, part) => {
      if (!node || typeof node !== 'object') return undefined;
      return (node as Record<string, unknown>)[part];
    }, namespace);
    out[key] = typeof raw === 'string' ? raw : key;
  }
  return out;
}
