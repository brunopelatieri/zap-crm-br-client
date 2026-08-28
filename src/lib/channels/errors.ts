/**
 * Erros da camada de canais (SPEC 064 F2).
 *
 * Por que num arquivo só deles
 *
 *   `cloud-channels.ts` (SPEC 064 §4.1) precisa lançar
 *   `ChannelNotConfiguredError`, e `send.ts` precisa chamar
 *   `resolveCloudConfig`. Mantê-los em `send.ts` faria os dois módulos
 *   se importarem em ciclo — que o bundler até resolve para funções,
 *   mas não para CLASSES avaliadas na ordem errada (TDZ). Um módulo
 *   folha, sem nenhuma dependência, corta o ciclo pela raiz.
 *
 *   `send.ts` reexporta as duas classes, então nenhum importador de
 *   `@/lib/channels/send` precisou mudar — e `instanceof` continua
 *   valendo, porque a classe é a mesma.
 */

/**
 * Por que a credencial não pôde ser resolvida.
 *
 * `no_channel` é o único que significa "esta conta não tem número" — os
 * outros dizem "o número existe, mas não serve agora". A distinção não é
 * decorativa: `loadAccountQuota` responde `configured: false` ao
 * primeiro, e os dois chamadores de disparo traduzem isso em **teto
 * infinito** (`batchLimit = Infinity`, `broadcasts/send/route.ts`). Sem
 * o código, um canal desativado ou um token zerado derrubariam o teto
 * por disparo em silêncio, e a tela ainda esconderia o medidor.
 */
export type ChannelNotConfiguredReason =
  /** A conta não tem canal (do tipo pedido). */
  | 'no_channel'
  /** O id não existe nesta conta — inclui id de outra conta. */
  | 'not_found'
  /** O canal existe, mas é de outro tipo. */
  | 'wrong_type'
  /** Canal `disabled` (D-12). */
  | 'disabled'
  /** Canal órfão (sem linha de `whatsapp_config`) ou com token zerado. */
  | 'no_credentials'
  /** A consulta falhou — NÃO é o mesmo que "não existe". */
  | 'read_failed';

/**
 * A conta não tem canal configurado.
 *
 * Erro próprio (e não uma `Error` genérica) porque cada chamador precisa
 * mapeá-lo para a SUA forma de falha — `SendMessageError` com HTTP 400 na
 * API, `BroadcastError` no disparo, `Error` simples nos motores — e a
 * mensagem tem de continuar idêntica em cada um deles.
 *
 * `reason` tem default `no_channel` para que todo `new
 * ChannelNotConfiguredError()` já existente continue significando
 * exatamente o que significava.
 */
export class ChannelNotConfiguredError extends Error {
  readonly reason: ChannelNotConfiguredReason;

  constructor(
    message = 'WhatsApp not configured for this account',
    reason: ChannelNotConfiguredReason = 'no_channel'
  ) {
    super(message);
    this.name = 'ChannelNotConfiguredError';
    this.reason = reason;
  }
}

/** O canal não sabe fazer o que foi pedido (matriz de `capabilities`). */
export class ChannelCapabilityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChannelCapabilityError';
  }
}
