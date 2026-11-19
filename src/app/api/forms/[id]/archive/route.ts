// POST /api/forms/[id]/archive — SPEC 085 §4.5 / §7.1 (admin+)
// Arquivar despublica e sai da quota `forms`; mantém respostas e arquivos.
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
      from: ['draft', 'published'],
      patch: { status: 'archived', archived_at: new Date().toISOString() },
      action: 'form.archived',
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
