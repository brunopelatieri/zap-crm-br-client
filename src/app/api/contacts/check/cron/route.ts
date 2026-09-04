import { timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';

import { supabaseAdmin } from '@/lib/supabase/admin';
import { decrypt } from '@/lib/whatsapp/encryption';
import { evaluateColdSend } from '@/lib/channels/cold-send-limit';
import { loadCheckUsage } from '@/lib/channels/cold-send-usage';
import { readEvolutionConfig } from '@/lib/evolution/config';
import { resolveCheckInstance } from '@/lib/evolution/check-instance';
import { readCheckLimitsFromSources } from '@/lib/evolution/check-limits';
import {
  planCheckBatch,
  type CheckQueueItem,
} from '@/lib/evolution/check-queue';
import { runCheckBatch, type CheckRunItem } from '@/lib/evolution/check-run';
import { createLimitsCache, loadLimitSourcesCached } from '@/lib/limits/load';
import { resolveKey } from '@/lib/limits/resolve';

/**
 * GET /api/contacts/check/cron (a cada 5 min) — SPEC 069 §6.3/§7.1.
 *
 * Mesmo contrato de auth das outras cinco rotas de cron do repositório
 * (`x-cron-secret` vs `AUTOMATION_CRON_SECRET`, 503 deliberado sem a
 * variável, comparação em tempo constante).
 *
 * Uma margem de 30 s antes de `maxDuration` — o `deadline` que
 * `runCheckBatch` recebe é `agora + (maxDuration-30)s`, não os 300 s
 * inteiros: o processo precisa de tempo para devolver a resposta HTTP
 * depois do último item, e um corte exato no limite arriscaria a rota
 * ser morta no meio de um UPDATE.
 *
 * Escopo desta fase (F5): SÓ o R3 (checagem avulsa). O R6 (campanha em
 * `awaiting_check` retomando) é F8 — itens com `source='broadcast'`
 * são processados aqui como QUALQUER outro item da fila (o veredito e
 * o avatar valem igual), mas esta rota NÃO toca `broadcasts.status`
 * nem `checked_count`: isso é `partial-send.ts`, ainda não escrito.
 */
export const maxDuration = 300;
const DEADLINE_MARGIN_SECONDS = 30;

/** Grupos (conta, canal validador) processados por invocação — o
 *  equivalente ao `MAX_PER_RUN` de `/api/broadcasts/cron`. */
const MAX_GROUPS_PER_RUN = 20;

/** Item `in_progress` mais velho que isto voltou de um processo morto
 *  no meio do lote (§7.1 ponto 7). */
const STUCK_IN_PROGRESS_HOURS = 1;

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
    // Sem Evolution configurada, a fila nunca deveria ter sido
    // enchida — mas se ficou (config removida depois), 200 vazio é
    // melhor que 500: o cron continua rodando sem erro no operador.
    return NextResponse.json({
      accountsProcessed: 0,
      checked: 0,
      invalid: 0,
      avatarsFetched: 0,
      skipped: [],
      rerouted: [],
    });
  }

  const admin = supabaseAdmin();
  const now = new Date();
  const deadline = new Date(
    now.getTime() + (maxDuration - DEADLINE_MARGIN_SECONDS) * 1000
  );

  // §7.1 ponto 7: reclama itens `in_progress` abandonados por um
  // processo morto no meio do lote.
  const stuckSince = new Date(
    now.getTime() - STUCK_IN_PROGRESS_HOURS * 3_600_000
  ).toISOString();
  await admin
    .from('contact_check_queue')
    .update({ status: 'pending' })
    .eq('status', 'in_progress')
    .lt('updated_at', stuckSince);

  const { data: pendingRows, error: pendingError } = await admin
    .from('contact_check_queue')
    .select('id, account_id, check_channel_id, source, attempts, created_at')
    .eq('status', 'pending')
    .not('check_channel_id', 'is', null)
    .order('created_at', { ascending: true })
    .limit(5000);

  if (pendingError) {
    console.error('[check-cron] pending scan failed:', pendingError.message);
    return NextResponse.json({ error: pendingError.message }, { status: 500 });
  }

  const groups = groupByAccountAndChannel(pendingRows ?? []);

  let checked = 0;
  let invalid = 0;
  let avatarsFetched = 0;
  const skipped: Array<{
    accountId: string;
    channelId: string;
    reason: string;
  }> = [];
  let accountsProcessed = 0;
  const rerouted: Array<{
    accountId: string;
    fromChannelId: string;
    toChannelId: string;
    count: number;
  }> = [];
  const cache = createLimitsCache();

  for (const group of groups.slice(0, MAX_GROUPS_PER_RUN)) {
    if (new Date() >= deadline) break;

    const instance = await resolveConnectedCheckInstance(
      admin,
      group.accountId,
      group.channelId
    );
    if (!instance) {
      // ✅ Correção (code review): `check_channel_id` fica congelado na
      // linha desde o enfileiramento (`resolveCheckInstance` em
      // `check-instance.ts`, na hora do enqueue). Se ELA parar de
      // servir (desconectada, desabilitada — ex.: troca de SIM) mas a
      // conta tiver OUTRA instância `check_enabled`+conectada agora,
      // marcar `skipped` era um beco sem saída: nada nunca move um item
      // `skipped` de volta a `pending`, então a checagem parava para
      // essa fila mesmo com a conta ainda validando números por outro
      // canal. Realoca para a instância atual da conta em vez de
      // desistir; sem instância nenhuma disponível, cai no `skipped` de
      // antes.
      const current = await resolveCheckInstance(admin, group.accountId);
      if (current && current.channelId !== group.channelId) {
        await admin
          .from('contact_check_queue')
          .update({ check_channel_id: current.channelId })
          .in(
            'id',
            group.rows.map((r) => r.id)
          );
        rerouted.push({
          accountId: group.accountId,
          fromChannelId: group.channelId,
          toChannelId: current.channelId,
          count: group.rows.length,
        });
        continue;
      }

      await admin
        .from('contact_check_queue')
        .update({
          status: 'skipped',
          last_error: 'instance not enabled or not connected',
        })
        .in(
          'id',
          group.rows.map((r) => r.id)
        );
      skipped.push({
        accountId: group.accountId,
        channelId: group.channelId,
        reason: 'instance_unavailable',
      });
      continue;
    }

    // UMA leitura de fontes para o grupo inteiro (§4.3: uma vez por
    // instância por ciclo, não uma vez por chave). Todo `resolveKey`
    // abaixo usa a MESMA `sources` — é o que garante que
    // `evolution_check_batch_size` (accountConfigurable) também
    // resolve por conta/instância, e não só por `.env`/código.
    const sources = await loadLimitSourcesCached(
      admin,
      { accountId: group.accountId, channelId: group.channelId },
      cache
    );
    const checkLimits = readCheckLimitsFromSources(sources);
    const usage = await loadCheckUsage(admin, group.channelId, now);
    const decision = evaluateColdSend(checkLimits, usage, now);

    const maxAttempts = resolveKey(
      'evolution_check_max_attempts',
      sources
    ).value;
    const ttlHours = resolveKey(
      'evolution_check_queue_ttl_hours',
      sources
    ).value;
    const batchSizeLimit = resolveKey(
      'evolution_check_batch_size',
      sources
    ).value;
    const infoAvatarTimeoutMs = resolveKey(
      'evolution_info_avatar_timeout_ms',
      sources
    ).value;
    const avatarTtlDays = resolveKey(
      'evolution_avatar_ttl_days',
      sources
    ).value;
    const avatarMaxBytes = resolveKey(
      'evolution_avatar_max_bytes',
      sources
    ).value;

    const queueItems: CheckQueueItem[] = group.rows.map((r) => ({
      id: r.id,
      source: r.source,
      attempts: r.attempts,
      createdAt: new Date(r.created_at),
    }));

    const plan = planCheckBatch({
      pending: queueItems,
      decision,
      batchSize: batchSizeLimit,
      maxAttempts,
      ttlHours,
      now,
    });

    if (plan.toFail.length > 0) {
      await admin
        .from('contact_check_queue')
        .update({ status: 'failed', last_error: 'max attempts exceeded' })
        .in(
          'id',
          plan.toFail.map((i) => i.id)
        );
    }
    if (plan.toExpire.length > 0) {
      await admin
        .from('contact_check_queue')
        .update({ status: 'expired' })
        .in(
          'id',
          plan.toExpire.map((i) => i.id)
        );
    }

    if (plan.toProcess.length === 0) {
      if (!decision.allowed) {
        skipped.push({
          accountId: group.accountId,
          channelId: group.channelId,
          reason: decision.reason ?? 'no_quota',
        });
      }
      continue;
    }

    const items = await hydrateItems(admin, plan.toProcess);

    const summary = await runCheckBatch(admin, config, {
      items,
      accountId: group.accountId,
      channelId: group.channelId,
      instanceToken: instance.token,
      minIntervalSeconds: checkLimits.minIntervalSeconds,
      infoAvatarTimeoutMs,
      avatarTtlDays,
      avatarMaxBytes,
      deadline,
    });

    checked += summary.checked;
    invalid += summary.invalid;
    avatarsFetched += summary.avatarsFetched;
    accountsProcessed++;
  }

  return NextResponse.json({
    accountsProcessed,
    checked,
    invalid,
    avatarsFetched,
    skipped,
    rerouted,
  });
}

interface PendingRow {
  id: string;
  account_id: string;
  check_channel_id: string;
  source: 'contacts_import' | 'broadcast';
  attempts: number;
  created_at: string;
}

interface PendingGroup {
  accountId: string;
  channelId: string;
  rows: PendingRow[];
}

function groupByAccountAndChannel(rows: PendingRow[]): PendingGroup[] {
  const groups = new Map<string, PendingGroup>();
  for (const row of rows) {
    const key = `${row.account_id}:${row.check_channel_id}`;
    let group = groups.get(key);
    if (!group) {
      group = {
        accountId: row.account_id,
        channelId: row.check_channel_id,
        rows: [],
      };
      groups.set(key, group);
    }
    group.rows.push(row);
  }
  return Array.from(groups.values());
}

async function hydrateItems(
  db: ReturnType<typeof supabaseAdmin>,
  toProcess: CheckQueueItem[]
): Promise<CheckRunItem[]> {
  const byId = new Map(toProcess.map((i) => [i.id, i]));
  const { data: queueRows } = await db
    .from('contact_check_queue')
    .select('id, contact_id, phone_normalized')
    .in('id', Array.from(byId.keys()));

  const contactIds = (queueRows ?? []).map((r) => r.contact_id as string);
  const { data: contactRows } = await db
    .from('contacts')
    .select('id, avatar_fetched_at')
    .in('id', contactIds);
  const avatarFetchedById = new Map(
    (contactRows ?? []).map((c) => [
      c.id as string,
      c.avatar_fetched_at ? new Date(c.avatar_fetched_at as string) : null,
    ])
  );

  // Preserva a ORDEM que planCheckBatch decidiu (prioridade + FIFO) —
  // a hidratação não pode reordenar o que a higiene/prioridade já
  // resolveu.
  const rowById = new Map((queueRows ?? []).map((r) => [r.id as string, r]));

  return toProcess
    .map((item) => {
      const row = rowById.get(item.id);
      if (!row) return null;
      return {
        queueItemId: item.id,
        contactId: row.contact_id as string,
        phoneNormalized: row.phone_normalized as string,
        avatarFetchedAt:
          avatarFetchedById.get(row.contact_id as string) ?? null,
      };
    })
    .filter((i): i is CheckRunItem => i !== null);
}

async function resolveConnectedCheckInstance(
  db: ReturnType<typeof supabaseAdmin>,
  accountId: string,
  channelId: string
): Promise<{ token: string } | null> {
  const { data: instance, error } = await db
    .from('evolution_instances')
    .select('id, check_enabled, channels!inner(status)')
    .eq('account_id', accountId)
    .eq('channel_id', channelId)
    .eq('check_enabled', true)
    .eq('channels.status', 'connected')
    .maybeSingle();

  if (error || !instance) return null;

  const { data: secret, error: secretError } = await db
    .from('evolution_instance_secrets')
    .select('instance_token_encrypted')
    .eq('instance_id', instance.id as string)
    .maybeSingle();

  if (secretError || !secret) return null;

  return { token: decrypt(secret.instance_token_encrypted as string) };
}
