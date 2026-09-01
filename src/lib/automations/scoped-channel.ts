/**
 * Carrega o canal escolhido para um recurso, escopado à conta
 * (SPEC 065 §5.4 / §6).
 *
 * Duas rotas de automação — `POST /api/automations` e
 * `PATCH /api/automations/[id]` — precisam da mesma linha, com o mesmo
 * cuidado de tenancy, antes de gravar `channel_id`. Uma função só para
 * que a segunda não nasça com um `.eq()` a menos.
 *
 * **O `account_id` na consulta não é decoração.** As rotas escrevem com
 * o cliente `service_role`, que ignora RLS: sem ele, um `channel_id` de
 * outra conta seria gravado sem reclamação, e a automação passaria a
 * apontar para um canal alheio — exatamente a linha que a asserção
 * final da migração 075 procura ("automacao apontando para canal de
 * outra conta"). Com ele, o id de outra conta simplesmente não devolve
 * linha, e o chamador responde 400 sem confirmar que o id existe.
 *
 * `null` significa as duas coisas de propósito: id inexistente e id de
 * outra conta. Quem chama não deve distinguir — distinguir É o
 * vazamento.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

import type { ScopedChannel } from './validate';

export async function loadScopedChannel(
  db: SupabaseClient,
  accountId: string,
  channelId: string | null | undefined
): Promise<ScopedChannel | null> {
  if (!channelId) return null;

  const { data, error } = await db
    .from('channels')
    .select('id, type, status')
    .eq('id', channelId)
    .eq('account_id', accountId)
    .maybeSingle();

  if (error) {
    // Falha FECHADA: "a consulta falhou" e "o canal não é seu" levam ao
    // mesmo 400 aqui de propósito. Tratar um erro transitório como
    // "canal válido" gravaria um escopo que ninguém verificou.
    console.error(
      `[scoped-channel] failed to read channel ${channelId}:`,
      error
    );
    return null;
  }

  return (data as ScopedChannel | null) ?? null;
}
