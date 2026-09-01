import { describe, it, expect } from 'vitest';

import { selectableChannels } from './selectable';
import type { Channel, ChannelStatus, ChannelType } from './types';

let seq = 0;

function channel(over: Partial<Channel> = {}): Channel {
  seq += 1;
  return {
    id: `ch-${seq}`,
    account_id: 'acct-1',
    user_id: 'user-1',
    type: 'whatsapp_cloud' as ChannelType,
    name: `Canal ${seq}`,
    identifier: '+5511900000000',
    status: 'connected' as ChannelStatus,
    status_detail: null,
    is_default: false,
    connected_at: null,
    last_seen_at: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...over,
  };
}

describe('selectableChannels — exclusão (SPEC 065 §5.1)', () => {
  it('exclui `disabled`, mesmo quando ele é o padrão da conta', () => {
    const off = channel({ status: 'disabled', is_default: true });
    const on = channel({ status: 'connected' });

    const out = selectableChannels([off, on], 'broadcast');

    expect(out.map((c) => c.id)).toEqual([on.id]);
  });

  // Este é o bug que o comentário de `step4-schedule-send.tsx:105-141`
  // registra: filtrar por `status === 'connected'` — como
  // `contact-detail-view.tsx` faz — escondia o padrão QUEBRADO em vez de
  // deixá-lo ser trocado. Com um item só na lista o seletor sumia e a
  // campanha saía pelo número em `error`.
  it('NUNCA filtra por status=connected — `error` e `disconnected` continuam escolhíveis', () => {
    const broken = channel({ status: 'error', is_default: true });
    const flaky = channel({ status: 'disconnected' });
    const healthy = channel({ status: 'connected' });

    const ids = selectableChannels([broken, flaky, healthy], 'broadcast').map(
      (c) => c.id
    );

    expect(ids).toHaveLength(3);
    expect(ids).toContain(broken.id);
    expect(ids).toContain(flaky.id);
  });

  it('não muta nem reordena o array recebido', () => {
    const a = channel({ status: 'error', is_default: true });
    const b = channel({ status: 'connected' });
    const input = [a, b];

    selectableChannels(input, 'broadcast');

    expect(input).toEqual([a, b]);
  });
});

describe('selectableChannels — ordenação (SPEC 065 §5.1)', () => {
  // A UI pré-seleciona `[0]`. Com o padrão em `error` e um segundo
  // número saudável, `[0]` PRECISA ser o saudável.
  it('põe o `connected` na frente do padrão em `error`', () => {
    const defaultBroken = channel({ status: 'error', is_default: true });
    const healthy = channel({ status: 'connected', is_default: false });

    const out = selectableChannels([defaultBroken, healthy], 'broadcast');

    expect(out[0].id).toBe(healthy.id);
    expect(out[1].id).toBe(defaultBroken.id);
  });

  it('entre dois `connected`, o padrão vem primeiro', () => {
    const plain = channel({ status: 'connected', is_default: false });
    const preferred = channel({ status: 'connected', is_default: true });

    const out = selectableChannels([plain, preferred], 'broadcast');

    expect(out[0].id).toBe(preferred.id);
  });

  it('empate total preserva a ordem de entrada (ordenação estável)', () => {
    const first = channel({ status: 'connected' });
    const second = channel({ status: 'connected' });

    const out = selectableChannels([first, second], 'scope');

    expect(out.map((c) => c.id)).toEqual([first.id, second.id]);
  });
});

describe('selectableChannels — propósito (SPEC 065 §5.1)', () => {
  it('`broadcast` só aceita canal capaz de disparo em massa (QRCode fica fora)', () => {
    const cloud = channel({ type: 'whatsapp_cloud' });
    const qr = channel({ type: 'whatsapp_qr' });

    expect(
      selectableChannels([cloud, qr], 'broadcast').map((c) => c.id)
    ).toEqual([cloud.id]);
  });

  it('`templates` só aceita canal com template (conceito da Meta)', () => {
    const cloud = channel({ type: 'whatsapp_cloud' });
    const qr = channel({ type: 'whatsapp_qr' });

    expect(
      selectableChannels([cloud, qr], 'templates').map((c) => c.id)
    ).toEqual([cloud.id]);
  });

  it('`scope` aceita qualquer tipo — escopar automação a uma instância QRCode é legítimo', () => {
    const cloud = channel({ type: 'whatsapp_cloud' });
    const qr = channel({ type: 'whatsapp_qr' });

    const ids = selectableChannels([cloud, qr], 'scope').map((c) => c.id);
    expect(ids).toHaveLength(2);
    expect(ids).toContain(qr.id);
  });

  it('`scope` continua excluindo `disabled` — desativado não escopa nada', () => {
    const qrOff = channel({ type: 'whatsapp_qr', status: 'disabled' });

    expect(selectableChannels([qrOff], 'scope')).toEqual([]);
  });
});
