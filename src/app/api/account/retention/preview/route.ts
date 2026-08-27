// ============================================================
// POST /api/account/retention/preview — "Ver o que seria removido"
// (SPEC 060 §4.1, §7, F5)
//
// Só Proprietário. Recebe os limites AINDA NÃO SALVOS do formulário e
// devolve o que `purge_channel_messages` removeria se eles fossem
// salvos agora — `p_dry_run: true`, mesma função que a varredura de
// verdade usa (068 §4.1), nunca uma segunda implementação do predicado
// que poderia divergir da que apaga de fato.
//
// A prévia NÃO chama a função direto do navegador (ela está REVOKE'd
// de `authenticated`, §4.2) — passa por aqui, que já resolveu quem é o
// chamador via `requireRole('owner')` e injeta o `account_id` dele
// antes de usar `supabaseAdmin()`.
// ============================================================

import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { CHANNEL_TYPES, type ChannelType } from '@/lib/channels/types';
import { readRetentionDefaults } from '@/lib/retention/defaults';
import { resolveEffectivePolicy } from '@/lib/retention/policy';
import { parseRetentionLimitInput } from '@/lib/retention/validate';
import type { RetentionPurgeResult } from '@/lib/retention/types';

function isChannelType(value: unknown): value is ChannelType {
  return (
    typeof value === 'string' &&
    (CHANNEL_TYPES as readonly string[]).includes(value)
  );
}

export async function POST(request: Request) {
  try {
    const ctx = await requireRole('owner');
    const body = await request.json().catch(() => null);

    if (!body || !isChannelType(body.channelType)) {
      return NextResponse.json(
        { error: 'channelType must be one of: ' + CHANNEL_TYPES.join(', ') },
        { status: 400 }
      );
    }

    const maxMessages = parseRetentionLimitInput(body.maxMessages);
    const retentionDays = parseRetentionLimitInput(body.retentionDays);
    const maxFavorites = parseRetentionLimitInput(body.maxFavorites);
    if (!maxMessages.valid || !retentionDays.valid || !maxFavorites.valid) {
      return NextResponse.json(
        { error: 'Limits must be empty or a non-negative integer' },
        { status: 400 }
      );
    }

    const defaults = readRetentionDefaults(process.env);
    const effective = resolveEffectivePolicy(
      {
        maxMessages: maxMessages.value,
        retentionDays: retentionDays.value,
        maxFavorites: maxFavorites.value,
      },
      defaults[body.channelType as ChannelType]
    );

    const admin = supabaseAdmin();
    const { data, error } = await admin.rpc('purge_channel_messages', {
      p_account_id: ctx.accountId,
      p_channel_type: body.channelType,
      p_max_messages: effective.maxMessages,
      p_retention_days: effective.retentionDays,
      p_max_favorites: effective.maxFavorites,
      p_min_age_hours: defaults.minAgeHours,
      p_batch_limit: defaults.batchLimit,
      p_dry_run: true,
    });

    if (error) {
      console.error('[retention preview] rpc failed:', error.message);
      return NextResponse.json(
        { error: 'Failed to compute preview' },
        { status: 500 }
      );
    }

    return NextResponse.json({ result: data as RetentionPurgeResult });
  } catch (err) {
    return toErrorResponse(err);
  }
}
