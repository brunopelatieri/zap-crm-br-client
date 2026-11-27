import { describe, it, expect } from 'vitest';
import {
  parseProviderOptions,
  serializeProviderOptions,
} from './provider-options';

describe('parseProviderOptions', () => {
  it('is off by default (D-5: privacy filter born disabled)', () => {
    expect(parseProviderOptions({})).toEqual({ denyDataCollection: false });
    expect(parseProviderOptions(null)).toEqual({ denyDataCollection: false });
    expect(parseProviderOptions(undefined)).toEqual({
      denyDataCollection: false,
    });
  });

  it('turns on only for a literal true', () => {
    expect(parseProviderOptions({ deny_data_collection: true })).toEqual({
      denyDataCollection: true,
    });
    for (const junk of ['true', 1, 'yes', null, {}]) {
      expect(parseProviderOptions({ deny_data_collection: junk })).toEqual({
        denyDataCollection: false,
      });
    }
  });

  it('survives non-object junk', () => {
    for (const junk of ['x', 3, [], true]) {
      expect(parseProviderOptions(junk)).toEqual({ denyDataCollection: false });
    }
  });
});

describe('serializeProviderOptions', () => {
  it('round-trips and stores nothing when everything is off', () => {
    expect(serializeProviderOptions({ denyDataCollection: false })).toEqual({});
    const on = serializeProviderOptions({ denyDataCollection: true });
    expect(on).toEqual({ deny_data_collection: true });
    expect(parseProviderOptions(on)).toEqual({ denyDataCollection: true });
  });
});
