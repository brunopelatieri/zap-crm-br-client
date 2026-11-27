import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

const h = vi.hoisted(() => ({ searchKnowledge: vi.fn() }));
vi.mock('./knowledge', () => ({ searchKnowledge: h.searchKnowledge }));

import { generateReply } from './generate';
import { searchKnowledgeTool } from './tools/knowledge';
import { fixtureResponse, loadFixture } from './providers/openrouter-fixtures';
import type { AiConfig } from './types';
import type { ToolContext } from './tools/types';

// End to end through the real OpenRouter adapter with the REAL F0 payloads
// (docs/spec-089-f0-fixtures/): step 1 asks for two parallel
// search_knowledge calls, step 2 answers with the results. Only the
// knowledge search itself is faked.

const CONFIG: AiConfig = {
  provider: 'openrouter',
  model: 'anthropic/claude-haiku-5.5',
  apiKey: 'sk-or-test',
  systemPrompt: null,
  isActive: true,
  autoReplyEnabled: true,
  autoReplyMaxPerConversation: 3,
  handoffAgentId: null,
  embeddingsTarget: null,
  providerOptions: { denyDataCollection: false },
  toolsConfig: { search_knowledge: { enabled: true } },
};

const CTX: ToolContext = {
  db: {} as SupabaseClient,
  accountId: 'acct-a',
  conversationId: 'conv-a',
  contactId: 'contact-a',
  mode: 'auto_reply',
  dryRun: false,
  toolsConfig: CONFIG.toolsConfig!,
  aiConfig: { embeddingsTarget: null },
  turnId: 'turn-test',
  turnState: {},
};

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  h.searchKnowledge
    .mockReset()
    .mockImplementation(async (_db, _acct, _cfg, query: string) => ({
      hits: [
        {
          chunkId: `chunk-${query}`,
          documentId: 'doc-1',
          title: 'Loja Exemplo',
          heading: null,
          content: query.includes('devolução')
            ? 'O prazo para devolução é de 7 dias corridos após o recebimento.'
            : 'Plano Avançado: R$ 129,00 por mês.',
          score: 0.03,
          distance: 0.3,
          lexicalRank: 0.1,
          origin: 'both',
        },
      ],
      searchFailed: false,
      usedEmbedding: false,
      embeddingFailed: false,
      knowledgeEmpty: false,
    }));
});
afterEach(() => vi.unstubAllGlobals());

const USER_MSG =
  'Oi! Quanto custa o plano Avançado e qual o prazo para devolução?';

describe('generateReply with tools — real OpenRouter payloads', () => {
  it('runs both parallel calls and returns the final answer, cost summed', async () => {
    fetchMock
      .mockResolvedValueOnce(fixtureResponse('tool-calls-parallel.json'))
      .mockResolvedValueOnce(fixtureResponse('tool-result-final-answer.json'));
    const step1 = loadFixture('tool-calls-parallel.json').response.body as {
      usage: { cost: number };
    };
    const step2 = loadFixture('tool-result-final-answer.json').response
      .body as {
      choices: { message: { content: string } }[];
      usage: { cost: number };
    };

    const out = await generateReply({
      config: CONFIG,
      systemPrompt: 'Você é a atendente virtual.',
      messages: [{ role: 'user', content: USER_MSG }],
      tools: [searchKnowledgeTool as never],
      toolContext: CTX,
    });

    expect(out.text).toBe(step2.choices[0].message.content);
    expect(out.handoff).toBe(false);
    expect(out.steps).toBe(2);
    expect(out.toolCalls?.map((t) => [t.name, t.status, t.arguments])).toEqual([
      ['search_knowledge', 'ok', { query: 'preço plano Avançado' }],
      ['search_knowledge', 'ok', { query: 'prazo para devolução' }],
    ]);
    expect(out.usage?.costUsd).toBeCloseTo(
      step1.usage.cost + step2.usage.cost,
      10
    );
    expect(out.toolSources?.map((s) => s.chunkId)).toEqual([
      'chunk-preço plano Avançado',
      'chunk-prazo para devolução',
    ]);
    // The account comes from the context, the query from the model.
    expect(h.searchKnowledge).toHaveBeenCalledWith(
      CTX.db,
      'acct-a',
      { embeddingsTarget: null },
      'preço plano Avançado',
      { k: 3 }
    );

    // Second request: the tool turns carry the real call ids and the
    // wrapped results.
    const second = JSON.parse(fetchMock.mock.calls[1][1].body as string) as {
      messages: {
        role: string;
        tool_call_id?: string;
        content?: string | null;
      }[];
      tools: unknown[];
    };
    const toolMsgs = second.messages.filter((m) => m.role === 'tool');
    expect(toolMsgs.map((m) => m.tool_call_id)).toEqual([
      'toolu_01DWEqRDVEAWhhwiGMSVS8EG',
      'toolu_01PXWPLDAbi5gZ4tSUF4Q4Jy',
    ]);
    expect(toolMsgs[0].content).toMatch(
      /^<tool_result name="search_knowledge">.*R\$ 129,00.*<\/tool_result>$/
    );
    expect(second.tools).toHaveLength(1);
  });

  it('falls back to a tool-less call on the real "no tool support" 404', async () => {
    fetchMock
      .mockResolvedValueOnce(
        fixtureResponse('error-404-tools-unsupported.json')
      )
      .mockResolvedValueOnce(fixtureResponse('chat-completion.json'));
    const out = await generateReply({
      config: CONFIG,
      systemPrompt: 's',
      messages: [{ role: 'user', content: USER_MSG }],
      tools: [searchKnowledgeTool as never],
      toolContext: CTX,
    });
    expect(out.toolsDisabled).toBe('unsupported');
    expect(out.text.length).toBeGreaterThan(0);
    const retry = JSON.parse(fetchMock.mock.calls[1][1].body as string);
    expect(retry).not.toHaveProperty('tools');
  });

  it('without tools it is still a single call with the old request body', async () => {
    fetchMock.mockResolvedValueOnce(fixtureResponse('chat-completion.json'));
    const out = await generateReply({
      config: CONFIG,
      systemPrompt: 's',
      messages: [{ role: 'user', content: 'Oi' }],
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(
      JSON.parse(fetchMock.mock.calls[0][1].body as string)
    ).not.toHaveProperty('tools');
    expect(out.steps).toBeUndefined();
    expect(out.toolCalls).toBeUndefined();
  });
});
