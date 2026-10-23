import { AuthApiError } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';

import { getAuthErrorMessageKey, isSamePasswordError } from './error-messages';

describe('getAuthErrorMessageKey', () => {
  it('maps same_password to its own alert, not the generic one', () => {
    const error = new AuthApiError(
      'New password should be different from the old password.',
      422,
      'same_password'
    );
    expect(getAuthErrorMessageKey(error)).toBe('errorSamePassword');
  });

  it('keeps the generic fallback for codes it does not know', () => {
    const error = new AuthApiError('boom', 500, 'unexpected_failure');
    expect(getAuthErrorMessageKey(error)).toBe('errorGeneric');
  });

  it('keeps the generic fallback for non-auth errors', () => {
    expect(getAuthErrorMessageKey(new Error('network down'))).toBe(
      'errorGeneric'
    );
  });
});

describe('isSamePasswordError', () => {
  it('is true only for the same_password code', () => {
    expect(
      isSamePasswordError(new AuthApiError('same', 422, 'same_password'))
    ).toBe(true);
    expect(
      isSamePasswordError(new AuthApiError('weak', 422, 'weak_password'))
    ).toBe(false);
    expect(isSamePasswordError(new Error('same_password'))).toBe(false);
  });
});
