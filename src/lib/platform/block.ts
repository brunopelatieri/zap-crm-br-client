/**
 * Bloquear e desbloquear, pelo console (SPEC 062 §5.2, §7.3).
 *
 * Server-only, `service_role` — é a ÚNICA porta de escrita para
 * `accounts.blocked_at` / `profiles.blocked_at`. A 069 fechou as
 * outras: não existe policy de escrita nessas colunas para o cliente, e
 * a guarda de coluna em `profiles` (trigger
 * `enforce_profile_privilege_columns`) recusa a tentativa vinda do
 * papel `authenticated` mesmo passando pela policy `profiles_update`.
 *
 * Toda ação grava `platform_audit_log` (§2.5) com
 * `actor = 'console:<email do proprietário>'`. A distinção entre
 * `console:` e o `actor` livre de `/api/admin/**` é o que permite
 * responder "isso foi um clique meu ou um script?" seis meses depois.
 *
 * A auditoria é gravada DEPOIS da mudança e nunca derruba a resposta —
 * mesma postura de `account_plan_events` na rota de plano da 059: uma
 * ação sem rastro é ruim, uma ação que falha por causa do rastro é
 * pior. O erro vai para o log do servidor.
 *
 * `blockAccount`/`unblockAccount`/`blockUser`/`unblockUser` são as
 * quatro combinações de {conta, usuário} × {bloquear, desbloquear} —
 * mesma mecânica nos quatro casos (update com precondição de
 * idempotência → se não casou, distinguir "já estava assim" de "não
 * existe" → auditoria). Todas passam por `setBlocked()`, parametrizada
 * por `BlockTarget` (achado de code review: eram quatro funções quase
 * idênticas antes, e um fix na precondição ou no fallback de existência
 * precisava ser replicado à mão nas quatro).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

import {
  consoleActorTag,
  writePlatformAudit,
  type PlatformAuditAction,
} from './audit';
import { emitSystemEvent } from '@/lib/notifications/emit';
import type { SystemEventType } from '@/lib/notifications/types';

export interface BlockActorContext {
  /** E-mail normalizado do proprietário — vira `console:<email>`. */
  ownerEmail: string;
}

export interface BlockResult {
  ok: boolean;
  /** `not_found` quando a linha alvo não existe. */
  error?: 'not_found' | 'update_failed';
}

interface BlockTarget {
  table: 'accounts' | 'profiles';
  idColumn: 'id' | 'user_id';
  /** Colunas extras a ler no UPDATE, além de `idColumn` — `profiles`
   *  precisa de `account_id`/`email`/o nome da conta para a auditoria E
   *  para o aviso da SPEC 063; `accounts` precisa do próprio nome. */
  selectExtra: string;
  blockAction: PlatformAuditAction;
  unblockAction: PlatformAuditAction;
  /** SPEC 063 §3.1 — tipo do evento emitido na outbox do proprietário. */
  blockEvent: SystemEventType;
  unblockEvent: SystemEventType;
}

const ACCOUNT_TARGET: BlockTarget = {
  table: 'accounts',
  idColumn: 'id',
  selectExtra: ', name',
  blockAction: 'account.block',
  unblockAction: 'account.unblock',
  blockEvent: 'account.blocked',
  unblockEvent: 'account.unblocked',
};

const USER_TARGET: BlockTarget = {
  table: 'profiles',
  idColumn: 'user_id',
  selectExtra: ', account_id, email, accounts:account_id (name)',
  blockAction: 'user.block',
  unblockAction: 'user.unblock',
  blockEvent: 'member.blocked',
  unblockEvent: 'member.unblocked',
};

async function setBlocked(
  db: SupabaseClient,
  ctx: BlockActorContext,
  target: BlockTarget,
  id: string,
  blocking: boolean,
  reason: string | null
): Promise<BlockResult> {
  const actor = consoleActorTag(ctx.ownerEmail);
  const update = blocking
    ? {
        blocked_at: new Date().toISOString(),
        blocked_reason: reason,
        blocked_by: actor,
      }
    : { blocked_at: null, blocked_reason: null, blocked_by: actor };

  // Precondição de idempotência: bloquear de novo não pode reescrever o
  // `blocked_at` original — "desde quando" é a pergunta do suporte
  // (§3.1) e um duplo clique não pode apagar a resposta. Desbloquear
  // exige que já estivesse bloqueado, pela mesma razão simétrica.
  const filtered = db.from(target.table).update(update).eq(target.idColumn, id);
  const query = blocking
    ? filtered.is('blocked_at', null)
    : filtered.not('blocked_at', 'is', null);

  const { data, error } = await query
    .select(`${target.idColumn}${target.selectExtra}`)
    .maybeSingle();

  if (error) {
    console.error(
      `[platform/block] ${target.table}.${blocking ? 'block' : 'unblock'} falhou:`,
      error.message
    );
    return { ok: false, error: 'update_failed' };
  }
  if (!data) {
    // A precondição não casou: já estava no estado pedido, ou o alvo
    // não existe. Idempotente nos dois casos — o desfecho pretendido já
    // vale — mas sem linha de auditoria nova, senão o histórico enche
    // de eventos que não mudaram nada.
    const { data: exists } = await db
      .from(target.table)
      .select(target.idColumn)
      .eq(target.idColumn, id)
      .maybeSingle();
    return exists ? { ok: true } : { ok: false, error: 'not_found' };
  }

  // `data`'s inferred shape depends on a dynamically-built select
  // string, which supabase-js can't type-check statically — cast
  // through `unknown` since we know the runtime shape from `target`.
  const row = data as unknown as Record<string, unknown>;
  const accountId =
    target.table === 'accounts' ? id : ((row.account_id as string) ?? null);
  await writePlatformAudit(db, {
    actor,
    action: blocking ? target.blockAction : target.unblockAction,
    accountId,
    targetUserId: target.table === 'profiles' ? id : null,
    payload: blocking ? { reason } : {},
  });

  const accountName =
    target.table === 'accounts'
      ? ((row.name as string) ?? 'Conta')
      : ((row.accounts as { name?: string } | null)?.name ?? 'Conta');

  await emitSystemEvent(
    {
      type: blocking ? target.blockEvent : target.unblockEvent,
      accountId,
      account: accountId
        ? { id: accountId, name: accountName, ownerEmail: null }
        : null,
      actor,
      data:
        target.table === 'profiles'
          ? { block: { memberEmail: row.email ?? null, reason } }
          : { block: { reason } },
    },
    db
  );

  return { ok: true };
}

export function blockAccount(
  db: SupabaseClient,
  ctx: BlockActorContext,
  accountId: string,
  reason: string | null
): Promise<BlockResult> {
  return setBlocked(db, ctx, ACCOUNT_TARGET, accountId, true, reason);
}

export function unblockAccount(
  db: SupabaseClient,
  ctx: BlockActorContext,
  accountId: string
): Promise<BlockResult> {
  return setBlocked(db, ctx, ACCOUNT_TARGET, accountId, false, null);
}

export function blockUser(
  db: SupabaseClient,
  ctx: BlockActorContext,
  userId: string,
  reason: string | null
): Promise<BlockResult> {
  return setBlocked(db, ctx, USER_TARGET, userId, true, reason);
}

export function unblockUser(
  db: SupabaseClient,
  ctx: BlockActorContext,
  userId: string
): Promise<BlockResult> {
  return setBlocked(db, ctx, USER_TARGET, userId, false, null);
}
