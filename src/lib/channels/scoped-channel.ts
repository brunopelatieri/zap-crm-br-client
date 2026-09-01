/**
 * Carrega o canal escolhido para um recurso, escopado à conta
 * (SPEC 065 §5.4 / §6).
 *
 * Quatro rotas — `POST`/`PATCH` de automações e `POST`/`PUT` de fluxos,
 * mais a ativação de fluxo — precisam da mesma linha, com o mesmo
 * cuidado de tenancy, antes de gravar `channel_id`. Uma função só para
 * que a próxima não nasça com um `.eq()` a menos.
 *
 * Mora em `lib/channels/` (e não junto de um dos motores) porque a
 * pergunta — "este canal é desta conta?" — é da camada de canais, e os
 * dois motores são apenas os primeiros a fazê-la.
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

import type { ChannelType } from './types';

/**
 * O mínimo de `channels` que as validações precisam. Definido aqui, do
 * lado de quem lê a linha; `lib/automations/validate.ts` o reexporta
 * para não quebrar quem já importava de lá.
 */
export interface ScopedChannel {
  id: string;
  type: ChannelType;
  status: string;
}

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
