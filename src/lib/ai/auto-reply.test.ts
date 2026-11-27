import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AiError, type AiConfig } from './types';

// Shared, hoisted mock state so the module mocks can close over it.
const h = vi.hoisted(() => ({
  loadAiConfig: vi.fn(),
  buildConversationContext: vi.fn(),
  retrieveKnowledge: vi.fn(),
  generateReply: vi.fn(),
  engineSendText: vi.fn(),
  hasAiFeature: vi.fn(),
  state: {
    conv: null as Record<string, unknown> | null,
    autoResponders: [] as { id: string }[],
    claim: true as boolean,
    updatePayload: null as Record<string, unknown> | null,
    rpcCalls: [] as { name: string; args: unknown }[],
    /**
     * Resultado da checagem de elegibilidade do agente de handoff
     * (`profiles` filtrada por conta + papel). `null` = aquele uuid não
     * é mais membro elegível — o motor deve deixar a conversa na fila
     * em vez de escondê-la (SPEC 041, F-41-A).
     */
    eligibleProfile: null as { user_id: string } | null,
    /**
     * `resolveChannelTypeForConversation` (SPEC 049 §5.6) reads
     * `conversations.channel_id` then `channels.type`. `null` on either
     * degrades to `whatsapp_cloud` — the default in every test that
     * doesn't set these explicitly.
     */
    conversationChannelId: null as string | null,
    channelType: null as string | null,
    /** SPEC 062 §4.3 ponto 5 — conta bloqueada não auto-responde. */
    accountBlockedAt: null as string | null,
    /** Linhas gravadas em `ai_usage_log` (uso, inclusive o parcial). */
    usageInserts: [] as Record<string, unknown>[],
    /** Ordem dos eventos do turno (a vaga vem antes do laço, D-17). */
    order: [] as string[],
  },
}));

vi.mock('./config', () => ({ loadAiConfig: h.loadAiConfig }));
vi.mock('./context', () => ({
  buildConversationContext: h.buildConversationContext,
}));
vi.mock('./knowledge', () => ({ retrieveKnowledge: h.retrieveKnowledge }));
vi.mock('./generate', () => ({ generateReply: h.generateReply }));
vi.mock('./plan-gate', () => ({ hasAiFeature: h.hasAiFeature }));
vi.mock('@/lib/flows/meta-send', () => ({ engineSendText: h.engineSendText }));
vi.mock('./admin-client', () => ({
  supabaseAdmin: () => ({
    from: (table: string) => {
      // SPEC 062 §4.3 ponto 5: a auto-resposta confere o bloqueio da
      // conta antes de qualquer outra coisa. `h.state.accountBlockedAt`
      // deixa o caso bloqueado testável.
      if (table === 'accounts') {
        const chain = {
          select: () => chain,
          eq: () => chain,
          maybeSingle: () =>
            Promise.resolve({
              data: { blocked_at: h.state.accountBlockedAt },
              error: null,
            }),
        };
        return chain;
      }
      if (table === 'ai_usage_log') {
        return {
          insert: (row: Record<string, unknown>) => {
            h.state.usageInserts.push(row);
            return Promise.resolve({ error: null });
          },
        };
      }
      if (table === 'automations') {
        // .select().eq().eq().in().limit() → active auto-responders
        const chain = {
          select: () => chain,
          eq: () => chain,
          in: () => chain,
          limit: () =>
            Promise.resolve({ data: h.state.autoResponders, error: null }),
        };
        return chain;
      }
      if (table === 'profiles') {
        const chain = {
          select: () => chain,
          eq: () => chain,
          in: () => chain,
          maybeSingle: () =>
            Promise.resolve({ data: h.state.eligibleProfile, error: null }),
        };
        return chain;
      }
      if (table === 'channels') {
        // resolveChannelTypeForConversation: .select('type').eq('id',…)
        // .eq('account_id',…).maybeSingle()
        const chain = {
          select: () => chain,
          eq: () => chain,
          maybeSingle: () =>
            Promise.resolve({
              data: h.state.channelType ? { type: h.state.channelType } : null,
              error: null,
            }),
        };
        return chain;
      }
      // conversations — two different call shapes hit this table:
      //   1) the eligibility read (`.select('assigned_agent_id, …')
      //      .eq('id',…).maybeSingle()`) — ONE `.eq()`.
      //   2) resolveChannelTypeForConversation's channel lookup
      //      (`.select('channel_id').eq('id',…).eq('account_id',…)
      //      .maybeSingle()`) — TWO chained `.eq()` calls.
      // Both resolve to the SAME terminal `.maybeSingle()`, so a single
      // chain object that supports repeated `.eq()` answers both; which
      // fields the caller asked for doesn't matter to this fake.
      const chain = {
        select: () => chain,
        eq: () => chain,
        maybeSingle: () =>
          Promise.resolve({
            data: h.state.conv
              ? { ...h.state.conv, channel_id: h.state.conversationChannelId }
              : null,
            error: null,
          }),
      };
      return {
        ...chain,
        update: (payload: Record<string, unknown>) => {
          // Handoff writes in two steps since SPEC 089 F8 (pause + summary,
          // then the assignee only if the thread is still unowned): the
          // payloads are merged so a test sees the end state.
          const assignOnlyIfFree = 'assigned_agent_id' in payload;
          const apply = () => {
            if (assignOnlyIfFree && h.state.conv?.assigned_agent_id) return;
            h.state.updatePayload = {
              ...(h.state.updatePayload ?? {}),
              ...payload,
            };
          };
          const done = Promise.resolve({ error: null });
          return {
            eq: () => ({
              is: () => {
                apply();
                return done;
              },
              then: (
                ok: (v: { error: null }) => unknown,
                ko?: (e: unknown) => unknown
              ) => {
                apply();
                return done.then(ok, ko);
              },
            }),
          };
        },
      };
    },
    rpc: (name: string, args: unknown) => {
      h.state.rpcCalls.push({ name, args });
      h.state.order.push(`rpc:${name}`);
      return Promise.resolve({ data: h.state.claim, error: null });
    },
  }),
}));

import { dispatchInboundToAiReply } from './auto-reply';

const ARGS = {
  accountId: 'acct-1',
  conversationId: 'conv-1',
  contactId: 'contact-1',
  configOwnerUserId: 'user-1',
};

function aiConfig(overrides: Partial<AiConfig> = {}): AiConfig {
  return {
    provider: 'openai',
    model: 'gpt-test',
    apiKey: 'sk-test',
    systemPrompt: null,
    isActive: true,
    autoReplyEnabled: true,
    autoReplyMaxPerConversation: 3,
    handoffAgentId: null,
    embeddingsTarget: null,
    providerOptions: { denyDataCollection: false },
    ...overrides,
  };
}

beforeEach(() => {
  h.state.conv = {
    assigned_agent_id: null,
    ai_autoreply_disabled: false,
    ai_reply_count: 0,
  };
  h.state.autoResponders = [];
  h.state.claim = true;
  h.state.updatePayload = null;
  h.state.rpcCalls = [];
  h.state.usageInserts = [];
  h.state.order = [];
  // Por padrão o agente de handoff configurado É elegível — os testes
  // que exercitam o caminho inverso sobrescrevem isto.
  h.state.eligibleProfile = { user_id: 'agent-7' };
  h.state.conversationChannelId = null;
  h.state.channelType = null;
  h.state.accountBlockedAt = null;
  h.hasAiFeature.mockReset().mockResolvedValue(true);
  h.loadAiConfig.mockResolvedValue(aiConfig());
  h.buildConversationContext.mockResolvedValue([
    { role: 'user', content: 'hi' },
  ]);
  h.retrieveKnowledge.mockResolvedValue([]);
  h.generateReply.mockResolvedValue({ text: 'Hello!', handoff: false });
  h.engineSendText.mockResolvedValue({ whatsapp_message_id: 'm1' });
});

describe('dispatchInboundToAiReply — eligibility gates', () => {
  it('claims a slot and sends on the happy path', async () => {
    await dispatchInboundToAiReply(ARGS);
    expect(h.state.rpcCalls).toEqual([
      {
        name: 'claim_ai_reply_slot',
        args: { conversation_id: 'conv-1', max_replies: 3 },
      },
    ]);
    expect(h.engineSendText).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'conv-1', text: 'Hello!' })
    );
  });

  // SPEC 062 §4.3 ponto 5. Chegamos aqui por uma mensagem RECEBIDA, que
  // por D-9 continua entrando com a conta bloqueada — sem esta guarda o
  // robô da conta bloqueada seguiria conversando com o cliente final.
  it('não responde por conta bloqueada, e nem chega a carregar a config de IA', async () => {
    h.state.accountBlockedAt = '2026-08-27T00:00:00Z';
    await dispatchInboundToAiReply(ARGS);
    expect(h.engineSendText).not.toHaveBeenCalled();
    expect(h.loadAiConfig).not.toHaveBeenCalled();
    expect(h.state.rpcCalls).toEqual([]);
  });

  // SPEC 089 D-20: `ai_enabled` em modo estrito. Plano sem a chave = o
  // robô não responde, e a checagem vem antes de carregar a config.
  it('não responde quando o plano não tem ai_enabled (D-20), sem carregar a config', async () => {
    h.hasAiFeature.mockResolvedValue(false);
    await dispatchInboundToAiReply(ARGS);
    expect(h.hasAiFeature).toHaveBeenCalledWith('acct-1', expect.anything());
    expect(h.loadAiConfig).not.toHaveBeenCalled();
    expect(h.generateReply).not.toHaveBeenCalled();
    expect(h.engineSendText).not.toHaveBeenCalled();
    expect(h.state.rpcCalls).toEqual([]);
  });

  it('a conta bloqueada é checada antes do plano (primeira checagem)', async () => {
    h.state.accountBlockedAt = '2026-08-27T00:00:00Z';
    await dispatchInboundToAiReply(ARGS);
    expect(h.hasAiFeature).not.toHaveBeenCalled();
  });

  it('grounds the reply in retrieved knowledge', async () => {
    h.retrieveKnowledge.mockResolvedValue([
      {
        chunkId: 'c1',
        documentId: 'd1',
        title: 'Returns',
        heading: null,
        content: 'Returns accepted within 30 days.',
        distance: 0.31,
        lexicalRank: 0.1,
        score: 0.033,
        origin: 'both',
      },
    ]);
    await dispatchInboundToAiReply(ARGS);
    expect(h.retrieveKnowledge).toHaveBeenCalled();
    const systemPrompt = h.generateReply.mock.calls[0][0]
      .systemPrompt as string;
    expect(systemPrompt).toContain('Returns accepted within 30 days.');
  });

  // SPEC 089 F4: tools off by default — generateReply gets no tools, so
  // the existing behaviour (one model call) is untouched.
  it('passes no tools when the account has none on', async () => {
    await dispatchInboundToAiReply(ARGS);
    const args = h.generateReply.mock.calls[0][0];
    expect(args.tools).toEqual([]);
    expect(args.toolContext).toBeNull();
  });

  it('with tools on, binds them to the contact of the conversation row (not the webhook payload); a write tool is offered in the live auto-reply (F5)', async () => {
    h.loadAiConfig.mockResolvedValue(
      aiConfig({
        toolsConfig: {
          get_contact_profile: { enabled: true },
          add_contact_tags: { enabled: true, tagIds: [] },
        },
      })
    );
    h.state.conv = {
      ...h.state.conv,
      id: 'conv-1',
      account_id: 'acct-1',
      contact_id: 'contact-from-row',
    };
    await dispatchInboundToAiReply({
      ...ARGS,
      contactId: 'contact-from-payload',
    });
    const args = h.generateReply.mock.calls[0][0];
    expect(args.tools.map((t: { key: string }) => t.key)).toEqual([
      'get_contact_profile',
      'add_contact_tags',
    ]);
    expect(args.toolContext).toMatchObject({
      accountId: 'acct-1',
      conversationId: 'conv-1',
      contactId: 'contact-from-row',
      mode: 'auto_reply',
    });
    expect(h.engineSendText).toHaveBeenCalled();
  });

  // SPEC 089 D-17: with tools on the slot is claimed BEFORE the agent loop.
  describe('reply slot and the agent loop (SPEC 089 D-17)', () => {
    const withTools = () => {
      h.loadAiConfig.mockResolvedValue(
        aiConfig({
          toolsConfig: { add_contact_tags: { enabled: true, tagIds: [] } },
        })
      );
      // The tools are bound to the conversation row (buildToolContext).
      h.state.conv = {
        ...h.state.conv,
        id: 'conv-1',
        account_id: 'acct-1',
        contact_id: 'contact-1',
      };
    };
    const genOrdered = (result: Record<string, unknown>) =>
      h.generateReply.mockImplementation(async () => {
        h.state.order.push('generate');
        return result;
      });

    it('with tools: claims the slot, THEN runs the loop, then sends', async () => {
      withTools();
      genOrdered({ text: 'Done!', handoff: false });
      await dispatchInboundToAiReply(ARGS);
      expect(h.state.order).toEqual(['rpc:claim_ai_reply_slot', 'generate']);
      // One claim only: the slot is not claimed a second time after the loop.
      expect(
        h.state.rpcCalls.filter((c) => c.name === 'claim_ai_reply_slot')
      ).toHaveLength(1);
      expect(h.engineSendText).toHaveBeenCalledWith(
        expect.objectContaining({ text: 'Done!' })
      );
    });

    it('with tools: losing the claim race means the loop (and its writes) never runs', async () => {
      withTools();
      h.state.claim = false;
      await dispatchInboundToAiReply(ARGS);
      expect(h.generateReply).not.toHaveBeenCalled();
      expect(h.engineSendText).not.toHaveBeenCalled();
    });

    it('without tools (regression): the claim stays AFTER generation', async () => {
      genOrdered({ text: 'Hello!', handoff: false });
      await dispatchInboundToAiReply(ARGS);
      expect(h.state.order).toEqual(['generate', 'rpc:claim_ai_reply_slot']);
    });

    it('with tools: a turn that ends in a handoff keeps the slot spent', async () => {
      withTools();
      genOrdered({ text: '', handoff: true });
      await dispatchInboundToAiReply(ARGS);
      expect(h.state.order).toEqual(['rpc:claim_ai_reply_slot', 'generate']);
      expect(h.engineSendText).not.toHaveBeenCalled();
      expect(h.state.updatePayload).toMatchObject({
        ai_autoreply_disabled: true,
      });
    });

    it('handoff_to_human: the summary carries the model reason and nothing is sent', async () => {
      withTools();
      h.generateReply.mockResolvedValue({
        text: '',
        handoff: true,
        stopReason: 'handoff',
        handoffRequest: {
          reason: 'Customer wants to negotiate a discount',
          summary: 'Asked for 15% off on the Pro plan.',
        },
      });
      await dispatchInboundToAiReply(ARGS);
      expect(h.engineSendText).not.toHaveBeenCalled();
      expect(h.state.updatePayload?.ai_handoff_summary).toContain(
        'Customer wants to negotiate a discount'
      );
      expect(h.state.updatePayload?.ai_handoff_summary).toContain(
        'Asked for 15% off on the Pro plan.'
      );
    });

    it('a turn that throws midway still records what it spent', async () => {
      withTools();
      const err = new AiError('too slow', { code: 'agent_timeout' });
      err.partial = {
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
        steps: 2,
        toolCalls: [
          {
            step: 1,
            name: 'add_contact_tags',
            arguments: {},
            status: 'ok',
            durationMs: 3,
          },
        ],
      };
      h.generateReply.mockRejectedValue(err);
      await dispatchInboundToAiReply(ARGS);
      expect(h.engineSendText).not.toHaveBeenCalled();
      expect(h.state.usageInserts).toHaveLength(1);
      expect(h.state.usageInserts[0]).toMatchObject({
        account_id: 'acct-1',
        total_tokens: 15,
        steps: 2,
        tool_calls: 1,
      });
      // A write landed: the thread goes to a human, it is not left silent.
      expect(h.state.updatePayload).toMatchObject({
        ai_autoreply_disabled: true,
      });
    });

    const failing = (
      calls: {
        name: string;
        status: 'ok' | 'error';
        error?: string;
        risk?: 'read' | 'write';
        outcomeUnknown?: true;
      }[]
    ) => {
      const err = new AiError('provider down', { code: 'provider_error' });
      err.partial = {
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        steps: 1,
        toolCalls: calls.map((c) => ({
          step: 1,
          arguments: {},
          durationMs: 1,
          ...c,
        })),
      };
      return err;
    };

    it('an error after a timed-out WRITE (it may still land) also hands off', async () => {
      withTools();
      h.generateReply.mockRejectedValue(
        failing([
          { name: 'add_internal_note', status: 'error', error: 'tool_timeout' },
        ])
      );
      await dispatchInboundToAiReply(ARGS);
      expect(h.state.updatePayload).toMatchObject({
        ai_autoreply_disabled: true,
      });
      expect(h.engineSendText).not.toHaveBeenCalled();
    });

    // SPEC 089 F8: `getTool` only knows the built-in catalog, so an account
    // HTTP tool that wrote was not seen and the thread stayed silent.
    it('an error after an account HTTP WRITE (risk from the trace) also hands off', async () => {
      withTools();
      h.generateReply.mockRejectedValue(
        failing([
          {
            name: 'abrir_chamado',
            status: 'error',
            error: 'http_5xx',
            risk: 'write',
            outcomeUnknown: true,
          },
        ])
      );
      await dispatchInboundToAiReply(ARGS);
      expect(h.state.updatePayload).toMatchObject({
        ai_autoreply_disabled: true,
      });
      expect(h.engineSendText).not.toHaveBeenCalled();
    });

    it('an error after only READS or refused writes stays as before: no handoff, no send', async () => {
      withTools();
      h.generateReply.mockRejectedValue(
        failing([
          { name: 'get_contact_profile', status: 'ok' },
          {
            name: 'add_contact_tags',
            status: 'error',
            error: 'tag_not_allowed',
          },
        ])
      );
      await dispatchInboundToAiReply(ARGS);
      expect(h.state.updatePayload).toBeNull();
      expect(h.engineSendText).not.toHaveBeenCalled();
      // The spend is still recorded.
      expect(h.state.usageInserts).toHaveLength(1);
    });
  });

  it('a tool turn that hit the step limit is handed off, not sent', async () => {
    h.generateReply.mockResolvedValue({
      text: '',
      handoff: true,
      stopReason: 'step_limit',
      steps: 4,
      toolCalls: [],
    });
    await dispatchInboundToAiReply(ARGS);
    expect(h.engineSendText).not.toHaveBeenCalled();
    expect(h.state.updatePayload).toMatchObject({
      ai_autoreply_disabled: true,
    });
  });

  // SPEC 049 §5.6 — the prompt must not promise a UI the channel can't
  // render.
  describe('channel-aware prompt (SPEC 049 §5.6)', () => {
    it('QR conversation: system prompt tells the model to use numbered plain text', async () => {
      h.state.conversationChannelId = 'chan-qr-1';
      h.state.channelType = 'whatsapp_qr';

      await dispatchInboundToAiReply(ARGS);

      const systemPrompt = h.generateReply.mock.calls[0][0]
        .systemPrompt as string;
      expect(systemPrompt).toContain('cannot render buttons');
      expect(systemPrompt).toContain('numbered plain-text list');
    });

    it('Cloud conversation (or no channel resolved): prompt says nothing about the restriction', async () => {
      h.state.conversationChannelId = 'chan-cloud-1';
      h.state.channelType = 'whatsapp_cloud';

      await dispatchInboundToAiReply(ARGS);

      const systemPrompt = h.generateReply.mock.calls[0][0]
        .systemPrompt as string;
      expect(systemPrompt).not.toContain('cannot render buttons');
    });
  });

  it('stands down when an active message-level automation exists', async () => {
    h.state.autoResponders = [{ id: 'auto-1' }];
    await dispatchInboundToAiReply(ARGS);
    expect(h.generateReply).not.toHaveBeenCalled();
    expect(h.engineSendText).not.toHaveBeenCalled();
  });

  it('does not send when the atomic slot claim loses the race', async () => {
    h.state.claim = false;
    await dispatchInboundToAiReply(ARGS);
    // It still attempts the claim, but the send is skipped.
    expect(h.state.rpcCalls).toHaveLength(1);
    expect(h.engineSendText).not.toHaveBeenCalled();
  });

  it('skips when AI is off / not configured', async () => {
    h.loadAiConfig.mockResolvedValue(null);
    await dispatchInboundToAiReply(ARGS);
    expect(h.generateReply).not.toHaveBeenCalled();
    expect(h.engineSendText).not.toHaveBeenCalled();
  });

  it('skips when auto-reply is disabled for the account', async () => {
    h.loadAiConfig.mockResolvedValue(aiConfig({ autoReplyEnabled: false }));
    await dispatchInboundToAiReply(ARGS);
    expect(h.engineSendText).not.toHaveBeenCalled();
  });

  it('skips when a human agent is assigned', async () => {
    h.state.conv = {
      assigned_agent_id: 'agent-9',
      ai_autoreply_disabled: false,
      ai_reply_count: 0,
    };
    await dispatchInboundToAiReply(ARGS);
    expect(h.engineSendText).not.toHaveBeenCalled();
  });

  it('skips when auto-reply was disabled on this conversation', async () => {
    h.state.conv = {
      assigned_agent_id: null,
      ai_autoreply_disabled: true,
      ai_reply_count: 0,
    };
    await dispatchInboundToAiReply(ARGS);
    expect(h.engineSendText).not.toHaveBeenCalled();
  });

  it('skips when the per-conversation cap is reached', async () => {
    h.state.conv = {
      assigned_agent_id: null,
      ai_autoreply_disabled: false,
      ai_reply_count: 3,
    };
    await dispatchInboundToAiReply(ARGS);
    expect(h.engineSendText).not.toHaveBeenCalled();
  });

  it('skips when there is nothing to reply to', async () => {
    h.buildConversationContext.mockResolvedValue([]);
    await dispatchInboundToAiReply(ARGS);
    expect(h.generateReply).not.toHaveBeenCalled();
    expect(h.engineSendText).not.toHaveBeenCalled();
  });
});

describe('dispatchInboundToAiReply — handoff', () => {
  it('disables auto-reply, writes a summary, and does not send on handoff', async () => {
    h.generateReply.mockResolvedValue({ text: '', handoff: true });
    await dispatchInboundToAiReply(ARGS);
    expect(h.engineSendText).not.toHaveBeenCalled();
    expect(h.state.rpcCalls).toHaveLength(0);
    expect(h.state.updatePayload).toMatchObject({
      ai_autoreply_disabled: true,
    });
    expect(h.state.updatePayload?.ai_handoff_summary).toContain(
      'AI agent handed off'
    );
    // No handoff target configured → conversation left unassigned.
    expect(h.state.updatePayload).not.toHaveProperty('assigned_agent_id');
  });

  // SPEC 089 F8 — eligibility was read once, before a turn of up to 60 s.
  it('does not send when a human took the thread while the turn ran', async () => {
    h.generateReply.mockImplementation(async () => {
      h.state.conv = { ...h.state.conv, assigned_agent_id: 'human-1' };
      return { text: 'Hello!', handoff: false };
    });
    await dispatchInboundToAiReply(ARGS);
    expect(h.engineSendText).not.toHaveBeenCalled();
  });

  it('does not send when a concurrent turn handed the thread off', async () => {
    h.generateReply.mockImplementation(async () => {
      h.state.conv = { ...h.state.conv, ai_autoreply_disabled: true };
      return { text: 'Hello!', handoff: false };
    });
    await dispatchInboundToAiReply(ARGS);
    expect(h.engineSendText).not.toHaveBeenCalled();
  });

  it('a handoff never overwrites a human who took the thread during the turn', async () => {
    h.loadAiConfig.mockResolvedValue(aiConfig({ handoffAgentId: 'agent-7' }));
    h.generateReply.mockImplementation(async () => {
      h.state.conv = { ...h.state.conv, assigned_agent_id: 'human-1' };
      return { text: '', handoff: true };
    });
    await dispatchInboundToAiReply(ARGS);
    expect(h.state.updatePayload).toMatchObject({
      ai_autoreply_disabled: true,
    });
    expect(h.state.updatePayload).not.toHaveProperty('assigned_agent_id');
  });

  it('holds a reply with a link the business never wrote and hands off', async () => {
    h.generateReply.mockResolvedValue({
      text: 'Confirme aqui: https://evil.example/?e=maria@x.com',
      handoff: false,
    });
    await dispatchInboundToAiReply(ARGS);
    expect(h.engineSendText).not.toHaveBeenCalled();
    expect(h.state.updatePayload).toMatchObject({
      ai_autoreply_disabled: true,
    });
  });

  it('sends a reply whose link is in the business instructions', async () => {
    h.loadAiConfig.mockResolvedValue(
      aiConfig({ systemPrompt: 'Catálogo: https://loja.example/catalogo' })
    );
    h.generateReply.mockResolvedValue({
      text: 'Veja https://loja.example/catalogo/',
      handoff: false,
    });
    await dispatchInboundToAiReply(ARGS);
    expect(h.engineSendText).toHaveBeenCalled();
  });

  it('routes to the configured handoff agent on handoff', async () => {
    h.loadAiConfig.mockResolvedValue(aiConfig({ handoffAgentId: 'agent-7' }));
    h.generateReply.mockResolvedValue({ text: '', handoff: true });
    await dispatchInboundToAiReply(ARGS);
    expect(h.state.updatePayload).toMatchObject({
      ai_autoreply_disabled: true,
      assigned_agent_id: 'agent-7',
    });
  });

  it('leaves the conversation in the queue when the handoff agent is no longer eligible', async () => {
    // SPEC 041, F-41-A. `handoffAgentId` é gravado uma vez na config da
    // IA e nunca revalidado. Se aquele agente saiu da conta (ou virou
    // `viewer`), atribuir a ele tiraria a conversa da fila sem dar dono
    // a ninguém que possa atendê-la — ela sumiria para a conta inteira,
    // justamente quando a IA desistiu e um humano precisa assumir.
    h.loadAiConfig.mockResolvedValue(aiConfig({ handoffAgentId: 'ex-agent' }));
    h.state.eligibleProfile = null; // não é mais membro elegível
    h.generateReply.mockResolvedValue({ text: '', handoff: true });

    await dispatchInboundToAiReply(ARGS);

    // O handoff em si acontece — o que se perde é só a atribuição.
    expect(h.state.updatePayload).toMatchObject({
      ai_autoreply_disabled: true,
    });
    expect(h.state.updatePayload?.ai_handoff_summary).toBeTruthy();
    // E a conversa fica SEM dono, portanto visível na fila.
    expect(h.state.updatePayload).not.toHaveProperty('assigned_agent_id');
  });
});
