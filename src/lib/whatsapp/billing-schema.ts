/**
 * Pedaços de infraestrutura compartilhados por `billing-signal.ts` (F3) e
 * `billing-server.ts` (F4) do monitor de cobrança (SPEC 076).
 *
 * Existem os dois porque o webhook/envio e a rota de leitura falam com as
 * mesmas peças da migração 086/087 e precisam concordar sobre DUAS coisas:
 * o que significa "isso não existe neste banco" e como se lê o flag D-10.
 * Cada módulo continua dono do SEU estado de processo (por quanto tempo
 * deixa de consultar uma peça ausente) — só o vocabulário é comum.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Códigos de "isso não existe no banco": tabela, coluna ou função
 * ausente — tanto do Postgres quanto do cache de schema do PostgREST.
 *
 * Um projeto Supabase sem a 086/087 aplicada (o `rs`, hoje) não pode
 * transformar cada status do webhook, ou cada abertura da aba, numa
 * consulta que falha e num `console.error`.
 */
export const SCHEMA_MISSING_CODES: ReadonlySet<string> = new Set([
  '42P01', // undefined_table
  '42703', // undefined_column
  '42883', // undefined_function
  'PGRST202', // função não encontrada no cache de schema
  'PGRST204', // coluna não encontrada no cache de schema
  'PGRST205', // tabela não encontrada no cache de schema
]);

/** Por quanto tempo uma peça ausente deixa de ser consultada. */
export const SCHEMA_RETRY_MS = 10 * 60 * 1000;

export function isSchemaMissingError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && SCHEMA_MISSING_CODES.has(code);
}

/** Mensagem de um erro de banco/Graph, para log. */
export function errMsg(error: unknown): unknown {
  return (error as { message?: string } | null)?.message ?? error;
}

/**
 * `platform_settings.whatsapp_billing_monitor_enabled` (D-10).
 *
 * `null` = a leitura falhou (inclui a COLUNA ausente num projeto sem a
 * 086) — distinto de `false` ("desligado"). Quem chama decide o que
 * "não sei" significa: a rota trata como desligado (404); a notificação
 * do webhook não dá o episódio por resolvido. Nunca lança.
 *
 * Sem cache de processo de propósito: é uma leitura por ponto de uma
 * linha única, e um cache faria o interruptor do `/admin` parecer
 * quebrado por alguns segundos.
 */
export async function readBillingMonitorFlag(
  db: SupabaseClient,
  tag: string
): Promise<boolean | null> {
  try {
    const { data, error } = await db
      .from('platform_settings')
      .select('whatsapp_billing_monitor_enabled')
      .maybeSingle();
    if (error) {
      console.error(
        `[${tag}] could not read whatsapp_billing_monitor_enabled:`,
        errMsg(error)
      );
      return null;
    }
    return data?.whatsapp_billing_monitor_enabled === true;
  } catch (err) {
    console.error(
      `[${tag}] flag read threw:`,
      err instanceof Error ? err.message : err
    );
    return null;
  }
}
