/**
 * Log estruturado de todo envio de saída (SPEC 064 §11.1).
 *
 * A classe de bug que a SPEC 064 pode causar é silenciosa: a mensagem
 * sai pelo número errado, o cliente recebe, o CRM grava, e ninguém
 * percebe até alguém estranhar o remetente. Esta linha é o que permite
 * responder "por qual número saiu?" sem consultar o banco — grep no log
 * por `accountId`/`conversationId` mostra o `channelId` real usado.
 *
 * Deliberadamente sem dependência: cada camada (motores, inbox,
 * disparo, API pública, ingest) chama isto direto depois de confirmar
 * o envio — nunca antes, para não registrar uma tentativa que falhou
 * como se tivesse saído.
 */

export type SendOrigin =
  'inbox' | 'automation' | 'flow' | 'ai' | 'broadcast' | 'api_v1' | 'ingest';

export interface OutboundSendLogEntry {
  accountId: string;
  /** `null` quando a origem não opera sobre uma conversa (disparo em massa). */
  conversationId: string | null;
  channelId: string;
  channelType: string;
  /** `null` num canal QRCode, que não tem `phone_number_id` da Meta. */
  phoneNumberId: string | null;
  origin: SendOrigin;
}

export function logOutboundSend(entry: OutboundSendLogEntry): void {
  console.log(JSON.stringify({ event: 'outbound_send', ...entry }));
}
