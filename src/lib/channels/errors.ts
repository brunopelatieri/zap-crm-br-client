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
 * A conta não tem canal configurado.
 *
 * Erro próprio (e não uma `Error` genérica) porque cada chamador precisa
 * mapeá-lo para a SUA forma de falha — `SendMessageError` com HTTP 400 na
 * API, `BroadcastError` no disparo, `Error` simples nos motores — e a
 * mensagem tem de continuar idêntica em cada um deles.
 */
export class ChannelNotConfiguredError extends Error {
  constructor(message = 'WhatsApp not configured for this account') {
    super(message);
    this.name = 'ChannelNotConfiguredError';
  }
}

/** O canal não sabe fazer o que foi pedido (matriz de `capabilities`). */
export class ChannelCapabilityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChannelCapabilityError';
  }
}
