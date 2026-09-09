import type { SupabaseClient } from '@supabase/supabase-js';
import {
  daysAgoStart,
  DOW_SHORT_MON_FIRST,
  lastNDayKeys,
  localDayKey,
  mondayIndex,
  startOfLocalDay,
} from './date-utils';
import type {
  ConversationsSeriesPoint,
  MetricsBundle,
  PipelineDonutData,
  PipelineStageSlice,
  ResponseTimeBucket,
  ResponseTimeSummary,
} from './types';
import { queryActivity } from '@/lib/activity/query';
import { toFeedEntry, type ActivityFeedEntry } from '@/lib/activity/feed';

// ------------------------------------------------------------
// Agregação no cliente. A RLS escopa cada query — MAS, desde a
// migração 039, `conversations` e `messages` são visíveis POR LINHA:
// um agente só enxerga as conversas atribuídas a ele mais a fila.
//
// Isso quebraria silenciosamente todo número desta tela. Não com um
// erro — com um valor MENOR: "Conversas ativas" viraria "as minhas",
// o gráfico de tempo de resposta ficaria vazio para um agente recém-
// chegado, e admin e agente veriam totais diferentes na mesma tela
// sem nada indicando o porquê. É o pior modo de falha possível,
// porque parece funcionar.
//
// Por isso tudo o que toca `conversations` / `messages` passa pelas
// RPCs `dashboard_*` (039): SECURITY DEFINER, escopadas por
// `account_id` e com guarda de `is_account_member` — o dashboard
// continua sendo da CONTA para todos os papéis. Daí o parâmetro
// `accountId` que estas funções agora exigem.
//
// `contacts`, `deals` e `pipeline_stages` seguem em queries diretas:
// suas políticas continuam planas por conta e não foram tocadas.
//
// Toda a lógica de bucket por dia LOCAL continua aqui, em TS. Mover
// datas para o SQL trocaria um problema conhecido por um de fuso.
// ------------------------------------------------------------

type DB = SupabaseClient;

// --- 1. Metric cards ---------------------------------------------------

/** Uma linha de `dashboard_counts` (039). */
interface DashboardCountsRow {
  open_conversations: number;
  new_conversations_today: number;
  new_conversations_yesterday: number;
  agent_messages_today: number;
  agent_messages_yesterday: number;
}

export async function loadMetrics(
  db: DB,
  accountId: string
): Promise<MetricsBundle> {
  const todayStart = startOfLocalDay().toISOString();
  const yesterdayStart = daysAgoStart(1).toISOString();

  const [counts, newContactsToday, newContactsYesterday, openDeals] =
    await Promise.all([
      // As cinco contagens que tocam conversations/messages numa RPC só
      // — quatro round-trips a menos que a versão anterior, de quebra.
      db.rpc('dashboard_counts', {
        p_account_id: accountId,
        p_today_start: todayStart,
        p_yesterday_start: yesterdayStart,
      }),
      db
        .from('contacts')
        .select('id', { count: 'exact', head: true })
        .gte('created_at', todayStart),
      db
        .from('contacts')
        .select('id', { count: 'exact', head: true })
        .gte('created_at', yesterdayStart)
        .lt('created_at', todayStart),
      db.from('deals').select('value, status').eq('status', 'open'),
    ]);

  if (counts.error) throw counts.error;

  // `RETURNS TABLE` chega como array de uma linha. Ausência só ocorre
  // se a guarda de conta rejeitar — que já teria lançado acima.
  const c = (counts.data as DashboardCountsRow[] | null)?.[0];

  const openDealsRows = (openDeals.data ?? []) as { value: number | null }[];
  const openDealsValue = openDealsRows.reduce(
    (sum, d) => sum + (d.value ?? 0),
    0
  );

  return {
    activeConversations: {
      current: c?.open_conversations ?? 0,
      // "vs yesterday" on a current-state count has no clean answer
      // without snapshots — we show the delta in NEW open conversations
      // today vs yesterday. That's the business-meaningful daily signal.
      previous:
        (c?.new_conversations_today ?? 0) -
        (c?.new_conversations_yesterday ?? 0),
    },
    newContactsToday: {
      current: newContactsToday.count ?? 0,
      previous: newContactsYesterday.count ?? 0,
    },
    openDealsValue,
    openDealsCount: openDealsRows.length,
    messagesSentToday: {
      current: c?.agent_messages_today ?? 0,
      previous: c?.agent_messages_yesterday ?? 0,
    },
  };
}

// --- 2. Conversations over time ---------------------------------------

export async function loadConversationsSeries(
  db: DB,
  accountId: string,
  rangeDays: number
): Promise<ConversationsSeriesPoint[]> {
  const start = daysAgoStart(rangeDays - 1).toISOString();
  const { data, error } = await db.rpc('dashboard_message_series', {
    p_account_id: accountId,
    p_start: start,
  });
  if (error) throw error;

  const keys = lastNDayKeys(rangeDays);
  const buckets = new Map<string, { incoming: number; outgoing: number }>();
  for (const k of keys) buckets.set(k, { incoming: 0, outgoing: 0 });

  for (const row of (data ?? []) as {
    created_at: string;
    sender_type: string;
  }[]) {
    const key = localDayKey(row.created_at);
    const bucket = buckets.get(key);
    if (!bucket) continue;
    if (row.sender_type === 'customer') bucket.incoming += 1;
    else bucket.outgoing += 1; // agent + bot both count as outgoing
  }

  return keys.map((day) => ({
    day,
    ...(buckets.get(day) ?? { incoming: 0, outgoing: 0 }),
  }));
}

// --- 3. Pipeline donut -------------------------------------------------

export async function loadPipelineDonut(db: DB): Promise<PipelineDonutData> {
  const [stagesRes, dealsRes] = await Promise.all([
    db
      .from('pipeline_stages')
      .select('id, name, color, pipeline_id, position')
      .order('position'),
    db.from('deals').select('stage_id, value, status').eq('status', 'open'),
  ]);

  const stages = (stagesRes.data ?? []) as {
    id: string;
    name: string;
    color: string;
  }[];
  const deals = (dealsRes.data ?? []) as {
    stage_id: string;
    value: number | null;
  }[];

  const byStage = new Map<string, { count: number; total: number }>();
  for (const d of deals) {
    const row = byStage.get(d.stage_id) ?? { count: 0, total: 0 };
    row.count += 1;
    row.total += d.value ?? 0;
    byStage.set(d.stage_id, row);
  }

  const slices: PipelineStageSlice[] = stages
    .map((s) => ({
      id: s.id,
      name: s.name,
      color: s.color || '#64748b',
      dealCount: byStage.get(s.id)?.count ?? 0,
      totalValue: byStage.get(s.id)?.total ?? 0,
    }))
    // Hide empty stages from the ring (but we'd still show them in the
    // legend if the user wanted a full breakdown — trimming keeps the
    // visual clean for the common case).
    .filter((s) => s.totalValue > 0 || s.dealCount > 0);

  return {
    stages: slices,
    totalValue: slices.reduce((sum, s) => sum + s.totalValue, 0),
  };
}

// --- 4. Response time by day of week ----------------------------------

export async function loadResponseTime(
  db: DB,
  accountId: string
): Promise<ResponseTimeSummary> {
  // Pull the last 14 days of messages in one shot, then walk per
  // conversation to find each "first inbound" → "first subsequent
  // outbound" pair. 14 days gives us both "this week" + "last week"
  // with enough overlap if the user opens the dashboard late on a
  // Monday.
  const fourteenDaysAgo = daysAgoStart(13).toISOString();
  // A RPC já devolve ordenado por (conversation_id, created_at) — a
  // ordenação faz parte do contrato dela, porque o pareamento abaixo
  // percorre as linhas em sequência e depende disso.
  const { data, error } = await db.rpc('dashboard_response_samples', {
    p_account_id: accountId,
    p_start: fourteenDaysAgo,
  });
  if (error) throw error;

  const rows = (data ?? []) as {
    conversation_id: string;
    sender_type: string;
    created_at: string;
  }[];

  // Group per conversation, pair unreplied customer messages with the
  // next outbound message from the agent/bot. A single customer message
  // can only count once (avoids inflating averages if the customer
  // double-messages while the agent takes time to reply).
  interface Sample {
    customerAt: Date;
    responseAt: Date;
  }
  const samples: Sample[] = [];

  let currentConv = '';
  let pendingCustomer: Date | null = null;
  for (const row of rows) {
    if (row.conversation_id !== currentConv) {
      currentConv = row.conversation_id;
      pendingCustomer = null;
    }
    const ts = new Date(row.created_at);
    if (row.sender_type === 'customer') {
      if (!pendingCustomer) pendingCustomer = ts;
    } else if (pendingCustomer) {
      samples.push({ customerAt: pendingCustomer, responseAt: ts });
      pendingCustomer = null;
    }
  }

  const now = new Date();
  const thisWeekStart = daysAgoStart(mondayIndex(now));
  const lastWeekStart = daysAgoStart(mondayIndex(now) + 7);

  // Per-day-of-week buckets, averaged over both weeks' worth of data
  // so each bar has more samples to stand on. If a day has no samples
  // its avgMinutes stays null and the chart renders the bar muted.
  const byDow = new Map<number, number[]>();
  for (let i = 0; i < 7; i++) byDow.set(i, []);
  const thisWeekMins: number[] = [];
  const lastWeekMins: number[] = [];

  for (const s of samples) {
    const diffMin = (s.responseAt.getTime() - s.customerAt.getTime()) / 60_000;
    if (diffMin < 0) continue;
    const dow = mondayIndex(s.customerAt);
    byDow.get(dow)!.push(diffMin);
    if (s.customerAt >= thisWeekStart) {
      thisWeekMins.push(diffMin);
    } else if (s.customerAt >= lastWeekStart && s.customerAt < thisWeekStart) {
      lastWeekMins.push(diffMin);
    }
  }

  const avg = (arr: number[]) =>
    arr.length === 0 ? null : arr.reduce((a, b) => a + b, 0) / arr.length;

  const buckets: ResponseTimeBucket[] = Array.from({ length: 7 }, (_, dow) => {
    const samples = byDow.get(dow) ?? [];
    return {
      dow,
      avgMinutes: avg(samples),
      samples: samples.length,
    };
  });

  // Silence unused-label warnings — keep the arrays explicitly named
  // for readability above.
  void DOW_SHORT_MON_FIRST;

  return {
    buckets,
    thisWeekAvg: avg(thisWeekMins),
    lastWeekAvg: avg(lastWeekMins),
  };
}

// --- 5. Activity feed --------------------------------------------------

/**
 * O feed "Atividade recente" (SPEC 075 F6).
 *
 * ## Era cinco consultas ao vivo; virou uma leitura de log
 *
 * Até a SPEC 075 esta função disparava cinco consultas em paralelo
 * (mensagens, contatos, negócios, disparos, execuções de automação) e
 * intercalava o resultado por timestamp. O problema não era o custo —
 * era o significado: das cinco fontes, só `automation_logs` era um log.
 * As outras quatro eram o ESTADO PRESENTE das tabelas disfarçado de
 * linha do tempo (§1.1 da SPEC).
 *
 * O caso que expõe isso: `deals` entrava por `updated_at` e o texto
 * mostrava o estágio ATUAL. Mover o mesmo negócio de novo não criava
 * histórico — reescrevia a linha. E contato editado, conversa
 * reatribuída e mensagem apagada não apareciam de jeito nenhum, porque
 * nenhum `SELECT` recupera um valor que nunca foi gravado.
 *
 * Agora é UMA consulta em `account_activity_log`, onde cada linha foi
 * gravada no instante em que o evento aconteceu.
 *
 * ## O que a RLS faz aqui, e por que isso basta
 *
 * Nenhum filtro de ator neste código: a policy `account_activity_log_select`
 * (migração 084) já entrega a conta inteira para admin/owner e SÓ as
 * linhas do próprio usuário para um agente (D-5). O widget renderiza o
 * que voltar — o corte de privacidade do §9 é do banco, não daqui.
 */
export async function loadActivity(
  db: DB,
  accountId: string,
  limit = 20
): Promise<ActivityFeedEntry[]> {
  // Janela explícita de 90 dias em vez dos 30 padrão de `queryActivity`:
  // o widget é a primeira coisa que alguém vê depois de uma semana sem
  // abrir o CRM, e um feed vazio ali se lê como "nada aconteceu", não
  // como "nada aconteceu NO ÚLTIMO MÊS".
  const from = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();

  const result = await queryActivity(
    db as unknown as SupabaseClient,
    accountId,
    {
      from,
      limit,
    }
  );

  // `ActivityQueryError` só acontece por filtro inválido, e os dois
  // filtros aqui são gerados por este próprio código — se acontecer, é
  // bug nosso, não entrada do usuário.
  if ('error' in result) {
    console.error('[dashboard] activity query rejected filters:', result);
    return [];
  }

  return result.items.map(toFeedEntry);
}
