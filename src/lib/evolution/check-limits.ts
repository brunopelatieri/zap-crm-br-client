/**
 * Os três eixos da cota de CHECAGEM (SPEC 069 §4.5, D-1) — cota
 * separada do envio frio, mesmo motor de decisão.
 *
 * Por que `evaluateColdSend` de novo
 *
 *   `checar um número` e `enviar frio` são o mesmo tipo de risco pelo
 *   mesmo motivo: os dois são tráfego automatizado, em volume, contra
 *   números que não pediram — o padrão que o antispam do WhatsApp
 *   observa. `evaluateColdSend` já sabe decidir "hora / dia / intervalo
 *   mínimo, com aquecimento" de forma genérica; escrever um segundo
 *   avaliador para o mesmo formato de decisão seria duplicar a lógica
 *   mais delicada do módulo só para trocar o nome das chaves.
 *
 * Por que `warmupDays` vem do eixo de ENVIO frio (D-1)
 *
 *   Uma instância nova é nova para TUDO — não faz sentido ela chegar
 *   aquecida para checar e fria para enviar, ou vice-versa. Duas rampas
 *   por instância criariam dois relógios medindo a mesma maturidade, e
 *   um deles inevitavelmente divergiria do outro (config diferente,
 *   bug de digitação). Uma rampa só, lida do eixo de envio, é a
 *   verdade única sobre "há quanto tempo este número está ativo".
 *
 * `silenceHours` não se aplica aqui, de propósito
 *
 *   O envio frio distingue "frio" de "quente" pela última mensagem do
 *   contato (`isColdSend`). Checagem não tem esse conceito — TODA
 *   checagem consome a cota, não importa se o contato já conversou.
 *   `ColdSendLimits.silenceHours` precisa existir para o tipo bater com
 *   `evaluateColdSend`, mas nada aqui o lê (`effectiveDailyLimit` e
 *   `evaluateColdSend` só tocam `perDay`/`perHour`/`minIntervalSeconds`/
 *   `warmupDays`) — fixado em `0` e documentado, não usado de fato.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

import type { ColdSendLimits } from '@/lib/channels/cold-send-limit';
import {
  loadLimitSourcesCached,
  type LimitScope,
  type LimitsCache,
} from '@/lib/limits/load';
import { resolveKey, type LimitSources } from '@/lib/limits/resolve';
import type { LimitLevel } from '@/lib/limits/registry';

export interface ResolvedCheckLimits {
  limits: ColdSendLimits;
  levels: Record<keyof ColdSendLimits, LimitLevel>;
}

/** Metade pura — monta `ColdSendLimits` a partir de fontes já lidas. */
export function readCheckLimitsFromSources(
  sources: LimitSources
): ColdSendLimits {
  return {
    silenceHours: 0, // não usado por evaluateColdSend — ver cabeçalho.
    perHour: resolveKey('evolution_check_per_hour', sources).value,
    perDay: resolveKey('evolution_check_per_day', sources).value,
    minIntervalSeconds: resolveKey(
      'evolution_check_min_interval_seconds',
      sources
    ).value,
    // D-1: a MESMA rampa do envio frio, não um eixo próprio.
    warmupDays: resolveKey('evolution_cold_send_warmup_days', sources).value,
  };
}

export function describeCheckLevels(
  sources: LimitSources
): Record<keyof ColdSendLimits, LimitLevel> {
  return {
    silenceHours: 'code', // eixo não lido — não há nível a reportar.
    perHour: resolveKey('evolution_check_per_hour', sources).level,
    perDay: resolveKey('evolution_check_per_day', sources).level,
    minIntervalSeconds: resolveKey(
      'evolution_check_min_interval_seconds',
      sources
    ).level,
    warmupDays: resolveKey('evolution_cold_send_warmup_days', sources).level,
  };
}

/** Metade impura — lê a cascata (com cache de ciclo opcional) e resolve. */
export async function resolveCheckLimits(
  db: SupabaseClient,
  scope: LimitScope,
  cache?: LimitsCache,
  env: Record<string, string | undefined> = process.env
): Promise<ResolvedCheckLimits> {
  const sources = await loadLimitSourcesCached(db, scope, cache, env);
  return {
    limits: readCheckLimitsFromSources(sources),
    levels: describeCheckLevels(sources),
  };
}
