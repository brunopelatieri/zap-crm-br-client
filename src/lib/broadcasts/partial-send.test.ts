import { describe, expect, it } from 'vitest';

import { decidePartialSend, type PartialSendState } from './partial-send';

function state(over: Partial<PartialSendState> = {}): PartialSendState {
  return {
    pendingChecks: 0,
    readyToDispatch: 0,
    readyRemaining: 0,
    unresolvedChecks: 0,
    everDispatched: 0,
    withinSendWindow: true,
    windowOverride: false,
    ...over,
  };
}

// ============================================================
// Os quatro desfechos do §7.3, um a um
// ============================================================

describe('decidePartialSend — (a) dispara para os validados', () => {
  it('lote pronto e ainda há o que checar: dispara e VOLTA a awaiting_check', () => {
    expect(
      decidePartialSend(state({ readyToDispatch: 10, pendingChecks: 90 }))
    ).toEqual({ action: 'dispatch', nextStatus: 'awaiting_check' });
  });

  it('lote pronto e fila vazia depois dele: dispara e conclui em sent', () => {
    expect(
      decidePartialSend(state({ readyToDispatch: 10, pendingChecks: 0 }))
    ).toEqual({ action: 'dispatch', nextStatus: 'sent' });
  });

  it('um único contato pronto já é lote — não espera acumular', () => {
    expect(
      decidePartialSend(state({ readyToDispatch: 1, pendingChecks: 5 }))
    ).toMatchObject({ action: 'dispatch' });
  });

  it('fila vazia MAS lote cortado pela cota de envio: volta a awaiting_check', () => {
    // 30 validados, cota de 10: os 20 que sobraram continuam presos à
    // campanha. Marcá-la `sent` aqui a encerraria com dois terços da
    // audiência nunca enviada, e nada na tela dizendo isso.
    expect(
      decidePartialSend(
        state({ readyToDispatch: 10, readyRemaining: 20, pendingChecks: 0 })
      )
    ).toEqual({ action: 'dispatch', nextStatus: 'awaiting_check' });
  });

  it('só conclui quando não sobra NADA — nem fila, nem resto de cota', () => {
    expect(
      decidePartialSend(
        state({ readyToDispatch: 10, readyRemaining: 0, pendingChecks: 0 })
      )
    ).toEqual({ action: 'dispatch', nextStatus: 'sent' });
  });
});

describe('decidePartialSend — (b) volta a awaiting_check', () => {
  it('nada pronto mas fila com itens: espera o próximo ciclo de cota', () => {
    expect(decidePartialSend(state({ pendingChecks: 100 }))).toEqual({
      action: 'wait',
      reason: 'awaiting_checks',
    });
  });

  it('esperar NÃO depende da janela de horário — nada a disparar, nada a adiar', () => {
    // Sem esta ordem, a trilha encheria de `blocked_window` para
    // campanhas que não tinham lote nenhum para sair.
    expect(
      decidePartialSend(state({ pendingChecks: 100, withinSendWindow: false }))
    ).toEqual({ action: 'wait', reason: 'awaiting_checks' });
  });

  it('itens em in_progress contam como pendentes (o chamador soma os dois)', () => {
    expect(decidePartialSend(state({ pendingChecks: 1 }))).toMatchObject({
      action: 'wait',
    });
  });
});

describe('decidePartialSend — (c) conclui em sent', () => {
  it('fila vazia, nada pronto, já disparou antes: completa', () => {
    expect(decidePartialSend(state({ everDispatched: 500 }))).toEqual({
      action: 'complete',
    });
  });

  it('completa mesmo com itens não resolvidos, desde que ALGO tenha saído', () => {
    // 900 entregues e 100 nunca checados é um envio parcial de verdade
    // — o número exato vai para a trilha, não para o status.
    expect(
      decidePartialSend(state({ everDispatched: 900, unresolvedChecks: 100 }))
    ).toEqual({ action: 'complete' });
  });

  it('audiência inteira inválida (checada, nada a enviar) completa em vez de falhar', () => {
    // Todos foram checados (`unresolvedChecks: 0`), todos vieram
    // `IsInWhatsapp: false` — nenhum virou destinatário. A campanha fez
    // o trabalho dela: descobriu que a lista estava morta.
    expect(decidePartialSend(state({ everDispatched: 0 }))).toEqual({
      action: 'complete',
    });
  });
});

describe('decidePartialSend — (d) adia por janela de horário (D-11)', () => {
  it('lote pronto mas fora da janela: adia, não dispara', () => {
    expect(
      decidePartialSend(
        state({
          readyToDispatch: 10,
          pendingChecks: 90,
          withinSendWindow: false,
        })
      )
    ).toEqual({ action: 'postpone', reason: 'outside_window' });
  });

  it('adia mesmo quando seria o ÚLTIMO lote — a janela não abre exceção para terminar', () => {
    expect(
      decidePartialSend(
        state({
          readyToDispatch: 10,
          pendingChecks: 0,
          withinSendWindow: false,
        })
      )
    ).toEqual({ action: 'postpone', reason: 'outside_window' });
  });

  it('window_override dispara fora da janela — foi escolha explícita de quem agendou', () => {
    expect(
      decidePartialSend(
        state({
          readyToDispatch: 10,
          withinSendWindow: false,
          windowOverride: true,
        })
      )
    ).toMatchObject({ action: 'dispatch' });
  });
});

// ============================================================
// O quinto desfecho: §14 — campanha presa
// ============================================================

describe('decidePartialSend — (§14) nada checado e nada disparado', () => {
  it('todos os itens saíram sem veredito e nada saiu: falha com motivo', () => {
    // Instância apagada/desconectada: o cron de checagem marcou os
    // itens como `skipped`. Sem esta regra, a campanha ficaria em
    // `awaiting_check` para sempre — a armadilha do §14.
    expect(
      decidePartialSend(state({ unresolvedChecks: 50, everDispatched: 0 }))
    ).toEqual({ action: 'fail', reason: 'checks_unresolved' });
  });

  it('mas NÃO falha enquanto ainda houver item pendente — a instância pode voltar', () => {
    // Desconexão de um ciclo não pode matar a campanha: enquanto há
    // item `pending`, o desfecho é esperar.
    expect(
      decidePartialSend(
        state({ pendingChecks: 10, unresolvedChecks: 40, everDispatched: 0 })
      )
    ).toEqual({ action: 'wait', reason: 'awaiting_checks' });
  });

  it('nem falha se ainda há lote pronto para sair', () => {
    expect(
      decidePartialSend(
        state({ readyToDispatch: 5, unresolvedChecks: 40, everDispatched: 0 })
      )
    ).toMatchObject({ action: 'dispatch' });
  });
});

// ============================================================
// Bordas de contagem
// ============================================================

describe('decidePartialSend — bordas', () => {
  it('contagens negativas (dado torto) não viram disparo', () => {
    expect(
      decidePartialSend(state({ readyToDispatch: -1, pendingChecks: -1 }))
    ).toEqual({ action: 'complete' });
  });

  it('estado inteiramente zerado completa — não trava e não falha', () => {
    expect(decidePartialSend(state())).toEqual({ action: 'complete' });
  });
});
