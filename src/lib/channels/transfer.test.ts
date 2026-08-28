import { describe, it, expect } from 'vitest';

import {
  evaluateTransferChannel,
  evaluateTransferChannels,
  eligibleTransferChannels,
  type TransferCandidateChannel,
} from './transfer';

const CURRENT = 'cloud-1';

const cloudCurrent: TransferCandidateChannel = {
  id: CURRENT,
  name: 'WhatsApp Oficial',
  type: 'whatsapp_cloud',
  status: 'connected',
  sessionWindow: null,
};

const qrConnected: TransferCandidateChannel = {
  id: 'qr-1',
  name: 'Vendas (QRCode)',
  type: 'whatsapp_qr',
  status: 'connected',
  sessionWindow: null,
};

const qrDisconnected: TransferCandidateChannel = {
  ...qrConnected,
  id: 'qr-2',
  name: 'Suporte (QRCode)',
  status: 'disconnected',
};

const cloudWindowOpen: TransferCandidateChannel = {
  id: 'cloud-2',
  name: 'Segundo Oficial',
  type: 'whatsapp_cloud',
  status: 'connected',
  sessionWindow: {
    applicable: true,
    isOpen: true,
    minutesRemaining: 600,
    lastCustomerMessageAt: new Date('2026-08-20T10:00:00Z'),
  },
};

const cloudWindowClosed: TransferCandidateChannel = {
  ...cloudWindowOpen,
  id: 'cloud-3',
  name: 'Terceiro Oficial',
  sessionWindow: {
    applicable: true,
    isOpen: false,
    minutesRemaining: 0,
    lastCustomerMessageAt: new Date('2026-08-18T10:00:00Z'),
  },
};

const cloudNoThreadYet: TransferCandidateChannel = {
  ...cloudWindowOpen,
  id: 'cloud-4',
  name: 'Quarto Oficial',
  sessionWindow: null,
};

describe('evaluateTransferChannel — critérios da SPEC 056 §4.3', () => {
  it('o próprio canal da conversa nunca é destino de si mesmo', () => {
    expect(evaluateTransferChannel(cloudCurrent, CURRENT)).toEqual({
      channel: cloudCurrent,
      eligible: false,
      reason: 'same_channel',
    });
  });

  it('QRCode desconectado é recusado com motivo', () => {
    expect(evaluateTransferChannel(qrDisconnected, CURRENT)).toEqual({
      channel: qrDisconnected,
      eligible: false,
      reason: 'not_connected',
    });
  });

  it('número oficial desconectado é recusado — a F4 deu escritor ao status', () => {
    // Até a F4 este teste afirmava o CONTRÁRIO: `channels.status` do
    // canal Cloud vinha do backfill da 055 e não tinha escritor, então
    // recusá-lo tirava da lista de destinos justamente o resgate fora
    // da janela de 24 h da SPEC 056. Com a rota de configuração
    // escrevendo a coluna, `disconnected` num número oficial passa a
    // significar "a Meta reprovou a credencial" — e aí ele não é
    // destino de transferência nenhuma.
    const cloudDesconectado: TransferCandidateChannel = {
      ...cloudWindowOpen,
      id: 'cloud-5',
      status: 'disconnected',
    };

    expect(evaluateTransferChannel(cloudDesconectado, CURRENT)).toEqual({
      channel: cloudDesconectado,
      eligible: false,
      reason: 'not_connected',
    });
  });

  it('canal DESATIVADO é recusado em qualquer tipo (D-12)', () => {
    const cloudDesativado: TransferCandidateChannel = {
      ...cloudWindowOpen,
      id: 'cloud-6',
      status: 'disabled',
    };

    expect(evaluateTransferChannel(cloudDesativado, CURRENT)).toEqual({
      channel: cloudDesativado,
      eligible: false,
      reason: 'not_connected',
    });
  });

  it('QRCode conectado, sem regra de janela, é sempre elegível (Cloud → QR)', () => {
    expect(evaluateTransferChannel(qrConnected, CURRENT)).toEqual({
      channel: qrConnected,
      eligible: true,
    });
  });

  it('D-3: canal com sessionWindow24h e janela FECHADA é recusado', () => {
    expect(evaluateTransferChannel(cloudWindowClosed, CURRENT)).toEqual({
      channel: cloudWindowClosed,
      eligible: false,
      reason: 'session_window_closed',
    });
  });

  it('D-3: canal com sessionWindow24h e janela ABERTA é aceito', () => {
    expect(evaluateTransferChannel(cloudWindowOpen, CURRENT)).toEqual({
      channel: cloudWindowOpen,
      eligible: true,
    });
  });

  it('sessionWindow null (contato sem thread ali ainda) conta como fechada', () => {
    // Uma janela que nunca abriu não está aberta — é o caso mais comum
    // do sentido QR→Cloud, que motivou o D-3.
    expect(evaluateTransferChannel(cloudNoThreadYet, CURRENT)).toEqual({
      channel: cloudNoThreadYet,
      eligible: false,
      reason: 'session_window_closed',
    });
  });
});

describe('evaluateTransferChannels / eligibleTransferChannels', () => {
  it('avalia a lista inteira, preservando a ordem', () => {
    const result = evaluateTransferChannels(
      [cloudCurrent, qrConnected, qrDisconnected, cloudWindowOpen],
      CURRENT
    );
    expect(result.map((r) => r.eligible)).toEqual([false, true, false, true]);
  });

  it('conta sem canal elegível devolve lista vazia', () => {
    expect(
      eligibleTransferChannels([cloudCurrent, qrDisconnected], CURRENT)
    ).toEqual([]);
  });

  it('filtra só os elegíveis, sem os motivos de recusa', () => {
    expect(
      eligibleTransferChannels(
        [cloudCurrent, qrConnected, qrDisconnected, cloudWindowOpen],
        CURRENT
      )
    ).toEqual([qrConnected, cloudWindowOpen]);
  });
});
