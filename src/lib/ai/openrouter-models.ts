import { OPENROUTER_BASE_URL } from './providers/openrouter';

// ============================================================
// OpenRouter public model catalog, as a suggestion source for the model
// field (SPEC 089 D-2): NEVER an allow-list — the model stays free text.
// Fixed host, `redirect: 'manual'`, one-hour in-memory cache. The catalog
// is public (no key) and ~900 KB, so it is fetched at most once an hour
// per server instance.
// ============================================================

export const OPENROUTER_MODELS_URL = `${OPENROUTER_BASE_URL}/models`;
export const MODELS_CACHE_TTL_MS = 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 10_000;
/** Max suggestions returned per request. */
export const MODELS_RESULT_LIMIT = 20;

export interface ModelSuggestion {
  id: string;
  name: string;
  contextLength: number | null;
  /** `supported_parameters` includes `tools` (F0 §1.7). Not a guarantee
   *  that the full tool loop works — hence "Test tools" in F4. */
  supportsTools: boolean;
  /** USD per million tokens, or null when the catalog has no price. */
  promptPricePerM: number | null;
  completionPricePerM: number | null;
}

interface CatalogEntry {
  id?: unknown;
  name?: unknown;
  context_length?: unknown;
  supported_parameters?: unknown;
  pricing?: { prompt?: unknown; completion?: unknown };
  architecture?: { output_modalities?: unknown };
}

function perMillion(v: unknown): number | null {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 1e6 * 1e4) / 1e4 : null;
}

/** Reduce the raw catalog to the fields the screen needs. Text-output
 *  models only; entries without an `id` are dropped. */
export function normalizeCatalog(raw: unknown): ModelSuggestion[] {
  const list = (raw as { data?: unknown })?.data;
  if (!Array.isArray(list)) return [];
  const out: ModelSuggestion[] = [];
  for (const e of list as CatalogEntry[]) {
    if (!e || typeof e.id !== 'string' || !e.id) continue;
    const modalities = e.architecture?.output_modalities;
    if (Array.isArray(modalities) && !modalities.includes('text')) continue;
    const params = Array.isArray(e.supported_parameters)
      ? e.supported_parameters
      : [];
    out.push({
      id: e.id,
      name: typeof e.name === 'string' && e.name ? e.name : e.id,
      contextLength:
        typeof e.context_length === 'number' ? e.context_length : null,
      supportsTools: params.includes('tools'),
      promptPricePerM: perMillion(e.pricing?.prompt),
      completionPricePerM: perMillion(e.pricing?.completion),
    });
  }
  return out;
}

/** Filter by a case-insensitive substring of id or name; models that
 *  accept tools first, then catalog order. Empty query = first N. */
export function searchModels(
  models: ModelSuggestion[],
  q: string,
  limit = MODELS_RESULT_LIMIT
): ModelSuggestion[] {
  const needle = q.trim().toLowerCase();
  const hits = needle
    ? models.filter(
        (m) =>
          m.id.toLowerCase().includes(needle) ||
          m.name.toLowerCase().includes(needle)
      )
    : models;
  const withTools = hits.filter((m) => m.supportsTools);
  const without = hits.filter((m) => !m.supportsTools);
  return [...withTools, ...without].slice(0, limit);
}

let cache: { at: number; models: ModelSuggestion[] } | null = null;
let inflight: Promise<ModelSuggestion[]> | null = null;

/** Test hook. */
export function resetModelsCache(): void {
  cache = null;
  inflight = null;
}

/**
 * The normalized catalog, cached for an hour. Throws on failure with no
 * stale copy to fall back to; with a stale copy it serves that instead
 * (a suggestion list should not break because the catalog blinked).
 */
export async function getOpenRouterModels(
  now: number = Date.now()
): Promise<ModelSuggestion[]> {
  if (cache && now - cache.at < MODELS_CACHE_TTL_MS) return cache.models;
  if (inflight) return inflight;

  inflight = (async () => {
    try {
      await null; // `inflight` is assigned before anything can settle
      const res = await fetch(OPENROUTER_MODELS_URL, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        // A redirect would leave the fixed host: treat it as a failure.
        redirect: 'manual',
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`catalog status ${res.status}`);
      const models = normalizeCatalog(await res.json());
      if (models.length === 0) throw new Error('catalog was empty');
      cache = { at: now, models };
      return models;
    } catch (err) {
      if (cache) return cache.models; // stale beats nothing
      throw err;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}
