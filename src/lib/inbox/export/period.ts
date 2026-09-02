/**
 * Resolução do período da exportação (SPEC 067 D-7).
 *
 * O diálogo manda datas já convertidas para ISO no fuso do navegador
 * (§10), mas a rota também aceita `AAAA-MM-DD` puro — é o que alguém
 * digita num `curl` durante o teste manual, e devolver 400 nesse caso
 * seria hostilidade gratuita. Quando a data vem sem hora, ela é
 * expandida para o dia INTEIRO no fuso informado: início do dia para
 * `from`, 23:59:59.999 para `to`.
 *
 * Por que não usar `new Date('2026-08-12')` e pronto: essa string é
 * interpretada como meia-noite **UTC**, então num fuso a oeste o
 * intervalo começaria já com o dia anterior em curso e o PDF viria com
 * mensagens que o usuário não pediu.
 */

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Quanto o fuso está adiantado em relação ao UTC naquele instante, em
 * milissegundos. Calculado formatando o instante NO fuso e relendo as
 * partes como se fossem UTC — é a forma portátil de obter o offset sem
 * tabela de DST própria.
 */
function timeZoneOffsetMs(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(instant);

  const get = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((p) => p.type === type)?.value ?? '0');

  const asUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    // `hour12: false` pode render "24" para meia-noite em algumas
    // implementações do ICU; normalizar evita um dia inteiro de erro.
    get('hour') % 24,
    get('minute'),
    get('second')
  );
  // As partes formatadas não têm milissegundos, então `asUtc` é sempre
  // truncado no segundo. Comparar com o instante CHEIO faria os ms dele
  // vazarem para dentro do offset — 23:59:59.999 saía como 03:00:00.997.
  const instantTruncatedToSecond = Math.floor(instant.getTime() / 1000) * 1000;
  return asUtc - instantTruncatedToSecond;
}

/**
 * Instante UTC de uma hora de parede num fuso.
 *
 * Duas passadas de propósito: o offset depende do instante, e o
 * instante depende do offset. Na virada do horário de verão a primeira
 * estimativa erra em uma hora; a segunda corrige.
 */
function zonedWallTimeToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  ms: number,
  timeZone: string
): Date {
  const naive = Date.UTC(year, month - 1, day, hour, minute, second, ms);
  const firstGuess = new Date(
    naive - timeZoneOffsetMs(new Date(naive), timeZone)
  );
  return new Date(naive - timeZoneOffsetMs(firstGuess, timeZone));
}

export type PeriodBoundary = 'start' | 'end';

/**
 * Converte o que veio no corpo do POST em um instante ISO.
 * Devolve `null` quando a string não é uma data reconhecível.
 */
export function resolvePeriodBoundary(
  value: string,
  timeZone: string,
  boundary: PeriodBoundary
): string | null {
  if (DATE_ONLY.test(value)) {
    const [year, month, day] = value.split('-').map(Number);
    // `Date.UTC` faz overflow em silêncio: mês 13 vira janeiro do ano
    // seguinte e 31/02 vira 03/03. Sem esta checagem, `2026-13-45`
    // exportaria um período que o usuário nunca pediu, sem erro nenhum.
    const probe = new Date(Date.UTC(year, month - 1, day));
    if (
      probe.getUTCFullYear() !== year ||
      probe.getUTCMonth() !== month - 1 ||
      probe.getUTCDate() !== day
    ) {
      return null;
    }
    const resolved =
      boundary === 'start'
        ? zonedWallTimeToUtc(year, month, day, 0, 0, 0, 0, timeZone)
        : zonedWallTimeToUtc(year, month, day, 23, 59, 59, 999, timeZone);
    return Number.isNaN(resolved.getTime()) ? null : resolved.toISOString();
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString();
}

/** `Intl` aceita este fuso? Fuso inválido é erro do chamador (400), não
 *  um 500 vindo de dentro de um formatador. */
export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}
