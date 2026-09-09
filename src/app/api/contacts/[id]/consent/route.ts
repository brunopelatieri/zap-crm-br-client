// ============================================================
// PATCH /api/contacts/[id]/consent — SPEC 075 F4 (follow-up)
//
// O toggle manual de opt-in/opt-out (SPEC 044 §6.8) precisa rodar no
// servidor: `setContactOptIn` grava a atividade via `recordActivity`,
// que SEMPRE usa `supabaseAdmin()` (service_role) internamente — e
// service_role nunca pode rodar no browser (AGENTS.md, tabela de
// clientes Supabase). A RPC em si (`set_contact_opt_in`, SECURITY
// INVOKER) continua indo pelo cliente de SESSÃO (`ctx.supabase`), então
// a RLS de `contacts` segue sendo quem decide se este contato pode ser
// alterado — esta rota só move o registro de atividade para onde ele
// pode de fato escrever.
// ============================================================

import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { setContactOptIn } from '@/lib/contacts/consent';

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  let ctx;
  try {
    ctx = await requireRole('agent');
  } catch (err) {
    return toErrorResponse(err);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const status = (body as { status?: unknown } | null)?.status;
  if (status !== 'opted_in' && status !== 'opted_out') {
    return NextResponse.json(
      { error: 'status must be "opted_in" or "opted_out"' },
      { status: 400 }
    );
  }

  try {
    const result = await setContactOptIn(ctx.supabase, {
      contactId: id,
      status,
      source: 'manual',
      accountId: ctx.accountId,
      actorUserId: ctx.userId,
    });
    return NextResponse.json({ result });
  } catch (err) {
    console.error('[contacts/consent] update failed:', err);
    return NextResponse.json(
      { error: 'Could not update consent' },
      { status: 500 }
    );
  }
}
