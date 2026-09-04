/**
 * A máquina de estados do disparo parcial (SPEC 069 §4.10/§7.3, R6) —
 * módulo PURO.
 *
 * O problema que ela resolve
 *
 *   Uma campanha com "checar antes de disparar" não pode esperar a
 *   base inteira ser checada para começar a sair: a 300 checagens/dia,
 *   100 mil contatos levam quase um ano. Ela sai em fatias — a cada
 *   ciclo, dispara para quem foi validado desde o ciclo anterior e
 *   volta a esperar. Isso significa que a MESMA campanha atravessa
 *   `awaiting_check → sending → awaiting_check → … → sent` várias
 *   vezes, e cada transição errada é um defeito caro: disparar duas
 *   vezes para a mesma pessoa, ou parar de disparar e nunca mais
 *   voltar.
 *
 *   Por isso a decisão mora aqui, sem banco: os quatro desfechos do
 *   §7.3 (mais o quinto, do §14) são testáveis um a um, e o cron que a
 *   consome só executa o que ela decidiu.
 *
 * O que NÃO é decidido aqui
 *
 *   Quem já foi disparado. Isso é derivado no banco pela existência de
 *   uma linha em `broadcast_recipients` para o par (campanha, contato)
 *   — não por um estado a mais na fila. A diferença importa: um
 *   processo morto no meio de um ciclo não deixa a fila mentindo sobre
 *   o que saiu, porque a verdade é a linha do destinatário, que só
 *   existe se o INSERT aconteceu.
 *
 * Por que `complete` olha `everDispatched`
 *
 *   Uma campanha que terminou sem NENHUM disparo e com itens que nunca
 *   chegaram a ser checados (instância apagada, desconectada por dias,
 *   cron desligado — §14) não é uma campanha "enviada": ela não
 *   alcançou ninguém. Marcá-la `sent` esconderia isso na lista. Já uma
 *   que entregou para 900 de 1000 e perdeu 100 por falta de checagem É
 *   um envio — parcial, e o número exato fica na trilha de auditoria.
 */

export interface PartialSendState {
  /** Itens da fila desta campanha ainda por resolver (`pending` + `in_progress`). */
  pendingChecks: number;
  /**
   * Contatos já checados, com número válido, e ainda SEM linha em
   * `broadcast_recipients` — o lote que sai AGORA.
   */
  readyToDispatch: number;
  /**
   * Quantos ficaram DE FORA deste lote por não caberem na cota de 24 h
   * da Meta (ou no teto por ciclo). Não é a fila de checagem: são
   * contatos já validados, esperando só a cota de ENVIO.
   *
   * Sem este campo a campanha seria encerrada como `sent` no primeiro
   * ciclo em que a fila de checagem esvaziasse — mesmo com 20 dos 30
   * validados ainda sem sair, porque a cota cortou o lote em 10. O
   * desfecho seria uma campanha "enviada" que alcançou um terço da
   * audiência, sem nada na tela dizendo isso.
   */
  readyRemaining: number;
  /**
   * Itens que saíram da fila sem veredito (`skipped`/`failed`/
   * `expired`): instância indisponível, item envenenado, TTL vencido.
   */
  unresolvedChecks: number;
  /** Linhas de `broadcast_recipients` que esta campanha já tem. */
  everDispatched: number;
  /** `isWithinSendWindow(now, tz)` — D-11, a MESMA regra do cron comum. */
  withinSendWindow: boolean;
  /** O usuário aceitou disparar fora da janela no agendamento. */
  windowOverride: boolean;
}

export type PartialSendDecision =
  /** (a) Dispara para os validados deste ciclo. */
  | { action: 'dispatch'; nextStatus: 'awaiting_check' | 'sent' }
  /** (b) Continua em `awaiting_check`: a checagem ainda não produziu lote. */
  | { action: 'wait'; reason: 'awaiting_checks' }
  /** (c) Acabou: tudo checado e tudo disparado. */
  | { action: 'complete' }
  /** (d) Há lote pronto, mas fora da janela de envio (D-11). */
  | { action: 'postpone'; reason: 'outside_window' }
  /** (§14) Nada foi checado, nada saiu, e não há mais o que esperar. */
  | { action: 'fail'; reason: 'checks_unresolved' };

/**
 * A ordem das perguntas É a regra — trocá-la muda o comportamento:
 *
 *   1. Tem lote pronto? Se não, o desfecho depende só de haver ou não
 *      mais o que checar (esperar × terminar). Perguntar a janela de
 *      horário antes disso adiaria uma campanha que não tem nada a
 *      disparar — e a trilha encheria de `blocked_window` falsos.
 *   2. Com lote pronto, a janela decide ANTES do disparo. "Aproveitar
 *      a cota" às 23h é exatamente o oposto do que a feature protege.
 *   3. Só então dispara — e o estado seguinte é `sent` apenas quando
 *      não sobrou NADA: nem na fila de checagem, nem de fora do lote
 *      por falta de cota de envio. As duas coisas prendem a campanha em
 *      `awaiting_check`, e esquecer a segunda encerraria a campanha com
 *      parte da audiência validada e nunca enviada.
 */
export function decidePartialSend(
  state: PartialSendState
): PartialSendDecision {
  if (state.readyToDispatch <= 0) {
    if (state.pendingChecks > 0) {
      return { action: 'wait', reason: 'awaiting_checks' };
    }
    // Fila vazia. Terminou — mas terminou como o quê?
    if (state.everDispatched <= 0 && state.unresolvedChecks > 0) {
      return { action: 'fail', reason: 'checks_unresolved' };
    }
    return { action: 'complete' };
  }

  if (!state.windowOverride && !state.withinSendWindow) {
    return { action: 'postpone', reason: 'outside_window' };
  }

  const somethingLeftOver = state.pendingChecks > 0 || state.readyRemaining > 0;

  return {
    action: 'dispatch',
    nextStatus: somethingLeftOver ? 'awaiting_check' : 'sent',
  };
}
