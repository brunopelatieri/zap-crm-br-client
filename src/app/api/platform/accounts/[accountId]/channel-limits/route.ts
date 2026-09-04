// ============================================================
// /api/platform/accounts/[accountId]/channel-limits — SPEC 069 F10.
//
// A porta que o `ChannelLimitsPanel` (navegador) chama de verdade —
// sessão do proprietário via `requirePlatformOwner()`, nunca segredo
// no cliente. Chama a MESMA `lib/platform/channel-limits-actions.ts`
// que `/api/admin/accounts/[accountId]/channel-limits` chama, e grava
// `platform_audit_log` a mais — o mesmo par que `plan.ts`/`.../plan`
// já estabeleceu (ver o cabeçalho daquele arquivo).
// ============================================================

import { NextResponse } from 'next/server';

import { requirePlatformOwner } from '@/lib/platform/owner';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { consoleActorTag, writePlatformAudit } from '@/lib/platform/audit';
import {
  applyChannelLimits,
  loadChannelLimits,
  type ChannelLimitsPatch,
} from '@/lib/platform/channel-limits-actions';

const NOT_FOUND = NextResponse.json({ error: 'Not found' }, { status: 404 });

type Params = { params: Promise<{ accountId: string }> };

export async function GET(_request: Request, { params }: Params) {
  try {
    await requirePlatformOwner();
  } catch {
    return NOT_FOUND;
  }
  const { accountId } = await params;

  try {
    const snapshot = await loadChannelLimits(supabaseAdmin(), accountId);
    return NextResponse.json(snapshot);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Internal error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function PUT(request: Request, { params }: Params) {
  let ownerEmail: string;
  try {
    const ctx = await requirePlatformOwner();
    ownerEmail = ctx.email;
  } catch {
    return NOT_FOUND;
  }
  const { accountId } = await params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const patch = body as ChannelLimitsPatch;
  const result = await applyChannelLimits(accountId, patch);
  if (!result.ok) {
    return NextResponse.json(
      { error: result.error },
      { status: result.status }
    );
  }

  await writePlatformAudit(supabaseAdmin(), {
    actor: consoleActorTag(ownerEmail),
    action: 'channel_limits.update',
    accountId,
    payload: { account: patch.account ?? {}, instances: patch.instances ?? {} },
  });

  return NextResponse.json({ ok: true });
}
