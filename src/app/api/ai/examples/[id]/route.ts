import { NextResponse } from 'next/server';
import { loadEmbeddingsTarget } from '@/lib/ai/config';
import { supabaseAdmin } from '@/lib/ai/admin-client';
import { deleteExample, updateExample } from '@/lib/ai/tuning/examples';
import {
  UUID_RE,
  badRequest,
  readJson,
  tuningErrorResponse,
  tuningGuard,
} from '@/lib/ai/tuning/route-helpers';

type Params = { params: Promise<{ id: string }> };

/**
 * PATCH /api/ai/examples/[id]  (admin+)
 *   { status?: 'candidate'|'approved'|'rejected', customer_message?,
 *     ideal_response?, tags? }  → { example, embedded }
 *
 * Review and/or edit one example. Approving embeds the customer message
 * (`embedded: false` in the answer = approved but not searchable yet);
 * rejecting or reopening drops the vector.
 */
export async function PATCH(request: Request, { params }: Params) {
  try {
    const g = await tuningGuard('ai-examples-write');
    if (!g.ok) return g.response;
    const { id } = await params;
    if (!UUID_RE.test(id)) return badRequest('Invalid id.');
    const body = await readJson(request);
    if (!body) return badRequest('Invalid JSON body.');

    const { target } = await loadEmbeddingsTarget(supabaseAdmin(), g.accountId);
    const example = await updateExample(
      g.supabase,
      {
        accountId: g.accountId,
        userId: g.userId,
        embeddingsTarget: target,
      },
      id,
      {
        status: body.status,
        customerMessage: body.customer_message,
        idealResponse: body.ideal_response,
        tags: body.tags,
      }
    );
    return NextResponse.json({ example, embedded: example.embedded });
  } catch (err) {
    return tuningErrorResponse(err);
  }
}

/** DELETE /api/ai/examples/[id]  (admin+) */
export async function DELETE(_request: Request, { params }: Params) {
  try {
    const g = await tuningGuard('ai-examples-write');
    if (!g.ok) return g.response;
    const { id } = await params;
    if (!UUID_RE.test(id)) return badRequest('Invalid id.');
    await deleteExample(g.supabase, g.accountId, id);
    return NextResponse.json({ success: true });
  } catch (err) {
    return tuningErrorResponse(err);
  }
}
