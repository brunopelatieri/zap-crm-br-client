/**
 * Vocabulário dos eventos de sistema (SPEC 063 §3.1) — fonte de
 * verdade, no padrão de `QUOTA_KEYS`/`FEATURE_KEYS`
 * (`src/lib/plans/types.ts`) e `WEBHOOK_EVENTS`
 * (`src/lib/webhooks/events.ts`, que é o vocabulário IRMÃO: assinatura
 * por conta, não a outbox do proprietário).
 */

export const SYSTEM_EVENT_TYPES = [
  'account.created',
  'plan.changed',
  'plan.requested',
  'plan.canceled',
  'plan.cancel_reverted',
  'plan.canceled_applied',
  'plan.renewed',
  'plan.expiring',
  'plan.expired',
  'plan.grace_ended',
  'account.blocked',
  'account.unblocked',
  'member.blocked',
  'member.unblocked',
  'quota.exceeded',
  // SPEC 073 — o titular excluiu a própria conta. Evento pontual, sem
  // dedupe (ver `dedupeKeyFor`), emitido com `accountId: null` porque
  // `system_notifications.account_id` vai a NULL de qualquer forma
  // (a conta já foi apagada quando a linha é gravada).
  'account.deleted',
] as const;

export type SystemEventType = (typeof SYSTEM_EVENT_TYPES)[number];

export function isSystemEventType(value: unknown): value is SystemEventType {
  return (
    typeof value === 'string' &&
    (SYSTEM_EVENT_TYPES as readonly string[]).includes(value)
  );
}

export type DeliveryStatus = 'pending' | 'sent' | 'failed' | 'skipped';

export interface SystemEventAccount {
  id: string;
  name: string;
  ownerEmail: string | null;
}

/**
 * O payload versionado (§3.2) — gravado em `system_notifications.payload`
 * E entregue tal e qual pelo webhook (§4.3): não existe uma transformação
 * "de gravação" separada de uma "de fio", é o mesmo objeto.
 *
 * `event`/`accountId`/`accountName`/`planCode`/`planName`/`requestedAt`
 * só existem em `plan.requested` — o formato legado que
 * `PLAN_REQUEST_WEBHOOK_URL` já espera em produção (§3.2). Índice de
 * assinatura porque cada tipo carrega campos de detalhe diferentes
 * (`plan`, `quota`, `reason`, …) e uma união fechada aqui obrigaria
 * `dispatch.ts`/`render.ts` a conhecer os quinze formatos — o contrato
 * real de cada tipo vive no chamador (`emitSystemEvent`) e no par
 * `render.test.ts`/`webhook.test.ts`.
 */
export interface SystemEventPayload {
  v: 1;
  type: SystemEventType;
  occurredAt: string;
  account: SystemEventAccount | null;
  actor: string | null;
  message: string | null;
  /** Legado — só em `plan.requested` (§3.2). */
  event?: string;
  [key: string]: unknown;
}

export interface EmitSystemEventInput {
  type: SystemEventType;
  accountId: string | null;
  account?: SystemEventAccount | null;
  actor?: string | null;
  message?: string | null;
  /** Campos específicos do tipo (ex.: `plan`, `quota`, `reason`). */
  data?: Record<string, unknown>;
}

/** Constrói o payload versionado — puro, sem `Date.now()` por dentro. */
export function buildEventPayload(
  input: EmitSystemEventInput,
  now: Date
): SystemEventPayload {
  const payload: SystemEventPayload = {
    v: 1,
    type: input.type,
    occurredAt: now.toISOString(),
    account: input.account ?? null,
    actor: input.actor ?? null,
    message: input.message ?? null,
    ...(input.data ?? {}),
  };

  if (input.type === 'plan.requested') {
    payload.event = 'plan_change_requested';
  }

  return payload;
}
