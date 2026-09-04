/**
 * A irmã de quatro níveis de `readColdSendLimits` (SPEC 069 §4.4).
 *
 * `readColdSendLimits(env)` continua existindo, com a assinatura e o
 * comportamento intactos: é a vista de `.env` + padrão de código, e é
 * ela que a rota de leitura de configuração usa. Esta aqui percorre a
 * cascata inteira — instância > conta > `.env` > código — para o caso
 * em que existe um canal e uma conta de quem falar.
 *
 * Por que duas funções e não uma com parâmetro opcional
 *
 *   Porque as duas têm naturezas diferentes: uma é síncrona e pura, a
 *   outra vai ao banco. Escondê-las atrás de uma assinatura só faria o
 *   call site não saber se está pagando um round-trip. E, mais
 *   importante, as duas montam o objeto pelo MESMO caminho
 *   (`readColdSendLimitsFromSources` sobre o registro): não existe um
 *   segundo lugar onde a política do envio frio seja decidida, que é a
 *   regra 5 do §3.4.
 *
 * O que NÃO muda com isto
 *
 *   Um deployment sem nada configurado — sem `.env`, sem plano, sem
 *   override de instância — resolve exatamente `COLD_SEND_DEFAULTS`.
 *   Essa é a promessa do R7, e é o primeiro teste de `resolve.test.ts`.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

import {
  readColdSendLimitsFromSources,
  describeColdSendLevels,
  type ColdSendLimits,
} from './cold-send-limit';
import {
  loadLimitSourcesCached,
  type LimitScope,
  type LimitsCache,
} from '@/lib/limits/load';
import type { LimitLevel } from '@/lib/limits/registry';

export interface ResolvedColdSendLimits {
  limits: ColdSendLimits;
  /** De qual nível veio cada eixo — o "herdando da conta" da UI (D-8). */
  levels: Record<keyof ColdSendLimits, LimitLevel>;
}

export async function resolveColdSendLimits(
  db: SupabaseClient,
  scope: LimitScope,
  cache?: LimitsCache,
  // Parâmetro, e não `process.env` implícito, pela mesma razão que em
  // `readColdSendLimits`: é o que torna a cascata testável sem mexer no
  // ambiente global — e um teste que depende do `.env` da máquina de
  // quem roda não prova política nenhuma.
  env: Record<string, string | undefined> = process.env
): Promise<ResolvedColdSendLimits> {
  const sources = await loadLimitSourcesCached(db, scope, cache, env);
  return {
    limits: readColdSendLimitsFromSources(sources),
    levels: describeColdSendLevels(sources),
  };
}
