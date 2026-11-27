import { supabaseAdmin } from './admin-client';
import { loadAiConfig } from './config';
import { buildConversationContext } from './context';
import { composeAgentTurn } from './compose';
import { documentIdsOf, toolUsageOf, turnSources } from './sources';
import { generateReply } from './generate';
import { buildAgentHandoffSummary, buildHandoffSummary } from './handoff';
import { findDisallowedLinks } from './output-guard';
import { getTool } from './tools/registry';
import { partialOf } from './types';
import { logAiUsage } from './usage';
import { engineSendText } from '@/lib/flows/meta-send';
import { checkRateLimit, RATE_LIMITS } from '@/lib/rate-limit';
import { isAssignableMember } from '@/lib/inbox/assignment';
import { isAccountBlocked } from '@/lib/platform/blocked';
import { hasAiFeature } from './plan-gate';

interface DispatchArgs {
  /** Tenancy key — drives config, contact, and whatsapp_config lookups. */
  accountId: string;
  conversationId: string;
  contactId: string;
  /** The account's WhatsApp config owner, used for the outbound send's
   *  audit columns (mirrors how the flow runner passes it through). */
  configOwnerUserId: string;
}

/**
 * AI auto-reply for a freshly-arrived inbound message.
 *
 * Invoked from the WhatsApp webhook's `after()` block, only when no
 * deterministic flow consumed the message (flows win). Mirrors the flow
 * runner's contract: it owns its try/catch and NEVER throws — a failing
 * or slow LLM call must not affect the webhook's 200 to Meta.
 *
 * Eligibility gates (any → silent no-op):
 *   - AI off / auto-reply disabled for the account
 *   - a human agent is assigned (they own the thread)
 *   - auto-reply was disabled for this conversation (prior handoff)
 *   - the per-conversation reply cap is reached
 *   - there's nothing to reply to
 *
 * The 24h WhatsApp session window is inherently open here — we're
 * reacting to a customer message that just landed — so no separate
 * window check is needed.
 */
export async function dispatchInboundToAiReply(
  args: DispatchArgs
): Promise<void> {
  const { accountId, conversationId, contactId, configOwnerUserId } = args;

  try {
    const db = supabaseAdmin();

    // SPEC 062 §4.3 ponto 5. Chegamos aqui a partir de uma mensagem
    // RECEBIDA, que por D-9 continua entrando com a conta bloqueada —
    // então sem esta linha o robô da conta bloqueada segue conversando
    // com o cliente final como se nada tivesse acontecido. Primeira
    // checagem da função: mais barata que carregar a config de IA e
    // evita gastar token de LLM por uma conta que não pode responder.
    if (await isAccountBlocked(db, accountId)) return;

    // SPEC 089 D-20: `ai_enabled` em modo estrito. Plano sem a chave = IA
    // desligada para a conta; checado antes de carregar a config e de
    // gastar token.
    if (!(await hasAiFeature(accountId, db))) return;

    const config = await loadAiConfig(db, accountId);
    if (!config || !config.autoReplyEnabled) return;

    // Deterministic, user-configured responders win over the LLM — the
    // caller already excludes messages a Flow consumed. Message-level
    // automations (`new_message_received` / `keyword_match`) are
    // dispatched independently for this same inbound and may send their
    // own reply, so if the account has any active one we stand down to
    // avoid double-texting the customer. (Relationship triggers like
    // `first_inbound_message` don't count — they're not per-message
    // auto-responders.)
    const { data: autoResponders } = await db
      .from('automations')
      .select('id')
      .eq('account_id', accountId)
      .eq('is_active', true)
      .in('trigger_type', ['new_message_received', 'keyword_match'])
      .limit(1);
    if (autoResponders && autoResponders.length > 0) return;

    const { data: conv, error: convErr } = await db
      .from('conversations')
      .select('assigned_agent_id, ai_autoreply_disabled, ai_reply_count')
      .eq('id', conversationId)
      .maybeSingle();
    if (convErr || !conv) return;
    if (conv.assigned_agent_id) return; // a human owns this thread
    if (conv.ai_autoreply_disabled) return; // handed off / turned off here
    // Cheap early-out; the authoritative cap check is the atomic claim
    // below (this read can race a concurrent inbound).
    if (conv.ai_reply_count >= config.autoReplyMaxPerConversation) return;

    const messages = await buildConversationContext(db, conversationId);
    if (messages.length === 0) return;

    // Account-wide throttle on the shared BYO key. The per-conversation
    // cap bounds one thread; this bounds a burst across many threads (a
    // marketing blast landing 200 replies at once) so we never run the
    // owner's key past the provider's rate limit. Over the limit → skip
    // the auto-reply; the inbound still sits in the inbox for a human.
    const acctLimit = checkRateLimit(
      `ai-autoreply:${accountId}`,
      RATE_LIMITS.aiAutoReplyAccount
    );
    if (!acctLimit.success) {
      console.warn(
        `[ai auto-reply] account ${accountId} hit the per-account rate limit — skipping this inbound.`
      );
      return;
    }

    // One assembly point for the turn: knowledge (best-effort), channel
    // and system prompt (SPEC 089 P-7).
    const turn = await composeAgentTurn({
      db,
      accountId,
      config,
      mode: 'auto_reply',
      messages,
      conversationId,
    });

    // Atomically claim a reply slot: the cap check + increment happen in
    // one UPDATE, so concurrent inbounds can never overshoot the cap. If
    // another inbound just took the last slot, `claimed` is false and we
    // skip the turn. We consume a slot slightly before the send lands —
    // fail-safe: under-reply rather than over-reply.
    const claimSlot = async (): Promise<boolean> => {
      const { data: claimed, error: claimErr } = await db.rpc(
        'claim_ai_reply_slot',
        {
          conversation_id: conversationId,
          max_replies: config.autoReplyMaxPerConversation,
        }
      );
      if (claimErr) {
        // A real error here (vs. losing the cap race) is almost always a
        // deploy issue — e.g. `claim_ai_reply_slot` not EXECUTE-able by the
        // service role, or the migration not applied. Log it loudly: a
        // silent return makes "auto-reply never fires" undiagnosable.
        console.error('[ai auto-reply] claim_ai_reply_slot failed:', claimErr);
        return false;
      }
      return claimed === true; // false = lost the per-conversation cap race
    };

    // The model can't (or shouldn't) answer — stop auto-replying on this
    // thread and hand it to a human. We (a) pause the bot here (sticky until
    // re-enabled), (b) route the conversation to the configured handoff
    // agent — null leaves it in the shared queue — and (c) leave a short
    // internal note so whoever picks it up has context. Assigning fires the
    // `on_conversation_assigned` trigger, which notifies the agent.
    const handOff = async (summary: string): Promise<void> => {
      const update: Record<string, unknown> = {
        ai_autoreply_disabled: true,
        ai_handoff_summary: summary,
      };
      // Only set the assignee when a target is configured AND the thread
      // isn't already owned — never stomp an existing human assignment.
      //
      // ⚠️ E só quando o destino ainda é elegível (SPEC 041, F-41-A).
      // `db` é service role, e `handoffAgentId` vem da config da IA —
      // gravada uma vez, nunca revalidada. Se aquele agente saiu da
      // conta (ou virou `viewer`), atribuir a ele tira a conversa da
      // fila e a esconde de todos, justamente no momento em que a IA
      // desistiu e um humano precisa assumir. Destino inválido degrada
      // para "handoff sem dono": a conversa fica na fila, visível.
      let assignTo: string | null = null;
      if (config.handoffAgentId && !conv.assigned_agent_id) {
        const eligible = await isAssignableMember(
          db,
          accountId,
          config.handoffAgentId
        );
        if (eligible) {
          assignTo = config.handoffAgentId;
        } else {
          console.warn(
            '[ai] handoff agent is no longer an eligible member — leaving the conversation in the queue',
            { conversationId, handoffAgentId: config.handoffAgentId }
          );
        }
      }
      await db.from('conversations').update(update).eq('id', conversationId);
      // `conv` was read before a turn of up to 60 s: a human may have taken
      // the thread since. Assign only if it is STILL unowned (SPEC 089 F8).
      if (assignTo) {
        await db
          .from('conversations')
          .update({ assigned_agent_id: assignTo })
          .eq('id', conversationId)
          .is('assigned_agent_id', null);
      }
    };

    // SPEC 089 F8: eligibility (no human, bot not paused) was read once,
    // before a turn of up to 60 s. A human may have taken the thread, or a
    // concurrent turn may have handed it off, in the meantime. Re-read right
    // before sending; the slot RPC (migration 110) checks the same.
    const stillOurs = async (): Promise<boolean> => {
      const { data: now, error } = await db
        .from('conversations')
        .select('assigned_agent_id, ai_autoreply_disabled')
        .eq('id', conversationId)
        .eq('account_id', accountId)
        .maybeSingle();
      if (error || !now) return false;
      return !now.assigned_agent_id && !now.ai_autoreply_disabled;
    };

    // SPEC 089 D-17: with tools on, the slot is claimed BEFORE the agent
    // loop. A tool can change the CRM, and losing the race AFTER that would
    // leave the side effect with no reply sent (or a reply sent twice by two
    // inbounds that both acted). A turn that ends in a handoff keeps the
    // slot spent: we prefer to reply too little. Without tools nothing is
    // written, so the claim stays after generation, as it always was.
    const claimBeforeLoop = turn.tools.length > 0;
    if (claimBeforeLoop && !(await claimSlot())) return;

    // With tools on this runs the agent loop (SPEC 089 F4/F5); a turn that
    // uses its 4 steps, or in which the model calls `handoff_to_human`,
    // comes back as a handoff.
    let result: Awaited<ReturnType<typeof generateReply>>;
    try {
      result = await generateReply({
        config,
        systemPrompt: turn.systemPrompt,
        messages: turn.messages,
        tools: turn.tools,
        toolContext: turn.toolContext,
        fallbackSystemPrompt: turn.fallbackSystemPrompt,
      });
    } catch (err) {
      // A turn that fails midway has already spent tokens and made tool
      // calls (the quota of tool calls depends on them): record what
      // happened, then let the outer handler swallow the error as before.
      const partial = partialOf(err);
      if (partial) {
        await logAiUsage(db, {
          accountId,
          conversationId,
          mode: 'auto_reply',
          provider: config.provider,
          model: config.model,
          usage: partial.usage,
          steps: partial.steps,
          toolCalls: partial.toolCalls.length,
        });
        // A WRITE already landed (or may have: a timed-out one can still
        // finish) but no answer will go out. Staying silent would leave the
        // CRM changed, the customer unanswered and nobody told, and the next
        // turn would not see what was done: hand the thread to a human.
        // The risk comes from the trace (the tool OFFERED under that name):
        // `getTool` only knows the built-in catalog, so an account HTTP tool
        // that wrote was missed before (SPEC 089 F8).
        const wrote = partial.toolCalls.some(
          (t) =>
            (t.risk ?? getTool(t.name)?.risk) === 'write' &&
            (t.status === 'ok' ||
              t.error === 'tool_timeout' ||
              t.outcomeUnknown === true)
        );
        if (wrote) {
          await handOff(
            buildHandoffSummary({
              messages,
              replyCount: conv.ai_reply_count ?? 0,
            })
          );
          return;
        }
      }
      throw err;
    }
    const { text, handoff, usage } = result;

    // Record token spend on the account's BYO key. Fire-and-forget so it
    // never adds latency to the customer-facing send: `logAiUsage`
    // swallows its own errors, so the floating promise can't reject.
    // Logged regardless of handoff — the provider call happened either
    // way.
    void logAiUsage(db, {
      accountId,
      conversationId,
      mode: 'auto_reply',
      provider: config.provider,
      model: config.model,
      usage,
      knowledgeDocumentIds: documentIdsOf(
        turnSources(turn.sources, result.toolSources)
      ),
      ...toolUsageOf(result),
    });

    if (handoff || !text) {
      // The model's own reason and summary when it handed off through the
      // tool (F5); the deterministic summary otherwise (no second LLM call).
      await handOff(
        result.handoffRequest
          ? buildAgentHandoffSummary({
              ...result.handoffRequest,
              replyCount: conv.ai_reply_count ?? 0,
            })
          : buildHandoffSummary({
              messages,
              replyCount: conv.ai_reply_count ?? 0,
            })
      );
      return;
    }

    // SPEC 089 F8: nobody reviews an auto-reply before it goes out. A link
    // the business never wrote (not in its instructions, knowledge excerpts
    // or approved examples) may be a poisoned document or tool result
    // carrying the customer's data out: hold the reply, hand off. Only the
    // count is logged (the link itself may carry personal data).
    const heldLinks = findDisallowedLinks(text, [turn.systemPrompt]);
    if (heldLinks.length > 0) {
      console.warn('[ai auto-reply] reply held: link not from the business', {
        conversationId,
        links: heldLinks.length,
      });
      await handOff(
        buildHandoffSummary({
          messages,
          replyCount: conv.ai_reply_count ?? 0,
        })
      );
      return;
    }

    if (!claimBeforeLoop && !(await claimSlot())) return;
    if (!(await stillOurs())) return;

    await engineSendText({
      accountId,
      userId: configOwnerUserId,
      conversationId,
      contactId,
      text,
      aiGenerated: true,
    });
  } catch (err) {
    console.error('[ai auto-reply] dispatch failed:', err);
  }
}
