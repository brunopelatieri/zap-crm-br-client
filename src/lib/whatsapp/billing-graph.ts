/**
 * Leitura da Graph API para o monitor de cobrança (SPEC 076 §7.2).
 *
 * Só I/O: faz o GET, mede, loga e devolve o resultado já interpretado por
 * `billing-monitor.ts`. Cache, TTL, recuo e gravação são da F4
 * (`billing-server.ts`).
 *
 * Versão da Graph (D-3): `v26.0`, numa constante PRÓPRIA. O resto do
 * repositório fica em `META_API_VERSION = 'v21.0'` (meta-api.ts) e trocar
 * aquela merece PR próprio, com a sincronização de templates revalidada.
 * Se a validação V-7 mostrar que `v21.0` responde igual, esta constante
 * some e vale a global.
 */

import { MetaApiError, throwMetaError } from './meta-api';
import {
  maskId,
  parseBusinessUseCaseUsage,
  parseHealthStatus,
  parsePricingAnalytics,
  type BusinessUseCaseUsage,
  type ParsedHealth,
  type ParsedSpend,
} from './billing-monitor';

export const META_BILLING_API_VERSION = 'v26.0';
const META_BILLING_API_BASE = `https://graph.facebook.com/${META_BILLING_API_VERSION}`;

/** A tela nunca espera a Meta mais que isto (RNF-03). */
const GRAPH_TIMEOUT_MS = 10_000;

/**
 * `MetaApiError` que carrega o cabeçalho `X-Business-Use-Case-Usage` da
 * resposta de erro — é dele que sai o "tente após HH:MM" do limite de
 * taxa (§7.6). `instanceof MetaApiError` continua valendo.
 */
export class BillingGraphError extends MetaApiError {
  readonly usage: BusinessUseCaseUsage | null;

  constructor(source: MetaApiError, usage: BusinessUseCaseUsage | null) {
    super(source.message, source.status, source.code);
    this.usage = usage;
  }
}

/** Resultado de uma leitura: o dado interpretado + a folga de taxa. */
export interface GraphRead<T> {
  data: T;
  usage: BusinessUseCaseUsage | null;
}

interface GraphGetArgs {
  wabaId: string;
  accessToken: string;
  /** Valor do parâmetro `fields`. */
  fields: string;
  /** Rótulo da leitura no log (`health_status`, `pricing_analytics`). */
  label: string;
  /** Só para o log (§13.1); nunca vai à Meta. */
  accountId?: string;
}

/**
 * GET autenticado ao nó do WABA. O token vai SÓ no header (§12) — nunca
 * na query string — e o `wabaId` é validado como dígitos antes de entrar
 * no caminho da URL.
 */
async function graphGet(
  args: GraphGetArgs
): Promise<{ body: unknown; usage: BusinessUseCaseUsage | null }> {
  const { wabaId, accessToken, fields, label, accountId } = args;

  if (!/^\d+$/.test(wabaId)) {
    throw new MetaApiError('Invalid WABA id', 400, null);
  }

  const url = new URL(`${META_BILLING_API_BASE}/${wabaId}`);
  url.searchParams.set('fields', fields);

  const startedAt = Date.now();
  let status: number | null = null;
  let code: number | null = null;
  let usage: BusinessUseCaseUsage | null = null;
  let failed = true;

  try {
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(GRAPH_TIMEOUT_MS),
    });
    status = response.status;
    usage = parseBusinessUseCaseUsage(
      response.headers.get('X-Business-Use-Case-Usage')
    );

    if (!response.ok) {
      // `throwMetaError` sempre lança um `MetaApiError`; reembrulha para
      // anexar a folga de taxa lida do cabeçalho.
      try {
        await throwMetaError(response, `Meta API error: ${response.status}`);
      } catch (err) {
        code = (err as MetaApiError).code;
        throw new BillingGraphError(err as MetaApiError, usage);
      }
    }

    const body: unknown = await response.json();
    failed = false;
    return { body, usage };
  } finally {
    // Uma linha por chamada (§13.1). Nunca token, nunca corpo cru.
    const callCount =
      usage?.callCount != null ? ` usage_calls=${usage.callCount}%` : '';
    console.log(
      `[billing-monitor] account=${accountId ?? '-'} waba=${maskId(wabaId)} ` +
        `field=${label} http=${status ?? '-'} code=${code ?? '-'} ` +
        `ms=${Date.now() - startedAt} outcome=${failed ? 'error' : 'ok'}${callCount}`
    );
  }
}

export interface GetSendStatusArgs {
  wabaId: string;
  accessToken: string;
  accountId?: string;
}

/**
 * `GET /{WABA_ID}?fields=currency,health_status` — status de envio e
 * moeda do WABA (F-6).
 */
export async function getSendStatus(
  args: GetSendStatusArgs
): Promise<GraphRead<ParsedHealth>> {
  const { body, usage } = await graphGet({
    ...args,
    fields: 'currency,health_status',
    label: 'health_status',
  });
  return { data: parseHealthStatus(body), usage };
}

export interface GetMonthSpendArgs {
  wabaId: string;
  accessToken: string;
  /** Janela em segundos Unix — use `monthSpendWindow(now)`. */
  start: number;
  end: number;
  /** "Agora" para decidir o mês local; padrão `new Date()`. */
  now?: Date;
  accountId?: string;
}

/**
 * `pricing_analytics` diário por categoria (F-8), somado só no mês local
 * corrente do WABA.
 */
export async function getMonthSpend(
  args: GetMonthSpendArgs
): Promise<GraphRead<ParsedSpend>> {
  const { start, end, now = new Date(), ...rest } = args;
  if (!Number.isInteger(start) || !Number.isInteger(end)) {
    throw new MetaApiError('Invalid analytics window', 400, null);
  }

  const { body, usage } = await graphGet({
    ...rest,
    fields:
      `pricing_analytics.start(${start}).end(${end})` +
      `.granularity(DAILY).dimensions(["PRICING_CATEGORY"])`,
    label: 'pricing_analytics',
  });
  return { data: parsePricingAnalytics(body, now), usage };
}
