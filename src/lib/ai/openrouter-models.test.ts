import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  MODELS_CACHE_TTL_MS,
  OPENROUTER_MODELS_URL,
  getOpenRouterModels,
  normalizeCatalog,
  resetModelsCache,
  searchModels,
} from './openrouter-models';
import { loadFixture } from './providers/openrouter-fixtures';

// Real excerpt of the public catalog (F0 §1.7): pixtral (no tools),
// haiku 5.5 and a third model.
const catalogJson = loadFixture('models-catalog-sample.json').response.body;

let fetchMock: ReturnType<typeof vi.fn>;

function catalogResponse(): Response {
  return new Response(JSON.stringify(catalogJson), { status: 200 });
}

beforeEach(() => {
  resetModelsCache();
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe('normalizeCatalog (real catalog sample)', () => {
  const models = normalizeCatalog(catalogJson);

  it('keeps id, name, context and the tools flag from supported_parameters', () => {
    const pixtral = models.find((m) => m.id === 'mistralai/pixtral-large-2502');
    expect(pixtral).toMatchObject({
      name: 'Mistral: Pixtral Large 2502',
      contextLength: 128000,
      supportsTools: false,
      promptPricePerM: 2,
      completionPricePerM: 6,
    });
    const haiku = models.find((m) => m.id === 'anthropic/claude-haiku-5.5');
    expect(haiku?.supportsTools).toBe(true);
    expect(haiku?.contextLength).toBe(1000000);
  });

  it('drops junk entries and non-text outputs', () => {
    const out = normalizeCatalog({
      data: [
        null,
        { name: 'no id' },
        { id: 'x/img', architecture: { output_modalities: ['image'] } },
        { id: 'x/ok', architecture: { output_modalities: ['text'] } },
      ],
    });
    expect(out.map((m) => m.id)).toEqual(['x/ok']);
    expect(normalizeCatalog(null)).toEqual([]);
  });
});

describe('searchModels', () => {
  const models = normalizeCatalog(catalogJson);

  it('matches id or name case-insensitively, tools-capable first', () => {
    expect(searchModels(models, 'HAIKU').map((m) => m.id)).toContain(
      'anthropic/claude-haiku-5.5'
    );
    const all = searchModels(models, '');
    const firstNoTools = all.findIndex((m) => !m.supportsTools);
    const lastTools = all.map((m) => m.supportsTools).lastIndexOf(true);
    expect(firstNoTools === -1 || lastTools < firstNoTools).toBe(true);
  });

  it('is a suggestion, not an allow-list: unknown text just finds nothing', () => {
    expect(searchModels(models, 'zzz-not-a-model')).toEqual([]);
  });

  it('respects the limit', () => {
    expect(searchModels(models, '', 1)).toHaveLength(1);
  });
});

describe('getOpenRouterModels', () => {
  it('fetches the fixed host without following redirects, then caches for an hour', async () => {
    fetchMock.mockImplementation(async () => catalogResponse());
    await getOpenRouterModels(1_000);
    await getOpenRouterModels(1_000 + MODELS_CACHE_TTL_MS - 1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(OPENROUTER_MODELS_URL);
    expect(init.redirect).toBe('manual');

    await getOpenRouterModels(1_000 + MODELS_CACHE_TTL_MS);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('shares one request among concurrent callers', async () => {
    fetchMock.mockImplementation(async () => catalogResponse());
    await Promise.all([getOpenRouterModels(5), getOpenRouterModels(5)]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('treats a redirect (manual mode answers 3xx) as a failure', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 302 }));
    await expect(getOpenRouterModels(1)).rejects.toThrow();
  });

  it('serves the stale copy when a refresh fails', async () => {
    fetchMock.mockImplementationOnce(async () => catalogResponse());
    const first = await getOpenRouterModels(0);
    fetchMock.mockRejectedValueOnce(new Error('down'));
    const stale = await getOpenRouterModels(MODELS_CACHE_TTL_MS + 1);
    expect(stale).toBe(first);
  });

  it('throws with nothing cached, and a failure does not poison later calls', async () => {
    fetchMock.mockRejectedValueOnce(new Error('down'));
    await expect(getOpenRouterModels(0)).rejects.toThrow('down');
    fetchMock.mockImplementation(async () => catalogResponse());
    const ok = await getOpenRouterModels(1);
    expect(ok.length).toBeGreaterThan(0);
  });
});
