// POST /api/forms/[id]/publish — SPEC 085 §4.5 / §7.1 (admin+)
// Roda `validateFormForPublish` no servidor (422 `INVALID_FORM` com a lista de problemas). Só sai de rascunho; edição de formulário já publicado é salva (e validada) pelo PUT.
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
      from: ['draft'],
      patch: {
        status: 'published',
        published_at: new Date().toISOString(),
        archived_at: null,
      },
      action: 'form.published',
      validate: true,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
