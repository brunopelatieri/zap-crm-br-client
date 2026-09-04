import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/supabase/admin';

/**
 * POST /api/evolution/harvested/ignore (admin+) — SPEC 069 §6.5.
 *
 * `service_role` porque a triagem não tem policy de escrita nenhuma
 * (migração 078 §5) — o papel admin+ já foi conferido por
 * `requireRole`, e o filtro `account_id` abaixo é quem impede ignorar
 * a triagem de outra conta.
 */
export async function POST(request: Request) {
  try {
    const { accountId } = await requireRole('admin');

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
    }
    const { ids } = body as { ids?: unknown };
    if (
      !Array.isArray(ids) ||
      ids.length === 0 ||
      !ids.every((id) => typeof id === 'string' && id)
    ) {
      return NextResponse.json(
        { error: 'ids must be a non-empty array of strings' },
        { status: 400 }
      );
    }

    const admin = supabaseAdmin();
    const { data, error } = await admin
      .from('evolution_harvested_contacts')
      .update({ status: 'ignored' })
      .eq('account_id', accountId)
      .eq('status', 'new')
      .in('id', ids)
      .select('id');

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ ignored: data?.length ?? 0 });
  } catch (err) {
    return toErrorResponse(err);
  }
}
