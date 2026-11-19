// POST /api/forms/[id]/unpublish — SPEC 085 §4.5 / §7.1 (admin+)
// Despublicar: o link some na próxima requisição; respostas ficam.
import { toErrorResponse } from '@/lib/auth/account';
import { requireFormsRole, runTransition } from '@/lib/forms/account-api';

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await requireFormsRole('admin');
    const { id } = await params;
    return await runTransition(ctx, id, {
      from: ['published'],
      patch: { status: 'draft' },
      action: 'form.unpublished',
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
