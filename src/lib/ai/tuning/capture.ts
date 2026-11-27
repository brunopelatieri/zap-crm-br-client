import type { SupabaseClient } from '@supabase/supabase-js';
import { buildConversationContext } from '../context';
import { buildRetrievalQuery } from '../query';
import type { ChatMessage } from '../types';
import { maskAndLimit, type MaskOptions } from './mask';
import {
  DRAFT_MAX_AGE_MS,
  EXAMPLES_MAX_CANDIDATES,
  EXAMPLE_CUSTOMER_MAX_CHARS,
  EXAMPLE_RESPONSE_MAX_CHARS,
  type ExampleSource,
} from './types';

// ============================================================
// Capture of human corrections (SPEC 089 F7, §7.2). Two moments make an
// answer worth reviewing as an example:
//
//   1. the attendant EDITS the AI draft before sending it (`draft_edit`);
//   2. the attendant answers a conversation the AI handed off, the first
//      human message after the handoff (`handoff_reply`).
//
// The pair (customer message, what the human wrote) becomes a CANDIDATE.
// Nothing enters a prompt until an admin approves it. Personal data is
// masked HERE, at capture: the candidate table, the draft table and the
// export only ever hold masked text.
//
// How an edit is detected reliably (the code had no link from the draft to
// the send): `/api/ai/draft` stores the masked draft in `ai_drafts` and
// returns its id; the composer sends it back as `ai_draft_id` with the
// message; `captureAfterSend` consumes the row (one use) and compares the
// masked draft with the masked text that was actually sent.
//
// Every function here is BEST EFFORT and never throws: the capture can
// never fail or delay a send. They take the service-role client (the
// attendant is not an admin and has no access to these tables).
// ============================================================

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Whitespace-collapsed, NFC, trimmed: what "the same text" means. */
export function normalizeForCompare(text: string): string {
  return text.normalize('NFC').replace(/\s+/g, ' ').trim();
}

/** The contact names to mask in a conversation's text. */
export async function loadContactNames(
  db: SupabaseClient,
  accountId: string,
  conversationId: string
): Promise<string[]> {
  try {
    const { data: conv } = await db
      .from('conversations')
      .select('contact_id')
      .eq('id', conversationId)
      .eq('account_id', accountId)
      .maybeSingle();
    const contactId = (conv as { contact_id?: string | null } | null)
      ?.contact_id;
    if (!contactId) return [];
    const { data: contact } = await db
      .from('contacts')
      .select('name')
      .eq('id', contactId)
      .eq('account_id', accountId)
      .maybeSingle();
    const name = (contact as { name?: string | null } | null)?.name;
    return name ? [name] : [];
  } catch {
    return [];
  }
}

/** The masked customer side of a pair: the customer's last messages. */
export function maskedCustomerMessage(
  messages: ChatMessage[],
  mask: MaskOptions
): string {
  return maskAndLimit(
    buildRetrievalQuery(messages),
    EXAMPLE_CUSTOMER_MAX_CHARS,
    mask
  );
}

// ------------------------------------------------------------
// Draft register (the link)
// ------------------------------------------------------------

export interface RegisterDraftArgs {
  accountId: string;
  conversationId: string;
  userId: string;
  /** The conversation the draft was generated from, oldest first. */
  messages: ChatMessage[];
  draftText: string;
}

/**
 * Store the (masked) draft the attendant is about to see and return its id.
 * Null on any failure (migration 108 not applied, database down): the draft
 * is still served, it just cannot be linked to the send.
 */
export async function registerDraft(
  db: SupabaseClient,
  args: RegisterDraftArgs
): Promise<string | null> {
  try {
    const names = await loadContactNames(
      db,
      args.accountId,
      args.conversationId
    );
    const mask = { knownNames: names };
    const customerMessage = maskedCustomerMessage(args.messages, mask);
    const draftText = maskAndLimit(
      args.draftText,
      EXAMPLE_RESPONSE_MAX_CHARS,
      mask
    );
    if (!customerMessage || !draftText) return null;
    const { data, error } = await db
      .from('ai_drafts')
      .insert({
        account_id: args.accountId,
        conversation_id: args.conversationId,
        user_id: args.userId,
        customer_message: customerMessage,
        draft_text: draftText,
      })
      .select('id')
      .single();
    if (error || !data) {
      // `details` of a CHECK / NOT NULL violation holds the failing row.
      console.error(
        '[ai tuning] draft register skipped:',
        error?.code,
        error?.message
      );
      return null;
    }
    return (data as { id: string }).id;
  } catch (err) {
    console.error('[ai tuning] draft register threw:', err);
    return null;
  }
}

// ------------------------------------------------------------
// Capture after a send
// ------------------------------------------------------------

export type CaptureOutcome =
  /** A candidate was created. */
  | { kind: 'candidate'; source: ExampleSource }
  /** The draft went out as written: nothing to learn. */
  | { kind: 'unedited' }
  /** Nothing to capture (not a draft send, not after a handoff, too short…). */
  | { kind: 'skipped'; reason: string };

export interface CaptureArgs {
  accountId: string;
  userId: string;
  conversationId: string;
  /** The message row that was just sent. */
  messageId: string;
  /** What was sent (text messages only). */
  finalText: string;
  /** The id `/api/ai/draft` returned, if the attendant used a draft. */
  aiDraftId?: string | null;
}

const skipped = (reason: string): CaptureOutcome => ({
  kind: 'skipped',
  reason,
});

async function candidateRoom(
  db: SupabaseClient,
  accountId: string
): Promise<boolean> {
  const { count, error } = await db
    .from('ai_examples')
    .select('id', { count: 'exact', head: true })
    .eq('account_id', accountId)
    .eq('status', 'candidate');
  if (error) return false;
  return (count ?? 0) < EXAMPLES_MAX_CANDIDATES;
}

async function insertCandidate(
  db: SupabaseClient,
  row: {
    accountId: string;
    userId: string;
    conversationId: string;
    messageId: string;
    source: ExampleSource;
    customerMessage: string;
    idealResponse: string;
    aiDraft?: string | null;
  }
): Promise<CaptureOutcome> {
  if (!(await candidateRoom(db, row.accountId))) return skipped('limit');
  const { error } = await db.from('ai_examples').insert({
    account_id: row.accountId,
    customer_message: row.customerMessage,
    ideal_response: row.idealResponse,
    ai_draft: row.aiDraft ?? null,
    status: 'candidate',
    source: row.source,
    conversation_id: row.conversationId,
    source_message_id: row.messageId,
    created_by: row.userId,
  });
  if (error) {
    // 23505: this message already produced a candidate (replayed send).
    if ((error as { code?: string }).code === '23505') {
      return skipped('duplicate');
    }
    // `details` of a CHECK / NOT NULL violation holds the failing row.
    console.error(
      '[ai tuning] candidate insert failed:',
      (error as { code?: string }).code,
      error.message
    );
    return skipped('database_error');
  }
  return { kind: 'candidate', source: row.source };
}

/**
 * Called by the send route after a text message went out. Never throws.
 *
 *  - With an `aiDraftId` the draft is consumed (one use). A different text
 *    is a `draft_edit` candidate; the same text is `unedited`.
 *  - Without a usable draft, the first human message after an AI handoff is
 *    a `handoff_reply` candidate.
 */
export async function captureAfterSend(
  db: SupabaseClient,
  args: CaptureArgs
): Promise<CaptureOutcome> {
  try {
    const finalText = args.finalText?.trim();
    if (!finalText) return skipped('empty');

    const hasDraft = !!args.aiDraftId && UUID_RE.test(args.aiDraftId);
    // Most outbound messages are neither an AI draft nor the reply to a
    // handoff (and most accounts have no AI at all): decide that with one
    // cheap query before doing any masking work.
    const afterHandoff = hasDraft
      ? false
      : await isFirstHumanReplyAfterHandoff(db, args);
    if (!hasDraft && !afterHandoff) return skipped('not_a_correction');

    const names = await loadContactNames(
      db,
      args.accountId,
      args.conversationId
    );
    const mask = { knownNames: names };
    const maskedFinal = maskAndLimit(
      finalText,
      EXAMPLE_RESPONSE_MAX_CHARS,
      mask
    );
    // A reply of a couple of characters ("ok", "👍") teaches nothing.
    if (maskedFinal.length < 3) return skipped('too_short');

    if (hasDraft) {
      // Atomic consume: delete returns the row, a second send finds nothing.
      const { data, error } = await db
        .from('ai_drafts')
        .delete()
        .eq('id', args.aiDraftId as string)
        .eq('account_id', args.accountId)
        .eq('conversation_id', args.conversationId)
        .eq('user_id', args.userId)
        .select('customer_message, draft_text, created_at');
      if (!error) {
        const draft = (data ?? [])[0] as
          | { customer_message: string; draft_text: string; created_at: string }
          | undefined;
        const fresh =
          draft &&
          Date.now() - new Date(draft.created_at).getTime() <= DRAFT_MAX_AGE_MS;
        if (draft && fresh) {
          if (
            normalizeForCompare(draft.draft_text) ===
            normalizeForCompare(maskedFinal)
          ) {
            return { kind: 'unedited' };
          }
          return insertCandidate(db, {
            accountId: args.accountId,
            userId: args.userId,
            conversationId: args.conversationId,
            messageId: args.messageId,
            source: 'draft_edit',
            customerMessage: draft.customer_message,
            idealResponse: maskedFinal,
            aiDraft: draft.draft_text,
          });
        }
      }
      // Draft missing, stale or already used: it may still be the reply to
      // a handoff.
      if (!(await isFirstHumanReplyAfterHandoff(db, args))) {
        return skipped('not_a_correction');
      }
    }

    const messages = await buildConversationContext(
      db,
      args.conversationId,
      10
    );
    const customerMessage = maskedCustomerMessage(messages, mask);
    if (!customerMessage) return skipped('no_customer_message');
    return insertCandidate(db, {
      accountId: args.accountId,
      userId: args.userId,
      conversationId: args.conversationId,
      messageId: args.messageId,
      source: 'handoff_reply',
      customerMessage,
      idealResponse: maskedFinal,
    });
  } catch (err) {
    console.error('[ai tuning] capture skipped:', err);
    return skipped('error');
  }
}

/**
 * True when the conversation is in an AI handoff (the bot paused and left a
 * handoff summary) and the message just sent is the first human message
 * since the last AI message. A human takeover with no handoff, and a second
 * human message, are not corrections.
 */
export async function isFirstHumanReplyAfterHandoff(
  db: SupabaseClient,
  args: Pick<CaptureArgs, 'accountId' | 'conversationId' | 'messageId'>
): Promise<boolean> {
  const { data: conv, error } = await db
    .from('conversations')
    .select('ai_autoreply_disabled, ai_handoff_summary')
    .eq('id', args.conversationId)
    .eq('account_id', args.accountId)
    .maybeSingle();
  if (error || !conv) return false;
  const c = conv as {
    ai_autoreply_disabled: boolean | null;
    ai_handoff_summary: string | null;
  };
  if (!c.ai_autoreply_disabled || !c.ai_handoff_summary) return false;

  const { data: lastAi } = await db
    .from('messages')
    .select('created_at')
    .eq('conversation_id', args.conversationId)
    .eq('ai_generated', true)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  let query = db
    .from('messages')
    .select('id', { count: 'exact', head: true })
    .eq('conversation_id', args.conversationId)
    .eq('sender_type', 'agent')
    .neq('id', args.messageId);
  const since = (lastAi as { created_at?: string } | null)?.created_at;
  if (since) query = query.gt('created_at', since);
  const { count, error: countErr } = await query;
  if (countErr) return false;
  return (count ?? 0) === 0;
}
