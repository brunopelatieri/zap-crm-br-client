/**
 * A metade impura da cascata (SPEC 069 §4.3): lê os níveis 1a e 1b do
 * banco e entrega tudo pronto para `resolve.ts` decidir.
 *
 * Uma chamada, não uma por chave
 *
 *   `account_effective_limits(account_id)` devolve o JSONB inteiro de
 *   uma vez (`plans.limits || account_plans.limit_overrides`). Chamar
 *   `plan_limit()` por chave seria 11 round-trips para resolver um
 *   único envio — e no cron da F5, 11 por contato.
 *
 * Nenhuma leitura falha para cima
 *
 *   Todo acesso ao banco aqui é best-effort. Se a RPC não existe, se a
 *   RLS barra, se a rede cai — o resultado é "este nível não
 *   respondeu", com aviso, e a cascata desce para o `.env` e o padrão
 *   de código. É a regra 2 do §3.4 aplicada à origem do dado, e não só
 *   ao formato dele: uma oscilação de banco não pode virar "sem teto"
 *   (perigoso) nem derrubar o envio (pior ainda, porque um teto de
 *   segurança que quebra o produto quando o banco tosse é um teto que
 *   alguém vai querer desligar).
 *
 * O cache é do chamador, não deste módulo
 *
 *   A memoização que o §4.3 pede é "dentro da requisição": o cron
 *   resolve uma vez por instância por ciclo, não uma vez por contato.
 *   Um `Map` no escopo do módulo faria isso — e, num servidor Next de
 *   vida longa, também serviria um limite VELHO por tempo
 *   indeterminado depois de o proprietário mudar o plano. O operador
 *   mexeria no painel, nada aconteceria, e ele concluiria que o
 *   produto está quebrado: exatamente o bug que o D-8 existe para
 *   evitar, reinventado como cache. Por isso o cache é um objeto
 *   explícito, criado por quem sabe qual é o começo e o fim do ciclo.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

import { isIntegerLimit, LIMIT_ENTRIES } from './registry';
import {
  resolveLimitValue,
  type LimitSources,
  type ResolvedLimit,
} from './resolve';

export interface LimitScope {
  /** Conta dona do recurso. Ausente = o nível 1a não participa. */
  accountId?: string | null;
  /** Canal da instância Evolution. Ausente = o nível 1b não participa. */
  channelId?: string | null;
}

/**
 * Cache de um ciclo. `createLimitsCache()` no começo da execução do
 * cron, descartado no fim — a vida dele é a vida do ciclo, e não a do
 * processo.
 */
export type LimitsCache = Map<string, Promise<LimitSources>>;

export function createLimitsCache(): LimitsCache {
  return new Map();
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Lê os dois níveis de banco. Nunca lança e nunca devolve `undefined`
 * no lugar de um objeto: no pior caso os dois vêm vazios, o que a
 * cascata lê como "ninguém configurou nada aqui".
 */
export async function loadLimitSources(
  db: SupabaseClient,
  scope: LimitScope,
  env: Record<string, string | undefined> = process.env
): Promise<LimitSources> {
  let account: Record<string, unknown> = {};
  let instance: Record<string, unknown> = {};

  try {
    const [accountRes, instanceRes] = await Promise.all([
      scope.accountId
        ? db.rpc('account_effective_limits', { p_account_id: scope.accountId })
        : Promise.resolve({ data: null, error: null }),
      scope.channelId
        ? db
            .from('evolution_instances')
            .select('limit_overrides')
            .eq('channel_id', scope.channelId)
            .maybeSingle()
        : Promise.resolve({ data: null, error: null }),
    ]);

    if (accountRes.error) {
      console.warn(
        `[limits/load] account_effective_limits falhou (${accountRes.error.message}) — nível de conta ignorado neste ciclo.`
      );
    } else if (isPlainObject(accountRes.data)) {
      account = accountRes.data;
    }

    if (instanceRes.error) {
      console.warn(
        `[limits/load] leitura de evolution_instances.limit_overrides falhou (${instanceRes.error.message}) — nível de instância ignorado neste ciclo.`
      );
    } else {
      const raw = (instanceRes.data as { limit_overrides?: unknown } | null)
        ?.limit_overrides;
      if (isPlainObject(raw)) instance = raw;
    }
  } catch (err) {
    // Cliente sem `rpc`, sessão derrubada, timeout: os níveis de banco
    // simplesmente não respondem, e o `.env`/código respondem por eles.
    console.warn(
      `[limits/load] níveis de banco indisponíveis (${err instanceof Error ? err.message : String(err)}) — resolvendo por .env e padrão de código.`
    );
  }

  return { account, instance, env };
}

function cacheKey(scope: LimitScope): string {
  return `${scope.accountId ?? '-'}|${scope.channelId ?? '-'}`;
}

/** `loadLimitSources` memoizado no cache que o chamador passar. */
export function loadLimitSourcesCached(
  db: SupabaseClient,
  scope: LimitScope,
  cache?: LimitsCache,
  env: Record<string, string | undefined> = process.env
): Promise<LimitSources> {
  if (!cache) return loadLimitSources(db, scope, env);

  const key = cacheKey(scope);
  const hit = cache.get(key);
  if (hit) return hit;

  // A PROMESSA vai para o cache, não o resultado: duas resoluções
  // disparadas no mesmo tick compartilham o round-trip em vez de
  // fazerem dois.
  const pending = loadLimitSources(db, scope, env);
  cache.set(key, pending);
  return pending;
}

/**
 * Resolve TODAS as chaves numéricas do catálogo para um escopo.
 * `loadEvolutionLimits` é o nome que a SPEC usa (§4.3).
 */
export async function loadEvolutionLimits(
  db: SupabaseClient,
  scope: LimitScope,
  cache?: LimitsCache,
  env: Record<string, string | undefined> = process.env
): Promise<Record<string, ResolvedLimit>> {
  const sources = await loadLimitSourcesCached(db, scope, cache, env);
  const out: Record<string, ResolvedLimit> = {};
  for (const entry of LIMIT_ENTRIES) {
    if (isIntegerLimit(entry)) {
      out[entry.key] = resolveLimitValue(entry, sources);
    }
  }
  return out;
}
