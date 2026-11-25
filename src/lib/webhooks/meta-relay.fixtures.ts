// ============================================================
// Fixtures do repetidor do webhook da Meta (SPEC 088).
//
// Cada `change` abaixo é o exemplo OFICIAL da Meta Cloud API v27 de
// `docs/references/example_webhook_whatsapp_meta_cloud_api.md`, com a
// forma dos campos intacta. Só ids e valores que o teste precisa
// distinguir (conta A/B) são parametrizados. O envelope é o padrão da
// Meta, montado aqui por código.
//
// `realStatusesRawBody` e `realMessagesRawBody` (no fim do arquivo) são
// os corpos que o webhook da Meta entregou de verdade ao repetidor em
// 2026-11-25 (F6 da SPEC 088), com os dados pessoais trocados por valores
// fictícios e a FORMA preservada byte a byte: JSON compacto, na ordem de
// chaves da Meta (`value` ANTES de `field`, que o exemplo da
// documentação inverte) e, em `statuses`, o `pricing` completo. Eles
// fecham a lacuna que o arquivo de exemplos deixava (sem `statuses`).
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

/**
 * Corpo REAL de `statuses` (status `read`, com `pricing`), anonimizado.
 * Cru, como a Meta o envia: nada de reserializar. O `wamid` é fictício,
 * mas tem a mesma forma do real (prefixo `wamid.` + base64).
 */
export function realStatusesRawBody(
  opts: { phoneNumberId?: string; wabaId?: string } = {}
): string {
  const { phoneNumberId = '123456123', wabaId = '102290129340398' } = opts;
  return (
    `{"object":"whatsapp_business_account","entry":[{"id":"${wabaId}",` +
    `"changes":[{"value":{"messaging_product":"whatsapp","metadata":` +
    `{"display_phone_number":"16505551111","phone_number_id":"${phoneNumberId}"},` +
    `"contacts":[{"wa_id":"16315551181","user_id":"US.13491208655302741918"}],` +
    `"statuses":[{"id":"wamid.HBgLMTYzMTU1NTExODEVAgARGBI0Njg2Q0U1NjkzQjQ5QTM4MTEA",` +
    `"status":"read","timestamp":"1795576195","recipient_id":"16315551181",` +
    `"recipient_user_id":"US.13491208655302741918","pricing":{"billable":false,` +
    `"pricing_model":"PMP","category":"service","type":"free_customer_service",` +
    `"subtype":"free_tier"}}]},"field":"messages"}]}]}`
  );
}

/**
 * Corpo REAL de `messages` (texto recebido), anonimizado, na ordem de
 * chaves da Meta (`from`, `from_user_id`, `id`, `timestamp`, `text`,
 * `type`). Cru, como a Meta o envia.
 */
export function realMessagesRawBody(
  opts: { phoneNumberId?: string; wabaId?: string; text?: string } = {}
): string {
  const {
    phoneNumberId = '123456123',
    wabaId = '102290129340398',
    text = 'test return 3',
  } = opts;
  return (
    `{"object":"whatsapp_business_account","entry":[{"id":"${wabaId}",` +
    `"changes":[{"value":{"messaging_product":"whatsapp","metadata":` +
    `{"display_phone_number":"16505551111","phone_number_id":"${phoneNumberId}"},` +
    `"contacts":[{"profile":{"name":"test user name"},"wa_id":"16315551181",` +
    `"user_id":"US.13491208655302741918"}],"messages":[{"from":"16315551181",` +
    `"from_user_id":"US.13491208655302741918",` +
    `"id":"wamid.HBgLMTYzMTU1NTExODEVAgASGBYzRUIwMTYxMDY5QzQ0MjExNTQyMEE3AA==",` +
    `"timestamp":"1795576203","text":{"body":"${text}"},"type":"text"}]},` +
    `"field":"messages"}]}]}`
  );
}
