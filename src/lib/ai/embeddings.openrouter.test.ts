import { describe, it, expect, vi, afterEach } from 'vitest';
import { embedTexts, resolveEmbeddingsTarget } from './embeddings';
import { fixtureResponse, loadFixture } from './providers/openrouter-fixtures';

afterEach(() => vi.unstubAllGlobals());

describe('embedTexts — OpenRouter (SPEC 089 D-3)', () => {
  const OR = { provider: 'openrouter' as const, apiKey: 'sk-or-x' };

  it('uses the OpenRouter URL and the requested model id, never dimensions', async () => {
    const real = loadFixture('embeddings.json');
    const fetchMock = vi
      .fn()
      .mockResolvedValue(fixtureResponse('embeddings.json'));
    vi.stubGlobal('fetch', fetchMock);

    const input = real.request!.input as string[];
    const out = await embedTexts(OR, input);

    expect(out).toHaveLength(input.length);
    expect(out[0]).toHaveLength(1536);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://openrouter.ai/api/v1/embeddings');
    expect(init.headers.Authorization).toBe('Bearer sk-or-x');
    expect(init.headers['X-OpenRouter-Title']).toBe('ZAP CRM BR');
    const body = JSON.parse(init.body);
    // The identifier REQUESTED: the response echoes it without `openai/`.
    expect(body.model).toBe('openai/text-embedding-3-small');
    expect(body).not.toHaveProperty('dimensions');
  });

  it('maps a 402 from the embeddings endpoint to insufficient_credits', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          fixtureResponse('error-402-insufficient-credits.json')
        )
    );
    await expect(embedTexts(OR, ['x'])).rejects.toMatchObject({
      code: 'insufficient_credits',
    });
  });

  it('keeps the OpenAI target on api.openai.com with the bare model id', async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({ data: [{ embedding: [1, 2], index: 0 }] })
    );
    vi.stubGlobal('fetch', fetchMock);
    await embedTexts({ provider: 'openai', apiKey: 'sk-x' }, ['a']);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      { body: string },
    ];
    expect(url).toBe('https://api.openai.com/v1/embeddings');
    expect(JSON.parse(init.body).model).toBe('text-embedding-3-small');
  });
});

describe('resolveEmbeddingsTarget', () => {
  const base = {
    provider: 'openai' as const,
    apiKey: 'chat-key',
    embeddingsProvider: 'openai' as const,
    embeddingsApiKey: null,
  };

  it('prefers the own embeddings key, on its own provider', () => {
    expect(
      resolveEmbeddingsTarget({
        ...base,
        provider: 'openrouter',
        embeddingsProvider: 'openai',
        embeddingsApiKey: 'emb-key',
      })
    ).toEqual({ provider: 'openai', apiKey: 'emb-key' });
  });

  it('reuses the chat key on OpenRouter when there is no own key (D-3)', () => {
    expect(
      resolveEmbeddingsTarget({ ...base, provider: 'openrouter' })
    ).toEqual({ provider: 'openrouter', apiKey: 'chat-key' });
  });

  it('is null for OpenAI / Anthropic without an own key (lexical only)', () => {
    expect(resolveEmbeddingsTarget(base)).toBeNull();
    expect(
      resolveEmbeddingsTarget({ ...base, provider: 'anthropic' })
    ).toBeNull();
  });
});
