/**
 * Lê e valida o `.env` do canal de e-mail (SPEC 063 §4.1, §7). NUNCA
 * lança — canal ausente/incompleto é no-op silencioso (§1 regra 3), não
 * erro: um `.env` incompleto de fork nunca pode quebrar a operação dele.
 *
 * Sem `SMTP_HOST` OU sem `SYSTEM_NOTIFICATION_EMAIL` → `null` — e-mail
 * sem destino não é configuração parcial, é nenhuma (§4.1). Um
 * `console.warn` UMA vez por processo, não por evento, senão o log vira
 * ruído e o operador para de ler.
 */

export type EnvSource = Record<string, string | undefined>;

export interface MailerConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string | null;
  password: string | null;
  from: string;
  to: string;
}

let warnedThisProcess = false;

function warnOnce(message: string): void {
  if (warnedThisProcess) return;
  warnedThisProcess = true;
  console.warn(message);
}

/** Só para testes — reseta o guarda de "avisou uma vez". */
export function _resetMailerConfigWarningForTests(): void {
  warnedThisProcess = false;
}

function parsePort(raw: string | undefined): number | null {
  if (raw === undefined || raw.trim() === '') return 587;
  const n = Number(raw.trim());
  if (!Number.isInteger(n) || n <= 0 || n > 65535) return null;
  return n;
}

function parseSecure(raw: string | undefined): boolean {
  const normalized = (raw ?? '').trim().toLowerCase();
  return normalized === 'true' || normalized === '1';
}

export function readMailerConfig(
  env: EnvSource = process.env
): MailerConfig | null {
  const host = env.SMTP_HOST?.trim();
  const to = env.SYSTEM_NOTIFICATION_EMAIL?.trim();

  if (!host || !to) {
    warnOnce(
      '[mailer/config] SMTP_HOST/SYSTEM_NOTIFICATION_EMAIL ausente — canal de e-mail desligado'
    );
    return null;
  }

  const port = parsePort(env.SMTP_PORT);
  if (port === null) {
    warnOnce('[mailer/config] SMTP_PORT inválida — canal de e-mail desligado');
    return null;
  }

  return {
    host,
    port,
    secure: parseSecure(env.SMTP_SECURE),
    user: env.SMTP_USER?.trim() || null,
    password: env.SMTP_PASSWORD || null,
    // Achado de code review: o fallback antigo era `host` — um nome de
    // servidor SMTP (`smtp.gmail.com`), não um endereço. Praticamente
    // todo MTA rejeita `MAIL FROM:<smtp.gmail.com>` (501/553), e a
    // configuração mínima que o docstring deste arquivo promete (só
    // `SMTP_HOST` + `SYSTEM_NOTIFICATION_EMAIL`) produzia um canal
    // "configurado" que nunca entrega nada. `to` já é um endereço real
    // (é para onde os avisos vão) e é o único outro endereço que este
    // módulo conhece sem exigir uma variável nova.
    from: env.SMTP_FROM?.trim() || to,
    to,
  };
}
