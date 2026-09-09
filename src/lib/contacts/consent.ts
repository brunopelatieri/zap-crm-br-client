/**
 * Consentimento de contato — leitura e escrita (SPEC 044 §6.8).
 *
 * Três coisas moram aqui:
 *
 *   1. `setContactOptIn` — o ÚNICO caminho de escrita. Envolve a RPC
 *      `set_contact_opt_in` (migração 048), que grava o estado em
 *      `contacts` e o evento em `contact_consent_events` na mesma
 *      transação. Escrever `opt_in_status` direto pela tabela funciona
 *      no SQL e é errado: deixaria a trilha com um buraco exatamente no
 *      registro que alguém vai precisar mostrar depois.
 *   2. `excludesOptedOut` — a regra de PRODUTO da §6.8, em um lugar só.
 *   3. `isOptedOut` — o predicado, para o filtro em memória do envio.
 *
 * Por que a exclusão é por categoria de template
 *
 *   A §6.8 diz "`opted_out` **nunca** entra em audiência de marketing".
 *   Não diz "nunca recebe mensagem": um template Utility ("seu pedido
 *   saiu para entrega") é legítimo para quem cancelou marketing, e
 *   bloqueá-lo transformaria um pedido de "pare de me vender coisas" em
 *   "pare de me avisar do que eu comprei".
 *
 *   Categoria ausente ou desconhecida conta como marketing — o lado
 *   conservador é o único aceitável quando a dúvida é "posso mandar
 *   propaganda para quem pediu para sair?".
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { recordActivity } from '@/lib/activity/record';
import type { OptInStatus, ConsentSource } from './consent-rules';

// Reexportados para os chamadores SERVER-ONLY que já importavam daqui —
// código que chega ao browser deve importar de `consent-rules.ts` direto
// (ver o cabeçalho daquele arquivo).
export { excludesOptedOut, isOptedOut } from './consent-rules';
export type { OptInStatus, ConsentSource };

export interface SetContactOptInParams {
  contactId: string;
  status: OptInStatus;
  source: ConsentSource;
  /** Só para `inbound_keyword`: a frase normalizada que casou. */
  keyword?: string | null;
  /** Só para `inbound_keyword`: o id da mensagem na Meta. */
  whatsappMessageId?: string | null;
  /**
   * SPEC 075 F4 — necessário só para o feed de atividade
   * (`account_activity_log.account_id` não tem como ser inferido daqui
   * dentro; a RPC não devolve a conta do contato). Opcional para não
   * quebrar um chamador futuro que ainda não tenha a conta em mãos —
   * nesse caso o evento simplesmente não é gravado.
   */
  accountId?: string;
  /**
   * Só para `source: 'manual'` — o único source com um humano por trás.
   * Sem isto o evento é atribuído a `actor.kind: 'system'` como os
   * demais sources automáticos.
   */
  actorUserId?: string;
}

export interface SetContactOptInResult {
  contactId: string;
  status: OptInStatus;
  updatedAt: string;
  /** `false` quando o contato já estava neste estado. */
  changed: boolean;
}

/**
 * Grava o consentimento e o evento de trilha.
 *
 * Escopo: a RPC é `SECURITY INVOKER`, então quem decide se este contato
 * pode ser alterado é a RLS de `contacts` — o cliente SSR do usuário
 * fica limitado à conta dele, e o cliente de service-role (webhook)
 * alcança qualquer conta, que é o necessário para atender um inbound.
 */
export async function setContactOptIn(
  db: SupabaseClient,
  params: SetContactOptInParams
): Promise<SetContactOptInResult> {
  const { data, error } = await db.rpc('set_contact_opt_in', {
    p_contact_id: params.contactId,
    p_status: params.status,
    p_source: params.source,
    p_keyword: params.keyword ?? null,
    p_whatsapp_message_id: params.whatsappMessageId ?? null,
  });

  if (error) throw error;

  // `RETURNS TABLE` chega como array de uma linha.
  const row = (
    data as
      | {
          contact_id: string;
          opt_in_status: OptInStatus;
          opt_in_updated_at: string;
          changed: boolean;
        }[]
      | null
  )?.[0];

  if (!row) {
    throw new Error('set_contact_opt_in returned no row');
  }

  // SPEC 075 F4 — só `opted_out`/`opted_in` pertencem ao catálogo (§4);
  // `unknown` fica fora, e um estado que não MUDOU (`changed === false`,
  // ex.: pedir "sair" duas vezes) não vira uma segunda linha de feed.
  if (
    row.changed &&
    params.accountId &&
    (row.opt_in_status === 'opted_out' || row.opt_in_status === 'opted_in')
  ) {
    // `actor.kind: 'system'` para os sources automáticos
    // (`inbound_keyword`, `import`, `api`, `automation`) — nenhum tem um
    // `userId` de agente. `manual` é o único source com um humano por
    // trás; quando o chamador passa `actorUserId`, atribui a ele.
    await recordActivity(db, {
      accountId: params.accountId,
      resourceType: 'contact',
      action:
        row.opt_in_status === 'opted_out'
          ? 'contact.opted_out'
          : 'contact.opted_in',
      resourceId: row.contact_id,
      contactId: row.contact_id,
      actor:
        params.source === 'manual' && params.actorUserId
          ? { kind: 'user', userId: params.actorUserId }
          : { kind: 'system', name: params.source },
      source: { table: 'contact_consent_events', id: row.contact_id },
      metadata: { source: params.source, keyword: params.keyword ?? null },
    });
  }

  return {
    contactId: row.contact_id,
    status: row.opt_in_status,
    updatedAt: row.opt_in_updated_at,
    changed: row.changed,
  };
}
