/**
 * A janela de baixa atividade da captação (SPEC 069 §4.9, §7.2, R5) —
 * módulo PURO.
 *
 * Por que a janela é verificada NO CÓDIGO, não só no agendamento
 *
 *   `cron-jobs.sql` marca a expressão cron em UTC, no fuso do banco —
 *   mas "madrugada" é sobre o Brasil, não sobre o servidor Postgres. Um
 *   agendamento mal copiado (ou um Supabase que não está em
 *   `America/Sao_Paulo`) rodaria a captação o dia inteiro sem ninguém
 *   perceber, exatamente a armadilha "não dispara e não avisa" do
 *   AGENTS.md, na direção oposta: "dispara demais e não avisa". Esta
 *   função é a segunda trava, independente do cron externo.
 *
 * `endHour` é EXCLUSIVO
 *
 *   Padrão `[0, 6)`: a execução das 06:00 já está FORA da janela — a
 *   última execução válida é a das 05:00. Documentado explicitamente
 *   porque "0 a 6" sozinho é ambíguo sobre se a hora 6 conta.
 *
 * Virada de meia-noite é suportada, embora o padrão não a use
 *
 *   `startHour > endHour` (ex.: 22–6) é lido como "hora ≥ start OU hora
 *   < end" — um operador que prefira começar a captação mais cedo na
 *   noite anterior não deveria precisar de duas janelas.
 */

export interface HarvestWindowConfig {
  startHour: number;
  endHour: number;
  timeZone: string;
}

/**
 * A hora local (0–23) de `now` no fuso `timeZone`. Não usa
 * `now.getHours()` (fuso do processo) nem `getUTCHours()` (sempre UTC)
 * — nenhum dos dois é necessariamente `timeZone`.
 */
function localHour(now: Date, timeZone: string): number {
  const formatted = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: 'numeric',
    hourCycle: 'h23',
  }).format(now);
  return Number(formatted);
}

export function isWithinHarvestWindow(
  now: Date,
  { startHour, endHour, timeZone }: HarvestWindowConfig
): boolean {
  const hour = localHour(now, timeZone);

  if (startHour === endHour) {
    // Janela de tamanho zero — nunca "dentro". Evita que uma
    // configuração torta (0,0) seja lida como "24 horas por dia" por
    // acidente de aritmética (hour >= 0 && hour < 0 já dá false, mas
    // documentado para não depender de coincidência).
    return false;
  }

  if (startHour < endHour) {
    return hour >= startHour && hour < endHour;
  }

  // Virada de meia-noite: ex. 22–6.
  return hour >= startHour || hour < endHour;
}
