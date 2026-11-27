import type { AiProviderOptions } from './types';

/** Defaults: everything off. The privacy filter is OFF by default (SPEC 089 D-5). */
export const DEFAULT_PROVIDER_OPTIONS: AiProviderOptions = {
  denyDataCollection: false,
};

/**
 * Parse `ai_configs.provider_options` (jsonb, shape
 * `{ "deny_data_collection": true }`) into typed options. Tolerant of
 * null, junk and unknown keys: anything that is not literally `true`
 * stays off.
 */
export function parseProviderOptions(raw: unknown): AiProviderOptions {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ...DEFAULT_PROVIDER_OPTIONS };
  }
  const o = raw as Record<string, unknown>;
  return { denyDataCollection: o.deny_data_collection === true };
}

/** Serialize typed options back to the stored jsonb shape. */
export function serializeProviderOptions(
  options: AiProviderOptions
): Record<string, unknown> {
  return options.denyDataCollection ? { deny_data_collection: true } : {};
}
