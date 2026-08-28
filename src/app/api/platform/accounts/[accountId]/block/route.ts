// ============================================================
// POST/DELETE /api/platform/accounts/[accountId]/block — SPEC 062 §6
//
//   POST   { reason?: string }  → bloqueia a conta
//   DELETE                      → desbloqueia
//
// `requirePlatformOwner()` → 404 para qualquer chamador não autorizado
// (§2.4). O autobloqueio é barrado AQUI, e não só na UI (§4.4): o
// switch desabilitado na tela é conveniência, esta rota é a garantia —
// o proprietário que se tranca para fora só sai por SQL.
// ============================================================

import { NextResponse } from 'next/server';

import { requirePlatformOwner } from '@/lib/platform/owner';
import { loadOwnerSelfRefs } from '@/lib/platform/owner-profile';
import { canBlockAccount } from '@/lib/platform/guards';
import { blockAccount, unblockAccount } from '@/lib/platform/block';
import { supabaseAdmin } from '@/lib/supabase/admin';

const NOT_FOUND = NextResponse.json({ error: 'Not found' }, { status: 404 });

/**
 * Resolve o dono (`account_role = 'owner'`) da conta-alvo. É o segundo
 * caminho pelo qual `canBlockAccount` reconhece "esta conta é minha":
 * o primeiro é por id, e este cobre o caso de o proprietário ter perfil
 * em outra conta mas ser o dono desta.
 */
async function loadTargetOwnerEmail(
  db: ReturnType<typeof supabaseAdmin>,
  accountId: string
): Promise<string | null> {
  const { data } = await db
    .from('profiles')
    .select('email')
    .eq('account_id', accountId)
    .eq('account_role', 'owner')
    .maybeSingle();
  return (data?.email as string) ?? null;
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ accountId: string }> }
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

  const { accountId } = await params;
  const db = supabaseAdmin();

  const body = (await request.json().catch(() => null)) as {
    reason?: unknown;
  } | null;
  const reason =
    typeof body?.reason === 'string' && body.reason.trim() !== ''
      ? body.reason.trim()
      : null;

  const [self, targetOwnerEmail] = await Promise.all([
    loadOwnerSelfRefs(db, ownerUserId),
    loadTargetOwnerEmail(db, accountId),
  ]);

  const guard = canBlockAccount({
    ownerEmail,
    ownerAccountId: self.ownerAccountId,
    target: { accountId, ownerEmail: targetOwnerEmail },
  });
  if (!guard.ok) {
    return NextResponse.json(
      { error: 'You cannot block your own account', code: guard.reason },
      { status: 400 }
    );
  }

  const result = await blockAccount(db, { ownerEmail }, accountId, reason);
  if (!result.ok) {
    return result.error === 'not_found'
      ? NextResponse.json({ error: 'Account not found' }, { status: 404 })
      : NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }

  return NextResponse.json({ blocked: true });
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ accountId: string }> }
) {
  let ownerEmail: string;
  try {
    const ctx = await requirePlatformOwner();
    ownerEmail = ctx.email;
  } catch {
    return NOT_FOUND;
  }

  const { accountId } = await params;

  // Desbloquear NÃO passa por `canBlockAccount`: a guarda existe para
  // impedir que o proprietário se tranque para fora, e desbloquear é
  // exatamente o movimento inverso. Barrá-lo aqui seria transformar a
  // proteção no problema que ela previne.
  const result = await unblockAccount(
    supabaseAdmin(),
    { ownerEmail },
    accountId
  );
  if (!result.ok) {
    return result.error === 'not_found'
      ? NextResponse.json({ error: 'Account not found' }, { status: 404 })
      : NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }

  return NextResponse.json({ blocked: false });
}
