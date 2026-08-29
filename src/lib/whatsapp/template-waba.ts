/**
 * Resolve a local `message_templates` row by (name, language) FOR A
 * SPECIFIC WABA (SPEC 064 D-2/F5).
 *
 * Why not `.eq('name', name).eq('language', language).maybeSingle()`
 *
 *   That was safe while `message_templates` only ever had one number
 *   per account (migration 072 didn't exist). With two WABAs on the
 *   same account, the same name+language legitimately exists TWICE —
 *   Meta scopes templates per WABA, not per account — and
 *   `.maybeSingle()` throws "multiple rows returned" the moment a
 *   second WABA gets its first same-named template.
 *
 * The adoption rule (same one `templates/sync/route.ts` already uses)
 *
 *   The row that already belongs to THIS WABA wins. Failing that, a
 *   legacy row (`waba_id IS NULL`, written before the 072 backfill)
 *   is adopted — it's the only candidate, so it must be the one this
 *   number sends. Never "the first row the query happens to return".
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function findTemplateRowForWaba(
  db: SupabaseClient,
  params: {
    accountId: string;
    name: string;
    language: string;
    /** WABA of the channel resolving the send/edit. `null` matches only legacy rows. */
    wabaId: string | null;
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any | null> {
  const { accountId, name, language, wabaId } = params;
  const { data: candidates, error } = await db
    .from('message_templates')
    .select('*')
    .eq('account_id', accountId)
    .eq('name', name)
    .eq('language', language);

  // Degrada, não propaga: todo chamador que esta função substitui lia
  // com `.maybeSingle()` sem checar `error` — uma falha transitória de
  // leitura virava "sem linha local" e o envio seguia sem os
  // componentes do template (caminho já suportado, ver `templateRow:
  // null` nos chamadores). Lançar aqui trocaria "um soluço do Supabase
  // manda a mensagem sem cabeçalho/botões" por "um soluço do Supabase
  // derruba a campanha inteira com 500".
  if (error) {
    console.error(
      `[template-waba] failed to read message_templates for ${name}/${language}:`,
      error
    );
    return null;
  }
  if (!candidates?.length) return null;

  // `?? null` normaliza `undefined` (linha de teste/fixture sem a coluna,
  // ou um SELECT que não a trouxe) para o mesmo valor que a Meta/Postgres
  // devolvem quando ela é legítima — sem isto, um candidato legado sem a
  // chave `waba_id` no objeto nunca bateria com `null`.
  return (
    candidates.find((c) => (c.waba_id ?? null) === wabaId) ??
    candidates.find((c) => (c.waba_id ?? null) === null) ??
    null
  );
}
