/**
 * A varredura de retenção (SPEC 060 §5, §6). Server-only — usa
 * `supabaseAdmin()`, que ignora RLS.
 *
 * Duas portas chamam a MESMA implementação (`runMessageRetention`):
 *
 *   Porta 1 — fase 4 de `/api/automations/cron`, respeitando o
 *   intervalo (`shouldRunNow`). É a padrão: nenhuma ação manual do
 *   operador além de dizer "sim" uma vez no `.env`.
 *
 *   Porta 2 — `GET /api/messages/retention/cron`, ignorando o
 *   intervalo (`ignoreInterval: true`). Quem chama explicitamente já
 *   decidiu a cadência.
 *
 * Nunca lança — chamada de dentro de `after()` na rota de automações,
 * onde uma exceção não tem quem a leia (mesmo contrato de
 * `scanSessionWindows`/`scanSchedules`).
 *
 * `purge_channel_messages` (migração 068) RECEBE os limites já
 * resolvidos — este arquivo é quem lê o `.env`, resolve a precedência
 * por par (conta × canal) e só então chama a função. A função nunca
 * conhece `.env` nem lê `channel_retention_policies` sozinha (SPEC 060
 * §2 ponto 1, §4.1).
 */

import { supabaseAdmin } from '@/lib/supabase/admin';
import type { ChannelType } from '@/lib/channels/types';
import { readRetentionDefaults } from './defaults';
import { resolveEffectivePolicy, rowToPolicy } from './policy';
import { shouldRunNow, isClaimStale, CLAIM_STALE_MINUTES } from './schedule';
import type {
  RetentionPolicyRow,
  RetentionPurgeResult,
  RetentionRunResult,
} from './types';

export type RetentionSkipReason =
  'disabled' | 'interval_not_elapsed' | 'claim_held';

export interface RetentionSweepOutcome {
  ran: boolean;
  skippedReason?: RetentionSkipReason;
  result?: RetentionRunResult;
}

function emptyRunResult(): RetentionRunResult {
  return {
    accounts: 0,
    by_age: 0,
    by_count: 0,
    favorites_demoted: 0,
    truncated: false,
    errors: 0,
  };
}

export async function runMessageRetention(
  now: Date = new Date(),
  opts: { ignoreInterval?: boolean } = {}
): Promise<RetentionSweepOutcome> {
  try {
    const defaults = readRetentionDefaults(process.env);

    // Regra 1 da SPEC (§1): nasce desligado. Nenhuma leitura de estado,
    // nenhum claim, nenhuma query em `channels` — sai antes de tudo.
    if (!defaults.enabled) {
      return { ran: false, skippedReason: 'disabled' };
    }

    const db = supabaseAdmin();

    const { data: stateRow, error: stateErr } = await db
      .from('message_retention_state')
      .select('last_run_at, running_since')
      .eq('id', true)
      .maybeSingle();

    if (stateErr) {
      console.error('[retention-sweep] state read failed:', stateErr.message);
      return { ran: false, skippedReason: 'claim_held' };
    }

    const lastRunAt = stateRow?.last_run_at
      ? new Date(stateRow.last_run_at as string)
      : null;
    const runningSince = stateRow?.running_since
      ? new Date(stateRow.running_since as string)
      : null;

    if (
      !opts.ignoreInterval &&
      !shouldRunNow(lastRunAt, defaults.intervalHours, now)
    ) {
      return { ran: false, skippedReason: 'interval_not_elapsed' };
    }

    if (runningSince !== null && !isClaimStale(runningSince, now)) {
      return { ran: false, skippedReason: 'claim_held' };
    }

    // Claim atômico: só reivindica se `running_since` ainda for NULL ou
    // vencido (mesma janela de `isClaimStale`, aqui como corte SQL) —
    // fecha a corrida entre a leitura acima e este UPDATE.
    const staleCutoffIso = new Date(
      now.getTime() - CLAIM_STALE_MINUTES * 60 * 1000
    ).toISOString();
    const { data: claimRow, error: claimErr } = await db
      .from('message_retention_state')
      .update({ running_since: now.toISOString() })
      .eq('id', true)
      .or(`running_since.is.null,running_since.lt.${staleCutoffIso}`)
      .select('id')
      .maybeSingle();

    if (claimErr) {
      console.error('[retention-sweep] claim failed:', claimErr.message);
      return { ran: false, skippedReason: 'claim_held' };
    }
    if (!claimRow) {
      // Outra invocação reivindicou entre a leitura e este UPDATE.
      return { ran: false, skippedReason: 'claim_held' };
    }

    const result = emptyRunResult();
    try {
      await sweepAllPairs(db, defaults, result);
    } finally {
      // Solta o claim e grava o resultado do ciclo SEMPRE — mesmo que
      // um par tenha lançado de forma inesperada (cada par já se
      // protege com try/catch dentro de sweepAllPairs; isto aqui é o
      // cinto de segurança para o claim nunca ficar preso).
      const { error: releaseErr } = await db
        .from('message_retention_state')
        .update({
          running_since: null,
          last_run_at: now.toISOString(),
          last_result: result,
        })
        .eq('id', true);
      if (releaseErr) {
        console.error(
          '[retention-sweep] failed to release claim / record result:',
          releaseErr.message
        );
      }
    }

    return { ran: true, result };
  } catch (err) {
    console.error('[retention-sweep] sweep failed:', err);
    return { ran: false, skippedReason: 'claim_held' };
  }
}

/**
 * SPEC 060 §5: enumera os pares a partir de `SELECT DISTINCT account_id,
 * type FROM channels` — e não de `conversations` — porque é a lista
 * curta (uma conta tem 1–3 canais, não 40.000 conversas), e porque
 * `conversations.channel_id` é FK sem `ON DELETE` para `channels`: toda
 * conversa tem canal vivo, então nenhum par se perde.
 */
async function sweepAllPairs(
  db: ReturnType<typeof supabaseAdmin>,
  defaults: ReturnType<typeof readRetentionDefaults>,
  result: RetentionRunResult
): Promise<void> {
  const { data: channelRows, error: channelsErr } = await db
    .from('channels')
    .select('account_id, type');

  if (channelsErr) {
    console.error(
      '[retention-sweep] channels lookup failed:',
      channelsErr.message
    );
    result.errors++;
    return;
  }

  const pairs = new Map<
    string,
    { accountId: string; channelType: ChannelType }
  >();
  const accountIds = new Set<string>();
  for (const row of (channelRows ?? []) as {
    account_id: string;
    type: ChannelType;
  }[]) {
    pairs.set(`${row.account_id}:${row.type}`, {
      accountId: row.account_id,
      channelType: row.type,
    });
    accountIds.add(row.account_id);
  }
  result.accounts = accountIds.size;

  // Uma consulta batelada para TODAS as políticas das contas envolvidas,
  // em vez de uma por par (achado de code review, SPEC 060 — N+1: o
  // laço abaixo passava a rodar uma ida-e-volta de rede extra por par
  // só para uma linha estreita, sem nenhum comentário que justificasse
  // isso especificamente — só a enumeração de canais por conta tinha
  // essa justificativa, não a busca de política). `resolveEffectivePolicy`
  // é pura, então alimentá-la com a linha já buscada não muda nada do
  // resultado.
  const policyByPair = await fetchPoliciesByPair(db, accountIds);

  for (const { accountId, channelType } of pairs.values()) {
    try {
      const row = policyByPair.get(`${accountId}:${channelType}`) ?? null;
      await sweepOnePair(db, defaults, accountId, channelType, row, result);
    } catch (err) {
      console.error(
        '[retention-sweep] pair failed:',
        accountId,
        channelType,
        err
      );
      result.errors++;
    }
  }
}

async function fetchPoliciesByPair(
  db: ReturnType<typeof supabaseAdmin>,
  accountIds: Set<string>
): Promise<Map<string, RetentionPolicyRow | null>> {
  const byPair = new Map<string, RetentionPolicyRow | null>();
  if (accountIds.size === 0) return byPair;

  const { data, error } = await db
    .from('channel_retention_policies')
    .select(
      'account_id, channel_type, max_messages, retention_days, max_favorites'
    )
    .in('account_id', [...accountIds]);

  if (error) {
    // Falha aberta, por par: sem a linha batelada, cada `sweepOnePair`
    // trata a ausência como "sem política própria" (herda o padrão do
    // .env) — o mesmo comportamento de uma conta que nunca configurou
    // nada, nunca "apagar tudo" por engano.
    console.error('[retention-sweep] policies lookup failed:', error.message);
    return byPair;
  }

  for (const row of (data ?? []) as {
    account_id: string;
    channel_type: ChannelType;
    max_messages: number | null;
    retention_days: number | null;
    max_favorites: number | null;
  }[]) {
    byPair.set(`${row.account_id}:${row.channel_type}`, rowToPolicy(row));
  }
  return byPair;
}

async function sweepOnePair(
  db: ReturnType<typeof supabaseAdmin>,
  defaults: ReturnType<typeof readRetentionDefaults>,
  accountId: string,
  channelType: ChannelType,
  row: RetentionPolicyRow | null,
  result: RetentionRunResult
): Promise<void> {
  const effective = resolveEffectivePolicy(row, defaults[channelType]);

  const { data: purgeData, error: purgeErr } = await db.rpc(
    'purge_channel_messages',
    {
      p_account_id: accountId,
      p_channel_type: channelType,
      p_max_messages: effective.maxMessages,
      p_retention_days: effective.retentionDays,
      p_max_favorites: effective.maxFavorites,
      p_min_age_hours: defaults.minAgeHours,
      p_batch_limit: defaults.batchLimit,
      p_dry_run: false,
    }
  );

  if (purgeErr) {
    console.error(
      '[retention-sweep] purge failed:',
      accountId,
      channelType,
      purgeErr.message
    );
    result.errors++;
    return;
  }

  const purge = purgeData as RetentionPurgeResult;
  result.by_age += purge.by_age;
  result.by_count += purge.by_count;
  result.favorites_demoted += purge.favorites_demoted;
  result.truncated = result.truncated || purge.truncated;
}
