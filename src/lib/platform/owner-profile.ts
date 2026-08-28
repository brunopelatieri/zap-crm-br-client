/**
 * O proprietário da plataforma tem conta de cliente neste banco?
 * (SPEC 062 §4.4, §7.3)
 *
 * `PLATFORM_OWNER_EMAILS` é só uma lista de e-mails — nada impede (nem
 * deveria) que esse mesmo e-mail também seja dono de uma conta comum
 * aqui. É o caso normal, aliás, em deployment de um operador só. Sem
 * saber QUAL conta e QUAL usuário são dele, o console não consegue
 * barrar o autobloqueio, e o proprietário se tranca para fora com um
 * clique — sem tela para desfazer, porque a tela mora atrás da conta
 * que ele acabou de bloquear (§11: "Saída: `UPDATE accounts SET
 * blocked_at = NULL` por SQL").
 *
 * Devolve `null` nos dois campos quando ele não tem perfil aqui — o que
 * é perfeitamente válido, e nesse caso a guarda por e-mail em
 * `guards.ts` é a única que se aplica.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export interface OwnerSelfRefs {
  ownerUserId: string | null;
  ownerAccountId: string | null;
}

export async function loadOwnerSelfRefs(
  db: SupabaseClient,
  ownerUserId: string
): Promise<OwnerSelfRefs> {
  const { data, error } = await db
    .from('profiles')
    .select('user_id, account_id')
    .eq('user_id', ownerUserId)
    .maybeSingle();

  if (error) {
    console.error(
      '[platform/owner-profile] falha ao resolver o perfil do proprietario:',
      error.message
    );
    // Falha fechada para a guarda: sem saber quem ele é, a rota ainda
    // compara por e-mail, e o id do usuário da SESSÃO é conhecido de
    // qualquer forma — devolvê-lo mantém `canBlockUser` capaz de barrar
    // o autobloqueio mais óbvio.
    return { ownerUserId, ownerAccountId: null };
  }

  return {
    ownerUserId: (data?.user_id as string) ?? ownerUserId,
    ownerAccountId: (data?.account_id as string) ?? null,
  };
}
