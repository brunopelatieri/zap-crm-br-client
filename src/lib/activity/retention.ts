/**
 * Retenção de `account_activity_log` (SPEC 075 §8, D-6).
 *
 * "Regra própria, não a da SPEC 060" — a 060 recorta por conta × TIPO
 * DE CANAL, porque conversa é do canal; atividade não é. Aqui é um
 * corte GLOBAL só por idade, com um interruptor de duas posições:
 *
 *   - `ACTIVITY_LOG_RETENTION_DAYS` ausente/vazio → **desligada**
 *     ("nasce desligada", §8 — nenhuma varredura roda, nenhuma leitura
 *     a mais no cron). É o mesmo espírito de `MESSAGE_RETENTION_ENABLED`
 *     da SPEC 060, só que num knob só em vez de dois.
 *   - `=0` → **ligada, mas sem apagar nada** (§8: "0 = nunca apagar").
 *     Diferente de "desligada": é uma escolha explícita de manter tudo
 *     para sempre, e aparece como tal no resultado da varredura.
 *   - `>0` → ligada, apaga o que passou de N dias.
 *
 * Nunca lança — mesma disciplina de `retention/defaults.ts`: um `.env`
 * torto vira "desligada" com um aviso, nunca um erro que derruba o
 * cron que também drena mensagens e automações.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

const ENV_VAR = 'ACTIVITY_LOG_RETENTION_DAYS';

export interface ActivityRetentionConfig {
  enabled: boolean;
  /** Só significa algo quando `enabled` — dias até apagar; `0` = nunca. */
  days: number;
}

export type EnvSource = Record<string, string | undefined>;

export function readActivityRetentionConfig(
  env: EnvSource
): ActivityRetentionConfig {
  const raw = env[ENV_VAR];
  if (raw === undefined || raw.trim() === '') {
    return { enabled: false, days: 0 };
  }

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 0) {
    console.warn(
      `[activity/retention] ${ENV_VAR}="${raw}" inválido — retenção desligada.`
    );
    return { enabled: false, days: 0 };
  }

  return { enabled: true, days: parsed };
}

/** `null` = sem corte (desligada OU `days: 0`) — a varredura não apaga nada. */
export function activityRetentionCutoffIso(
  config: ActivityRetentionConfig,
  now: Date = new Date()
): string | null {
  if (!config.enabled || config.days === 0) return null;
  return new Date(
    now.getTime() - config.days * 24 * 60 * 60 * 1000
  ).toISOString();
}

export interface ActivityRetentionSweepResult {
  /** `false` só quando a variável está ausente/inválida. */
  enabled: boolean;
  /** `null` quando `enabled: false` OU `days: 0` (nunca apagar). */
  cutoff: string | null;
  /** Linhas de fato apagadas (0 em modo `dryRun`, mesmo que houvesse candidatas). */
  deleted: number;
  /**
   * Quantas linhas SERIAM apagadas — preenchido sempre que há corte,
   * nos dois modos. É o número que a prévia (F8, "dry-run antes de
   * qualquer apagamento") confere antes de deixar `dryRun` virar `false`.
   */
  candidates: number;
  dryRun: boolean;
  error?: string;
}

/**
 * A varredura em si. Chamada de dentro de `runMessageRetention`
 * (`retention/sweep.ts`) — SEM rota nova, sem agendamento novo (§8) —
 * mas de propósito INDEPENDENTE do `MESSAGE_RETENTION_ENABLED` daquela
 * varredura: "regra própria" significa um interruptor próprio, não um
 * apêndice do que já existe.
 *
 * `dryRun: true` só CONTA (via `count: 'exact', head: true`) — nunca
 * chama a RPC de exclusão. É o modo que a verificação manual do F8 usa
 * antes de a primeira varredura de verdade rodar em produção.
 */
export async function sweepActivityLog(
  db: SupabaseClient,
  now: Date = new Date(),
  opts: { dryRun?: boolean } = {}
): Promise<ActivityRetentionSweepResult> {
  const config = readActivityRetentionConfig(process.env);
  const cutoff = activityRetentionCutoffIso(config, now);

  if (!config.enabled) {
    return {
      enabled: false,
      cutoff: null,
      deleted: 0,
      candidates: 0,
      dryRun: !!opts.dryRun,
    };
  }

  if (cutoff === null) {
    // `days: 0` — ligada, mas o próprio D-6 manda nunca apagar.
    return {
      enabled: true,
      cutoff: null,
      deleted: 0,
      candidates: 0,
      dryRun: !!opts.dryRun,
    };
  }

  try {
    const { count, error: countErr } = await db
      .from('account_activity_log')
      .select('id', { count: 'exact', head: true })
      .lt('created_at', cutoff);

    if (countErr) {
      console.error('[activity/retention] count failed:', countErr.message);
      return {
        enabled: true,
        cutoff,
        deleted: 0,
        candidates: 0,
        dryRun: !!opts.dryRun,
        error: countErr.message,
      };
    }

    const candidates = count ?? 0;

    if (opts.dryRun || candidates === 0) {
      return {
        enabled: true,
        cutoff,
        deleted: 0,
        candidates,
        dryRun: !!opts.dryRun,
      };
    }

    const { data: deletedCount, error: purgeErr } = await db.rpc(
      'purge_account_activity_log',
      { p_older_than_days: config.days }
    );

    if (purgeErr) {
      console.error('[activity/retention] purge failed:', purgeErr.message);
      return {
        enabled: true,
        cutoff,
        deleted: 0,
        candidates,
        dryRun: false,
        error: purgeErr.message,
      };
    }

    return {
      enabled: true,
      cutoff,
      deleted: (deletedCount as number | null) ?? 0,
      candidates,
      dryRun: false,
    };
  } catch (err) {
    // Nunca lança — mesma disciplina de `runMessageRetention`: uma
    // varredura de manutenção que quebra o cron é pior que uma que
    // pula um ciclo.
    const message = err instanceof Error ? err.message : String(err);
    console.error('[activity/retention] sweep threw:', err);
    return {
      enabled: true,
      cutoff,
      deleted: 0,
      candidates: 0,
      dryRun: !!opts.dryRun,
      error: message,
    };
  }
}
