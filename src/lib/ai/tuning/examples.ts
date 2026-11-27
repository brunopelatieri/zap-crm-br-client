import type { SupabaseClient } from '@supabase/supabase-js';
import {
  EMBEDDINGS_PROVIDER_CONFIG,
  embedTexts,
  toVectorLiteral,
} from '../embeddings';
import { supabaseAdmin } from '../admin-client';
import type { EmbeddingsTarget } from '../types';
import { maskAndLimit, maskPersonalData } from './mask';
import {
  EXAMPLES_MAX_APPROVED,
  EXAMPLES_MAX_DISTANCE,
  EXAMPLES_PER_TURN,
  EXAMPLE_CUSTOMER_MAX_CHARS,
  EXAMPLE_MAX_TAGS,
  EXAMPLE_RESPONSE_MAX_CHARS,
  EXAMPLE_STATUSES,
  EXAMPLE_TAG_MAX_CHARS,
  TuningError,
  type ExampleCounts,
  type ExampleHit,
  type ExampleRow,
  type ExampleSource,
  type ExampleStatus,
} from './types';

// ============================================================
// Dynamic examples (SPEC 089 F7): list, create, review and retrieve the
// "how this business answers" examples. Everything here takes the client as
// a parameter: a panel route passes the member's client (RLS admin+), the
// capture and the turn pass the service role. Every query filters by
// `account_id` itself, so it holds with either.
//
// Only `approved` examples are ever retrieved for a prompt. Text is masked
// on EVERY write (capture, manual, edit), so the table never holds personal
// data and the export has nothing to leak.
// ============================================================

const COLUMNS =
  'id, customer_message, ideal_response, ai_draft, tags, status, source, ' +
  'conversation_id, embedding_model, created_at, updated_at, reviewed_at';

interface DbExample {
  id: string;
  customer_message: string;
  ideal_response: string;
  ai_draft: string | null;
  tags: string[] | null;
  status: ExampleStatus;
  source: ExampleSource;
  conversation_id: string | null;
  embedding_model: string | null;
  created_at: string;
  updated_at: string;
  reviewed_at: string | null;
}

/** `openai/text-embedding-3-small` and `text-embedding-3-small` are one model. */
export function normalizeEmbeddingModel(model: string | null | undefined) {
  return (model ?? '').trim().replace(/^openai\//, '');
}

function currentModel(target: EmbeddingsTarget | null | undefined) {
  return target
    ? normalizeEmbeddingModel(EMBEDDINGS_PROVIDER_CONFIG[target.provider].model)
    : null;
}

export function mapExampleRow(
  row: DbExample,
  target?: EmbeddingsTarget | null
): ExampleRow {
  const model = currentModel(target);
  return {
    id: row.id,
    customerMessage: row.customer_message,
    idealResponse: row.ideal_response,
    aiDraft: row.ai_draft,
    tags: row.tags ?? [],
    status: row.status,
    source: row.source,
    conversationId: row.conversation_id,
    // Without a current target the flag is only "has some embedding".
    embedded:
      !!row.embedding_model &&
      (model === null ||
        normalizeEmbeddingModel(row.embedding_model) === model),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    reviewedAt: row.reviewed_at,
  };
}

function dbError(error: unknown): TuningError {
  const code = (error as { code?: string } | null)?.code;
  // 42P01 / PGRST205: migration 108 not applied.
  const pending = code === '42P01' || code === 'PGRST205';
  console.error('[ai tuning] database error:', code ?? error);
  return new TuningError(
    'database_error',
    pending ? 'Migration 108 is not applied.' : 'Database error.'
  );
}

// ------------------------------------------------------------
// Input
// ------------------------------------------------------------

export interface ExampleInput {
  customerMessage?: unknown;
  idealResponse?: unknown;
  tags?: unknown;
}

function cleanTags(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of raw) {
    if (typeof t !== 'string') continue;
    const tag = maskAndLimit(t, EXAMPLE_TAG_MAX_CHARS).replace(/\s+/g, ' ');
    const key = tag.toLowerCase();
    if (!tag || seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
    if (out.length >= EXAMPLE_MAX_TAGS) break;
  }
  return out;
}

/** The masked, bounded customer message; '' when nothing is left. */
export function cleanCustomerMessage(raw: unknown): string {
  return typeof raw === 'string'
    ? maskAndLimit(raw, EXAMPLE_CUSTOMER_MAX_CHARS)
    : '';
}
export function cleanIdealResponse(raw: unknown): string {
  return typeof raw === 'string'
    ? maskAndLimit(raw, EXAMPLE_RESPONSE_MAX_CHARS)
    : '';
}

/**
 * For text an admin WRITES (manual create, edit, API): too long is an error,
 * not a silent cut (an answer chopped mid-sentence would be imitated as it
 * is). Captured text is the only place that is cut quietly.
 */
function assertFits(raw: unknown, max: number, field: string): void {
  if (typeof raw === 'string' && maskPersonalData(raw).trim().length > max) {
    throw new TuningError(
      'invalid_input',
      `${field} is too long (at most ${max} characters).`
    );
  }
}

// ------------------------------------------------------------
// Embedding
// ------------------------------------------------------------

/** The embedding of an example's customer message; null when the account
 *  has no embeddings target or the provider failed (never throws). */
export async function embedExampleMessage(
  target: EmbeddingsTarget | null | undefined,
  customerMessage: string
): Promise<{ literal: string; model: string } | null> {
  if (!target || !customerMessage.trim()) return null;
  try {
    const [vector] = await embedTexts(target, [customerMessage]);
    if (!vector) return null;
    return {
      literal: toVectorLiteral(vector),
      model: EMBEDDINGS_PROVIDER_CONFIG[target.provider].model,
    };
  } catch (err) {
    console.error('[ai tuning] example embedding failed:', err);
    return null;
  }
}

// ------------------------------------------------------------
// List / counts
// ------------------------------------------------------------

export interface ListExamplesArgs {
  status?: ExampleStatus;
  source?: ExampleSource;
  limit?: number;
  offset?: number;
}

export async function countExamples(
  db: SupabaseClient,
  accountId: string
): Promise<ExampleCounts> {
  const counts: ExampleCounts = { candidate: 0, approved: 0, rejected: 0 };
  for (const status of EXAMPLE_STATUSES) {
    const { count, error } = await db
      .from('ai_examples')
      .select('id', { count: 'exact', head: true })
      .eq('account_id', accountId)
      .eq('status', status);
    if (error) throw dbError(error);
    counts[status] = count ?? 0;
  }
  return counts;
}

export async function listExamples(
  db: SupabaseClient,
  accountId: string,
  args: ListExamplesArgs = {},
  target?: EmbeddingsTarget | null
): Promise<{ examples: ExampleRow[]; hasMore: boolean }> {
  const limit = Math.min(Math.max(args.limit ?? 50, 1), 100);
  const offset = Math.max(args.offset ?? 0, 0);
  let query = db
    .from('ai_examples')
    .select(COLUMNS)
    .eq('account_id', accountId)
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .range(offset, offset + limit);
  if (args.status) query = query.eq('status', args.status);
  if (args.source) query = query.eq('source', args.source);
  const { data, error } = await query;
  if (error) throw dbError(error);
  const rows = (data ?? []) as unknown as DbExample[];
  return {
    examples: rows.slice(0, limit).map((r) => mapExampleRow(r, target)),
    hasMore: rows.length > limit,
  };
}

async function loadExample(
  db: SupabaseClient,
  accountId: string,
  id: string
): Promise<DbExample> {
  const { data, error } = await db
    .from('ai_examples')
    .select(COLUMNS)
    .eq('id', id)
    .eq('account_id', accountId)
    .maybeSingle();
  if (error) throw dbError(error);
  if (!data) throw new TuningError('not_found', 'Example not found.');
  return data as unknown as DbExample;
}

async function approvedCount(
  db: SupabaseClient,
  accountId: string
): Promise<number> {
  const { count, error } = await db
    .from('ai_examples')
    .select('id', { count: 'exact', head: true })
    .eq('account_id', accountId)
    .eq('status', 'approved');
  if (error) throw dbError(error);
  return count ?? 0;
}

// ------------------------------------------------------------
// Create (manual) / update / review / delete
// ------------------------------------------------------------

export interface WriteContext {
  accountId: string;
  userId: string;
  /** For the embedding of an approved example; null = none (the example is
   *  saved but cannot enter a prompt until it is embedded). */
  embeddingsTarget: EmbeddingsTarget | null;
}

/**
 * An example the admin writes by hand: it is the admin's own approval, so
 * it is stored `approved` (and embedded when the account can).
 */
export async function createManualExample(
  db: SupabaseClient,
  ctx: WriteContext,
  input: ExampleInput
): Promise<ExampleRow> {
  assertFits(
    input.customerMessage,
    EXAMPLE_CUSTOMER_MAX_CHARS,
    'customer_message'
  );
  assertFits(input.idealResponse, EXAMPLE_RESPONSE_MAX_CHARS, 'ideal_response');
  const customerMessage = cleanCustomerMessage(input.customerMessage);
  const idealResponse = cleanIdealResponse(input.idealResponse);
  if (!customerMessage || !idealResponse) {
    throw new TuningError(
      'invalid_input',
      'customer_message and ideal_response are required.'
    );
  }
  if ((await approvedCount(db, ctx.accountId)) >= EXAMPLES_MAX_APPROVED) {
    throw new TuningError(
      'limit_reached',
      `An account keeps at most ${EXAMPLES_MAX_APPROVED} approved examples.`
    );
  }
  const embedding = await embedExampleMessage(
    ctx.embeddingsTarget,
    customerMessage
  );
  const now = new Date().toISOString();
  const { data, error } = await db
    .from('ai_examples')
    .insert({
      account_id: ctx.accountId,
      customer_message: customerMessage,
      ideal_response: idealResponse,
      tags: cleanTags(input.tags),
      status: 'approved',
      source: 'manual',
      embedding: embedding?.literal ?? null,
      embedding_model: embedding?.model ?? null,
      created_by: ctx.userId,
      reviewed_by: ctx.userId,
      reviewed_at: now,
    })
    .select(COLUMNS)
    .single();
  if (error) throw dbError(error);
  return mapExampleRow(data as unknown as DbExample, ctx.embeddingsTarget);
}

export interface ExamplePatch extends ExampleInput {
  status?: unknown;
}

/**
 * Edit and/or review one example. Approving embeds the customer message
 * (best effort: an approved example without an embedding is saved and shown
 * as "not embedded"); rejecting or reopening drops the vector, because only
 * approved examples are ever searched. Changing the message of an approved
 * example re-embeds it.
 */
export async function updateExample(
  db: SupabaseClient,
  ctx: WriteContext,
  id: string,
  patch: ExamplePatch
): Promise<ExampleRow> {
  const current = await loadExample(db, ctx.accountId, id);
  const update: Record<string, unknown> = {};

  let nextStatus = current.status;
  if (patch.status !== undefined) {
    if (
      typeof patch.status !== 'string' ||
      !(EXAMPLE_STATUSES as readonly string[]).includes(patch.status)
    ) {
      throw new TuningError('invalid_input', 'Invalid status.');
    }
    nextStatus = patch.status as ExampleStatus;
  }

  let message = current.customer_message;
  if (patch.customerMessage !== undefined) {
    assertFits(
      patch.customerMessage,
      EXAMPLE_CUSTOMER_MAX_CHARS,
      'customer_message'
    );
    message = cleanCustomerMessage(patch.customerMessage);
    if (!message) {
      throw new TuningError('invalid_input', 'customer_message is empty.');
    }
    update.customer_message = message;
  }
  if (patch.idealResponse !== undefined) {
    assertFits(
      patch.idealResponse,
      EXAMPLE_RESPONSE_MAX_CHARS,
      'ideal_response'
    );
    const response = cleanIdealResponse(patch.idealResponse);
    if (!response) {
      throw new TuningError('invalid_input', 'ideal_response is empty.');
    }
    update.ideal_response = response;
  }
  if (patch.tags !== undefined) update.tags = cleanTags(patch.tags);

  const becomesApproved =
    nextStatus === 'approved' && current.status !== 'approved';
  if (
    becomesApproved &&
    (await approvedCount(db, ctx.accountId)) >= EXAMPLES_MAX_APPROVED
  ) {
    throw new TuningError(
      'limit_reached',
      `An account keeps at most ${EXAMPLES_MAX_APPROVED} approved examples.`
    );
  }

  const messageChanged = message !== current.customer_message;
  if (nextStatus === 'approved') {
    if (becomesApproved || messageChanged) {
      const embedding = await embedExampleMessage(
        ctx.embeddingsTarget,
        message
      );
      update.embedding = embedding?.literal ?? null;
      update.embedding_model = embedding?.model ?? null;
    }
  } else {
    // Only approved examples are searched: drop the vector.
    update.embedding = null;
    update.embedding_model = null;
  }

  if (nextStatus !== current.status) {
    update.status = nextStatus;
    update.reviewed_by = ctx.userId;
    update.reviewed_at = new Date().toISOString();
  }

  if (Object.keys(update).length === 0) {
    return mapExampleRow(current, ctx.embeddingsTarget);
  }
  update.updated_at = new Date().toISOString();

  const { data, error } = await db
    .from('ai_examples')
    .update(update)
    .eq('id', id)
    .eq('account_id', ctx.accountId)
    .select(COLUMNS);
  if (error) throw dbError(error);
  const row = (data ?? [])[0] as unknown as DbExample | undefined;
  // RLS refusing silently comes back as zero rows.
  if (!row) throw new TuningError('not_found', 'Example not found.');
  return mapExampleRow(row, ctx.embeddingsTarget);
}

export async function approveExample(
  db: SupabaseClient,
  ctx: WriteContext,
  id: string
): Promise<ExampleRow> {
  return updateExample(db, ctx, id, { status: 'approved' });
}

export async function rejectExample(
  db: SupabaseClient,
  ctx: WriteContext,
  id: string
): Promise<ExampleRow> {
  return updateExample(db, ctx, id, { status: 'rejected' });
}

export async function deleteExample(
  db: SupabaseClient,
  accountId: string,
  id: string
): Promise<void> {
  const { data, error } = await db
    .from('ai_examples')
    .delete()
    .eq('id', id)
    .eq('account_id', accountId)
    .select('id');
  if (error) throw dbError(error);
  if (!data || data.length === 0) {
    throw new TuningError('not_found', 'Example not found.');
  }
}

/**
 * Embed the approved examples that cannot be searched yet (never embedded,
 * or embedded with another model). Returns how many got a vector and how
 * many failed. Throws `ai_not_configured` without a target.
 */
export async function embedPendingExamples(
  db: SupabaseClient,
  ctx: WriteContext
): Promise<{ embedded: number; failed: number }> {
  if (!ctx.embeddingsTarget) {
    throw new TuningError(
      'ai_not_configured',
      'The account has no embeddings key.'
    );
  }
  const model = currentModel(ctx.embeddingsTarget);
  const { data, error } = await db
    .from('ai_examples')
    .select('id, customer_message, embedding_model')
    .eq('account_id', ctx.accountId)
    .eq('status', 'approved')
    .limit(EXAMPLES_MAX_APPROVED);
  if (error) throw dbError(error);
  const pending = (
    (data ?? []) as {
      id: string;
      customer_message: string;
      embedding_model: string | null;
    }[]
  ).filter((r) => normalizeEmbeddingModel(r.embedding_model) !== model);

  let embedded = 0;
  let failed = 0;
  for (const row of pending) {
    const embedding = await embedExampleMessage(
      ctx.embeddingsTarget,
      row.customer_message
    );
    if (!embedding) {
      failed++;
      continue;
    }
    const { error: upErr } = await db
      .from('ai_examples')
      .update({
        embedding: embedding.literal,
        embedding_model: embedding.model,
        updated_at: new Date().toISOString(),
      })
      .eq('id', row.id)
      .eq('account_id', ctx.accountId)
      .eq('status', 'approved');
    if (upErr) failed++;
    else embedded++;
  }
  return { embedded, failed };
}

// ------------------------------------------------------------
// Retrieval for a turn
// ------------------------------------------------------------

export interface ExampleSearch {
  examples: ExampleHit[];
  /** The account has no approved, embedded example (nothing was searched). */
  none: boolean;
  /** The search could not run (no embeddings target, embedding or database
   *  failure): `examples` is empty because nothing was searched. */
  failed: boolean;
}

export interface RetrieveExamplesOptions {
  k?: number;
  maxDistance?: number;
}

/** The service-role client when it is configured, else the caller's. */
function existenceDb(db: SupabaseClient): SupabaseClient {
  try {
    return supabaseAdmin();
  } catch {
    return db;
  }
}

/**
 * The approved examples most similar to `queryText` (the same query as the
 * knowledge retrieval, D-13). BEST EFFORT, like the knowledge base: every
 * failure gives zero examples and never throws, so a broken example search
 * can never stop a reply.
 *
 * One cheap COUNT first (an account with no approved example pays nothing
 * more), then one query embedding and one RPC.
 */
export async function searchExamples(
  db: SupabaseClient,
  accountId: string,
  config: { embeddingsTarget?: EmbeddingsTarget | null },
  queryText: string,
  opts: RetrieveExamplesOptions = {}
): Promise<ExampleSearch> {
  const none: ExampleSearch = { examples: [], none: true, failed: false };
  const failed: ExampleSearch = { examples: [], none: false, failed: true };
  const query = queryText.trim();
  const k = Math.min(opts.k ?? EXAMPLES_PER_TURN, 5);
  if (!query || k <= 0) return none;
  try {
    // The existence check runs with the service role: a draft or playground
    // turn comes in with the member's own RLS client, and `ai_examples` is
    // readable by admin+ only, so an agent's client would always count 0 and
    // never get an example. It only yields a number for the code (the
    // account id comes from an already authorized route); the examples
    // themselves come from the SECURITY DEFINER RPC, which checks membership.
    const { count, error } = await existenceDb(db)
      .from('ai_examples')
      .select('id', { count: 'exact', head: true })
      .eq('account_id', accountId)
      .eq('status', 'approved')
      .not('embedding_model', 'is', null);
    if (error) return failed;
    if (!count) return none;
  } catch {
    return failed;
  }

  const target = config.embeddingsTarget;
  if (!target) return failed;
  const embedding = await embedExampleMessage(target, query);
  if (!embedding) return failed;

  try {
    // Service role here too (SPEC 089 F8, migration 110): the RPC now only
    // answers an admin SESSION, like the `ai_examples` table, and the draft
    // of an agent must still get the examples. The account id comes from an
    // already authorized route or from the engine, never from the caller.
    const { data, error } = await existenceDb(db).rpc('match_ai_examples', {
      p_account_id: accountId,
      p_query_embedding: embedding.literal,
      p_embedding_model: embedding.model,
      p_match_count: k,
      p_max_distance: opts.maxDistance ?? EXAMPLES_MAX_DISTANCE,
    });
    if (error || !Array.isArray(data)) {
      console.error('[ai tuning] example retrieval failed:', error);
      return failed;
    }
    const examples = (data as Record<string, unknown>[])
      .map(mapMatchRow)
      .filter((e): e is ExampleHit => e !== null)
      .slice(0, k);
    return { examples, none: false, failed: false };
  } catch (err) {
    console.error('[ai tuning] example retrieval threw:', err);
    return failed;
  }
}

/** Map one `match_ai_examples` row; null when malformed. */
export function mapMatchRow(row: Record<string, unknown>): ExampleHit | null {
  if (
    typeof row?.id !== 'string' ||
    typeof row.customer_message !== 'string' ||
    typeof row.ideal_response !== 'string'
  ) {
    return null;
  }
  return {
    id: row.id,
    customerMessage: row.customer_message,
    idealResponse: row.ideal_response,
    distance: typeof row.distance === 'number' ? row.distance : 0,
  };
}

/** Convenience for `compose.ts`: the hits only; never throws. */
export async function retrieveExamples(
  db: SupabaseClient,
  accountId: string,
  config: { embeddingsTarget?: EmbeddingsTarget | null },
  queryText: string,
  opts: RetrieveExamplesOptions = {}
): Promise<ExampleHit[]> {
  try {
    return (await searchExamples(db, accountId, config, queryText, opts))
      .examples;
  } catch {
    return [];
  }
}
