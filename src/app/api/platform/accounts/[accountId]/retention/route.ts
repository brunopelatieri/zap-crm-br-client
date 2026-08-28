// ============================================================
// GET/PUT /api/platform/accounts/[accountId]/retention
// (SPEC 062 §3.8, §6, §7.5, F7)
//
// A política de UMA conta, agora configurada pelo proprietário da
// plataforma. Mesma lógica de leitura/gravação que
// `/api/account/retention` tinha na SPEC 060 — o que muda é QUEM
// autentica (`requirePlatformOwner()` em vez de `requireRole('owner')`)
// e de onde vem o `accountId` (do path, não da sessão).
//
// A diferença que importa para o resultado: os `defaults` contra os
// quais a política é resolvida são os da cadeia COMPLETA da §5.3
// (`padrão global do console → .env`), os mesmos que `sweep.ts` usa.
// Se esta tela resolvesse só contra o `.env`, a prévia mentiria em
// relação ao que a varredura apaga em seguida — o item 15 do teste
// manual (§12) existe exatamente para pegar isso.
// ============================================================

import { NextResponse } from 'next/server';

import { requirePlatformOwner } from '@/lib/platform/owner';
import { consoleActorTag, writePlatformAudit } from '@/lib/platform/audit';
import { loadMergedRetentionDefaults } from '@/lib/platform/retention-defaults';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { CHANNEL_TYPES, type ChannelType } from '@/lib/channels/types';
import {
  resolveEffectivePolicyWithSource,
  rowToPolicy,
} from '@/lib/retention/policy';
import { parseRetentionLimitInput } from '@/lib/retention/validate';
import type { RetentionPurgeResult } from '@/lib/retention/types';

const NOT_FOUND = NextResponse.json({ error: 'Not found' }, { status: 404 });

function isChannelType(value: unknown): value is ChannelType {
  return (
    typeof value === 'string' &&
    (CHANNEL_TYPES as readonly string[]).includes(value)
  );
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ accountId: string }> }
) {
  try {
    await requirePlatformOwner();
  } catch {
    return NOT_FOUND;
  }

  const { accountId } = await params;
  const db = supabaseAdmin();

  let defaults;
  try {
    defaults = await loadMergedRetentionDefaults(db);
  } catch (err) {
    console.error(
      '[GET /api/platform/accounts/[accountId]/retention] defaults failed:',
      err
    );
    return NextResponse.json(
      { error: 'Failed to load retention settings' },
      { status: 500 }
    );
  }

  const [
    { data: channelRows, error: channelsErr },
    { data: policyRows, error: policyErr },
  ] = await Promise.all([
    db.from('channels').select('type').eq('account_id', accountId),
    db
      .from('channel_retention_policies')
      .select('channel_type, max_messages, retention_days, max_favorites')
      .eq('account_id', accountId),
  ]);

  if (channelsErr || policyErr) {
    console.error(
      '[GET /api/platform/accounts/[accountId]/retention] fetch failed:',
      channelsErr || policyErr
    );
    return NextResponse.json(
      { error: 'Failed to load retention settings' },
      { status: 500 }
    );
  }

  // Os canais PRESENTES na conta (mesma regra da SPEC 060): configurar
  // retenção de um canal que ela não usa não significa nada, e a lista
  // vazia é a resposta honesta para uma conta sem canal.
  const presentTypes = Array.from(
    new Set((channelRows ?? []).map((r) => r.type as ChannelType))
  );
  const policyByType = new Map(
    (policyRows ?? []).map((r) => [r.channel_type as ChannelType, r])
  );

  const channels = await Promise.all(
    presentTypes.map(async (type) => {
      const policy = rowToPolicy(policyByType.get(type) ?? null);
      const effective = resolveEffectivePolicyWithSource(
        policy,
        defaults[type]
      );

      // O uso vem de `purge_channel_messages` com os TRÊS limites
      // `null` e `p_dry_run` — nenhuma fase roda (cada uma exige
      // `p_x > 0`), então só voltam os totais. Reaproveitar a função em
      // vez de reimplementar o JOIN em PostgREST é o que garante que o
      // número da tela é o mesmo número que a varredura enxerga.
      const { data: usageData, error: usageErr } = await db.rpc(
        'purge_channel_messages',
        {
          p_account_id: accountId,
          p_channel_type: type,
          p_max_messages: null,
          p_retention_days: null,
          p_max_favorites: null,
          p_min_age_hours: defaults.minAgeHours,
          p_batch_limit: defaults.batchLimit,
          p_dry_run: true,
        }
      );
      if (usageErr) {
        console.error(
          '[GET /api/platform/accounts/[accountId]/retention] usage rpc failed:',
          type,
          usageErr.message
        );
      }
      const usage = usageData as RetentionPurgeResult | null;

      return {
        type,
        policy,
        effective,
        // `usageError: true` em vez de um `0` que pareceria "canal
        // vazio" e mentiria bem na tela usada para decidir se um limite
        // é seguro (achado de code review da SPEC 060, preservado).
        usage: usageErr
          ? { messagesTotal: null, favoritesTotal: null, usageError: true }
          : {
              messagesTotal: usage?.messages_total ?? 0,
              favoritesTotal: usage?.favorites_total ?? 0,
              usageError: false,
            },
      };
    })
  );

  return NextResponse.json({ minAgeHours: defaults.minAgeHours, channels });
}

export async function PUT(
  request: Request,
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

  // `updated_by` era o `user_id` do dono da conta na SPEC 060. O
  // proprietário da plataforma pode não ter perfil nesta conta (e o
  // padrão de identidade da §2.2 é o e-mail, não uma linha de
  // `auth.users`), então quem escreve pelo console deixa a coluna
  // `NULL` — o rastro de "quem mudou" fica em `platform_audit_log`,
  // que é onde a §2.5 mandou colocá-lo.
  const { data, error } = await db
    .from('channel_retention_policies')
    .upsert(
      {
        account_id: accountId,
        channel_type: channelType,
        max_messages: maxMessages.value,
        retention_days: retentionDays.value,
        max_favorites: maxFavorites.value,
        updated_by: null,
      },
      { onConflict: 'account_id,channel_type' }
    )
    .select('channel_type, max_messages, retention_days, max_favorites')
    .maybeSingle();

  if (error || !data) {
    console.error(
      '[PUT /api/platform/accounts/[accountId]/retention] upsert failed:',
      error
    );
    return NextResponse.json(
      { error: 'Failed to save retention policy' },
      { status: 500 }
    );
  }

  await writePlatformAudit(db, {
    actor: consoleActorTag(ownerEmail),
    action: 'retention.account.update',
    accountId,
    payload: {
      channelType,
      maxMessages: maxMessages.value,
      retentionDays: retentionDays.value,
      maxFavorites: maxFavorites.value,
    },
  });

  let defaults;
  try {
    defaults = await loadMergedRetentionDefaults(db);
  } catch (err) {
    console.error(
      '[PUT /api/platform/accounts/[accountId]/retention] defaults failed:',
      err
    );
    return NextResponse.json(
      { error: 'Failed to load retention settings' },
      { status: 500 }
    );
  }

  const policy = rowToPolicy(data);
  return NextResponse.json({
    policy,
    effective: resolveEffectivePolicyWithSource(policy, defaults[channelType]),
  });
}
