/**
 * `platform_audit_log` — o que o console fez (SPEC 062 §2.5, §3.5).
 *
 * Um só escritor, usado por `block.ts` e por toda rota de
 * `/api/platform/**` que muda algo. `actor` é sempre `console:<email>`
 * — a distinção entre isso e o `actor` livre que `/api/admin/**` já
 * aceitava é o que permite responder "isso foi um clique meu ou um
 * script?" mais tarde.
 *
 * Nunca lança: uma ação sem rastro é ruim, uma ação que falha por
 * causa do rastro é pior (mesma postura de `account_plan_events`).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export type PlatformAuditAction =
  | 'account.block'
  | 'account.unblock'
  | 'user.block'
  | 'user.unblock'
  | 'plan.change'
  | 'plan.request.approve'
  | 'plan.request.reject'
  | 'catalog.upsert'
  | 'settings.update'
  // SPEC 062 §3.8/§7.5 — a retenção passou a ser configuração do
  // proprietário; as duas escritas ganham ação própria para separar
  // "mexi no padrão de todo mundo" de "mexi na política de UMA conta".
  | 'retention.global.update'
  | 'retention.account.update'
  // SPEC 062 §8, F9 — `lifecycle.ts` grava um aviso aqui ANTES de
  // emitir `plan.expiring`/`plan.grace_ended` (payload.dedupeKey),
  // porque a transição de status por si só não impede um mesmo aviso
  // de repetir a cada corrida do cron (diferente de `plan.expired`/
  // `plan.canceled_applied`, que mudam `status`/`plan_id` e por isso
  // já não batem no WHERE da consulta seguinte). Ver
  // `src/lib/plans/lifecycle.ts`.
  | 'plan.lifecycle_notice'
  | 'billing.renew'
  // SPEC 063 §6 — o botão "Reenviar" de /admin/notifications.
  | 'notification.resend'
  // SPEC 069 F10 — o editor de limites de segurança (nível 1a/1b) do
  // ChannelLimitsPanel.
  | 'channel_limits.update'
  // SPEC 073 — o titular excluiu a própria conta pela "Zona de risco"
  // em /settings. `accountId`/`targetUserId` vão sempre `null`: a
  // conta e o login do titular já não existem quando esta linha é
  // gravada (ver `payload` para os dados preservados).
  | 'account.delete';

export function consoleActorTag(ownerEmail: string): string {
  return `console:${ownerEmail}`;
}

export async function writePlatformAudit(
  db: SupabaseClient,
  entry: {
    actor: string;
    action: PlatformAuditAction;
    accountId?: string | null;
    targetUserId?: string | null;
    payload?: Record<string, unknown>;
  }
): Promise<void> {
  const { error } = await db.from('platform_audit_log').insert({
    actor: entry.actor,
    action: entry.action,
    account_id: entry.accountId ?? null,
    target_user_id: entry.targetUserId ?? null,
    payload: entry.payload ?? {},
  });
  if (error) {
    console.error(
      `[platform/audit] falha ao gravar platform_audit_log (${entry.action}):`,
      error.message
    );
  }
}
