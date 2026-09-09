// Shared result shapes the dashboard components consume. Centralised
// here so each component stays thin and the page-level loader wires
// them up without type gymnastics.

export interface MetricDelta {
  current: number;
  previous: number;
}

export interface MetricsBundle {
  activeConversations: MetricDelta;
  newContactsToday: MetricDelta;
  openDealsValue: number;
  openDealsCount: number;
  messagesSentToday: MetricDelta;
}

export interface ConversationsSeriesPoint {
  day: string; // YYYY-MM-DD local
  incoming: number;
  outgoing: number;
}

export interface PipelineStageSlice {
  id: string;
  name: string;
  color: string;
  dealCount: number;
  totalValue: number;
}

export interface PipelineDonutData {
  stages: PipelineStageSlice[];
  totalValue: number;
}

export interface ResponseTimeBucket {
  /** 0 = Mon … 6 = Sun (Monday-first). */
  dow: number;
  /** Average first-response time in minutes. Null means no samples. */
  avgMinutes: number | null;
  samples: number;
}

export interface ResponseTimeSummary {
  buckets: ResponseTimeBucket[];
  thisWeekAvg: number | null;
  lastWeekAvg: number | null;
}

// `ActivityKind` / `ActivityItem` moraram aqui até a SPEC 075 F6.
//
// Eles descreviam um item com o `text` JÁ MONTADO — e montado em
// português cru dentro de `queries.ts`, fora do i18n (§7.1 da SPEC
// nomeia esse furo). O feed agora lê `account_activity_log` e o item
// carrega a AÇÃO, não a frase: quem traduz é o componente.
//
// O tipo que os substitui é `ActivityFeedEntry`
// (`@/lib/activity/feed.ts`), compartilhado com a página `/activity` —
// dois consumidores da mesma linha não podem ter dois tipos.
