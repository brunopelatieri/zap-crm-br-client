import type { ChatMessage } from './types';

/** Longest the quoted customer message runs before we ellipsize it —
 *  keeps the internal note to a glanceable one-liner. */
const MAX_QUOTE_LEN = 160;

/**
 * Build the short internal note the auto-reply bot leaves on a
 * conversation when it hands off to a human. Deterministic — composed
 * from context we already have (no extra LLM call / token spend), so it
 * can't fail or add latency to the handoff.
 *
 * Reads as, e.g.:
 *   "🤖 AI agent handed off after 2 replies. Last customer message:
 *    “can I speak to a manager about my refund?”"
 *
 * `replyCount` is the bot's auto-reply tally for the thread (0 when it
 * bailed on the very first inbound without answering).
 */
export function buildHandoffSummary(args: {
  messages: ChatMessage[];
  replyCount: number;
}): string {
  const { messages, replyCount } = args;

  const lastCustomer = [...messages]
    .reverse()
    .find((m) => m.role === 'user' && m.content.trim());

  const replies =
    replyCount === 0
      ? 'without replying'
      : `after ${replyCount} ${replyCount === 1 ? 'reply' : 'replies'}`;

  const base = `🤖 AI agent handed off ${replies}.`;

  if (!lastCustomer) return base;

  const quote = truncate(lastCustomer.content.trim(), MAX_QUOTE_LEN);
  return `${base} Last customer message: “${quote}”`;
}

/**
 * The summary when the MODEL handed off through `handoff_to_human` (SPEC 089
 * F5): its own short reason and summary for the team, after the same
 * "handed off after N replies" lead as the deterministic one. Model-written
 * and shown to staff as plain text; cut so it stays a glanceable note.
 */
export function buildAgentHandoffSummary(args: {
  reason: string;
  summary: string;
  replyCount: number;
}): string {
  const { reason, summary, replyCount } = args;
  const replies =
    replyCount === 0
      ? 'without replying'
      : `after ${replyCount} ${replyCount === 1 ? 'reply' : 'replies'}`;
  const why = truncate(reason, 200);
  const what = truncate(summary, 500);
  const body = what === why ? why : `${why} — ${what}`;
  // Written by the model after reading the customer's messages: it can
  // echo what the customer asked it to say, so staff must not read it as
  // a verification (a claim like "approved by finance" is just text).
  return `🤖 AI agent handed off ${replies}. [AI-written from the customer's messages, unverified] ${body}`;
}

function truncate(text: string, max: number): string {
  const collapsed = text.replace(/\s+/g, ' ');
  if (collapsed.length <= max) return collapsed;
  return `${collapsed.slice(0, max - 1).trimEnd()}…`;
}
