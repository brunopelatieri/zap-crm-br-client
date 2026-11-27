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
  | 'webhook'
  /** SPEC 085 §9 (migração 097 estende o CHECK da 084). */
  | 'form'
  /** SPEC 089 F5 (migração 106 estende o CHECK): o agente de IA agiu no CRM. */
  | 'ai';

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
    // Área do contato (SPEC 083). Login comum não entra (PRD 082 §6.4).
    'contact.portal_invited',
    'contact.portal_blocked',
    'contact.portal_unblocked',
    // Formulários (SPEC 085 §9): ator é o contato, telefone mascarado.
    // `contact.form_link_sent` entra na SPEC 086 (quem envia é a integração).
    'contact.form_submitted',
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
    // SPEC 076 Q-7: "Já regularizei" do monitor de cobrança (ação humana).
    'channel.payment_acknowledged',
  ],
  member: [
    'member.invited',
    'member.joined',
    'member.role_changed',
    'member.removed',
    // SPEC 078 §8.1 — o console do proprietário editou nome/e-mail.
    'member.profile_updated',
  ],
  export: [],
  plan: [
    'plan.changed',
    'plan.renewed',
    'plan.requested',
    // SPEC 078 §8.1 — vencimento alterado à mão / pagamento estornado.
    'plan.period_changed',
    'plan.payment_reversed',
  ],
  tag: [],
  webhook: [
    'webhook.ingest_failed',
    // Repetidor do webhook da Meta (SPEC 088 D-10): saída de dado pessoal
    // para fora do CRM. O rótulo é só o host de destino, nunca a URL
    // completa nem a chave.
    'webhook.relay_enabled',
    'webhook.relay_disabled',
    'webhook.relay_url_changed',
    'webhook.relay_secret_rotated',
    'webhook.relay_removed',
  ],
  // Formulários de captação (SPEC 085 §9). Visita e resposta parcial NÃO
  // entram no registro (PRD 084 §6.4).
  form: [
    'form.created',
    'form.published',
    'form.unpublished',
    'form.archived',
    'form.restored',
    'form.deleted',
    'form.responses_deleted',
    'form.exported',
  ],
  // Agente de IA (SPEC 089 F5): uma linha por ESCRITA real de uma ferramenta
  // no auto-reply; ator `system` (nome `ai-agent`). A auditoria completa de
  // cada chamada (inclusive leitura e recusa) está em `ai_tool_calls`.
  ai: [
    'ai.tool_contact_updated',
    'ai.tool_tags_added',
    'ai.tool_tags_removed',
    'ai.tool_deal_created',
    'ai.tool_deal_moved',
    'ai.tool_note_added',
    'ai.tool_handoff',
    // F6: a ferramenta HTTP da conta (escrita) chamou um endpoint externo.
    'ai.tool_http_called',
  ],
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
