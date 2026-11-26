import { describe, it, expect } from 'vitest';

import {
  channelIdentifierDisplay,
  channelIdentifierIsPhone,
} from './identifier';

// ---------------------------------------------------------------------------
// SPEC 064 D-9 / §1.1.E.2 — nenhuma tela exibe `phone_number_id`
// formatado como telefone.
//
// O bug concreto: `transfer-channel-dialog.tsx:212` rodava
// `formatPhoneForDisplay()` em `channels.identifier`, e o backfill da
// migração 055 gravou ali o `phone_number_id` do canal Cloud. O diálogo
// de transferência exibia `+892352847302912` como se fosse o número do
// WhatsApp da empresa. Antes deste módulo, a única saída seria a
// reconciliação ter passado por aquele canal.
// ---------------------------------------------------------------------------

const PHONE_NUMBER_ID = '892352847302912';
const PHONE = '5519991234567';

describe('channelIdentifierIsPhone', () => {
  it('com o phone_number_id em mãos, a comparação é exata', () => {
    expect(
      channelIdentifierIsPhone(
        { type: 'whatsapp_cloud', identifier: PHONE_NUMBER_ID },
        { phoneNumberId: PHONE_NUMBER_ID }
      )
    ).toBe(false);

    expect(
      channelIdentifierIsPhone(
        { type: 'whatsapp_cloud', identifier: PHONE },
        { phoneNumberId: PHONE_NUMBER_ID }
      )
    ).toBe(true);
  });

  it('sem essa informação, 15 dígitos são tratados como id da Meta', () => {
    // O erro possível é para o lado seguro: um telefone raríssimo de 15
    // dígitos aparece como rótulo do canal — nunca um id da Meta
    // aparece como telefone.
    expect(
      channelIdentifierIsPhone({
        type: 'whatsapp_cloud',
        identifier: PHONE_NUMBER_ID,
      })
    ).toBe(false);

    expect(
      channelIdentifierIsPhone({ type: 'whatsapp_cloud', identifier: PHONE })
    ).toBe(true);
  });

  it('QRCode sempre é telefone — o adaptador Evolution grava o número pareado', () => {
    expect(
      channelIdentifierIsPhone({ type: 'whatsapp_qr', identifier: PHONE })
    ).toBe(true);
  });

  it('sem identifier, não há telefone', () => {
    expect(
      channelIdentifierIsPhone({ type: 'whatsapp_qr', identifier: null })
    ).toBe(false);
    expect(
      channelIdentifierIsPhone({ type: 'whatsapp_cloud', identifier: '' })
    ).toBe(false);
  });
});

describe('channelIdentifierDisplay', () => {
  it('formata o telefone reconciliado', () => {
    expect(
      channelIdentifierDisplay({ type: 'whatsapp_cloud', identifier: PHONE })
    ).toBe('+55 (19) 99123-4567');
  });

  it('devolve null para o id da Meta — a tela mostra o rótulo do canal', () => {
    expect(
      channelIdentifierDisplay({
        type: 'whatsapp_cloud',
        identifier: PHONE_NUMBER_ID,
      })
    ).toBeNull();
  });
});
