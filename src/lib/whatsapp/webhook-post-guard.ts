/**
 * Limites de UM POST do webhook da Meta (achado A-1 da revisão integrada da
 * SPEC 088).
 *
 * O isolamento do B-6 fez cada item quebrado do corpo virar uma exceção
 * tratada e uma linha de log, sem parar o POST. Como cabem ~830 mil `null`
 * no teto de 4 MiB e nada no laço fazia I/O, um único POST assinado parava
 * o processo (todas as contas) por dezenas de segundos e escrevia centenas
 * de MB de log.
 *
 * Um guard por POST:
 *
 *   - item de FORMA inválida não chega ao banco, e o POST é abandonado a
 *     partir de {@link MAX_INVALID_ITEMS} deles. Falha ao processar um item
 *     BEM FORMADO não conta: com o banco fora do ar, contar descartaria
 *     evento legítimo da Meta (que não é reenviado);
 *   - teto de itens ({@link MAX_ITEMS_PER_POST});
 *   - teto de linhas de log ({@link MAX_LOG_LINES}) e UMA linha de resumo;
 *   - o event loop é cedido a cada {@link YIELD_EVERY_ITEMS} itens, porque
 *     um `await` que não faz I/O só cede microtarefas.
 */

/** Itens de forma inválida a partir dos quais o resto do POST é abandonado. */
export const MAX_INVALID_ITEMS = 100;

/**
 * Teto de itens (`entry` + `change` + `status` + mensagem) de um POST.
 *
 * A Meta documenta lotes de no máximo 1.000 atualizações (Graph API
 * Webhooks, "Frequency") e payload de até 3 MB (visão geral dos webhooks do
 * WhatsApp). O pior caso do lote, uma `entry` e um `change` por
 * atualização, dá 3.000 itens; e 3 MB de `statuses` sem `pricing` (~160
 * bytes cada) não chegam a 20 mil. Nenhum POST da Meta bate neste teto.
 */
export const MAX_ITEMS_PER_POST = 20_000;

/** Linhas de log de um POST, fora a do resumo. */
export const MAX_LOG_LINES = 20;

/**
 * Dessas, quantas podem ser aviso/informação. O resto fica para `error`: o
 * ruído do corpo (que é de quem assinou) não cala uma falha nossa.
 */
export const MAX_NOTICE_LINES = 10;

/** De quantos em quantos itens o event loop é cedido. */
export const YIELD_EVERY_ITEMS = 100;

/** Objeto JSON de verdade: nem `null`, nem lista, nem valor simples. */
export function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export class WebhookPostGuard {
  private items = 0;
  private invalidItems = 0;
  private failures = 0;
  private notices = 0;
  private errors = 0;
  private suppressed = 0;
  private suppressedErrors = 0;
  private steps = 0;
  private reason: 'malformed_items' | 'item_ceiling' | null = null;

  /** O resto do POST não deve ser lido. */
  get stopped(): boolean {
    return this.reason !== null;
  }

  /**
   * Antes de CADA item do corpo. `false`: pare de ler o POST (abandonado ou
   * no teto). Cede o event loop de tempos em tempos.
   */
  async next(): Promise<boolean> {
    if (this.stopped) return false;
    if (this.items >= MAX_ITEMS_PER_POST) {
      this.reason = 'item_ceiling';
      return false;
    }
    this.items++;
    await this.breathe();
    return true;
  }

  /** Cede o event loop a cada {@link YIELD_EVERY_ITEMS} chamadas. */
  async breathe(): Promise<void> {
    if (++this.steps % YIELD_EVERY_ITEMS === 0) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }

  /**
   * Os itens bem formados de uma lista do corpo, com o índice original.
   * Sem I/O: quem chama só consulta o banco se sobrar algum. Se a leitura
   * parar no meio, devolve o que veio antes.
   */
  async wellFormed<T>(
    list: unknown[],
    isWellFormed: (item: unknown) => item is T,
    onMalformed: (index: number) => void
  ): Promise<Array<{ item: T; index: number }>> {
    const kept: Array<{ item: T; index: number }> = [];
    for (let index = 0; index < list.length; index++) {
      if (!(await this.next())) break;
      const item = list[index];
      if (isWellFormed(item)) kept.push({ item, index });
      else onMalformed(index);
    }
    return kept;
  }

  /** Item de forma inválida: conta para o abandono. */
  malformed(...message: unknown[]): void {
    this.invalidItems++;
    this.warn(...message);
    if (this.invalidItems >= MAX_INVALID_ITEMS) {
      this.reason ??= 'malformed_items';
    }
  }

  /** Falha ao processar um item bem formado: NÃO conta para o abandono. */
  failed(...message: unknown[]): void {
    this.failures++;
    this.error(...message);
  }

  /** `console.info` dentro do teto de linhas do POST. */
  info(...message: unknown[]): void {
    if (this.takeNotice()) console.info(...message);
  }

  /** `console.warn` dentro do teto de linhas do POST. */
  warn(...message: unknown[]): void {
    if (this.takeNotice()) console.warn(...message);
  }

  /** `console.error` dentro do teto de linhas do POST. */
  error(...message: unknown[]): void {
    if (this.notices + this.errors < MAX_LOG_LINES) {
      this.errors++;
      console.error(...message);
      return;
    }
    this.suppressed++;
    this.suppressedErrors++;
  }

  /** Fim do POST: uma linha, só se ele foi cortado ou se calou alguma. */
  finish(): void {
    if (!this.stopped && this.suppressed === 0) return;
    console.warn(
      this.stopped
        ? '[webhook] POST cut short — the rest of it was discarded:'
        : '[webhook] POST processed — further log lines suppressed:',
      JSON.stringify({
        reason: this.reason,
        items: this.items,
        malformed: this.invalidItems,
        failed: this.failures,
        log_lines_suppressed: this.suppressed,
        errors_suppressed: this.suppressedErrors,
      })
    );
  }

  private takeNotice(): boolean {
    if (
      this.notices < MAX_NOTICE_LINES &&
      this.notices + this.errors < MAX_LOG_LINES
    ) {
      this.notices++;
      return true;
    }
    this.suppressed++;
    return false;
  }
}
