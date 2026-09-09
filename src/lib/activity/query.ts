// ============================================================
// Leitura de `account_activity_log` — a regra de negócio da página
// `/activity` e do widget "Atividade recente" (SPEC 075 §6.1).
//
// Reusa deliberadamente o que já existe, no espírito do §2 da SPEC:
//   - paginação por cursor `(created_at, id)`: `@/lib/api/v1/pagination`
//     (a mesma que TODO endpoint de lista de `/api/v1` já usa);
//   - resolução de período por fuso: `@/lib/inbox/export/period`
//     (`resolvePeriodBoundary`/`isValidTimeZone`) — é o MESMO bug de
//     fuso que a SPEC 067 já corrigiu uma vez (§7.3 desta SPEC cita
//     isso de propósito).
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import {
  buildPage,
  decodeCursor,
  keysetFilter,
  type Cursor,
} from '@/lib/api/v1/pagination';
import {
  isValidTimeZone,
  resolvePeriodBoundary,
} from '@/lib/inbox/export/period';
import type { ActivityAction, ActivityResourceType } from './types';

export const ACTIVITY_MAX_LIMIT = 100;
export const ACTIVITY_DEFAULT_LIMIT = 50;
/** Janela padrão quando `from`/`to` não vêm no filtro (§6.1). */
const DEFAULT_WINDOW_DAYS = 30;

export interface ActivityRow {
  id: string;
  created_at: string;
  actor_kind: 'user' | 'system' | 'contact' | 'api';
  actor_user_id: string | null;
  actor_name: string | null;
  actor_role: string | null;
  resource_type: ActivityResourceType;
  action: ActivityAction;
  resource_id: string | null;
  resource_label: string | null;
  channel_id: string | null;
  channel_type: string | null;
  conversation_id: string | null;
  contact_id: string | null;
  source_table: string | null;
  source_id: string | null;
  metadata: Record<string, unknown>;
}

export interface ActivityFilters {
  /** ISO ou `AAAA-MM-DD`; datas puras são expandidas por `timeZone`
   *  (§7.3). Ausentes os dois → últimos 30 dias. */
  from?: string | null;
  to?: string | null;
  /** Fuso para expandir `from`/`to` quando vêm como data pura.
   *  Padrão `UTC` — o mesmo default de `conversation/export`. */
  timeZone?: string;
  /** Um UUID de usuário, ou o literal `'system'` para "Sistema"
   *  (§13 item 7 — o cron/motor não tem `actor_user_id`). */
  actorUserId?: string | null;
  resourceTypes?: ActivityResourceType[];
  channelIds?: string[];
  /** Procura em `resource_label` + `actor_name` (§7.4/D-9). Nunca em
   *  `metadata` nem em conteúdo de mensagem. */
  search?: string;
  cursor?: string | null;
  /** Clampado em [1, {@link ACTIVITY_MAX_LIMIT}]. */
  limit?: number;
}

export interface ActivityQueryError {
  error: 'invalid_time_zone' | 'invalid_date';
  field?: 'from' | 'to';
}

export interface ActivityQueryResult {
  items: ActivityRow[];
  nextCursor: string | null;
  /**
   * D-10: quantos eventos o filtro de canal escondeu (a maioria dos
   * eventos — contato, negócio, plano — não tem canal). `null` quando o
   * filtro de canal não está ativo, para a UI distinguir "não filtrei"
   * de "filtrei e não escondi nada".
   */
  hiddenByChannelFilter: number | null;
}

function clampLimit(limit: number | undefined): number {
  if (!limit || !Number.isFinite(limit) || limit <= 0) {
    return ACTIVITY_DEFAULT_LIMIT;
  }
  return Math.min(Math.floor(limit), ACTIVITY_MAX_LIMIT);
}

/**
 * Resolve `from`/`to` em instantes ISO, aplicando a janela padrão de
 * 30 dias quando nenhum dos dois vier. `null` no retorno é erro do
 * chamador (fuso ou data inválidos) — nunca um 500.
 */
function resolveWindow(
  filters: Pick<ActivityFilters, 'from' | 'to' | 'timeZone'>
): { from: string; to: string | null } | ActivityQueryError {
  const timeZone = filters.timeZone ?? 'UTC';
  if (!isValidTimeZone(timeZone)) return { error: 'invalid_time_zone' };

  let from: string | null;
  if (filters.from) {
    from = resolvePeriodBoundary(filters.from, timeZone, 'start');
    if (!from) return { error: 'invalid_date', field: 'from' };
  } else {
    from = new Date(
      Date.now() - DEFAULT_WINDOW_DAYS * 24 * 60 * 60 * 1000
    ).toISOString();
  }

  let to: string | null = null;
  if (filters.to) {
    to = resolvePeriodBoundary(filters.to, timeZone, 'end');
    if (!to) return { error: 'invalid_date', field: 'to' };
  }

  return { from, to };
}

function isQueryError(
  value: { from: string; to: string | null } | ActivityQueryError
): value is ActivityQueryError {
  return 'error' in value;
}

const SELECT_COLUMNS =
  'id, created_at, actor_kind, actor_user_id, actor_name, actor_role, ' +
  'resource_type, action, resource_id, resource_label, channel_id, ' +
  'channel_type, conversation_id, contact_id, source_table, source_id, metadata';

/**
 * Aplica os filtros comuns (período, ator, tipo, busca) a uma query
 * base — usado tanto pela busca principal quanto pela contagem de
 * "escondidos pelo canal" (D-10), que precisa dos MESMOS filtros menos
 * o de canal.
 */
// `any` de propósito: cada estágio do fluent builder do Supabase é um
// tipo genérico DIFERENTE (`PostgrestQueryBuilder` → `PostgrestFilterBuilder`
// → …), e esta função precisa aceitar tanto a query principal quanto a
// de contagem "escondidos pelo canal" (D-10), que começam de formas
// diferentes (`.select(cols)` vs `.select('id', {count, head})`).
function applyCommonFilters(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  query: any,
  accountId: string,
  window: { from: string; to: string | null },
  filters: ActivityFilters
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): any {
  let q = query.eq('account_id', accountId).gte('created_at', window.from);
  if (window.to) q = q.lte('created_at', window.to);

  if (filters.actorUserId === 'system') {
    q = q.eq('actor_kind', 'system');
  } else if (filters.actorUserId) {
    q = q.eq('actor_user_id', filters.actorUserId);
  }

  if (filters.resourceTypes && filters.resourceTypes.length > 0) {
    q = q.in('resource_type', filters.resourceTypes);
  }

  // Mesmo padrão (sem escape) de `contacts/export-fetch.ts` — o termo
  // entra cru no `.or()`; uma vírgula ou parêntese no texto produz um
  // filtro malformado que o PostgREST recusa, não uma consulta
  // diferente da pedida.
  if (filters.search && filters.search.trim()) {
    const like = `%${filters.search.trim()}%`;
    q = q.or(`resource_label.ilike.${like},actor_name.ilike.${like}`);
  }

  return q;
}

/**
 * Busca uma página do feed de atividade da conta, já com o cursor da
 * PRÓXIMA página. Nunca lança por filtro malformado: erros de
 * validação vêm como `ActivityQueryError`, e o chamador (rota) decide
 * o 400.
 */
export async function queryActivity(
  db: SupabaseClient,
  accountId: string,
  filters: ActivityFilters
): Promise<ActivityQueryResult | ActivityQueryError> {
  const window = resolveWindow(filters);
  if (isQueryError(window)) return window;

  const limit = clampLimit(filters.limit);
  const cursor: Cursor | null = decodeCursor(filters.cursor ?? null);

  let query = applyCommonFilters(
    db.from('account_activity_log').select(SELECT_COLUMNS),
    accountId,
    window,
    filters
  );

  if (filters.channelIds && filters.channelIds.length > 0) {
    query = query.in('channel_id', filters.channelIds);
  }

  query = query
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(limit + 1);

  const kf = keysetFilter(cursor);
  if (kf) query = query.or(kf);

  const { data, error } = await query;
  if (error) {
    // A rota decide o 500 — aqui só se propaga o suficiente para logar.
    throw new Error(`queryActivity failed: ${error.message}`);
  }

  const { items, nextCursor } = buildPage(
    (data ?? []) as unknown as ActivityRow[],
    limit
  );

  // D-10 — só custa uma consulta a mais quando o filtro de canal está
  // de fato ligado, e é um `count: 'exact', head: true`: sem trazer
  // linha nenhuma.
  let hiddenByChannelFilter: number | null = null;
  if (filters.channelIds && filters.channelIds.length > 0) {
    const hiddenQuery = applyCommonFilters(
      db
        .from('account_activity_log')
        .select('id', { count: 'exact', head: true }),
      accountId,
      window,
      filters
    ).is('channel_id', null);
    const { count, error: hiddenErr } = await hiddenQuery;
    if (hiddenErr) {
      console.error(
        '[activity/query] hidden-by-channel count failed:',
        hiddenErr.message
      );
    } else {
      hiddenByChannelFilter = count ?? 0;
    }
  }

  return { items, nextCursor, hiddenByChannelFilter };
}
