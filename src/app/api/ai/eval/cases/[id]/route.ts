import { NextResponse } from 'next/server';
import { deleteCase, updateCase } from '@/lib/ai/tuning/eval';
import {
  UUID_RE,
  badRequest,
  readJson,
  tuningErrorResponse,
  tuningGuard,
} from '@/lib/ai/tuning/route-helpers';

type Params = { params: Promise<{ id: string }> };

/** PATCH /api/ai/eval/cases/[id]  (admin+) — same fields as the POST. */
export async function PATCH(request: Request, { params }: Params) {
  try {
    const g = await tuningGuard('ai-eval-cases-write');
    if (!g.ok) return g.response;
    const { id } = await params;
    if (!UUID_RE.test(id)) return badRequest('Invalid id.');
    const body = await readJson(request);
    if (!body) return badRequest('Invalid JSON body.');
    const updated = await updateCase(g.supabase, g.accountId, id, {
      title: body.title,
      conversation: body.conversation,
      expectHandoff: body.expect_handoff,
      expectedNotes: body.expected_notes,
    });
    return NextResponse.json({ case: updated });
  } catch (err) {
    return tuningErrorResponse(err);
  }
}

/** DELETE /api/ai/eval/cases/[id]  (admin+) — past runs keep their snapshot. */
export async function DELETE(_request: Request, { params }: Params) {
  try {
    const g = await tuningGuard('ai-eval-cases-write');
    if (!g.ok) return g.response;
    const { id } = await params;
    if (!UUID_RE.test(id)) return badRequest('Invalid id.');
    await deleteCase(g.supabase, g.accountId, id);
    return NextResponse.json({ success: true });
  } catch (err) {
    return tuningErrorResponse(err);
  }
}
