import { NextResponse } from 'next/server';

import { requireRole } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/supabase/admin';
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit';
import { loadLimitSourcesCached } from '@/lib/limits/load';
import { resolveKey } from '@/lib/limits/resolve';

type Params = { params: Promise<{ id: string }> };

/**
 * PATCH /api/channels/evolution/instances/[id]/enrichment (admin+)
 * SPEC 069 §6.1, R1 — os switches de checagem/captação e o teto de
 * captação desta instância.
 *
 * ⚠️ Caminho movido de `/api/evolution/instances/[id]/enrichment`
 * (como a SPEC 069 §6.1 escreveu) para
 * `/api/channels/evolution/instances/[id]/enrichment` — é aqui que
 * TODA a família de ações de instância já mora
 * (`disconnect`/`logout`/`pair`/`qr`/`reconnect`/`status`, SPEC 048),
 * e `[id]` já é convenção estabelecida para `evolution_instances.id`
 * (não `channel_id`). Duas famílias de rota para a mesma instância
 * seria a divergência que a F2 gastou o módulo de limites inteiro
 * para evitar, só que em rotas em vez de em `.env`.
 *
 * Sem esta rota, `check_enabled`/`harvest_enabled` só ligam por SQL
 * direto — e os dois nascem `FALSE` de propósito (migração 078,
 * PRD 068 §6.2). Implementada nesta sessão (F3–F7) fora da tabela de
 * fases original porque, sem ela, nada que a F5/F7 constrói é
 * alcançável por um cliente real.
 */
export async function PATCH(request: Request, { params }: Params) {
  try {
    const { accountId, userId } = await requireRole('admin');
    const { id } = await params;

    const limit = checkRateLimit(
      `evolution:instanceAction:${userId}`,
      RATE_LIMITS.evolutionInstanceAction
    );
    if (!limit.success) return rateLimitResponse(limit);

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
    }
    const parsed = parseBody(body);
    if ('error' in parsed) {
      return NextResponse.json({ error: parsed.error }, { status: 400 });
    }

    const admin = supabaseAdmin();
    const { data: instance, error: fetchError } = await admin
      .from('evolution_instances')
      .select(
        'id, channel_id, connected_phone, check_enabled, harvest_enabled, harvest_max_contacts, harvested_count'
      )
      .eq('id', id)
      .eq('account_id', accountId)
      .maybeSingle();

    if (fetchError) {
      return NextResponse.json({ error: fetchError.message }, { status: 500 });
    }
    if (!instance) {
      return NextResponse.json(
        { error: 'instance not found' },
        { status: 404 }
      );
    }

    // Ligar checagem é uma promessa de que ela vai funcionar; deixar
    // ligar sem sessão só empurra a frustração para o cron (§6.1).
    if (parsed.checkEnabled === true && !instance.connected_phone) {
      return NextResponse.json(
        { error: 'instance is not connected' },
        { status: 409 }
      );
    }

    let harvestMaxContactsCeiling: number | null = null;
    if (
      parsed.harvestMaxContacts !== undefined &&
      parsed.harvestMaxContacts !== null
    ) {
      const sources = await loadLimitSourcesCached(admin, {
        accountId,
        channelId: instance.channel_id,
      });
      const resolved = resolveKey(
        'evolution_harvest_max_per_instance',
        sources
      );
      harvestMaxContactsCeiling = resolved.hardCap;
      if (
        harvestMaxContactsCeiling !== null &&
        parsed.harvestMaxContacts > harvestMaxContactsCeiling
      ) {
        return NextResponse.json(
          {
            error: `harvestMaxContacts exceeds the ceiling of ${harvestMaxContactsCeiling}`,
          },
          { status: 400 }
        );
      }
    }

    const update: Record<string, unknown> = {};
    if (parsed.checkEnabled !== undefined)
      update.check_enabled = parsed.checkEnabled;
    if (parsed.harvestEnabled !== undefined)
      update.harvest_enabled = parsed.harvestEnabled;
    if (parsed.harvestMaxContacts !== undefined) {
      update.harvest_max_contacts = parsed.harvestMaxContacts;
    }

    const { error: updateError } = await admin
      .from('evolution_instances')
      .update(update)
      .eq('id', id);
    if (updateError) {
      return NextResponse.json({ error: updateError.message }, { status: 500 });
    }

    if (
      harvestMaxContactsCeiling === null &&
      parsed.harvestMaxContacts === undefined
    ) {
      // O ceiling não foi calculado porque o campo não foi tocado
      // nesta chamada — a resposta ainda deve mostrá-lo (a UI da F9
      // exibe o teto sempre, não só quando o campo muda).
      const sources = await loadLimitSourcesCached(admin, {
        accountId,
        channelId: instance.channel_id,
      });
      harvestMaxContactsCeiling = resolveKey(
        'evolution_harvest_max_per_instance',
        sources
      ).hardCap;
    }

    return NextResponse.json({
      checkEnabled: parsed.checkEnabled ?? instance.check_enabled,
      harvestEnabled: parsed.harvestEnabled ?? instance.harvest_enabled,
      harvestMaxContacts:
        parsed.harvestMaxContacts !== undefined
          ? parsed.harvestMaxContacts
          : instance.harvest_max_contacts,
      harvestMaxContactsCeiling,
      harvestedCount: instance.harvested_count,
    });
  } catch (err) {
    console.error('[evolution/enrichment] unexpected error:', err);
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}

interface ParsedEnrichmentBody {
  checkEnabled?: boolean;
  harvestEnabled?: boolean;
  /** `undefined` = campo não enviado (não mexe); `null` = voltar a
   *  herdar; número = teto próprio desta instância. */
  harvestMaxContacts?: number | null;
}

function parseBody(body: unknown): ParsedEnrichmentBody | { error: string } {
  if (typeof body !== 'object' || body === null) {
    return { error: 'Body must be a JSON object' };
  }
  const { checkEnabled, harvestEnabled, harvestMaxContacts } = body as Record<
    string,
    unknown
  >;
  const result: ParsedEnrichmentBody = {};

  if (checkEnabled !== undefined) {
    if (typeof checkEnabled !== 'boolean') {
      return { error: 'checkEnabled must be a boolean' };
    }
    result.checkEnabled = checkEnabled;
  }
  if (harvestEnabled !== undefined) {
    if (typeof harvestEnabled !== 'boolean') {
      return { error: 'harvestEnabled must be a boolean' };
    }
    result.harvestEnabled = harvestEnabled;
  }
  if (harvestMaxContacts !== undefined) {
    if (harvestMaxContacts !== null) {
      if (
        typeof harvestMaxContacts !== 'number' ||
        !Number.isInteger(harvestMaxContacts) ||
        harvestMaxContacts < 0
      ) {
        return {
          error: 'harvestMaxContacts must be a non-negative integer or null',
        };
      }
    }
    result.harvestMaxContacts = harvestMaxContacts;
  }

  return result;
}
