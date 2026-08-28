/**
 * Transporte `nodemailer` único por processo (SPEC 063 §4.1).
 *
 * Server-only. `pool: true` reaproveita a conexão entre entregas — sem
 * isto, cada e-mail abriria um handshake SMTP novo, que é caro e é
 * exatamente o tipo de coisa que o `after()` da porta 1 não pode pagar.
 *
 * `connectionTimeout`/`socketTimeout` de 10s — sem timeout, um SMTP que
 * aceita a conexão e não responde segura o `after()` até o teto da
 * função (armadilha documentada na §9 da SPEC).
 *
 * Recriado quando a config muda (host/porta/usuário) — relevante em
 * teste e em hot-reload de dev; em produção o `.env` não muda em tempo
 * de execução, então isto na prática cria um transporte só.
 */

import nodemailer, { type Transporter } from 'nodemailer';

import type { MailerConfig } from './config';

const TIMEOUT_MS = 10_000;

let cached: { key: string; transporter: Transporter } | null = null;

function configKey(config: MailerConfig): string {
  return `${config.host}:${config.port}:${config.secure}:${config.user ?? ''}`;
}

export function getMailTransport(config: MailerConfig): Transporter {
  const key = configKey(config);
  if (cached && cached.key === key) return cached.transporter;

  const transporter = nodemailer.createTransport({
    pool: true,
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: config.user
      ? { user: config.user, pass: config.password ?? undefined }
      : undefined,
    connectionTimeout: TIMEOUT_MS,
    socketTimeout: TIMEOUT_MS,
  });

  cached = { key, transporter };
  return transporter;
}
