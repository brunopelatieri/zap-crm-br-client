/**
 * Leitura de `platform_settings.retention_defaults` — o padrão global
 * de retenção que o console edita (SPEC 062 §3.8, §5.3).
 *
 * Um único lugar que conhece o nome da coluna. Duas portas com
 * semânticas de falha DIFERENTES, de propósito:
 *
 *   - as rotas do console (`/api/platform/retention*`) deixam o erro
 *     subir e viram 500 — quem está olhando é uma pessoa que precisa
 *     saber que a leitura falhou antes de salvar por cima;
 *   - `sweep.ts` embrulha em try/catch e cai no `.env` puro, porque a
 *     varredura NUNCA pode abortar o ciclo por causa desta leitura
 *     (§11) — inclusive num projeto onde a 069 ainda não rodou e a
 *     coluna nem existe.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

import {
  readRetentionDefaults,
  type EnvSource,
} from '@/lib/retention/defaults';
import { mergeGlobalDefaults } from '@/lib/retention/global-defaults';
import type { RetentionDefaults } from '@/lib/retention/types';

/**
 * O JSONB cru, como objeto. Linha ausente, `NULL` ou valor que não seja
 * objeto viram `{}` — "console não configurou nada". Lança em erro de
 * banco (o chamador decide o que fazer com isso).
 */
export async function readPlatformRetentionDefaults(
  db: SupabaseClient
): Promise<Record<string, unknown>> {
  const { data, error } = await db
    .from('platform_settings')
    .select('retention_defaults')
    .eq('id', true)
    .maybeSingle();
  if (error) throw error;

  const raw = data?.retention_defaults;
  return typeof raw === 'object' && raw !== null && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {};
}

/**
 * A cadeia da §5.3 já resolvida até o nível global:
 * `padrão global do console → padrão do .env`. É o que as telas do
 * console e a varredura precisam passar adiante para `policy.ts`
 * resolver o último nível (a linha da conta).
 */
export async function loadMergedRetentionDefaults(
  db: SupabaseClient,
  env: EnvSource = process.env
): Promise<RetentionDefaults> {
  const fromEnv = readRetentionDefaults(env);
  const fromConsole = await readPlatformRetentionDefaults(db);
  return mergeGlobalDefaults(fromConsole, fromEnv);
}
