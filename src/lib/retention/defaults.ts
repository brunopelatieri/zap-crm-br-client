/**
 * Leitura e validação do `.env` de retenção (SPEC 060 §5, §15).
 *
 * Nunca lança — um `.env` torto não pode derrubar o cron que também
 * drena automações (fase 4 de `/api/automations/cron`, SPEC 060 §6).
 * Valor ausente, não numérico ou negativo numa DIMENSÃO de limite vira
 * "sem limite" ali, com um `console.warn` — nunca "apaga tudo" (§3.4:
 * "toda ausência de configuração resulta em não apagar nada").
 *
 * `MESSAGE_RETENTION_MIN_AGE_HOURS`/`_INTERVAL_HOURS`/`_BATCH_LIMIT` são
 * trilhos de ritmo, não dimensões de limite — valor ausente ou inválido
 * cai no padrão documentado (72h / 6h / 5000), não em "sem limite".
 */

import type {
  RetentionChannelDefaults,
  RetentionDefaults,
  RetentionLimitValue,
} from './types';

export type EnvSource = Record<string, string | undefined>;

const DEFAULT_MIN_AGE_HOURS = 72;
const DEFAULT_INTERVAL_HOURS = 6;
const DEFAULT_BATCH_LIMIT = 5000;

/**
 * Parser de dimensão de limite (max_messages/retention_days/max_favorites
 * vindos do `.env`). Ausente → sem limite, silenciosamente (não
 * configurar é uma escolha válida). Presente mas inválido (não numérico
 * ou negativo) → sem limite, com aviso (é um erro de digitação, não uma
 * escolha). `0` explícito → sem limite, igual à semântica da coluna na
 * tabela (§3.4) — consistência entre as duas fontes de precedência.
 */
function parseLimitDimension(
  raw: string | undefined,
  varName: string
): RetentionLimitValue {
  if (raw === undefined || raw === '') return null;

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 0) {
    console.warn(
      `[retention/defaults] ${varName}="${raw}" inválido — tratando como sem limite.`
    );
    return null;
  }
  if (parsed === 0) return null;
  return parsed;
}

/** Parser de trilho de ritmo — sempre cai num inteiro positivo válido. */
function parsePositiveIntWithFallback(
  raw: string | undefined,
  varName: string,
  fallback: number
): number {
  if (raw === undefined || raw === '') return fallback;

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) {
    console.warn(
      `[retention/defaults] ${varName}="${raw}" inválido — usando padrão ${fallback}.`
    );
    return fallback;
  }
  return parsed;
}

function readChannelDefaults(
  env: EnvSource,
  prefix: string
): RetentionChannelDefaults {
  return {
    maxMessages: parseLimitDimension(
      env[`${prefix}_MAX_MESSAGES`],
      `${prefix}_MAX_MESSAGES`
    ),
    retentionDays: parseLimitDimension(env[`${prefix}_DAYS`], `${prefix}_DAYS`),
    maxFavorites: parseLimitDimension(
      env[`${prefix}_MAX_FAVORITES`],
      `${prefix}_MAX_FAVORITES`
    ),
  };
}

export function readRetentionDefaults(env: EnvSource): RetentionDefaults {
  return {
    enabled: (env.MESSAGE_RETENTION_ENABLED ?? '').toLowerCase() === 'true',
    minAgeHours: parsePositiveIntWithFallback(
      env.MESSAGE_RETENTION_MIN_AGE_HOURS,
      'MESSAGE_RETENTION_MIN_AGE_HOURS',
      DEFAULT_MIN_AGE_HOURS
    ),
    intervalHours: parsePositiveIntWithFallback(
      env.MESSAGE_RETENTION_INTERVAL_HOURS,
      'MESSAGE_RETENTION_INTERVAL_HOURS',
      DEFAULT_INTERVAL_HOURS
    ),
    batchLimit: parsePositiveIntWithFallback(
      env.MESSAGE_RETENTION_BATCH_LIMIT,
      'MESSAGE_RETENTION_BATCH_LIMIT',
      DEFAULT_BATCH_LIMIT
    ),
    whatsapp_qr: readChannelDefaults(env, 'MESSAGE_RETENTION_WHATSAPP_QR'),
    whatsapp_cloud: readChannelDefaults(
      env,
      'MESSAGE_RETENTION_WHATSAPP_CLOUD'
    ),
  };
}
