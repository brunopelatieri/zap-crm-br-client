// ============================================================
// POST/DELETE /api/platform/users/[userId]/block — SPEC 062 §6
//
//   POST   { reason?: string }  → bloqueia a pessoa
//   DELETE                      → desbloqueia
//
// Bloquear o DONO de uma conta é permitido (§4.4) — é o caminho para
// credencial comprometida, e a UI avisa que a conta ficará sem dono
// ativo. O que é barrado, aqui e na tela, é o proprietário da
// plataforma bloquear o próprio usuário.
// ============================================================

import { NextResponse } from 'next/server';

import { requirePlatformOwner } from '@/lib/platform/owner';
import { loadOwnerSelfRefs } from '@/lib/platform/owner-profile';
import { canBlockUser } from '@/lib/platform/guards';
import { blockUser, unblockUser } from '@/lib/platform/block';
import { supabaseAdmin } from '@/lib/supabase/admin';

const NOT_FOUND = NextResponse.json({ error: 'Not found' }, { status: 404 });

async function loadTargetEmail(
  db: ReturnType<typeof supabaseAdmin>,
  userId: string
): Promise<string | null> {
  const { data } = await db
    .from('profiles')
    .select('email')
    .eq('user_id', userId)
    .maybeSingle();
  return (data?.email as string) ?? null;
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ userId: string }> }
) {
  let ownerEmail: string;
  let ownerUserId: string;
  try {
    const ctx = await requirePlatformOwner();
    ownerEmail = ctx.email;
    ownerUserId = ctx.userId;
  } catch {
    return NOT_FOUND;
  }

  const { userId } = await params;
  const db = supabaseAdmin();

  const body = (await request.json().catch(() => null)) as {
    reason?: unknown;
  } | null;
  const reason =
    typeof body?.reason === 'string' && body.reason.trim() !== ''
      ? body.reason.trim()
      : null;

  const [self, targetEmail] = await Promise.all([
    loadOwnerSelfRefs(db, ownerUserId),
    loadTargetEmail(db, userId),
  ]);

  const guard = canBlockUser({
    ownerEmail,
    ownerUserId: self.ownerUserId,
    target: { userId, email: targetEmail },
  });
  if (!guard.ok) {
    return NextResponse.json(
      { error: 'You cannot block yourself', code: guard.reason },
      { status: 400 }
    );
  }

  const result = await blockUser(db, { ownerEmail }, userId, reason);
  if (!result.ok) {
    return result.error === 'not_found'
      ? NextResponse.json({ error: 'User not found' }, { status: 404 })
      : NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }

  return NextResponse.json({ blocked: true });
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ userId: string }> }
) {
  let ownerEmail: string;
  try {
    const ctx = await requirePlatformOwner();
    ownerEmail = ctx.email;
  } catch {
    return NOT_FOUND;
  }

  const { userId } = await params;

  // Mesma razão da rota de conta: desbloquear é o movimento inverso do
  // que a guarda protege, e nunca é barrado.
  const result = await unblockUser(supabaseAdmin(), { ownerEmail }, userId);
  if (!result.ok) {
    return result.error === 'not_found'
      ? NextResponse.json({ error: 'User not found' }, { status: 404 })
      : NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }

  return NextResponse.json({ blocked: false });
}
