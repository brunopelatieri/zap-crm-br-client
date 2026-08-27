// ============================================================
// GET/PUT /api/account/retention — painel "Retenção" (SPEC 060 §7, F5)
//
// Só Proprietário (`requireRole('owner')`) — o mesmo papel exigido pela
// RLS de `channel_retention_policies` (migração 068 §3.2). O guard de
// servidor aqui é redundante com a RLS de propósito: RLS é o chão, não
// o único andar.
//
// GET devolve, por tipo de canal PRESENTE na conta: a política salva
// (bruta — `null`/coluna ausente = herda), a política EFETIVA já
// resolvida contra o `.env` (`resolveEffectivePolicyWithSource`) e o
// uso atual (mensagens/favoritas). O uso é lido via
// `purge_channel_messages(..., p_dry_run: true)` com os TRÊS limites
// `null` — nenhuma fase roda (cada fase exige `p_x > 0`), então a
// função só devolve os totais que já computa incondicionalmente no
// fim (`messages_total`/`favorites_total`). Isso evita reimplementar,
// em PostgREST, o JOIN de três tabelas que a função já tem testado —
// e por isso PRECISA do cliente de service-role (a função está
// REVOKE'd de `authenticated`, §4.2): o guard `requireRole('owner')`
// já filtrou quem chega até aqui, então chamar via `supabaseAdmin()`
// depois dele é o caminho confiável que a SPEC pede.
//
// PUT grava OU limpa a política de um `channel_type` — os dois cabem
// na mesma operação porque `null` em qualquer campo já significa
// "herdar" (§3.4); não existe uma política "parcialmente ausente" que
// precise de uma rota de DELETE separada.
// ============================================================

import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { CHANNEL_TYPES, type ChannelType } from '@/lib/channels/types';
import { readRetentionDefaults } from '@/lib/retention/defaults';
import {
  resolveEffectivePolicyWithSource,
  rowToPolicy,
} from '@/lib/retention/policy';
import { parseRetentionLimitInput } from '@/lib/retention/validate';
import type { RetentionPurgeResult } from '@/lib/retention/types';

function isChannelType(value: unknown): value is ChannelType {
  return (
    typeof value === 'string' &&
    (CHANNEL_TYPES as readonly string[]).includes(value)
  );
}

export async function GET() {
  try {
    const ctx = await requireRole('owner');
    const defaults = readRetentionDefaults(process.env);

    const [
      { data: channelRows, error: channelsErr },
      { data: policyRows, error: policyErr },
      { data: stateRow, error: stateErr },
    ] = await Promise.all([
      ctx.supabase
        .from('channels')
        .select('type')
        .eq('account_id', ctx.accountId),
      ctx.supabase
        .from('channel_retention_policies')
        .select('channel_type, max_messages, retention_days, max_favorites')
        .eq('account_id', ctx.accountId),
      ctx.supabase
        .from('message_retention_state')
        .select('last_run_at, last_result')
        .eq('id', true)
        .maybeSingle(),
    ]);

    if (channelsErr || policyErr || stateErr) {
      console.error(
        '[retention GET] fetch failed:',
        channelsErr || policyErr || stateErr
      );
      return NextResponse.json(
        { error: 'Failed to load retention settings' },
        { status: 500 }
      );
    }

    const presentTypes = Array.from(
      new Set((channelRows ?? []).map((r) => r.type as ChannelType))
    );
    const policyByType = new Map(
      (policyRows ?? []).map((r) => [r.channel_type as ChannelType, r])
    );

    const admin = supabaseAdmin();

    const channels = await Promise.all(
      presentTypes.map(async (type) => {
        const policy = rowToPolicy(policyByType.get(type) ?? null);
        const effective = resolveEffectivePolicyWithSource(
          policy,
          defaults[type]
        );

        const { data: usageData, error: usageErr } = await admin.rpc(
          'purge_channel_messages',
          {
            p_account_id: ctx.accountId,
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
            '[retention GET] usage rpc failed:',
            type,
            usageErr.message
          );
        }
        const usage = usageData as RetentionPurgeResult | null;

        return {
          type,
          policy,
          effective,
          // `usageErr` (achado de code review, SPEC 060): sem o sinal
          // `usageError`, um `0` por falha de RPC era indistinguível de
          // um canal genuinamente vazio — exatamente na tela que o
          // dono usa para decidir se um limite é seguro. `null` nos
          // totais + `usageError: true` deixa o card renderizar um
          // aviso em vez de "0 de X mensagens".
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

    return NextResponse.json({
      enabled: defaults.enabled,
      minAgeHours: defaults.minAgeHours,
      intervalHours: defaults.intervalHours,
      lastRunAt: stateRow?.last_run_at ?? null,
      lastResult: stateRow?.last_result ?? null,
      channels,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function PUT(request: Request) {
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

    const { data, error } = await ctx.supabase
      .from('channel_retention_policies')
      .upsert(
        {
          account_id: ctx.accountId,
          channel_type: body.channelType,
          max_messages: maxMessages.value,
          retention_days: retentionDays.value,
          max_favorites: maxFavorites.value,
          updated_by: ctx.userId,
        },
        { onConflict: 'account_id,channel_type' }
      )
      .select('channel_type, max_messages, retention_days, max_favorites')
      .maybeSingle();

    if (error || !data) {
      console.error('[retention PUT] upsert failed:', error);
      return NextResponse.json(
        { error: 'Failed to save retention policy' },
        { status: 500 }
      );
    }

    const defaults = readRetentionDefaults(process.env);
    const policy = rowToPolicy(data);
    const effective = resolveEffectivePolicyWithSource(
      policy,
      defaults[body.channelType as ChannelType]
    );

    return NextResponse.json({ policy, effective });
  } catch (err) {
    return toErrorResponse(err);
  }
}
