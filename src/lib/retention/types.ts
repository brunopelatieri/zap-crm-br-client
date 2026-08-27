/**
 * Fonte de verdade das chaves e formas do motor de retenção (SPEC 060
 * §5). Espelha a migração 068: `RetentionChannelType` é o `ChannelType`
 * de `@/lib/channels/types` (reexportado, não redeclarado — a migração
 * usa o mesmo CHECK, e duas listas divergindo seria o pior jeito de
 * descobrir isso).
 */

import type { ChannelType } from '@/lib/channels/types';

export type RetentionChannelType = ChannelType;

/** Uma dimensão da política: `null` = sem limite nesse nível. */
export type RetentionLimitValue = number | null;

/**
 * Linha de `channel_retention_policies` (ou ausência dela — o
 * chamador passa `null` quando a conta não configurou nada para este
 * canal). `NULL` numa coluna e coluna ausente da linha são a MESMA
 * coisa aqui — "herda o padrão global daquela dimensão" — e é por isso
 * que os três campos são `number | null | undefined`: `undefined`
 * nunca deveria ocorrer vindo do banco, mas o tipo aceita para não
 * forçar um `!` no call site que lê a linha do Supabase.
 */
export interface RetentionPolicyRow {
  maxMessages?: number | null;
  retentionDays?: number | null;
  maxFavorites?: number | null;
}

/** Padrões lidos do `.env`, por tipo de canal (SPEC 060 §15). */
export interface RetentionChannelDefaults {
  maxMessages: RetentionLimitValue;
  retentionDays: RetentionLimitValue;
  maxFavorites: RetentionLimitValue;
}

export interface RetentionDefaults {
  enabled: boolean;
  minAgeHours: number;
  intervalHours: number;
  batchLimit: number;
  whatsapp_cloud: RetentionChannelDefaults;
  whatsapp_qr: RetentionChannelDefaults;
}

/** A tabela da §3.4, já resolvida — o que `purge_channel_messages` recebe. */
export interface EffectivePolicy {
  maxMessages: RetentionLimitValue;
  retentionDays: RetentionLimitValue;
  maxFavorites: RetentionLimitValue;
}

/**
 * Origem de cada dimensão da política efetiva — a UI (§8.2) precisa
 * distinguir "5.000 porque é o padrão do sistema" de "5.000 porque
 * alguém digitou". Um campo por dimensão, não um enum só, porque as
 * três podem ter origens diferentes na mesma linha (§3.4: "dá para
 * fixar só retention_days e deixar max_messages no padrão").
 */
export type RetentionValueSource = 'policy' | 'default' | 'unlimited';

export interface EffectivePolicyWithSource extends EffectivePolicy {
  maxMessagesSource: RetentionValueSource;
  retentionDaysSource: RetentionValueSource;
  maxFavoritesSource: RetentionValueSource;
}

/** Retorno de `purge_channel_messages` (migração 068 §4.1). */
export interface RetentionPurgeResult {
  by_age: number;
  by_count: number;
  favorites_demoted: number;
  favorites_total: number;
  messages_total: number;
  truncated: boolean;
}

/** Agregado de um ciclo inteiro da varredura — vira `last_result`. */
export interface RetentionRunResult {
  accounts: number;
  by_age: number;
  by_count: number;
  favorites_demoted: number;
  truncated: boolean;
  errors: number;
}
