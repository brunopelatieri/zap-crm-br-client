/**
 * Meta API error code mapping to i18n translation keys.
 * Translates known Meta error codes/messages to user-facing strings.
 */

export interface MetaErrorMapping {
  key: string;
  pattern: RegExp;
}

const META_ERROR_MAPPINGS: MetaErrorMapping[] = [
  {
    key: 'experimentUser',
    pattern: /130472|user.*experiment|part of an experiment/i,
  },
  {
    key: 'undeliverable',
    pattern: /131026|message undeliverable/i,
  },
  {
    key: 'ecosystemProtection',
    pattern: /131049|healthy ecosystem|ecosystem engagement/i,
  },
];

/**
 * Attempt to match an error message against known Meta API codes/messages.
 * Returns the i18n key if found, otherwise null (caller should display raw message).
 *
 * @param errorMessage - The error message from Meta API or webhook
 * @returns i18n key like 'experimentUser', or null if no match
 */
export function getMetaErrorTranslationKey(
  errorMessage: string | null | undefined
): string | null {
  if (!errorMessage) return null;

  for (const { key, pattern } of META_ERROR_MAPPINGS) {
    if (pattern.test(errorMessage)) {
      return key;
    }
  }

  return null;
}
