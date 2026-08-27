/**
 * Precedência de limite efetivo (SPEC 060 §3.4) — o arquivo mais
 * importante da SPEC. A cadeia, do mais específico ao mais geral:
 *
 *   linha da política → padrão do `.env` daquela dimensão → sem limite
 *
 * `NULL`/coluna ausente na política = herda o padrão global daquela
 * dimensão. `0` explícito na política, OU padrão de `.env` resolvido
 * como `0` (já normalizado para `null` por `defaults.ts`) = sem
 * limite. Nunca confundir "não configurado" com "configurado para
 * apagar tudo" — é a regressão que este módulo existe para impedir.
 */

import type {
  EffectivePolicy,
  EffectivePolicyWithSource,
  RetentionChannelDefaults,
  RetentionPolicyRow,
  RetentionValueSource,
} from './types';

function resolveDimension(
  policyValue: number | null | undefined,
  defaultValue: number | null
): { value: number | null; source: RetentionValueSource } {
  // Linha ausente inteira chega aqui como `undefined` em cada campo —
  // mesmo tratamento de "herda o padrão" que um `NULL` explícito na
  // coluna receberia.
  if (policyValue !== undefined && policyValue !== null) {
    // `0` explícito é "sem limite" (§3.4), não o valor literal zero — a
    // ORIGEM continua sendo a política (a conta escolheu isso), só o
    // valor resolvido é que vira null.
    return { value: policyValue === 0 ? null : policyValue, source: 'policy' };
  }
  return {
    value: defaultValue,
    source: defaultValue === null ? 'unlimited' : 'default',
  };
}

/**
 * Linha bruta (snake_case) de `channel_retention_policies` → forma
 * TypeScript (camelCase). Um único lugar para essa conversão — achado
 * de code review, SPEC 060: antes disto era reescrita à mão em 3
 * pontos (GET/PUT de `route.ts`, `sweepOnePair`), cada um com seu
 * próprio `as number | null` silenciando o compilador exatamente onde
 * uma divergência de coluna precisaria aparecer.
 */
export function rowToPolicy(
  row: {
    max_messages: number | null;
    retention_days: number | null;
    max_favorites: number | null;
  } | null
): RetentionPolicyRow | null {
  if (!row) return null;
  return {
    maxMessages: row.max_messages,
    retentionDays: row.retention_days,
    maxFavorites: row.max_favorites,
  };
}

export function resolveEffectivePolicy(
  row: RetentionPolicyRow | null,
  defaults: RetentionChannelDefaults
): EffectivePolicy {
  const r = row ?? {};
  return {
    maxMessages: resolveDimension(r.maxMessages, defaults.maxMessages).value,
    retentionDays: resolveDimension(r.retentionDays, defaults.retentionDays)
      .value,
    maxFavorites: resolveDimension(r.maxFavorites, defaults.maxFavorites).value,
  };
}

/** Mesma resolução, mas carregando a origem de cada dimensão para a UI (§8.2). */
export function resolveEffectivePolicyWithSource(
  row: RetentionPolicyRow | null,
  defaults: RetentionChannelDefaults
): EffectivePolicyWithSource {
  const r = row ?? {};
  const maxMessages = resolveDimension(r.maxMessages, defaults.maxMessages);
  const retentionDays = resolveDimension(
    r.retentionDays,
    defaults.retentionDays
  );
  const maxFavorites = resolveDimension(r.maxFavorites, defaults.maxFavorites);
  return {
    maxMessages: maxMessages.value,
    retentionDays: retentionDays.value,
    maxFavorites: maxFavorites.value,
    maxMessagesSource: maxMessages.source,
    retentionDaysSource: retentionDays.source,
    maxFavoritesSource: maxFavorites.source,
  };
}
