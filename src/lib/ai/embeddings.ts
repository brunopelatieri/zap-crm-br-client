import {
  AiError,
  type AiProvider,
  type EmbeddingsProvider,
  type EmbeddingsTarget,
} from './types';
import { aiRequestTimeoutMs } from './defaults';
import { providerHttpError, toNetworkError } from './providers/shared';
import { OPENROUTER_BASE_URL, openRouterHeaders } from './providers/openrouter';

// ============================================================
// Embeddings (OpenAI-compatible).
//
// Used for the knowledge base's optional semantic-search path: embed
// each chunk at ingest, and embed the query at retrieval. Anthropic has
// no embeddings endpoint, so the provider is OpenAI or OpenRouter (SPEC
// 089 D-3) — the account supplies a (possibly separate) embeddings key,
// or reuses the chat key on OpenRouter. Both serve 1536-dim
// text-embedding-3-small, which matches the `vector(1536)` column in
// migration 030. The adapter never sends `dimensions` (F0 §1.9).
// ============================================================

/** URL and model per embeddings provider (the model id is the one
 *  REQUESTED — OpenRouter echoes it back without the `openai/` prefix). */
export const EMBEDDINGS_PROVIDER_CONFIG: Record<
  EmbeddingsProvider,
  { url: string; model: string; label: string }
> = {
  openai: {
    url: 'https://api.openai.com/v1/embeddings',
    model: 'text-embedding-3-small',
    label: 'OpenAI embeddings',
  },
  openrouter: {
    url: `${OPENROUTER_BASE_URL}/embeddings`,
    model: 'openai/text-embedding-3-small',
    label: 'OpenRouter embeddings',
  },
};

export const EMBEDDING_DIMENSIONS = 1536;

/**
 * Decide who embeds, given what the account configured:
 *  - an own embeddings key wins, on `embeddingsProvider`;
 *  - else, on OpenRouter, the chat key is reused (D-3);
 *  - else null → lexical-only retrieval (OpenAI / Anthropic chat keys
 *    are never reused silently, as before).
 */
export function resolveEmbeddingsTarget(args: {
  provider: AiProvider;
  apiKey: string;
  embeddingsProvider: EmbeddingsProvider;
  embeddingsApiKey: string | null;
}): EmbeddingsTarget | null {
  if (args.embeddingsApiKey) {
    return {
      provider: args.embeddingsProvider,
      apiKey: args.embeddingsApiKey,
    };
  }
  if (args.provider === 'openrouter' && args.apiKey) {
    return { provider: 'openrouter', apiKey: args.apiKey };
  }
  return null;
}

// OpenAI accepts an array input; keep batches modest so a big re-index
// stays under request-size limits and partial failures are cheap.
const BATCH_SIZE = 96;

interface EmbeddingResponse {
  data?: { embedding?: number[]; index?: number }[];
}

/** Format a vector for a pgvector column / RPC param: `[0.1,0.2,...]`.
 *  PostgREST casts this text literal to `vector`; a raw JS array does
 *  not cast reliably. */
export function toVectorLiteral(embedding: number[]): string {
  return `[${embedding.join(',')}]`;
}

/**
 * Embed a list of strings, preserving input order. Batched; throws
 * `AiError` on provider/network failure so callers can decide whether
 * to degrade (retrieval) or surface (ingest).
 */
export async function embedTexts(
  target: EmbeddingsTarget,
  inputs: string[]
): Promise<number[][]> {
  if (inputs.length === 0) return [];
  const cfg = EMBEDDINGS_PROVIDER_CONFIG[target.provider];
  const timeoutMs = aiRequestTimeoutMs();
  const out: number[][] = [];

  for (let start = 0; start < inputs.length; start += BATCH_SIZE) {
    const batch = inputs.slice(start, start + BATCH_SIZE);

    let res: Response;
    try {
      res = await fetch(cfg.url, {
        method: 'POST',
        headers:
          target.provider === 'openrouter'
            ? openRouterHeaders(target.apiKey)
            : {
                Authorization: `Bearer ${target.apiKey}`,
                'Content-Type': 'application/json',
              },
        body: JSON.stringify({ model: cfg.model, input: batch }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw toNetworkError(err);
    }

    if (!res.ok) {
      throw await providerHttpError(cfg.label, res);
    }

    const data = (await res
      .json()
      .catch(() => null)) as EmbeddingResponse | null;
    const rows = data?.data;
    if (!rows || rows.length !== batch.length) {
      throw new AiError('Embeddings response was malformed.', {
        code: 'embeddings_malformed',
      });
    }

    // Sort by index so order matches the input batch regardless of how
    // the provider returns them. Require a real numeric index — defaulting
    // a missing one to 0 would silently misalign chunks with their
    // vectors (chunk N gets chunk M's embedding), so fail loud instead.
    if (rows.some((r) => typeof r.index !== 'number')) {
      throw new AiError('Embeddings response was missing result indices.', {
        code: 'embeddings_malformed',
      });
    }
    const ordered = [...rows].sort((a, b) => a.index! - b.index!);
    for (const r of ordered) {
      if (!Array.isArray(r.embedding)) {
        throw new AiError('Embeddings response missing a vector.', {
          code: 'embeddings_malformed',
        });
      }
      out.push(r.embedding);
    }
  }

  return out;
}
