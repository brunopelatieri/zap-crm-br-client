/**
 * O elo novo na cadeia de retenção (SPEC 062 §3.8, §5.3):
 *
 *   linha da política da conta → padrão global do console → padrão do `.env` → sem limite
 *
 * `defaults.ts` (leitura do `.env`) não muda nenhuma linha — este
 * módulo entra ACIMA dele. Duas regras que os testes fixam:
 *
 *   1. Dimensão a dimensão, não objeto a objeto — definir só
 *      `retentionDays` no console mantém `maxMessages` vindo do
 *      `.env`. Substituir o objeto inteiro faria "editei um campo na
 *      tela" apagar silenciosamente dois limites.
 *   2. JSONB inválido não derruba a varredura — chave desconhecida,
 *      tipo errado ou JSON corrompido faz IGNORAR só aquele pedaço,
 *      com `console.warn`, e seguir com o `.env` para essa dimensão
 *      (ou canal) especificamente. Um valor torto nunca vira "sem
 *      limite" numa direção nem "apagar tudo" na outra.
 *
 * `validateRetentionDefaults` é o parceiro estrito deste módulo — usado
 * pela rota de SAVE (`PUT /api/platform/retention`), no mesmo espírito
 * de `validateCatalog()`: rejeita o payload inteiro com um erro claro
 * quando ele está malformado, porque ali existe uma pessoa digitando
 * que precisa do feedback. `mergeGlobalDefaults` é o lado tolerante,
 * usado pelo `sweep.ts` uma vez por ciclo: o dado já está gravado, e a
 * varredura NUNCA pode abortar por causa de uma linha torta.
 */

import type {
  RetentionChannelDefaults,
  RetentionChannelType,
  RetentionDefaults,
  RetentionLimitValue,
} from './types';
import { MAX_RETENTION_LIMIT_VALUE } from './validate';

const CHANNEL_KEYS = [
  'whatsapp_qr',
  'whatsapp_cloud',
] as const satisfies readonly RetentionChannelType[];
const DIMENSION_KEYS = [
  'maxMessages',
  'retentionDays',
  'maxFavorites',
] as const;
type DimensionKey = (typeof DIMENSION_KEYS)[number];

export type RetentionDefaultsInput = Partial<
  Record<RetentionChannelType, Partial<Record<DimensionKey, number | null>>>
>;

// ------------------------------------------------------------
// mergeGlobalDefaults — lado tolerante (sweep.ts)
// ------------------------------------------------------------

/**
 * Uma dimensão do console. Três estados, e os dois primeiros NÃO são o
 * mesmo estado (achado de code review — colapsá-los era o bug):
 *
 *   - chave AUSENTE do objeto (`undefined`) = não configurado aqui,
 *     cai para o `.env`;
 *   - chave PRESENTE com `null` = "sem limite" explícito — é assim que
 *     `validateRetentionDefaults` grava um `0` digitado no formulário
 *     (mesma semântica de `defaults.ts`/`policy.ts`). Devolver
 *     `undefined` aqui faria essa escolha explícita reverter para o
 *     `.env` no próximo ciclo — exatamente "editar um campo apagou
 *     outro" ao contrário: a varredura volta a aplicar um limite que o
 *     proprietário tinha acabado de desligar;
 *   - número inteiro `>= 0` válido = limite explícito (um `0` cru,
 *     embora `validateRetentionDefaults` nunca deva persistir um, seria
 *     tratado com a mesma semântica de "sem limite" por defesa em
 *     profundidade).
 *
 * Qualquer outra coisa é inválida: avisa e cai para o `.env`, sem
 * derrubar as outras dimensões nem os outros canais.
 */
function parseConsoleDimension(
  raw: unknown,
  path: string
): number | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === null) return null;
  if (
    typeof raw !== 'number' ||
    !Number.isInteger(raw) ||
    raw < 0 ||
    raw > MAX_RETENTION_LIMIT_VALUE
  ) {
    console.warn(
      `[retention/global-defaults] ${path}=${JSON.stringify(raw)} inválido — ignorando, caindo para o .env.`
    );
    return undefined;
  }
  return raw === 0 ? null : raw;
}

function mergeChannel(
  consoleChannelRaw: unknown,
  envChannel: RetentionChannelDefaults,
  channelKey: string
): RetentionChannelDefaults {
  if (consoleChannelRaw === undefined || consoleChannelRaw === null) {
    return envChannel;
  }
  if (
    typeof consoleChannelRaw !== 'object' ||
    Array.isArray(consoleChannelRaw)
  ) {
    console.warn(
      `[retention/global-defaults] ${channelKey} não é um objeto — ignorando, caindo para o .env.`
    );
    return envChannel;
  }

  const consoleChannel = consoleChannelRaw as Record<string, unknown>;
  const result: Record<DimensionKey, RetentionLimitValue> = { ...envChannel };

  for (const dim of DIMENSION_KEYS) {
    const parsed = parseConsoleDimension(
      consoleChannel[dim],
      `${channelKey}.${dim}`
    );
    if (parsed !== undefined) {
      result[dim] = parsed;
    }
  }

  return result;
}

/**
 * `fromConsole` é `platform_settings.retention_defaults` cru (JSONB —
 * `unknown` de propósito, o parser abaixo nunca confia no shape).
 * `fromEnv` é o que `readRetentionDefaults()` já devolve. Nunca lança.
 */
export function mergeGlobalDefaults(
  fromConsole: unknown,
  fromEnv: RetentionDefaults
): RetentionDefaults {
  if (
    fromConsole === undefined ||
    fromConsole === null ||
    typeof fromConsole !== 'object' ||
    Array.isArray(fromConsole)
  ) {
    if (fromConsole !== undefined && fromConsole !== null) {
      console.warn(
        '[retention/global-defaults] retention_defaults não é um objeto — ignorando por inteiro, caindo para o .env.'
      );
    }
    return fromEnv;
  }

  const raw = fromConsole as Record<string, unknown>;

  return {
    ...fromEnv,
    whatsapp_qr: mergeChannel(
      raw.whatsapp_qr,
      fromEnv.whatsapp_qr,
      'whatsapp_qr'
    ),
    whatsapp_cloud: mergeChannel(
      raw.whatsapp_cloud,
      fromEnv.whatsapp_cloud,
      'whatsapp_cloud'
    ),
  };
}

// ------------------------------------------------------------
// validateRetentionDefaults — lado estrito (rota de salvar)
// ------------------------------------------------------------

export type ValidateRetentionDefaultsResult =
  { ok: true; value: RetentionDefaultsInput } | { ok: false; error: string };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Validador estrito para o payload que a tela de configurações envia.
 * Chave de canal ou de dimensão desconhecida, ou valor fora do formato
 * (não inteiro, negativo, ou tipo errado) rejeita o objeto INTEIRO com
 * um erro — ao contrário de `mergeGlobalDefaults`, aqui existe alguém
 * digitando que precisa do feedback antes de salvar.
 */
export function validateRetentionDefaults(
  raw: unknown
): ValidateRetentionDefaultsResult {
  if (!isPlainObject(raw)) {
    return { ok: false, error: 'retention_defaults deve ser um objeto' };
  }

  for (const key of Object.keys(raw)) {
    if (!CHANNEL_KEYS.includes(key as RetentionChannelType)) {
      return { ok: false, error: `chave de canal desconhecida: ${key}` };
    }
  }

  const value: RetentionDefaultsInput = {};

  for (const channel of CHANNEL_KEYS) {
    const channelRaw = raw[channel];
    if (channelRaw === undefined) continue;
    if (!isPlainObject(channelRaw)) {
      return { ok: false, error: `${channel} deve ser um objeto` };
    }

    for (const key of Object.keys(channelRaw)) {
      if (!DIMENSION_KEYS.includes(key as DimensionKey)) {
        return { ok: false, error: `${channel}: chave desconhecida ${key}` };
      }
    }

    const parsedChannel: Partial<Record<DimensionKey, number | null>> = {};
    for (const dim of DIMENSION_KEYS) {
      const dimRaw = channelRaw[dim];
      if (dimRaw === undefined) continue;
      if (dimRaw === null) {
        parsedChannel[dim] = null;
        continue;
      }
      if (
        typeof dimRaw !== 'number' ||
        !Number.isInteger(dimRaw) ||
        dimRaw < 0 ||
        dimRaw > MAX_RETENTION_LIMIT_VALUE
      ) {
        return {
          ok: false,
          error: `${channel}.${dim} deve ser um inteiro >= 0 e <= ${MAX_RETENTION_LIMIT_VALUE}, ou null`,
        };
      }
      // `0` normalizado para `null` — mesma semântica de "sem limite"
      // usada em toda a cadeia de precedência.
      parsedChannel[dim] = dimRaw === 0 ? null : dimRaw;
    }
    value[channel] = parsedChannel;
  }

  return { ok: true, value };
}
