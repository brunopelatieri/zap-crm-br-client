/**
 * `emitSystemEvent` — grava um evento na outbox (SPEC 063 §1, §7).
 * Server-only, `service_role`.
 *
 * Grava primeiro (regra 1 da §1): a chamada retorna assim que a linha
 * está no banco, e a entrega em si acontece depois, fora do caminho da
 * resposta, via `after()` (porta 1, §5) — a fase 6 do cron (porta 2) é
 * a rede de segurança para tudo que a porta 1 perder.
 *
 * `dedupe_key` com violação de unicidade (23505) é tratado como
 * "já existe, nada a fazer" — o equivalente prático de
 * `ON CONFLICT (dedupe_key) DO NOTHING` sem depender de upsert com
 * predicado parcial (Postgres exige que o alvo do ON CONFLICT bata
 * exatamente com o índice parcial, o que o upsert do PostgREST não
 * expressa).
 *
 * Nunca lança — um evento que falha ao ser registrado é ruim, mas
 * jamais pode derrubar a ação que o originou (§1, o princípio que
 * organiza toda a SPEC).
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { after } from 'next/server';

import { supabaseAdmin } from '@/lib/supabase/admin';
import { isUniqueViolation } from '@/lib/contacts/dedupe';
import { buildEventPayload, type EmitSystemEventInput } from './types';
import { dedupeKeyFor } from './dedupe';
import { deliverOne } from './dispatch';

/**
 * `db` é opcional, não um parâmetro com default: `supabaseAdmin()` só
 * pode ser resolvido DENTRO do `try` abaixo. Um default de parâmetro é
 * avaliado na hora da chamada, fora de qualquer `try/catch` da função —
 * se `supabaseAdmin()` lançasse ali (ex.: `SUPABASE_SERVICE_ROLE_KEY`
 * ausente num fork), a promise que `emitSystemEvent` devolve rejeitaria
 * sem que o "nunca lança" documentado abaixo valesse — achado de code
 * review: `getCurrentAccount()` chama isto com `void` e sem `.catch()`
 * em toda requisição, e a rota de solicitação de plano dá `await` nisto
 * dentro do MESMO `try/catch` da própria ação.
 */
export async function emitSystemEvent(
  input: EmitSystemEventInput,
  db?: SupabaseClient,
  now: Date = new Date()
): Promise<void> {
  try {
    const client = db ?? supabaseAdmin();
    const dedupeKey = dedupeKeyFor(input, now);
    const payload = buildEventPayload(input, now);

    const { data: inserted, error } = await client
      .from('system_notifications')
      .insert({
        type: input.type,
        account_id: input.accountId,
        payload,
        dedupe_key: dedupeKey,
      })
      .select('id')
      .maybeSingle();

    if (error) {
      if (isUniqueViolation(error)) return; // já emitido — dedupe fez o trabalho
      console.error('[notifications/emit] insert failed:', error.message);
      return;
    }
    if (!inserted) return;

    const id = inserted.id as string;
    scheduleDelivery(id, client);
  } catch (err) {
    console.error('[notifications/emit] emitSystemEvent failed:', err);
  }
}

/**
 * Porta 1 (§5): entrega em segundos, sem segurar a resposta. `after()`
 * só pode ser chamado dentro do ciclo de vida de uma requisição —
 * chamadores fora desse contexto (scripts, testes, um `after()` já em
 * andamento no cron) fazem esta chamada lançar; o `catch` aqui garante
 * que a gravação acima nunca é derrubada por isso. Nesses casos a
 * porta 2 (a varredura do cron) entrega.
 */
function scheduleDelivery(id: string, db: SupabaseClient): void {
  try {
    after(async () => {
      await deliverOne(id, db, new Date());
    });
  } catch (err) {
    console.warn(
      '[notifications/emit] could not schedule after() delivery, relying on the cron sweep:',
      err instanceof Error ? err.message : err
    );
  }
}
