import { searchKnowledge } from '../knowledge';
import type { KnowledgeSource } from '../types';
import { asObject, readString } from './input';
import type { AgentTool } from './types';

// search_knowledge (read): a new search in the account's knowledge base
// with a query the model chooses. Same hybrid retrieval as the automatic
// one in compose.ts (D-10), so the account filter and the distance
// threshold are the RPC's. The excerpts are data for the model; their
// sources (D-14) go to the playground and `ai_usage_log`, never to the
// customer.

const MAX_QUERY = 300;
const TOOL_TOP_K = 3;

export const searchKnowledgeTool: AgentTool<{ query: string }> = {
  key: 'search_knowledge',
  description:
    "Search the business's knowledge base (prices, policies, opening hours, products) with a short query in the customer's language. Use it before answering any factual question. Returns matching excerpts, or none.",
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description:
          'Short search query, in the language the customer writes in.',
        maxLength: MAX_QUERY,
      },
    },
    required: ['query'],
    additionalProperties: false,
  },
  risk: 'read',
  parse(input) {
    const obj = asObject(input);
    if (!obj.ok) return obj;
    const query = readString(obj.value, 'query', {
      required: true,
      max: MAX_QUERY,
    });
    if (!query.ok) return query;
    return { ok: true, value: { query: query.value as string } };
  },
  async handler(ctx, { query }) {
    // 3 excerpts of up to 1,200 characters fit the 4 KB result budget
    // (rule 2); 5 would be cut mid-excerpt.
    const search = await searchKnowledge(
      ctx.db,
      ctx.accountId,
      ctx.aiConfig,
      query,
      {
        k: TOOL_TOP_K,
      }
    );
    if (search.searchFailed) return { ok: false, error: 'search_failed' };
    const sources: KnowledgeSource[] = search.hits.map(
      ({ chunkId, documentId, title, score }) => ({
        chunkId,
        documentId,
        title,
        score,
      })
    );
    return {
      ok: true,
      data: {
        results: search.hits.map((h) => ({
          title: h.title,
          section: h.heading,
          excerpt: h.content,
        })),
      },
      sources,
    };
  },
};
