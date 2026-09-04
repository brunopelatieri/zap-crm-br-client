import { timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';

import { supabaseAdmin } from '@/lib/supabase/admin';
import { decrypt } from '@/lib/whatsapp/encryption';
import { readEvolutionConfig } from '@/lib/evolution/config';
import { listWhatsappContacts } from '@/lib/evolution/user';
import { isWithinHarvestWindow } from '@/lib/evolution/harvest-window';
import {
  planHarvestBatch,
  type HarvestCandidate,
} from '@/lib/evolution/harvest';
import { createLimitsCache, loadLimitSourcesCached } from '@/lib/limits/load';
import { resolveKey, resolveTimeZoneValue } from '@/lib/limits/resolve';
import { getLimitEntry } from '@/lib/limits/registry';

/**
 * GET /api/contacts/harvest/cron (de hora em hora, 00–05) — SPEC 069
 * §6.4/§7.2, R5.
 *
 * A janela é conferida NO CÓDIGO antes de tocar a Evolution — não só
 * no agendamento (ver `harvest-window.ts`). Fora da janela, devolve
 * `{skipped:"outside_window"}` sem NENHUMA chamada de rede.
 *
 * Desvio da SPEC §7.2 ponto 5: avatar do captado NÃO é buscado aqui
 *
 *   O texto original previa buscar o avatar "no mesmo lote" do
 *   harvest. Adiado para a PROMOÇÃO (`POST /api/evolution/harvested/
 *   promote`), pela mesma razão da F5 (ver `check-run.ts`):
 *   `/user/avatar` é uma consulta ao vivo por número, com o mesmo
 *   risco de lentidão/reputação medido na F3, e sem `min_interval_
 *   seconds` nenhum protegendo o harvest (a SPEC não previu pacing
 *   aqui, só o teto de `harvest_per_run`). Buscar foto para até 50
 *   contatos por hora que talvez NUNCA sejam promovidos gastaria essa
 *   consulta à toa; buscar só na promoção significa que só quem um
 *   humano decidiu que importa paga o custo.
 */
export const maxDuration = 120;
const MAX_INSTANCES_PER_RUN = 20;

export async function GET(request: Request) {
  const expected = process.env.AUTOMATION_CRON_SECRET;
  if (!expected) {
    return NextResponse.json({ error: 'cron not configured' }, { status: 503 });
  }
  const supplied = request.headers.get('x-cron-secret') ?? '';
  const suppliedBuf = Buffer.from(supplied);
  const expectedBuf = Buffer.from(expected);
  if (
    suppliedBuf.length !== expectedBuf.length ||
    !timingSafeEqual(suppliedBuf, expectedBuf)
  ) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const config = readEvolutionConfig();
  if (!config) {
    return NextResponse.json({
      instancesProcessed: 0,
      harvested: 0,
      skipped: 'not_configured',
    });
  }

  const now = new Date();
  const tzEntry = getLimitEntry('evolution_harvest_timezone');
  const timeZone =
    tzEntry && tzEntry.valueType === 'timezone'
      ? resolveTimeZoneValue(tzEntry, { env: process.env }).value
      : 'America/Sao_Paulo';
  const startHour = resolveKey('evolution_harvest_window_start_hour', {
    env: process.env,
  }).value;
  const endHour = resolveKey('evolution_harvest_window_end_hour', {
    env: process.env,
  }).value;

  if (!isWithinHarvestWindow(now, { startHour, endHour, timeZone })) {
    return NextResponse.json({
      instancesProcessed: 0,
      harvested: 0,
      skipped: 'outside_window',
    });
  }

  const admin = supabaseAdmin();
  const { data: instances, error } = await admin
    .from('evolution_instances')
    .select(
      'id, account_id, channel_id, harvested_count, channels!inner(status)'
    )
    .eq('harvest_enabled', true)
    .eq('channels.status', 'connected')
    .order('harvest_last_run_at', { ascending: true, nullsFirst: true })
    .limit(MAX_INSTANCES_PER_RUN);

  if (error) {
    console.error('[harvest-cron] instance scan failed:', error.message);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  let instancesProcessed = 0;
  let harvested = 0;
  const results: Array<{
    accountId: string;
    channelId: string;
    harvested: number;
    reason?: string;
  }> = [];
  const cache = createLimitsCache();

  for (const row of instances ?? []) {
    const instance = row as unknown as {
      id: string;
      account_id: string;
      channel_id: string;
      harvested_count: number;
    };

    const sources = await loadLimitSourcesCached(
      admin,
      { accountId: instance.account_id, channelId: instance.channel_id },
      cache
    );
    const perRun = resolveKey('evolution_harvest_per_run', sources).value;
    const maxPerInstance = resolveKey(
      'evolution_harvest_max_per_instance',
      sources
    ).value;

    const remainingCapacity = maxPerInstance - instance.harvested_count;
    if (remainingCapacity <= 0) {
      results.push({
        accountId: instance.account_id,
        channelId: instance.channel_id,
        harvested: 0,
        reason: 'harvest_complete',
      });
      continue;
    }

    const token = await resolveInstanceToken(admin, instance.id);
    if (!token) {
      results.push({
        accountId: instance.account_id,
        channelId: instance.channel_id,
        harvested: 0,
        reason: 'missing_secret',
      });
      continue;
    }

    let contacts: HarvestCandidate[];
    try {
      const raw = await listWhatsappContacts(config, token);
      contacts = raw.map((c) => ({
        jid: c.jid,
        found: c.found,
        firstName: c.firstName,
        fullName: c.fullName,
        pushName: c.pushName,
        businessName: c.businessName,
      }));
    } catch (err) {
      console.error(
        `[harvest-cron] /user/contacts failed for instance ${instance.id}:`,
        err
      );
      results.push({
        accountId: instance.account_id,
        channelId: instance.channel_id,
        harvested: 0,
        reason: 'channel_unavailable',
      });
      continue;
    }

    const existingJids = await loadExistingJids(
      admin,
      instance.account_id,
      instance.channel_id,
      contacts.map((c) => c.jid)
    );

    const plan = planHarvestBatch({
      contacts,
      existingJids,
      perRun,
      remainingCapacity,
    });

    /** Só sobe quando o INSERT realmente confirma — ver correção abaixo. */
    let insertedCount = 0;

    if (plan.toInsert.length > 0) {
      const rows = plan.toInsert.map((c) => ({
        account_id: instance.account_id,
        channel_id: instance.channel_id,
        jid: c.jid,
        phone_normalized: phoneFromJid(c.jid),
        push_name: c.pushName,
        full_name: c.fullName,
        business_name: c.businessName,
        status: 'new' as const,
        raw: c,
      }));
      const { error: insertError } = await admin
        .from('evolution_harvested_contacts')
        .insert(rows);
      if (insertError) {
        console.error('[harvest-cron] insert failed:', insertError.message);
      }
      // ✅ Correção (code review): `insert(rows)` roda como um único
      // INSERT — falha é tudo-ou-nada, não parcial. Sem este `if`,
      // `harvested_count` era incrementado por `plan.toInsert.length`
      // mesmo quando ZERO linhas entraram, e não existe nenhuma
      // varredura que recalcule o contador a partir da tabela real —
      // o desvio se acumula a cada falha até `harvest_complete`
      // disparar cedo demais, com a fila de triagem vazia.
      insertedCount = insertError ? 0 : plan.toInsert.length;
    }

    await admin
      .from('evolution_instances')
      .update({
        harvested_count: instance.harvested_count + insertedCount,
        harvest_cursor: plan.cursor ?? undefined,
        harvest_last_run_at: now.toISOString(),
      })
      .eq('id', instance.id);

    harvested += insertedCount;
    instancesProcessed++;
    results.push({
      accountId: instance.account_id,
      channelId: instance.channel_id,
      harvested: insertedCount,
      reason: plan.capacityReached ? 'harvest_complete' : undefined,
    });
  }

  return NextResponse.json({ instancesProcessed, harvested, results });
}

/** Telefone só-dígitos a partir de um Jid `@s.whatsapp.net`; `null`
 *  para Jid `@lid` (não há telefone a extrair). */
function phoneFromJid(jid: string): string | null {
  if (!jid.endsWith('@s.whatsapp.net')) return null;
  const digits = jid.split('@')[0].replace(/\D/g, '');
  return digits || null;
}

/**
 * União de dois dedupes (SPEC §7.2 ponto 3): quem já está na TRIAGEM
 * desta instância, e quem já é um contato REAL vinculado por
 * `contact_identities` (LID) ou por telefone já cadastrado — sem o
 * segundo, a captação reencheria a triagem com gente que já é cliente.
 */
async function loadExistingJids(
  db: ReturnType<typeof supabaseAdmin>,
  accountId: string,
  channelId: string,
  candidateJids: string[]
): Promise<Set<string>> {
  const jids = new Set<string>();

  const { data: triaged } = await db
    .from('evolution_harvested_contacts')
    .select('jid')
    .eq('account_id', accountId)
    .eq('channel_id', channelId)
    .in('jid', candidateJids);
  for (const row of triaged ?? []) jids.add(row.jid as string);

  const { data: linked } = await db
    .from('contact_identities')
    .select('external_id')
    .eq('account_id', accountId)
    .eq('channel_type', 'whatsapp_qr')
    .in('external_id', candidateJids);
  for (const row of linked ?? []) jids.add(row.external_id as string);

  const phoneCandidates = candidateJids
    .map((jid) => ({ jid, phone: phoneFromJid(jid) }))
    .filter((c): c is { jid: string; phone: string } => c.phone !== null);
  if (phoneCandidates.length > 0) {
    const { data: existingContacts } = await db
      .from('contacts')
      .select('phone_normalized')
      .eq('account_id', accountId)
      .in(
        'phone_normalized',
        phoneCandidates.map((c) => c.phone)
      );
    const existingPhones = new Set(
      (existingContacts ?? []).map((r) => r.phone_normalized as string)
    );
    for (const c of phoneCandidates) {
      if (existingPhones.has(c.phone)) jids.add(c.jid);
    }
  }

  return jids;
}

async function resolveInstanceToken(
  db: ReturnType<typeof supabaseAdmin>,
  instanceId: string
): Promise<string | null> {
  const { data: secret, error } = await db
    .from('evolution_instance_secrets')
    .select('instance_token_encrypted')
    .eq('instance_id', instanceId)
    .maybeSingle();
  if (error || !secret) return null;
  return decrypt(secret.instance_token_encrypted as string);
}
