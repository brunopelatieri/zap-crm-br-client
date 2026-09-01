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

/**
 * De onde veio a escolha do canal (SPEC 065 §11).
 *
 * A pergunta que este campo responde: "esta mensagem saiu pelo número B
 * porque ALGUÉM escolheu, ou porque caiu no padrão?" — sem ele, o log já
 * dizia QUAL canal saiu, mas não POR QUE aquele canal, o que faz
 * qualquer investigação de "saiu pelo número errado" precisar reconstruir
 * manualmente a cadeia de resolução (recurso → conversa → padrão).
 *
 *   `'resource'`     — o RECURSO que disparou escolheu explicitamente:
 *                       `channel_id` de uma campanha/API/ingest, ou o
 *                       desvio `fallback_channel` de uma automação.
 *   `'conversation'` — herdado de `conversations.channel_id` — o caso
 *                       comum de responder numa thread existente.
 *   `'default'`      — ninguém escolheu; caiu no canal Cloud padrão da
 *                       conta (D-11).
 */
export type ChannelSource = 'resource' | 'conversation' | 'default';

/**
 * `ChannelSource` sem `'conversation'` — o subconjunto que resolvedores
 * que NUNCA herdam de uma conversa (campanha, ingest, API pública)
 * podem produzir. Usar este alias em vez de retipar `'resource' |
 * 'default'` à mão mantém esses locais estruturalmente amarrados a
 * `ChannelSource` — um quarto valor adicionado lá se propaga aqui sem
 * precisar caçar declarações duplicadas (achado de code review:
 * `broadcast-core.ts`/`broadcast-dispatch.ts` retipavam isto à mão).
 */
export type NonConversationChannelSource = Exclude<
  ChannelSource,
  'conversation'
>;

/**
 * A regra "id explícito ⇒ o recurso escolheu; ausente ⇒ caiu no padrão"
 * (SPEC 065 §11), numa função só. Estava reimplementada à mão como
 * `channelId ? 'resource' : 'default'` em `broadcast-core.ts`,
 * `broadcast-dispatch.ts`, `lib/ingest/send.ts` e `lib/channels/send.ts`
 * (achado de code review) — um bug fix numa cópia não chegava às
 * outras três.
 */
export function channelSourceFromId(
  channelId: string | null | undefined
): NonConversationChannelSource {
  return channelId ? 'resource' : 'default';
}

export interface OutboundSendLogEntry {
  accountId: string;
  /** `null` quando a origem não opera sobre uma conversa (disparo em massa). */
  conversationId: string | null;
  channelId: string;
  channelType: string;
  /** `null` num canal QRCode, que não tem `phone_number_id` da Meta. */
  phoneNumberId: string | null;
  origin: SendOrigin;
  channelSource: ChannelSource;
}

export function logOutboundSend(entry: OutboundSendLogEntry): void {
  console.log(JSON.stringify({ event: 'outbound_send', ...entry }));
}
