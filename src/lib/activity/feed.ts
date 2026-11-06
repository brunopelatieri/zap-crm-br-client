// ============================================================
// Apresentação de uma linha de `account_activity_log` — a parte PURA,
// compartilhada pelo widget "Atividade recente" (F6) e pela página
// `/activity` (F7).
//
// O que mora aqui e por quê
//
//   O texto do feed NÃO é montado com string interpolada (era o que
//   `dashboard/queries.ts` fazia, em português cru, fora do i18n — §7.1
//   da SPEC nomeia isso como um furo a consertar de lambuja). Aqui a
//   linha vira uma CHAVE de tradução (`Activity.actions.<action>`) mais
//   os VALORES dos placeholders; quem traduz é o componente, que tem o
//   `t`. Assim a mesma linha rende em pt-BR e en sem duas montagens de
//   frase.
//
//   O deep-link também é decidido aqui, e tem uma regra que vale
//   escrever: **ação de exclusão não gera link**. "Ver o contato que
//   acabou de ser apagado" é uma promessa que o clique não cumpre —
//   e é justamente o recurso apagado que a auditoria mais nomeia
//   (§3.1, a decisão de guardar `resource_label`).
// ============================================================

import type { ActivityRow } from './query';
import type { ActivityAction, ActivityResourceType } from './types';

/** Ações que descrevem um recurso que deixou de existir. Nenhuma delas
 *  ganha `href`: o destino não existe mais do outro lado do clique. */
const DESTRUCTIVE_ACTIONS = new Set<ActivityAction>([
  'message.purged',
  'contact.deleted',
  'deal.deleted',
  'automation.deleted',
  'channel.deleted',
  'member.removed',
  'form.deleted',
]);

/**
 * Para onde a linha leva, ou `null` quando não há destino honesto.
 *
 * Escopo deliberadamente conservador: só rotas que existem hoje e que
 * aceitam o id que a linha carrega. Quando o id não está lá (evento de
 * lote, como `contact.imported`), cai na listagem do módulo.
 */
export function activityHref(row: {
  resource_type: ActivityResourceType;
  action: ActivityAction;
  resource_id: string | null;
  conversation_id: string | null;
}): string | null {
  if (DESTRUCTIVE_ACTIONS.has(row.action)) return null;

  switch (row.resource_type) {
    case 'message':
    case 'conversation':
      return row.conversation_id ? `/inbox?c=${row.conversation_id}` : null;
    case 'contact':
      return '/contacts';
    case 'deal':
      return '/pipelines';
    case 'broadcast':
      return row.resource_id ? `/broadcasts/${row.resource_id}` : '/broadcasts';
    case 'automation':
      return row.resource_id
        ? `/automations/${row.resource_id}/edit`
        : '/automations';
    case 'flow':
      return row.resource_id ? `/flows/${row.resource_id}` : '/flows';
    case 'channel':
    case 'member':
    case 'webhook':
      return '/settings';
    case 'plan':
      return '/plan';
    case 'form':
      // `/forms` só existe a partir da F2 da SPEC 085; até lá, sem destino.
      return null;
    case 'export':
    case 'tag':
      return null;
  }
}

/**
 * Valores dos placeholders de `Activity.actions.<action>`, extraídos de
 * `metadata` — sempre como string/number prontos para o ICU.
 *
 * Nunca lança: `metadata` é JSONB gravado por catorze call sites
 * diferentes (e por trigger), então um campo ausente ou com tipo
 * inesperado é normal, não excepcional. O que falta vira string vazia e
 * o componente decide o fallback traduzido.
 */
export function activityValues(row: {
  action: ActivityAction;
  resource_label: string | null;
  metadata: Record<string, unknown> | null;
}): Record<string, string | number> {
  const md = row.metadata ?? {};
  const str = (key: string): string => {
    const v = md[key];
    return typeof v === 'string' || typeof v === 'number' ? String(v) : '';
  };

  const values: Record<string, string | number> = {
    label: row.resource_label ?? '',
  };

  if (row.action === 'deal.stage_changed') {
    values.from = str('from');
    values.to = str('to');
  }
  if (
    row.action === 'contact.imported' ||
    row.action === 'contact.exported' ||
    row.action === 'form.responses_deleted'
  ) {
    const count = md.count;
    values.count = typeof count === 'number' ? count : 0;
  }
  if (row.action === 'contact.form_submitted') {
    values.form = str('form_name');
  }
  if (row.action === 'member.role_changed') {
    values.role = str('new_role');
  }
  if (
    row.action === 'conversation.exported' ||
    row.action === 'contact.exported'
  ) {
    values.format = str('format').toUpperCase();
  }

  return values;
}

/**
 * A linha inteira, pronta para o componente traduzir e renderizar.
 * `actorFallbackKey` é o que a UI usa quando `actor_name` é nulo —
 * é o caso normal para cron/motor (`system`) e para o contato.
 */
export interface ActivityFeedEntry {
  id: string;
  kind: ActivityResourceType;
  action: ActivityAction;
  at: string;
  actorName: string | null;
  actorKind: ActivityRow['actor_kind'];
  actorRole: string | null;
  values: Record<string, string | number>;
  href: string | null;
  channelId: string | null;
  /** Ponteiro para a tabela especializada com o detalhe (§3.1, D-2). */
  source: { table: string; id: string } | null;
}

export function toFeedEntry(row: ActivityRow): ActivityFeedEntry {
  return {
    id: row.id,
    kind: row.resource_type,
    action: row.action,
    at: row.created_at,
    actorName: row.actor_name,
    actorKind: row.actor_kind,
    actorRole: row.actor_role,
    values: activityValues(row),
    href: activityHref(row),
    channelId: row.channel_id,
    source:
      row.source_table && row.source_id
        ? { table: row.source_table, id: row.source_id }
        : null,
  };
}
