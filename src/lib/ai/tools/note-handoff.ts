import { resolveAuditUserId } from '@/lib/api/v1/contacts';
import { insertContactNotes } from '@/lib/ingest/notes';
import { asObject, readString } from './input';
import { guardWrite, simulated } from './write-support';
import type { AgentTool, ParseResult, ToolContext, ToolResult } from './types';

// ============================================================
// add_internal_note and handoff_to_human (SPEC 089 F5).
//
// Both are bound to the conversation: the note goes on `ctx.contactId` (the
// contact of the conversation row) and the handoff on the conversation the
// engine is running in — the model names neither.
// ============================================================

/** Prefix that marks a note written by the agent (the team sees who wrote it). */
const NOTE_PREFIX = '🤖 [AI, unverified] ';

async function contactExists(ctx: ToolContext): Promise<boolean> {
  if (!ctx.contactId) return false;
  const { data, error } = await ctx.db
    .from('contacts')
    .select('id')
    .eq('id', ctx.contactId)
    .eq('account_id', ctx.accountId)
    .maybeSingle();
  return !error && !!data;
}

// ------------------------------------------------------------
// add_internal_note
// ------------------------------------------------------------

function parseNote(input: unknown): ParseResult<{ note: string }> {
  const obj = asObject(input);
  if (!obj.ok) return obj;
  const note = readString(obj.value, 'note', { required: true, max: 2000 });
  if (!note.ok) return note;
  return { ok: true, value: { note: note.value as string } };
}

async function addNote(
  ctx: ToolContext,
  input: { note: string }
): Promise<ToolResult> {
  const blocked = guardWrite(ctx);
  if (blocked) return blocked;
  if (ctx.dryRun) return simulated('add_internal_note', input);

  if (!(await contactExists(ctx)))
    return { ok: false, error: 'contact_not_found' };
  try {
    const userId = await resolveAuditUserId(ctx.db, ctx.accountId);
    await insertContactNotes(ctx.db, {
      accountId: ctx.accountId,
      userId,
      contactId: ctx.contactId as string,
      notes: [`${NOTE_PREFIX}${input.note}`],
    });
  } catch (err) {
    console.error('[ai tools] add_internal_note failed:', err);
    return { ok: false, error: 'update_failed' };
  }
  return {
    ok: true,
    data: { status: 'ok' },
    // The note text never goes to the activity log (it may hold personal data).
    activity: {
      action: 'ai.tool_note_added',
      metadata: { length: input.note.length },
    },
  };
}

export const addInternalNoteTool: AgentTool<{ note: string }> = {
  key: 'add_internal_note',
  description:
    'Leave an internal note about the customer in this conversation, visible only to the business team (never to the customer).',
  inputSchema: {
    type: 'object',
    properties: { note: { type: 'string', maxLength: 2000 } },
    required: ['note'],
    additionalProperties: false,
  },
  risk: 'write',
  parse: parseNote,
  handler: addNote,
};

// ------------------------------------------------------------
// handoff_to_human
// ------------------------------------------------------------

interface HandoffInput {
  reason: string;
  summary?: string;
}

function parseHandoff(input: unknown): ParseResult<HandoffInput> {
  const obj = asObject(input);
  if (!obj.ok) return obj;
  const reason = readString(obj.value, 'reason', { required: true, max: 300 });
  if (!reason.ok) return reason;
  const summary = readString(obj.value, 'summary', { max: 600 });
  if (!summary.ok) return summary;
  return {
    ok: true,
    value: {
      reason: reason.value as string,
      ...(summary.value ? { summary: summary.value } : {}),
    },
  };
}

async function handoff(
  ctx: ToolContext,
  input: HandoffInput
): Promise<ToolResult> {
  const blocked = guardWrite(ctx);
  if (blocked) return blocked;

  // The caller (auto-reply) performs the handoff when the turn ends: it
  // pauses the bot on the conversation, leaves the summary and assigns the
  // configured agent. The tool only records the request and ends the turn.
  ctx.turnState.handoff = {
    reason: input.reason,
    summary: input.summary ?? input.reason,
  };

  if (ctx.dryRun) {
    const sim = simulated('handoff_to_human', input);
    return sim.ok ? { ...sim, endTurn: 'handoff' } : sim;
  }
  return {
    ok: true,
    data: {
      status: 'ok',
      note: 'The conversation is being handed to a human.',
    },
    endTurn: 'handoff',
    activity: {
      action: 'ai.tool_handoff',
      // No free text in the label: the reason is written from what the
      // customer said and this line outlives the contact. Only its length.
      metadata: { reason_length: input.reason.length },
    },
  };
}

export const handoffToHumanTool: AgentTool<HandoffInput> = {
  key: 'handoff_to_human',
  description:
    'Hand this conversation over to a human on the team, with a short reason and a short summary for them. Use it when the customer asks for a person, is upset, or needs something you cannot or may not do. The turn ends after this call.',
  inputSchema: {
    type: 'object',
    properties: {
      reason: { type: 'string', maxLength: 300 },
      summary: {
        type: 'string',
        description: 'What the human needs to know to continue.',
        maxLength: 600,
      },
    },
    required: ['reason'],
    additionalProperties: false,
  },
  risk: 'write',
  parse: parseHandoff,
  handler: handoff,
};
