/**
 * Quando `channels.status` pode barrar um envio (SPEC 064 F3/F4).
 *
 * O problema que este módulo resolveu
 *
 *   `channels.status` só tinha escritor para **um** tipo. O fluxo do
 *   WhatsApp QRCode escreve `connecting`/`connected`/`error`/`disabled`
 *   (`lib/evolution/instances.ts`), e ali o valor reflete a conexão de
 *   verdade. Para `whatsapp_cloud` **ninguém escrevia a coluna**: a
 *   linha nascia do backfill da migração 055 e ficava congelada nele —
 *   `POST /api/whatsapp/config` sequer tocava a tabela `channels` (o
 *   bug §1.1.E.1). Recusar um envio por causa daquele valor testava uma
 *   coluna que ninguém mantinha: em `vn`, o único número oficial dizia
 *   `disconnected` com `whatsapp_config` em `connected` — e enviava
 *   normalmente. `POST /api/v1/messages` devolvia 400 "is disconnected"
 *   e o diálogo de transferência (SPEC 056) listava o número como
 *   indisponível.
 *
 * O que a F4 mudou
 *
 *   A rota de configuração passou a criar e manter a linha de
 *   `channels`: `connected` ao salvar com a credencial aceita pela
 *   Meta, `error` com o motivo quando o diagnóstico é reprovado, e
 *   `disabled` quando o operador remove o número (D-12). Com escritor
 *   nos dois lados, `whatsapp_cloud` volta a ser `true` no mapa abaixo.
 *
 *   ⚠️ **O canal só é reconciliado quando alguém passa pela rota.** Um
 *   canal do backfill da 055 continua `disconnected` até o primeiro
 *   salvamento ou diagnóstico — que qualquer abertura da aba de
 *   configuração dispara, porque o `GET` sonda o canal padrão e grava o
 *   resultado. É por isso que a virada desta constante e a
 *   reconciliação foram entregues na mesma fase.
 *
 * O que continua barrado, sempre
 *
 *   `disabled` — nos dois tipos. É o estado que o D-12 cria ao "remover
 *   número": segredo zerado, canal preservado. `resolveCloudConfig` o
 *   recusa pelo mesmo motivo.
 *
 * Por que o mapa continua existindo
 *
 *   O próximo canal (Instagram, e-mail) nasce com exatamente o mesmo
 *   problema até alguém escrever a coluna, e um `Record<ChannelType,
 *   boolean>` exaustivo obriga quem o adicionar a decidir isso de
 *   propósito, em vez de herdar um `!== 'connected'` que ninguém
 *   sustenta.
 */

import type { ChannelType } from './types';

/**
 * Para quais tipos o valor de `channels.status` é mantido por alguém.
 *
 * Adicionar um canal novo obriga a decidir isto de forma explícita — é
 * de propósito que o mapa é exaustivo por `ChannelType`.
 */
const STATUS_IS_MAINTAINED: Record<ChannelType, boolean> = {
  // `POST /api/whatsapp/config` (salvar e reativar), o `GET` de saúde e
  // o de `verify-registration` (reconciliação) e o `DELETE` (D-12)
  // escrevem esta coluna desde a F4.
  whatsapp_cloud: true,
  // `createEvolutionInstance`, `connect`, o webhook e `deleteEvolutionInstance`
  // escrevem esta coluna a cada transição.
  whatsapp_qr: true,
};

/** Por que um canal não pode enviar agora. `null` = pode. */
export type ChannelSendBlock = 'disabled' | 'not_connected';

/**
 * Um canal pode receber um envio novo?
 *
 * Devolve o MOTIVO em vez de um booleano porque os dois chamadores
 * precisam dele: a API pública o coloca na mensagem do 400, e o diálogo
 * de transferência escolhe qual rótulo mostrar no destino recusado.
 */
export function channelSendBlock(channel: {
  type: ChannelType;
  status: string;
}): ChannelSendBlock | null {
  // D-12: vale para todo tipo, e é o estado que "remover número" cria.
  // Fica fora do mapa de propósito — é a única regra que nunca depende
  // de a coluna ser mantida, porque quem a escreve é sempre o operador.
  if (channel.status === 'disabled') return 'disabled';

  if (STATUS_IS_MAINTAINED[channel.type] && channel.status !== 'connected') {
    return 'not_connected';
  }

  return null;
}
