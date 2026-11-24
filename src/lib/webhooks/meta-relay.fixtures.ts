// ============================================================
// Fixtures do repetidor do webhook da Meta (SPEC 088).
//
// Cada `change` abaixo é o exemplo OFICIAL da Meta Cloud API v27 de
// `docs/references/example_webhook_whatsapp_meta_cloud_api.md`, com a
// forma dos campos intacta. Só ids e valores que o teste precisa
// distinguir (conta A/B) são parametrizados. O envelope é o padrão da
// Meta, montado aqui por código.
//
// Lacuna conhecida: o arquivo de exemplos não traz `statuses`
// (sent/delivered/read, com `pricing`). Nenhum teste deste módulo
// depende dessa forma, e ela NÃO deve ser inventada aqui: falta um
// exemplo real fornecido pelo mantenedor.
// ============================================================

export type Change = Record<string, unknown>;

/** Envelope padrão da Meta com UMA entry. */
export function envelope(wabaId: string, changes: Change[]) {
  return {
    object: 'whatsapp_business_account',
    entry: [{ id: wabaId, changes }],
  };
}

/** Envelope com várias entries (uma por WABA). */
export function envelopeOf(entries: { id: string; changes: Change[] }[]) {
  return { object: 'whatsapp_business_account', entry: entries };
}

/** `messages` — texto recebido. */
export function messagesChange(
  opts: {
    phoneNumberId?: string;
    displayPhoneNumber?: string;
    waId?: string;
    text?: string;
  } = {}
): Change {
  const {
    phoneNumberId = '123456123',
    displayPhoneNumber = '16505551111',
    waId = '16315551181',
    text = 'this is a text message',
  } = opts;
  return {
    field: 'messages',
    value: {
      messaging_product: 'whatsapp',
      metadata: {
        display_phone_number: displayPhoneNumber,
        phone_number_id: phoneNumberId,
      },
      contacts: [
        {
          profile: { name: 'test user name' },
          wa_id: waId,
          user_id: 'US.13491208655302741918',
        },
      ],
      messages: [
        {
          id: 'ABGGFlA5Fpa',
          timestamp: '1504902988',
          from: waId,
          from_user_id: 'US.13491208655302741918',
          type: 'text',
          text: { body: text },
        },
      ],
    },
  };
}

/** `calls` — também traz `metadata.phone_number_id`. */
export function callsChange(
  opts: { phoneNumberId?: string; waId?: string } = {}
): Change {
  const { phoneNumberId = '123456123', waId = '16315551181' } = opts;
  return {
    field: 'calls',
    value: {
      messaging_product: 'whatsapp',
      metadata: {
        display_phone_number: '16505551111',
        phone_number_id: phoneNumberId,
      },
      calls: [
        {
          id: 'ABGGFlA5Fpa',
          to: '18005551180',
          from: waId,
          timestamp: 1504902988,
          event: 'connect',
        },
      ],
      contacts: [{ profile: { name: 'test user name' }, wa_id: waId }],
    },
  };
}

/** `message_template_status_update` — evento de WABA, sem `metadata`. */
export function templateStatusChange(): Change {
  return {
    field: 'message_template_status_update',
    value: {
      event: 'APPROVED',
      message_template_id: 12345678,
      message_template_name: 'my_message_template',
      message_template_language: 'pt-BR',
      reason: null,
      message_template_category: 'MARKETING',
    },
  };
}

/** `account_update` — evento de conta, sem `metadata`. */
export function accountUpdateChange(): Change {
  return {
    field: 'account_update',
    value: {
      phone_number: '16505551111',
      event: 'VERIFIED_ACCOUNT',
    },
  };
}
