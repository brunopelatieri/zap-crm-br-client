/**
 * Quais canais podem ser ESCOLHIDOS num seletor (SPEC 065 §5.1).
 *
 * Por que existe
 *
 *   A pergunta "quais canais entram neste seletor" estava escrita
 *   QUATRO vezes, com critérios sutilmente diferentes:
 *
 *     - `components/broadcasts/step4-schedule-send.tsx:105-141`
 *       `type === 'whatsapp_cloud' && status !== 'disabled'`, ordenado
 *       por saúde e depois por padrão — o critério CERTO, com um
 *       comentário longo explicando o bug que ele corrigiu;
 *     - `components/contacts/contact-detail-view.tsx:108-130`
 *       `status === 'connected' && can(type, 'templates')` — o critério
 *       ERRADO, que é exatamente o que aquele comentário desaconselha;
 *     - `hooks/use-fallback-channels.ts` e `hooks/use-transfer-channels.ts`
 *       leem `channels` cru e decidem elegibilidade em outro lugar
 *       (`window-fallback.ts` / `transfer.ts`).
 *
 *   O bug que a divergência causou, registrado no passo 4: filtrar por
 *   `status === 'connected'` com o canal PADRÃO em `error` e um segundo
 *   canal saudável deixava a lista com um item só — o seletor sumia
 *   ("não há escolha a fazer") e a campanha saía pelo padrão QUEBRADO.
 *   Esconder o número com problema é o oposto de deixar trocá-lo.
 *
 * As regras, uma vez só
 *
 *   1. Exclui `status = 'disabled'` — e SÓ ele. É o estado que "remover
 *      número" cria (SPEC 064 D-12): segredo zerado, canal preservado.
 *      Um canal desativado não envia nada e não pode ser escolhido.
 *   2. **Nunca** exclui `error` / `disconnected` / `connecting`. Eles
 *      aparecem na lista, com selo, PARA PODEREM SER TROCADOS. É o
 *      mesmo critério que o servidor usa para resolver o padrão
 *      (`resolveDefaultChannelId` / `resolveCloudConfig`), e a lista da
 *      UI não pode ser mais restrita que ele — senão o operador escolhe
 *      um número que o servidor recusa, ou (pior) não escolhe nada e o
 *      servidor manda pelo quebrado.
 *   3. Filtra por CAPACIDADE, não por tipo. `capabilities.ts` já é a
 *      fonte única de "este canal sabe fazer isto"; comparar
 *      `type === 'whatsapp_cloud'` à mão faz o próximo canal (Instagram,
 *      e-mail) nascer invisível em todo seletor.
 *   4. Ordena `connected` antes de `is_default`. A UI pré-seleciona
 *      `[0]`, e um padrão em `error` não pode ganhar de um número
 *      saudável só por ser o padrão.
 *
 * O que este módulo NÃO faz
 *
 *   Escopo de conta. A lista já chega escopada — por RLS
 *   (`channels_select` = `is_account_member`) no cliente, e por
 *   `.eq('account_id', …)` no servidor. Refiltrar aqui daria a falsa
 *   impressão de que passar canais de outra conta é seguro.
 */

import { can } from './capabilities';
import type { Channel } from './types';

/**
 * Para que serve o seletor. Decide qual capacidade o canal precisa ter.
 *
 * `'scope'` não pede capacidade nenhuma de propósito: escopar uma
 * automação ("vale para o número X") é dizer PARA QUAIS CONVERSAS ela
 * vale, não por onde ela responde — e escopar a uma instância QRCode é
 * legítimo, mesmo que ela não envie template nem disparo em massa.
 */
export type ChannelPurpose = 'broadcast' | 'templates' | 'scope';

/** Capacidade exigida por propósito. `null` = qualquer canal serve. */
const REQUIRED_CAPABILITY: Record<
  ChannelPurpose,
  'broadcast' | 'templates' | null
> = {
  broadcast: 'broadcast',
  templates: 'templates',
  scope: null,
};

/**
 * Canais que podem ser escolhidos para um propósito, **na ordem em que a
 * UI deve mostrá-los**.
 *
 * Não muta a lista recebida. A ordenação é estável: canais empatados em
 * saúde e em padrão saem na ordem em que entraram (normalmente a do
 * banco: padrão primeiro, depois do mais antigo para o mais novo — a
 * mesma de `listCloudChannels`).
 */
export function selectableChannels(
  channels: Channel[],
  purpose: ChannelPurpose
): Channel[] {
  const capability = REQUIRED_CAPABILITY[purpose];

  return channels
    .filter((c) => {
      // Regra 1 e 2: só `disabled` sai. Ver o cabeçalho antes de
      // acrescentar qualquer outro status aqui.
      if (c.status === 'disabled') return false;
      return capability === null || can(c.type, capability);
    })
    .sort((a, b) => {
      const byHealth =
        Number(b.status === 'connected') - Number(a.status === 'connected');
      if (byHealth !== 0) return byHealth;
      return Number(b.is_default) - Number(a.is_default);
    });
}
