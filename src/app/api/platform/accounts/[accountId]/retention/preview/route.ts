// ============================================================
// POST /api/platform/accounts/[accountId]/retention/preview
// (SPEC 062 §6, §7.5, F7 — herdeira de SPEC 060 §4.1)
//
// "Ver o que seria removido" — sobre os limites AINDA NÃO SALVOS que
// estão no formulário, para a conta escolhida. `p_dry_run: true` na
// MESMA função que a varredura de verdade usa, nunca uma segunda
// implementação do predicado (que divergiria da que apaga de fato).
//
// A prévia é o item nº 1 da §8.2 da SPEC 060 e não podia se perder na
// virada de dono: salvar sem antes ver o impacto continua sendo a forma
// mais provável de perder histórico.
// ============================================================

import { NextResponse } from 'next/server';

import { requirePlatformOwner } from '@/lib/platform/owner';
import { loadMergedRetentionDefaults } from '@/lib/platform/retention-defaults';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { CHANNEL_TYPES, type ChannelType } from '@/lib/channels/types';
import { resolveEffectivePolicy } from '@/lib/retention/policy';
import { parseRetentionLimitInput } from '@/lib/retention/validate';
import type { RetentionPurgeResult } from '@/lib/retention/types';

const NOT_FOUND = NextResponse.json({ error: 'Not found' }, { status: 404 });

function isChannelType(value: unknown): value is ChannelType {
  return (
    typeof value === 'string' &&
    (CHANNEL_TYPES as readonly string[]).includes(value)
  );
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ accountId: string }> }
) {
  try {
    await requirePlatformOwner();
  } catch {
    return NOT_FOUND;
  }

  const { accountId } = await params;
  const body = await request.json().catch(() => null);

  if (!body || !isChannelType(body.channelType)) {
    return NextResponse.json(
      { error: 'channelType must be one of: ' + CHANNEL_TYPES.join(', ') },
      { status: 400 }
    );
  }
  const channelType: ChannelType = body.channelType;

  const maxMessages = parseRetentionLimitInput(body.maxMessages);
  const retentionDays = parseRetentionLimitInput(body.retentionDays);
  const maxFavorites = parseRetentionLimitInput(body.maxFavorites);
  if (!maxMessages.valid || !retentionDays.valid || !maxFavorites.valid) {
    return NextResponse.json(
      { error: 'Limits must be empty or a non-negative integer' },
      { status: 400 }
    );
  }

  const db = supabaseAdmin();

  // Cadeia completa da §5.3 — a prévia PRECISA resolver contra os mesmos
  // `defaults` que `sweep.ts` resolve, ou ela promete um número e a
  // varredura apaga outro (§12 item 15).
  let defaults;
  try {
    defaults = await loadMergedRetentionDefaults(db);
  } catch (err) {
    console.error('[platform retention preview] defaults failed:', err);
    return NextResponse.json(
      { error: 'Failed to compute preview' },
      { status: 500 }
    );
  }

  const effective = resolveEffectivePolicy(
    {
      maxMessages: maxMessages.value,
      retentionDays: retentionDays.value,
      maxFavorites: maxFavorites.value,
    },
    defaults[channelType]
  );

  const { data, error } = await db.rpc('purge_channel_messages', {
    p_account_id: accountId,
    p_channel_type: channelType,
    p_max_messages: effective.maxMessages,
    p_retention_days: effective.retentionDays,
    p_max_favorites: effective.maxFavorites,
    p_min_age_hours: defaults.minAgeHours,
    p_batch_limit: defaults.batchLimit,
    p_dry_run: true,
  });

  if (error) {
    console.error('[platform retention preview] rpc failed:', error.message);
    return NextResponse.json(
      { error: 'Failed to compute preview' },
      { status: 500 }
    );
  }

  return NextResponse.json({ result: data as RetentionPurgeResult });
}
