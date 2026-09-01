/**
 * Quais templates aparecem para um canal (SPEC 065 §5.2 / D-2).
 *
 * O problema
 *
 *   Template pertence ao WABA, não à conta. Toda tela que lista
 *   `message_templates` sem filtrar pelo WABA do canal que vai enviar
 *   está oferecendo algo que a Meta recusa depois com
 *   `(#132001) Template name does not exist in the translation` — do
 *   ponto de vista do WABA que está enviando, o nome realmente não
 *   existe lá.
 *
 *   O inbox (`template-picker.tsx`) e a ficha do contato já filtram
 *   certo; o passo 1 do disparo e o construtor de automações não
 *   filtram nada (SPEC 065 §2.A A2/A3 e §2.B B4). Este módulo é a regra
 *   que as quatro telas passam a consumir, para que nenhuma volte a
 *   reimplementá-la — e a decisão em si continua sendo
 *   `templateBelongsToWaba`, uma só, já testada.
 *
 * A invariante que a SPEC promove (§2.E)
 *
 *   A variável que filtra a lista de templates e a que vai no
 *   `channel_id` do envio são **a mesma variável**. Sempre. Usar uma
 *   para listar e outra para enviar reproduz o `#132001` que o filtro
 *   existia para evitar — foi o achado de code review registrado em
 *   `contact-detail-view.tsx:108-130` (`effectiveTemplateChannelId`).
 */

import type { MessageTemplate } from '@/types';

import { templateBelongsToWaba } from './template-waba';

/**
 * `wabaIdOfChannel` é implementada em `template-waba.ts` e reexportada
 * aqui — ver o comentário dela para o porquê (ciclo ESM com uma classe
 * no meio). Quem importa continua vendo as duas funções neste módulo,
 * como a SPEC descreve, e a implementação é uma só.
 */
export { wabaIdOfChannel, type ChannelWabaId } from './template-waba';

import type { ChannelWabaId } from './template-waba';

/**
 * Os templates visíveis para um canal.
 *
 * `wabaId` tem os três estados de `ChannelWabaId`, e cada um leva a um
 * resultado diferente:
 *
 *   - `'waba-a'`  → os do WABA `waba-a` **mais** os legados;
 *   - `null`      → só os legados (o canal tem credencial mas nenhum
 *                   WABA gravado — numa conta assim, os templates
 *                   também são todos legados);
 *   - `undefined` → **a lista inteira, sem filtrar**. "Não sei qual é o
 *                   WABA" tem de falhar ABERTO: encolher a lista para
 *                   os legados por causa de uma consulta que falhou, de
 *                   um canal ainda não escolhido ou de um canal sem
 *                   linha de credencial esconderia templates válidos e
 *                   deixaria o operador sem explicação. É o achado de
 *                   code review em `template-picker.tsx:170-190`.
 *
 * Templates **legados** (`waba_id IS NULL`, anteriores à migração 072)
 * entram em toda lista: `templateBelongsToWaba` já os trata como
 * pertencentes a qualquer WABA, e a SPEC 064 D-2 decidiu que nada some
 * da lista de ninguém.
 *
 * O status (`APPROVED`) continua sendo filtro da CONSULTA de quem chama,
 * não desta função: aqui a pergunta é só "este template serve para este
 * canal?".
 */
export function templatesForChannel(
  all: MessageTemplate[],
  wabaId: ChannelWabaId
): MessageTemplate[] {
  if (wabaId === undefined) return [...all];
  return all.filter((t) => templateBelongsToWaba(t.waba_id, wabaId));
}
