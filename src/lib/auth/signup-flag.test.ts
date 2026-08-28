import { describe, expect, it } from 'vitest';
import { isPublicSignupEnabled } from './signup-flag';

describe('isPublicSignupEnabled', () => {
  it('defaults to enabled when the variable is undeclared', () => {
    expect(isPublicSignupEnabled(undefined)).toBe(true);
  });

  it('disables only on the literal "false" (case-insensitive)', () => {
    expect(isPublicSignupEnabled('false')).toBe(false);
    expect(isPublicSignupEnabled('FALSE')).toBe(false);
    expect(isPublicSignupEnabled(' False ')).toBe(false);
  });

  it('stays enabled for any other declared value', () => {
    expect(isPublicSignupEnabled('true')).toBe(true);
    expect(isPublicSignupEnabled('1')).toBe(true);
    expect(isPublicSignupEnabled('')).toBe(true);
  });
});
