// ============================================================
// /api/admin/accounts/[accountId]/channel-limits — SPEC 069 §6.6, F10.
//
//   GET — os limites de segurança da conta (nível 1a) e, por
//         instância, os overrides próprios (nível 1b) — com o nível de
//         origem e o teto duro.
//   PUT — grava overrides. `null` remove (volta a herdar); um número
//         é o valor próprio; `0` bloqueia o eixo (D-6). Acima do teto
//         duro é `400`, nunca clamp silencioso (D-7).
//
// Protegida por PLATFORM_ADMIN_SECRET — mesmo padrão de
// .../[accountId]/plan. É a porta para script/curl; o navegador usa
// `/api/platform/accounts/[accountId]/channel-limits` (sessão do
// proprietário) — as duas chamam `lib/platform/channel-limits-actions.ts`,
// nunca duas cópias da lógica.
// ============================================================

import { NextResponse } from 'next/server';

import { requirePlatformAdminSecret } from '@/lib/auth/platform-admin';
import { supabaseAdmin } from '@/lib/supabase/admin';
import {
  applyChannelLimits,
  loadChannelLimits,
  type ChannelLimitsPatch,
} from '@/lib/platform/channel-limits-actions';

type Params = { params: Promise<{ accountId: string }> };

export async function GET(request: Request, { params }: Params) {
  const denied = requirePlatformAdminSecret(request);
  if (denied) return denied;
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
  const denied = requirePlatformAdminSecret(request);
  if (denied) return denied;
  const { accountId } = await params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const result = await applyChannelLimits(
    accountId,
    body as ChannelLimitsPatch
  );
  if (!result.ok) {
    return NextResponse.json(
      { error: result.error },
      { status: result.status }
    );
  }
  return NextResponse.json({ ok: true });
}
