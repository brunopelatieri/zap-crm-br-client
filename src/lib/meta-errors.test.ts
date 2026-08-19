import { describe, it, expect } from 'vitest';
import { getMetaErrorTranslationKey } from './meta-errors';

describe('meta-errors', () => {
  it('matches error code #130472 (experiment user)', () => {
    expect(
      getMetaErrorTranslationKey(
        '(#130472) User\'s number is part of an experiment'
      )
    ).toBe('experimentUser');

    expect(getMetaErrorTranslationKey('130472')).toBe('experimentUser');
    expect(
      getMetaErrorTranslationKey('part of an experiment')
    ).toBe('experimentUser');
  });

  it('matches error code #131026 (undeliverable)', () => {
    expect(
      getMetaErrorTranslationKey('(#131026) Message undeliverable')
    ).toBe('undeliverable');

    expect(getMetaErrorTranslationKey('131026')).toBe('undeliverable');
    expect(
      getMetaErrorTranslationKey('Message undeliverable')
    ).toBe('undeliverable');
  });

  it('matches error code #131049 (ecosystem protection)', () => {
    expect(
      getMetaErrorTranslationKey(
        '(#131049) This message was not delivered to maintain healthy ecosystem engagement.'
      )
    ).toBe('ecosystemProtection');

    expect(getMetaErrorTranslationKey('131049')).toBe('ecosystemProtection');
    expect(
      getMetaErrorTranslationKey('healthy ecosystem engagement')
    ).toBe('ecosystemProtection');
  });

  it('returns null for unknown errors', () => {
    expect(getMetaErrorTranslationKey('Some random error')).toBe(null);
    expect(getMetaErrorTranslationKey('')).toBe(null);
    expect(getMetaErrorTranslationKey(null)).toBe(null);
    expect(getMetaErrorTranslationKey(undefined)).toBe(null);
  });

  it('is case-insensitive', () => {
    expect(
      getMetaErrorTranslationKey('Message Undeliverable')
    ).toBe('undeliverable');
    expect(
      getMetaErrorTranslationKey('PART OF AN EXPERIMENT')
    ).toBe('experimentUser');
  });
});
