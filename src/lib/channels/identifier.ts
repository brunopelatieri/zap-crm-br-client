/**
 * Quando `channels.identifier` pode ser exibido como telefone
 * (SPEC 064 D-9 / §1.1.E.2).
 *
 * O problema
 *
 *   O backfill da migração 055 gravou `identifier = phone_number_id`
 *   nos canais Cloud — um id opaco da Meta, todo em dígitos. E
 *   `transfer-channel-dialog.tsx` já rodava `formatPhoneForDisplay()`
 *   nesse valor, exibindo `+892352847302912` como se fosse o telefone
 *   do número oficial. A migração não podia consertar o dado: converter
 *   `phone_number_id` em telefone exige perguntar à Graph API, e
 *   migração que precisa de token da Meta não é migração.
 *
 *   A F4 reconcilia nos dois pontos que já falam com a Meta — o `POST`
 *   de salvamento e o `GET` de diagnóstico —, mas o canal só é
 *   reconciliado quando alguém passa por lá. Entre o deploy e esse
 *   primeiro toque, o valor antigo continua no banco.
 *
 * A regra
 *
 *   Só formata o que sabemos ser telefone. Na dúvida, devolve `null` —
 *   e a tela mostra o rótulo do canal, que é exatamente o que o D-9
 *   descreve ("mostra o telefone quando ele existe e o rótulo do canal
 *   quando não").
 *
 *   1. `whatsapp_qr` — o adaptador Evolution grava o telefone pareado
 *      (`bindChannelToPhone`), nunca um id. Sempre formata.
 *   2. `whatsapp_cloud` com o `phone_number_id` em mãos — comparação
 *      exata: igual ao `identifier` significa "ainda é o valor do
 *      backfill". É o caminho preciso, e é o que a rota de configuração
 *      usa, porque ela tem as duas informações.
 *   3. `whatsapp_cloud` sem essa informação (o diálogo de
 *      transferência, que só carrega `channels`) — cai na heurística de
 *      tamanho: `phone_number_id` da Meta tem 15 dígitos, e um telefone
 *      de exibição em E.164 vai até 15 mas na prática fica em 11-14.
 *      15 dígitos, portanto, é tratado como id. O erro possível é para
 *      o lado seguro: um telefone raríssimo de 15 dígitos aparece como
 *      rótulo em vez de número — nunca o contrário.
 */

import { formatPhoneForDisplay } from '@/lib/phone/br';
import { sanitizePhoneForMeta } from '@/lib/whatsapp/phone-utils';

import type { ChannelType } from './types';

/** Comprimento de um `phone_number_id` da Meta. */
const META_PHONE_NUMBER_ID_DIGITS = 15;

export function channelIdentifierIsPhone(
  channel: { type: ChannelType; identifier: string | null | undefined },
  opts?: { phoneNumberId?: string | null }
): boolean {
  const digits = sanitizePhoneForMeta(channel.identifier ?? '');
  if (!digits) return false;
  if (channel.type !== 'whatsapp_cloud') return true;

  const phoneNumberId = opts?.phoneNumberId
    ? sanitizePhoneForMeta(opts.phoneNumberId)
    : null;
  if (phoneNumberId) return digits !== phoneNumberId;

  return digits.length < META_PHONE_NUMBER_ID_DIGITS;
}

/**
 * O telefone do canal, pronto para a tela — ou `null` quando não dá
 * para afirmar que é um telefone. Quem chama mostra o rótulo do canal
 * nesse caso; nunca o valor cru.
 */
export function channelIdentifierDisplay(
  channel: { type: ChannelType; identifier: string | null | undefined },
  opts?: { phoneNumberId?: string | null }
): string | null {
  if (!channelIdentifierIsPhone(channel, opts)) return null;
  return formatPhoneForDisplay(channel.identifier ?? '') || null;
}
