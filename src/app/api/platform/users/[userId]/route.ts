// ============================================================
// PATCH /api/platform/users/[userId] — SPEC 078 §5, §8
//
//   Edita nome e/ou e-mail de qualquer usuário, inclusive o dono da
//   conta. Corpo: { fullName?, email?, reason? }. A troca de e-mail é
//   imediata e já confirmada (D-10). Guardas, ordem das escritas e
//   efeitos vivem em `editUserIdentity`.
// ============================================================

import { isUuid } from '@/lib/api/uuid';
import { notFoundResponse, toResponse } from '@/lib/platform/console-result';
import { requirePlatformOwner } from '@/lib/platform/owner';
import { editUserIdentity } from '@/lib/platform/user-identity-console';
import { supabaseAdmin } from '@/lib/supabase/admin';

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ userId: string }> }
) {
  let ownerEmail: string;
  try {
    ownerEmail = (await requirePlatformOwner()).email;
  } catch {
    return notFoundResponse();
  }

  const { userId } = await params;
  if (!isUuid(userId)) return notFoundResponse();

  const body = (await request.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;

  return toResponse(
    await editUserIdentity(supabaseAdmin(), { userId, ownerEmail, body })
  );
}
