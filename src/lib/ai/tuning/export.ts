import type { SupabaseClient } from '@supabase/supabase-js';
import { maskAndLimit } from './mask';
import {
  EXAMPLES_MAX_APPROVED,
  EXAMPLE_CUSTOMER_MAX_CHARS,
  EXAMPLE_RESPONSE_MAX_CHARS,
  TuningError,
} from './types';

// ============================================================
// Dataset export (SPEC 089 F7): the approved examples as JSONL in chat
// format, for whoever wants to train a model OUTSIDE the product (D-19: the
// product itself trains nothing). Admin only (the route gates it).
//
// "No unmasked data" is enforced twice: the table only ever holds masked
// text, and every line is masked AGAIN here (idempotent), so even a row
// that reached the table some other way cannot leave in the clear. The
// number of lines that changed on the second pass is reported, so a
// non-zero value is visible as the symptom it is.
// ============================================================

/** One training line in the OpenAI-style chat format. */
export interface DatasetLine {
  messages: { role: 'system' | 'user' | 'assistant'; content: string }[];
}

export interface DatasetExport {
  jsonl: string;
  count: number;
  /** Lines whose text changed when masked a second time (should be 0). */
  remasked: number;
}

export interface BuildDatasetArgs {
  rows: { customer_message: string; ideal_response: string }[];
  /** The account's system prompt, as the first message of every line. Omit
   *  for a dataset without it. It is masked like the rest. */
  systemPrompt?: string | null;
}

/** Pure: the JSONL for a list of approved rows. */
export function buildDataset(args: BuildDatasetArgs): DatasetExport {
  const system = args.systemPrompt?.trim()
    ? maskAndLimit(args.systemPrompt, 8000)
    : null;
  const lines: string[] = [];
  let remasked = 0;
  for (const row of args.rows) {
    const user = maskAndLimit(row.customer_message, EXAMPLE_CUSTOMER_MAX_CHARS);
    const assistant = maskAndLimit(
      row.ideal_response,
      EXAMPLE_RESPONSE_MAX_CHARS
    );
    if (!user || !assistant) continue;
    if (user !== row.customer_message.trim()) remasked++;
    else if (assistant !== row.ideal_response.trim()) remasked++;
    const line: DatasetLine = {
      messages: [
        ...(system ? [{ role: 'system' as const, content: system }] : []),
        { role: 'user', content: user },
        { role: 'assistant', content: assistant },
      ],
    };
    // JSON.stringify never emits a raw newline, so one object = one line.
    lines.push(JSON.stringify(line));
  }
  return {
    jsonl: lines.length > 0 ? `${lines.join('\n')}\n` : '',
    count: lines.length,
    remasked,
  };
}

/** The account's approved examples as a JSONL dataset. */
export async function exportDataset(
  db: SupabaseClient,
  accountId: string,
  opts: { systemPrompt?: string | null } = {}
): Promise<DatasetExport> {
  const { data, error } = await db
    .from('ai_examples')
    .select('customer_message, ideal_response')
    .eq('account_id', accountId)
    .eq('status', 'approved')
    .order('created_at', { ascending: true })
    .limit(EXAMPLES_MAX_APPROVED);
  if (error) {
    console.error(
      '[ai tuning] export failed:',
      (error as { code?: string }).code
    );
    throw new TuningError('database_error', 'Database error.');
  }
  return buildDataset({
    rows: (data ?? []) as {
      customer_message: string;
      ideal_response: string;
    }[],
    systemPrompt: opts.systemPrompt,
  });
}
