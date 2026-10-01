/**
 * Leitura do monitor de cobrança no servidor (SPEC 076 §7.2, §7.5, §7.6, §9).
 *
 * O que este módulo faz
 *
 *   Resolve o canal, lê o retrato guardado em `whatsapp_billing_status`,
 *   decide POR CAMPO o que venceu (status de envio 5 min, consumo 15 min,
 *   virada de mês invalida o consumo), chama a Graph só para o que venceu
 *   (os dois campos em paralelo), grava e devolve o DTO filtrado por
 *   papel. É o irmão de `messaging-limit-server.ts` — o precedente de
 *   cache persistido da SPEC 044 — com três diferenças:
 *
 *     1. o retrato é por WABA, não por número (D-1);
 *     2. cada leitura tem o seu erro, o seu contador e o seu recuo (§7.6);
 *     3. a tabela só aceita escrita de `service_role` e só admin+ a lê
 *        (RLS), então TODA ida a ela passa por `supabaseAdmin()` — o
 *        cliente de sessão fica restrito a resolver canal/credencial.
 *
 * Contratos que a F3 deixou (billing-signal.ts / migração 087)
 *
 *   - O UPSERT do retrato leva SÓ colunas de health/spend. As colunas de
 *     pagamento (`payment_*`, `last_payment_error_*`) são de
 *     `apply_payment_signal`: um upsert que as incluísse poderia
 *     sobrescrever um episódio aberto no meio da leitura da Graph. O
 *     `select('*')` do upsert devolve a linha JÁ mesclada, com o
 *     pagamento atual.
 *   - Um carimbo por rodada: `health_checked_at`/`*_error_at` usam o
 *     mesmo `now` (`deriveSendState` compara com `>`).
 *   - O estado de pagamento é só LIDO aqui (D-4: nunca se limpa por
 *     `health_status = AVAILABLE`). A única escrita nele é a limpeza
 *     MANUAL de {@link acknowledgePayment}, com `now()` de propósito.
 *
 * A Meta nunca vira erro 5xx
 *
 *   Falha da Graph (timeout, 5xx, limite de taxa, token recusado) é
 *   gravada como erro da leitura e devolvida num 200 com o último
 *   retrato, `stale` e `error`. Só erro interno (o banco) sobe como
 *   exceção.
 *
 * Token (RNF-01)
 *
 *   `decrypt` roda só aqui, só quando há chamada a fazer (retrato fresco
 *   não decifra nada) e DEPOIS de `resolveCloudConfig` ter validado
 *   conta/tipo/`disabled`. O token vai só no header (billing-graph) e
 *   nunca em log, DTO, `*_error_message` ou tabela.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { after } from 'next/server';

import { ChannelNotConfiguredError } from '@/lib/channels/errors';
import { canEditSettings, type AccountRole } from '@/lib/auth/roles';
import { supabaseAdmin } from '@/lib/supabase/admin';
import type { WabaHealthEntity, WhatsappBillingStatusRow } from '@/types';
import {
  BillingGraphError,
  getMonthSpend,
  getSendStatus,
} from './billing-graph';
import {
  buildChannelBillingDto,
  buildChannelSummary,
  computeNextRetryAt,
  decideRead,
  FORCE_REFRESH_COOLDOWN_MS,
  worstState,
  type ChannelBillingDto,
  type ChannelBillingSummaryDto,
} from './billing-dto';
import {
  classifyGraphError,
  maskId,
  monthSpendWindow,
  sanitizeErrorMessage,
  type SendState,
} from './billing-monitor';
import { listCloudChannels, resolveCloudConfig } from './cloud-channels';
import { decrypt } from './encryption';
import { MetaApiError } from './meta-api';
import {
  SCHEMA_RETRY_MS,
  errMsg,
  isSchemaMissingError,
  readBillingMonitorFlag,
} from './billing-schema';

const TABLE = 'whatsapp_billing_status';

/** Quantos WABAs vencidos a LISTA atualiza por chamada (§7.5). */
export const LIST_REFRESH_MAX_WABAS = 5;

// ============================================================
// Schema ausente (projeto sem a 086)
// ============================================================

/**
 * Um projeto sem a 086 (o `rs`, hoje) não pode derrubar a aba de
 * configuração (RNF-11). O vocabulário de "schema ausente" é o mesmo de
 * `billing-signal.ts` (`billing-schema.ts`); o estado de processo — por
 * quanto tempo esta peça deixa de consultar — é daqui.
 */
let schemaUnavailableUntil = 0;

function schemaAvailable(now: Date): boolean {
  return now.getTime() >= schemaUnavailableUntil;
}

/** `true` se era schema ausente (já tratado e logado uma vez). */
function noteSchemaMissing(error: unknown, now: Date): boolean {
  if (!isSchemaMissingError(error)) return false;
  const wasAvailable = schemaAvailable(now);
  schemaUnavailableUntil = now.getTime() + SCHEMA_RETRY_MS;
  if (wasAvailable) {
    console.warn(
      `[billing-monitor] ${TABLE} missing (migration 086 not applied?) — skipping Graph reads for ${SCHEMA_RETRY_MS / 60000} min:`,
      errMsg(error)
    );
  }
  return true;
}

// ============================================================
// Estado de processo: single-flight e cooldown da leitura forçada
// ============================================================

/**
 * Uma leitura em andamento por `account:waba` (§7.5): lista + detalhe
 * abrindo juntos, ou dois números do mesmo WABA, dividem a mesma ida à
 * Meta. Com mais de uma instância o pior caso é uma chamada duplicada por
 * TTL (RNF-04).
 */
const inflight = new Map<string, Promise<WhatsappBillingStatusRow>>();

/** Quando a última leitura FORÇADA do WABA começou (§9.1: 1 a cada 60 s). */
const forceStamps = new Map<string, number>();

function forceCooldownRemainingMs(key: string, now: Date): number {
  const last = forceStamps.get(key);
  if (last === undefined) return 0;
  return Math.max(0, last + FORCE_REFRESH_COOLDOWN_MS - now.getTime());
}

function stampForce(key: string, now: Date): void {
  forceStamps.set(key, now.getTime());
  if (forceStamps.size > 500) {
    for (const [k, t] of forceStamps) {
      if (t + FORCE_REFRESH_COOLDOWN_MS <= now.getTime()) forceStamps.delete(k);
    }
  }
}

/** Só para teste: zera o estado de processo deste módulo. */
export function __resetBillingServerStateForTests(): void {
  schemaUnavailableUntil = 0;
  inflight.clear();
  forceStamps.clear();
}

// ============================================================
// Flag (D-10)
// ============================================================

/**
 * `platform_settings.whatsapp_billing_monitor_enabled`.
 *
 * Leitura falha (inclui a COLUNA ausente num projeto sem a 086) = tratada
 * como desligado: a rota responde 404 e a UI não renderiza o card, em vez
 * de derrubar a aba (RNF-11). Sem cache de processo de propósito: é uma
 * leitura por ponto de uma linha única, e o cache faria o interruptor do
 * `/admin` parecer quebrado por alguns segundos.
 */
export async function isBillingMonitorEnabled(
  admin?: SupabaseClient
): Promise<boolean> {
  // `supabaseAdmin()` lança sem as variáveis de ambiente: resolvê-lo como
  // valor padrão do parâmetro o avaliaria FORA de qualquer try/catch, e a
  // promessa "erro de leitura = desligado" não valeria para este caso.
  let db: SupabaseClient;
  try {
    db = admin ?? supabaseAdmin();
  } catch (err) {
    console.error(
      '[billing-monitor] could not create the admin client — treating flag as off:',
      err instanceof Error ? err.message : err
    );
    return false;
  }
  return (await readBillingMonitorFlag(db, 'billing-monitor')) === true;
}

// ============================================================
// Retrato
// ============================================================

function emptyRow(accountId: string, wabaId: string): WhatsappBillingStatusRow {
  return {
    account_id: accountId,
    waba_id: wabaId,
    currency: null,
    health_overall: null,
    health_entities: null,
    business_id: null,
    health_checked_at: null,
    spend_period_start: null,
    spend_tz_offset_seconds: null,
    spend_total: null,
    spend_by_category: null,
    spend_currency: null,
    spend_checked_at: null,
    health_error_kind: null,
    health_error_code: null,
    health_error_message: null,
    health_error_at: null,
    health_consecutive_failures: 0,
    health_next_retry_at: null,
    spend_error_kind: null,
    spend_error_code: null,
    spend_error_message: null,
    spend_error_at: null,
    spend_consecutive_failures: 0,
    spend_next_retry_at: null,
    payment_blocked_since: null,
    last_payment_error_at: null,
    last_payment_error_phone_number_id: null,
    payment_cleared_at: null,
    payment_cleared_by: null,
    payment_clear_reason: null,
    created_at: new Date(0).toISOString(),
    updated_at: new Date(0).toISOString(),
  };
}

/**
 * Retrato do WABA, ou `null` se nunca houve leitura — ou se a tabela não
 * existe neste projeto. Erro de banco que não é schema ausente sobe.
 */
async function readSnapshot(
  admin: SupabaseClient,
  accountId: string,
  wabaId: string,
  now: Date
): Promise<WhatsappBillingStatusRow | null> {
  const { data, error } = await admin
    .from(TABLE)
    .select('*')
    .eq('account_id', accountId)
    .eq('waba_id', wabaId)
    .maybeSingle();
  if (error) {
    if (noteSchemaMissing(error, now)) return null;
    throw new Error(`failed to read ${TABLE}: ${errMsg(error)}`);
  }
  return (data as WhatsappBillingStatusRow | null) ?? null;
}

// ============================================================
// Rodada de leitura
// ============================================================

function clearedErrorColumns(
  prefix: 'health' | 'spend'
): Record<string, unknown> {
  return {
    [`${prefix}_error_kind`]: null,
    [`${prefix}_error_code`]: null,
    [`${prefix}_error_message`]: null,
    [`${prefix}_error_at`]: null,
    [`${prefix}_consecutive_failures`]: 0,
    [`${prefix}_next_retry_at`]: null,
  };
}

function failureColumns(
  prefix: 'health' | 'spend',
  err: unknown,
  previousFailures: number,
  nowIso: string,
  now: Date,
  wabaId: string
): Record<string, unknown> {
  const cls = classifyGraphError(err);
  const failures = previousFailures + 1;
  const usage = err instanceof BillingGraphError ? err.usage : null;
  const next = computeNextRetryAt({
    kind: cls.kind,
    consecutiveFailures: failures,
    usageMinutes: usage?.estimatedMinutesToRegainAccess ?? null,
    now,
  });

  // Alertas do §13.3: falha repetida, e código 100 (a Meta mudou o
  // campo/versão). Contáveis por log; nunca token.
  if (failures >= 3) {
    console.error(
      `[billing-monitor] ALERT ${prefix} read failing waba=${maskId(wabaId)} consecutive=${failures} kind=${cls.kind} code=${cls.code ?? '-'}`
    );
  }
  if (cls.suspectVersion) {
    console.error(
      `[billing-monitor] ALERT code=100 on ${prefix} read waba=${maskId(wabaId)} — field or API version may have changed (V-7)`
    );
  }

  return {
    [`${prefix}_error_kind`]: cls.kind,
    [`${prefix}_error_code`]: cls.code,
    [`${prefix}_error_message`]: sanitizeErrorMessage(
      err instanceof Error ? err.message : 'Unknown error'
    ),
    [`${prefix}_error_at`]: nowIso,
    [`${prefix}_consecutive_failures`]: failures,
    [`${prefix}_next_retry_at`]: next ? next.toISOString() : null,
  };
}

/**
 * 368/131031/130403 numa leitura de `health_status`: a conta está
 * restrita por política. §13.2 manda mostrar `blocked` com o texto — então
 * isto vira uma leitura BOA com `BLOCKED` e uma entidade sintética, e não
 * um erro de leitura (que o estado trataria como "falha, mantém o
 * retrato").
 */
function policyBlockedColumns(
  err: unknown,
  wabaId: string,
  nowIso: string
): Record<string, unknown> {
  const code = classifyGraphError(err).code;
  const entity: WabaHealthEntity = {
    entity_type: 'WABA',
    id: wabaId,
    can_send_message: 'BLOCKED',
    errors: [
      {
        error_code: code,
        error_description: sanitizeErrorMessage(
          err instanceof Error ? err.message : 'Account restricted by policy'
        ),
        possible_solution: null,
      },
    ],
    additional_info: [],
  };
  return {
    health_overall: 'BLOCKED',
    health_entities: [entity],
    health_checked_at: nowIso,
    ...clearedErrorColumns('health'),
  };
}

/**
 * Moeda registrada para o consumo do mês (F-5, R-5).
 *
 * O `pricing_analytics` não traz moeda: ela vem do `health_status`. Se a
 * cada leitura `spend_currency` fosse a moeda do momento, a troca de moeda
 * no meio do mês (USD → BRL) acenderia `currency_changed` por no máximo 15
 * min e o aviso sumiria com o mês ainda misturado. Por isso, dentro do
 * MESMO mês (mesmo `spend_period_start`) vale a moeda de quando o mês
 * começou a ser lido; ela só é renovada na virada do mês.
 */
function spendCurrencyFor(
  row: WhatsappBillingStatusRow | null,
  periodStart: string,
  currentCurrency: string | null
): string | null {
  if (row?.spend_currency && row.spend_period_start === periodStart) {
    return row.spend_currency;
  }
  return currentCurrency;
}

interface RefreshArgs {
  admin: SupabaseClient;
  accountId: string;
  wabaId: string;
  /** Token cifrado — decifrado só aqui dentro, só se houver chamada. */
  cipher: string;
  row: WhatsappBillingStatusRow | null;
  healthDue: boolean;
  spendDue: boolean;
  now: Date;
}

/**
 * Uma rodada: chama a Graph para o que venceu (em paralelo), monta o
 * `patch` SÓ com colunas de health/spend, faz o UPSERT e devolve a linha
 * mesclada. Nunca lança por causa da Meta.
 */
async function runRefresh(
  args: RefreshArgs
): Promise<WhatsappBillingStatusRow> {
  const { admin, accountId, wabaId, row, healthDue, spendDue, now } = args;
  const nowIso = now.toISOString();

  let accessToken: string | null = null;
  try {
    accessToken = decrypt(args.cipher);
  } catch (err) {
    // ENCRYPTION_KEY mudou ou ciphertext corrompido. Não há o que
    // chamar: vira erro de credencial (`auth`, sem recuo) e a UI manda
    // refazer o token. Nada do valor decifrado/cifrado entra no log.
    console.error(
      `[billing-monitor] token decryption failed account=${accountId} waba=${maskId(wabaId)}:`,
      err instanceof Error ? err.name : 'error'
    );
  }
  const noToken = () =>
    Promise.reject(
      new MetaApiError('Stored access token cannot be decrypted', 401, null)
    );

  const window = monthSpendWindow(now);
  const [healthRes, spendRes] = await Promise.allSettled([
    healthDue
      ? accessToken
        ? getSendStatus({ wabaId, accessToken, accountId })
        : noToken()
      : Promise.resolve(null),
    spendDue
      ? accessToken
        ? getMonthSpend({
            wabaId,
            accessToken,
            start: window.startSeconds,
            end: window.endSeconds,
            now,
            accountId,
          })
        : noToken()
      : Promise.resolve(null),
  ]);

  const patch: Record<string, unknown> = {
    account_id: accountId,
    waba_id: wabaId,
  };
  let currency = row?.currency ?? null;

  if (healthDue) {
    if (healthRes.status === 'fulfilled' && healthRes.value) {
      const { data } = healthRes.value;
      currency = data.currency ?? currency;
      if (data.overall === null) {
        // §8.1: fora do vocabulário (ou ausente) grava NULL e loga.
        console.warn(
          `[billing-monitor] health_status missing or outside vocabulary waba=${maskId(wabaId)}`
        );
      }
      Object.assign(patch, {
        currency,
        health_overall: data.overall,
        health_entities: data.entities,
        business_id: data.businessId,
        health_checked_at: nowIso,
        ...clearedErrorColumns('health'),
      });
    } else if (healthRes.status === 'rejected') {
      if (classifyGraphError(healthRes.reason).policyBlocked) {
        Object.assign(
          patch,
          policyBlockedColumns(healthRes.reason, wabaId, nowIso)
        );
      } else {
        Object.assign(
          patch,
          failureColumns(
            'health',
            healthRes.reason,
            row?.health_consecutive_failures ?? 0,
            nowIso,
            now,
            wabaId
          )
        );
      }
    }
  }

  if (spendDue) {
    if (spendRes.status === 'fulfilled' && spendRes.value) {
      const { data } = spendRes.value;
      Object.assign(patch, {
        spend_period_start: data.periodStart,
        spend_tz_offset_seconds: data.tzOffsetSeconds,
        // Nulo = indisponível, nunca zero (RF-04).
        spend_total: data.total,
        spend_by_category: data.byCategory,
        spend_currency: spendCurrencyFor(row, data.periodStart, currency),
        spend_checked_at: nowIso,
        ...clearedErrorColumns('spend'),
      });
    } else if (spendRes.status === 'rejected') {
      Object.assign(
        patch,
        failureColumns(
          'spend',
          spendRes.reason,
          row?.spend_consecutive_failures ?? 0,
          nowIso,
          now,
          wabaId
        )
      );
    }
  }

  // O fallback é o retrato anterior + o patch: se a gravação falhar, a
  // resposta ainda mostra o que acabou de ser lido.
  const merged = {
    ...(row ?? emptyRow(accountId, wabaId)),
    ...patch,
  } as WhatsappBillingStatusRow;

  try {
    const { data, error } = await admin
      .from(TABLE)
      .upsert(patch, { onConflict: 'account_id,waba_id' })
      .select('*')
      .maybeSingle();
    if (error) {
      if (!noteSchemaMissing(error, now)) {
        console.error(
          `[billing-monitor] snapshot write failed waba=${maskId(wabaId)}:`,
          errMsg(error)
        );
      }
      return merged;
    }
    return (data as WhatsappBillingStatusRow | null) ?? merged;
  } catch (err) {
    console.error(
      `[billing-monitor] snapshot write threw waba=${maskId(wabaId)}:`,
      err instanceof Error ? err.message : err
    );
    return merged;
  }
}

/** Junta-se à rodada em andamento do WABA, ou começa uma. */
function refreshSingleFlight(
  key: string,
  start: () => Promise<WhatsappBillingStatusRow>
): { promise: Promise<WhatsappBillingStatusRow>; joined: boolean } {
  const existing = inflight.get(key);
  if (existing) return { promise: existing, joined: true };

  const promise: Promise<WhatsappBillingStatusRow> = start().finally(() => {
    if (inflight.get(key) === promise) inflight.delete(key);
  });
  inflight.set(key, promise);
  return { promise, joined: false };
}

// ============================================================
// Um canal (§9.1)
// ============================================================

export type BillingLoadResult =
  | { status: 'ok'; dto: ChannelBillingDto }
  /** Canal de outra conta, de outro tipo, `disabled` ou inexistente. */
  | { status: 'not_found' }
  /** Leitura forçada de novo antes de 60 s no mesmo WABA. */
  | { status: 'throttled'; retryAfterSeconds: number };

export interface LoadChannelBillingOptions {
  /** Ignora o TTL (respeita `next_retry_at` e o 1/60 s por WABA). */
  force?: boolean;
  role: AccountRole;
  now?: Date;
  /** Cliente `service_role`; o padrão é `supabaseAdmin()`. */
  admin?: SupabaseClient;
}

/**
 * Status de envio + consumo de UM canal Cloud.
 *
 * `db` é o cliente de SESSÃO: só resolve canal e credencial (sujeito a
 * RLS, e `resolveCloudConfig` ainda casa `account_id`). O retrato é lido
 * e escrito pelo `admin`, e o `waba_id` consultado vem SEMPRE da
 * `whatsapp_config` da conta — nunca da requisição (RNF-02).
 *
 * Nunca lança por causa da Meta. Lança só erro interno (o banco).
 */
export async function loadChannelBilling(
  db: SupabaseClient,
  accountId: string,
  channelId: string,
  options: LoadChannelBillingOptions
): Promise<BillingLoadResult> {
  const { role } = options;
  // Defesa em profundidade: a rota já responde 403 ao `refresh=1` de
  // agent/viewer, mas quem chamar esta função direto (outra rota, job)
  // não pode contornar a regra de papel nem o balde por usuário.
  const force = Boolean(options.force) && canEditSettings(role);
  const now = options.now ?? new Date();
  const admin = options.admin ?? supabaseAdmin();

  // RF-12: sem WABA/token utilizável o canal é `no_credentials` — sem tocar
  // a Meta nem o banco do monitor. Um ponto só para os dois caminhos
  // (canal órfão/token zerado, ou `waba_id` ausente).
  const noCredentials = (): BillingLoadResult => ({
    status: 'ok',
    dto: buildChannelBillingDto({
      channelId,
      wabaId: null,
      sharedWithChannels: 0,
      row: null,
      role,
      now,
    }),
  });

  let config;
  try {
    ({ config } = await resolveCloudConfig(db, accountId, channelId));
  } catch (err) {
    if (!(err instanceof ChannelNotConfiguredError)) throw err;
    if (err.reason === 'read_failed') throw err;
    if (err.reason === 'no_credentials') return noCredentials();
    // not_found / wrong_type / disabled / no_channel: para quem pergunta
    // é tudo "esse canal não existe" (não vaza que existe em outra conta).
    return { status: 'not_found' };
  }

  const wabaId = (config.waba_id as string | null) || null;
  if (!wabaId) return noCredentials();

  const sharedWithChannels = await countChannelsOfWaba(db, accountId, wabaId);
  const build = (row: WhatsappBillingStatusRow | null): BillingLoadResult => ({
    status: 'ok',
    dto: buildChannelBillingDto({
      channelId,
      wabaId,
      sharedWithChannels,
      row,
      role,
      now,
    }),
  });

  // Tabela ausente (projeto sem a 086): sem retrato, sem como cachear nem
  // recuar — chamar a Meta a cada abertura queimaria o limite de taxa.
  if (!schemaAvailable(now)) return build(null);

  const row = await readSnapshot(admin, accountId, wabaId, now);
  if (!schemaAvailable(now)) return build(null);

  const healthDue = decideRead({ row, field: 'health', now, force }) === 'due';
  const spendDue = decideRead({ row, field: 'spend', now, force }) === 'due';
  if (!healthDue && !spendDue) return build(row);

  const key = `${accountId}:${wabaId}`;
  if (force && !inflight.has(key)) {
    const remaining = forceCooldownRemainingMs(key, now);
    if (remaining > 0) {
      return {
        status: 'throttled',
        retryAfterSeconds: Math.max(1, Math.ceil(remaining / 1000)),
      };
    }
  }

  const { promise, joined } = refreshSingleFlight(key, () =>
    runRefresh({
      admin,
      accountId,
      wabaId,
      cipher: config.access_token as string,
      row,
      healthDue,
      spendDue,
      now,
    })
  );
  // Só a leitura que de fato saiu consome o cooldown.
  if (force && !joined) stampForce(key, now);

  return build(await promise);
}

/**
 * Quantos números ATIVOS da conta atendem o WABA, ele incluído.
 *
 * Enfeite do painel ("Compartilhado com N números"), mas roda em toda
 * leitura — inclusive a de retrato fresco, que não toca a Meta. Por isso é
 * barato no caso comum: UMA consulta a `whatsapp_config` (por `account_id` +
 * `waba_id`); só com mais de uma linha uma segunda consulta confere quais
 * dos canais estão ativos (um `disabled` não conta, como em
 * `listCloudChannels`).
 */
async function countChannelsOfWaba(
  db: SupabaseClient,
  accountId: string,
  wabaId: string
): Promise<number> {
  try {
    const { data: configs, error } = await db
      .from('whatsapp_config')
      .select('channel_id')
      .eq('account_id', accountId)
      .eq('waba_id', wabaId);
    if (error) throw new Error(String(errMsg(error)));

    const ids = [
      ...new Set(
        ((configs ?? []) as Array<{ channel_id: string | null }>)
          .map((c) => c.channel_id)
          .filter((id): id is string => typeof id === 'string' && id !== '')
      ),
    ];
    if (ids.length <= 1) return 1;

    const { data: channels, error: chError } = await db
      .from('channels')
      .select('id')
      .eq('account_id', accountId)
      .eq('type', 'whatsapp_cloud')
      .neq('status', 'disabled')
      .in('id', ids);
    if (chError) throw new Error(String(errMsg(chError)));
    return Math.max(1, (channels ?? []).length);
  } catch (err) {
    // Contagem é enfeite do painel: não derruba a leitura.
    console.error(
      '[billing-monitor] could not count channels of waba:',
      err instanceof Error ? err.message : err
    );
    return 1;
  }
}

// ============================================================
// A lista (§9.2)
// ============================================================

export interface BillingSummaryDto {
  channels: ChannelBillingSummaryDto[];
  /** `null` = conta sem número oficial. */
  worst_state: SendState | null;
}

export interface LoadBillingSummaryOptions {
  role: AccountRole;
  now?: Date;
  admin?: SupabaseClient;
  /** `false` só para teste/uso que não quer disparar atualização. */
  scheduleRefresh?: boolean;
}

/**
 * Resumo de todos os canais Cloud da conta, lido SÓ do banco (a lista
 * nunca espera a Meta). Os WABAs vencidos (no máximo
 * {@link LIST_REFRESH_MAX_WABAS}) são atualizados depois da resposta, via
 * `after()`.
 */
export async function loadBillingSummary(
  db: SupabaseClient,
  accountId: string,
  options: LoadBillingSummaryOptions
): Promise<BillingSummaryDto> {
  const { role, scheduleRefresh = true } = options;
  const now = options.now ?? new Date();
  const admin = options.admin ?? supabaseAdmin();

  const channels = await listCloudChannels(db, accountId);

  let rows: WhatsappBillingStatusRow[] = [];
  if (channels.length > 0 && schemaAvailable(now)) {
    const { data, error } = await admin
      .from(TABLE)
      .select('*')
      .eq('account_id', accountId);
    if (error) {
      if (!noteSchemaMissing(error, now)) {
        throw new Error(`failed to read ${TABLE}: ${errMsg(error)}`);
      }
    } else {
      rows = (data ?? []) as WhatsappBillingStatusRow[];
    }
  }
  const byWaba = new Map(rows.map((r) => [r.waba_id, r]));

  const summaries: ChannelBillingSummaryDto[] = [];
  const refreshTargets = new Map<string, string>();

  for (const channel of channels) {
    const row = channel.wabaId ? (byWaba.get(channel.wabaId) ?? null) : null;
    summaries.push(
      buildChannelSummary({
        channelId: channel.channelId,
        wabaId: channel.wabaId,
        row,
        role,
        now,
      })
    );

    if (
      channel.wabaId &&
      schemaAvailable(now) &&
      !refreshTargets.has(channel.wabaId) &&
      (decideRead({ row, field: 'health', now, force: false }) === 'due' ||
        decideRead({ row, field: 'spend', now, force: false }) === 'due')
    ) {
      refreshTargets.set(channel.wabaId, channel.channelId);
    }
  }

  if (scheduleRefresh && refreshTargets.size > 0) {
    scheduleBackgroundRefresh(
      admin,
      accountId,
      [...refreshTargets.values()].slice(0, LIST_REFRESH_MAX_WABAS)
    );
  }

  return {
    channels: summaries,
    worst_state: worstState(summaries.map((s) => s.state)),
  };
}

/**
 * Atualiza os canais depois de a resposta sair. Roda com o cliente
 * `service_role` (o de sessão pode vencer no meio, como o fan-out de
 * disparo — `supabase/admin.ts`); o escopo de conta continua em toda
 * consulta de `resolveCloudConfig`. Fora do ciclo de uma requisição
 * `after()` lança, e a promessa corre solta como último recurso (mesmo
 * desenho de `notifications/emit.ts`).
 */
function scheduleBackgroundRefresh(
  admin: SupabaseClient,
  accountId: string,
  channelIds: string[]
): void {
  const run = async () => {
    const results = await Promise.allSettled(
      channelIds.map((id) =>
        loadChannelBilling(admin, accountId, id, {
          force: false,
          role: 'viewer',
          admin,
        })
      )
    );
    for (const r of results) {
      if (r.status === 'rejected') {
        console.error(
          '[billing-monitor] background refresh failed:',
          r.reason instanceof Error ? r.reason.message : r.reason
        );
      }
    }
  };
  try {
    after(run);
  } catch {
    void run().catch(() => undefined);
  }
}

// ============================================================
// Limpeza manual do pagamento (§6.3, §9.3)
// ============================================================

export type PaymentAckResult =
  | { status: 'ok'; cleared: false }
  | { status: 'ok'; cleared: true; clearedAt: string }
  | { status: 'not_found' };

/**
 * "Já regularizei": limpa o estado de pagamento do WABA do canal.
 *
 * `payment_cleared_at = now()` de PROPÓSITO — a limpeza automática da F3
 * usa o carimbo da mensagem cobrável (cabeçalho da migração 087), mas
 * aqui a intenção é justamente descartar os erros que já existem: um
 * 131042 com `ts` anterior a este instante não reabre o episódio.
 *
 * O `UPDATE` é condicional (`payment_blocked_since IS NOT NULL`), então
 * dois cliques simultâneos limpam uma vez só e o segundo vê
 * `cleared: false`. O `waba_id` vem da `whatsapp_config` da conta.
 */
export async function acknowledgePayment(
  db: SupabaseClient,
  accountId: string,
  channelId: string,
  options: { userId: string; now?: Date; admin?: SupabaseClient }
): Promise<PaymentAckResult> {
  const now = options.now ?? new Date();
  const admin = options.admin ?? supabaseAdmin();

  // Só valida conta/tipo/`disabled` — não precisa do token, então nem a
  // credencial zerada impede de limpar um alerta antigo.
  const { data: channel, error: channelError } = await db
    .from('channels')
    .select('id, type, status')
    .eq('id', channelId)
    .eq('account_id', accountId)
    .maybeSingle();
  if (channelError) {
    throw new Error(`failed to read channel: ${errMsg(channelError)}`);
  }
  if (
    !channel ||
    channel.type !== 'whatsapp_cloud' ||
    channel.status === 'disabled'
  ) {
    return { status: 'not_found' };
  }

  // Lido direto (e não por `resolveWabaIdForChannel`, que engole o erro e
  // devolve `null`): uma leitura que FALHOU não pode virar "sem pendência"
  // — o admin ouviria `cleared: false` com o alerta ainda aberto.
  const { data: config, error: configError } = await db
    .from('whatsapp_config')
    .select('waba_id')
    .eq('channel_id', channelId)
    .eq('account_id', accountId)
    .maybeSingle();
  if (configError) {
    throw new Error(`failed to read waba_id: ${errMsg(configError)}`);
  }
  const wabaId = (config?.waba_id as string | null | undefined) || null;
  if (!wabaId) return { status: 'ok', cleared: false };

  // Limite conhecido (SPEC 076 §10.4): `payment_cleared_at` é comparado com
  // o carimbo DA META em `apply_payment_signal`. Com o relógio do app
  // adiantado em relação ao da Meta, um 131042 real logo depois do clique
  // chega com `ts < payment_cleared_at` e é ignorado. Não há margem segura:
  // recuar o carimbo faria os erros de segundos ANTES do clique (o caso
  // comum — o admin vê a falha, paga, clica) reabrirem o episódio. A
  // premissa é relógio sincronizado por NTP no servidor.
  const clearedAt = now.toISOString();
  const { data, error } = await admin
    .from(TABLE)
    .update({
      payment_blocked_since: null,
      payment_cleared_at: clearedAt,
      payment_cleared_by: options.userId,
      payment_clear_reason: 'manual',
    })
    .eq('account_id', accountId)
    .eq('waba_id', wabaId)
    .not('payment_blocked_since', 'is', null)
    .select('waba_id');
  if (error) {
    if (noteSchemaMissing(error, now)) return { status: 'ok', cleared: false };
    throw new Error(`failed to clear payment state: ${errMsg(error)}`);
  }

  if (!data || data.length === 0) return { status: 'ok', cleared: false };

  console.log(
    `[billing-monitor] payment cleared manually waba=${maskId(wabaId)} by=${options.userId}`
  );
  return { status: 'ok', cleared: true, clearedAt };
}

// ============================================================
// Credencial refeita (§9.4)
// ============================================================

/**
 * Zera os erros, contadores e recuos das DUAS leituras do WABA salvo, para
 * o `auth_error` sair assim que a credencial for refeita (`POST
 * /api/whatsapp/config`). Não toca no retrato nem no pagamento.
 *
 * Best-effort, nunca lança: o `POST` já gravou a credencial, e uma falha
 * aqui só adia a saída do `auth_error` até a próxima leitura forçada.
 */
export async function resetBillingReadErrors(
  admin: SupabaseClient,
  accountId: string,
  wabaId: string
): Promise<void> {
  try {
    const { error } = await admin
      .from(TABLE)
      .update({
        ...clearedErrorColumns('health'),
        ...clearedErrorColumns('spend'),
      })
      .eq('account_id', accountId)
      .eq('waba_id', wabaId);
    if (error && !noteSchemaMissing(error, new Date())) {
      console.error(
        `[billing-monitor] could not reset read errors waba=${maskId(wabaId)}:`,
        errMsg(error)
      );
    }
  } catch (err) {
    console.error(
      `[billing-monitor] reset read errors threw waba=${maskId(wabaId)}:`,
      err instanceof Error ? err.message : err
    );
  }
}
