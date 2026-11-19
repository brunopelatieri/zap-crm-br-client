// POST /api/forms/[id]/restore — SPEC 085 §4.5 / §7.1 (admin+)
// Restaurar volta a rascunho e CHECA a quota `forms` (trigger → 409 `QUOTA_EXCEEDED`).
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
      from: ['archived'],
      patch: { status: 'draft', archived_at: null },
      action: 'form.restored',
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
