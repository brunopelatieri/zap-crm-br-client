import { NextResponse } from 'next/server';
import { loadEmbeddingsTarget } from '@/lib/ai/config';
import { supabaseAdmin } from '@/lib/ai/admin-client';
import {
  countExamples,
  createManualExample,
  listExamples,
} from '@/lib/ai/tuning/examples';
import {
  badRequest,
  readJson,
  tuningErrorResponse,
  tuningGuard,
} from '@/lib/ai/tuning/route-helpers';
import {
  EXAMPLE_SOURCES,
  EXAMPLE_STATUSES,
  EXAMPLES_MAX_APPROVED,
  EXAMPLES_MAX_CANDIDATES,
  type ExampleSource,
  type ExampleStatus,
} from '@/lib/ai/tuning/types';

/**
 * GET /api/ai/examples  (admin+)
 *   ?status=candidate|approved|rejected  &source=manual|draft_edit|handoff_reply
 *   &limit=50 &offset=0
 *   → { examples, has_more, counts, embeddings_available, limits }
 *
 * The dynamic examples of the account (SPEC 089 F7). Only `approved` ones
 * reach a prompt; `embeddings_available` says whether the account can embed
 * them at all (without an embeddings key an approved example is saved but
 * never retrieved).
 */
export async function GET(request: Request) {
  try {
    const g = await tuningGuard('ai-examples-list');
    if (!g.ok) return g.response;

    const url = new URL(request.url);
    const status = url.searchParams.get('status');
    const source = url.searchParams.get('source');
    if (status && !(EXAMPLE_STATUSES as readonly string[]).includes(status)) {
      return badRequest('Invalid status filter.');
    }
    if (source && !(EXAMPLE_SOURCES as readonly string[]).includes(source)) {
      return badRequest('Invalid source filter.');
    }
    const limit = Number(url.searchParams.get('limit') ?? 50);
    const offset = Number(url.searchParams.get('offset') ?? 0);

    const { target } = await loadEmbeddingsTarget(supabaseAdmin(), g.accountId);
    const [list, counts] = await Promise.all([
      listExamples(
        g.supabase,
        g.accountId,
        {
          status: (status as ExampleStatus | null) ?? undefined,
          source: (source as ExampleSource | null) ?? undefined,
          limit: Number.isFinite(limit) ? limit : 50,
          offset: Number.isFinite(offset) ? offset : 0,
        },
        target
      ),
      countExamples(g.supabase, g.accountId),
    ]);
    return NextResponse.json({
      examples: list.examples,
      has_more: list.hasMore,
      counts,
      embeddings_available: !!target,
      limits: {
        max_approved: EXAMPLES_MAX_APPROVED,
        max_candidates: EXAMPLES_MAX_CANDIDATES,
      },
    });
  } catch (err) {
    return tuningErrorResponse(err);
  }
}

/**
 * POST /api/ai/examples  (admin+)
 *   { customer_message, ideal_response, tags? }  → { example }
 *
 * An example written by hand: it is the admin's own approval, so it is
 * stored `approved` (and embedded when the account has an embeddings key).
 * Text is masked of personal data before it is stored.
 */
export async function POST(request: Request) {
  try {
    const g = await tuningGuard('ai-examples-write');
    if (!g.ok) return g.response;
    const body = await readJson(request);
    if (!body) return badRequest('Invalid JSON body.');

    const { target } = await loadEmbeddingsTarget(supabaseAdmin(), g.accountId);
    const example = await createManualExample(
      g.supabase,
      {
        accountId: g.accountId,
        userId: g.userId,
        embeddingsTarget: target,
      },
      {
        customerMessage: body.customer_message,
        idealResponse: body.ideal_response,
        tags: body.tags,
      }
    );
    return NextResponse.json({ example }, { status: 201 });
  } catch (err) {
    return tuningErrorResponse(err);
  }
}
