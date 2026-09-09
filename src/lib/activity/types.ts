// ============================================================
// Catálogo fechado de eventos de `account_activity_log` (SPEC 075 §4).
//
// `ACTIVITY_CATALOG` é a fonte da verdade de "que ação pertence a que
// tipo de recurso" — é o que impede `contact_updated`, `contact.update`
// e `contactUpdated` de conviverem na mesma coluna seis meses depois
// (§4, intro). A tabela em si não tem CHECK de `action` (só de
// `resource_type`, migração 084 §3.1): a validação de verdade acontece
// em runtime, em `record.ts`, contra este catálogo.
//
// `resource_type` inclui dois valores ('export', 'tag') que NENHUMA
// ação da v1 usa — ficam no CHECK do banco e no tipo aqui só para não
// exigir migração quando `contact.tagged/untagged` (D-7) ou uma leitura
// de exportação forem ligados depois.
// ============================================================

export type ActivityResourceType =
  | 'message'
  | 'conversation'
  | 'contact'
  | 'deal'
  | 'broadcast'
  | 'automation'
  | 'flow'
  | 'channel'
  | 'member'
  | 'export'
  | 'plan'
  | 'tag'
  | 'webhook';

/**
 * Uma entrada por linha da tabela do §4. `broadcast.blocked` cobre os
 * dois motivos de recusa que `broadcast_audit_log` distingue
 * (`blocked_window`/`blocked_quota`) — o feed não precisa do motivo na
 * ação, ele vai em `metadata` (ver `broadcast-activity.ts`).
 */
export const ACTIVITY_CATALOG = {
  message: ['message.deleted', 'message.purged', 'message.deleted_by_contact'],
  conversation: [
    'conversation.assigned',
    'conversation.transferred',
    'conversation.exported',
  ],
  contact: [
    'contact.created',
    'contact.updated',
    'contact.deleted',
    'contact.imported',
    'contact.exported',
    'contact.opted_out',
    'contact.opted_in',
  ],
  deal: ['deal.created', 'deal.stage_changed', 'deal.deleted'],
  broadcast: [
    'broadcast.created',
    'broadcast.dispatched',
    'broadcast.scheduled',
    'broadcast.canceled',
    'broadcast.blocked',
  ],
  automation: [
    'automation.enabled',
    'automation.disabled',
    'automation.created',
    'automation.updated',
    'automation.deleted',
    'automation.failed',
  ],
  flow: ['flow.activated', 'flow.deactivated', 'flow.run_failed'],
  channel: [
    'channel.connected',
    'channel.disconnected',
    'channel.deleted',
    'channel.default_changed',
  ],
  member: [
    'member.invited',
    'member.joined',
    'member.role_changed',
    'member.removed',
  ],
  export: [],
  plan: ['plan.changed', 'plan.renewed', 'plan.requested'],
  tag: [],
  webhook: ['webhook.ingest_failed'],
} as const satisfies Record<ActivityResourceType, readonly string[]>;

type CatalogValues = typeof ACTIVITY_CATALOG;

/** União fechada de toda ação válida, de qualquer tipo de recurso. */
export type ActivityAction = CatalogValues[keyof CatalogValues][number];

/** Ações válidas para UM tipo de recurso — o que `isValidActivityAction` checa. */
export type ActivityActionFor<T extends ActivityResourceType> =
  CatalogValues[T][number];

/** `true` sse `action` pertence ao catálogo do tipo `resourceType`. */
export function isValidActivityAction(
  resourceType: ActivityResourceType,
  action: string
): action is ActivityAction {
  const allowed: readonly string[] = ACTIVITY_CATALOG[resourceType];
  return allowed.includes(action);
}
