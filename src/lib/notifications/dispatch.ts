/**
 * Despacho da outbox de notificações (SPEC 063 §5). Server-only,
 * `service_role`.
 *
 *   1. reivindica as linhas devidas com um UPDATE-por-precondição — o
 *      mesmo padrão de claim do drenador de `automation_pending_executions`
 *      (`/api/automations/cron`, fase 1): lê candidatas, tenta um UPDATE
 *      condicionado a `next_attempt_at` não ter mudado desde a leitura
 *      (ninguém mais reivindicou), e só entrega se o UPDATE casou.
 *   2. entrega cada canal separadamente — e-mail e webhook não têm o
 *      mesmo desfecho na mesma tentativa;
 *   3. no erro, `attempts + 1`, `last_error` e recuo exponencial
 *      (`backoff.ts`);
 *   4. em `attempts >= 6`, marca o(s) canal(is) ainda pendente(s) como
 *      `failed` e para de tentar.
 *
 * Duas portas chamam isto:
 *   - `deliverOne` — porta 1, `after()` na rota que emitiu o evento
 *     (`emit.ts`). Sai em segundos, sem segurar a resposta.
 *   - `deliverPending` — porta 2, fase 6 de `/api/automations/cron`. A
 *     rede de segurança de tudo que a porta 1 perdeu.
 *
 * Nunca lança — chamado de dentro de `after()`, onde uma exceção não
 * tem quem a leia.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

import { supabaseAdmin } from '@/lib/supabase/admin';
import { deliverSystemEmail } from '@/lib/mailer/send';
import { deliverSystemWebhook } from './webhook';
import { hasGivenUp, nextAttemptAt } from './backoff';
import type { DeliveryStatus, SystemEventPayload } from './types';

const CLAIM_LEASE_MS = 2 * 60_000;
const DEFAULT_LIMIT = 50;

interface NotificationRow {
  id: string;
  payload: SystemEventPayload;
  email_status: DeliveryStatus;
  hook_status: DeliveryStatus;
  attempts: number;
  next_attempt_at: string;
}

export interface DeliverPendingResult {
  claimed: number;
  delivered: number;
  stillPending: number;
}

function emptyResult(): DeliverPendingResult {
  return { claimed: 0, delivered: 0, stillPending: 0 };
}

/** Reivindica UMA linha por precondição (o `next_attempt_at` lido não mudou). */
async function claimRow(
  db: SupabaseClient,
  row: NotificationRow,
  now: Date
): Promise<NotificationRow | null> {
  const leaseUntil = new Date(now.getTime() + CLAIM_LEASE_MS).toISOString();
  const { data, error } = await db
    .from('system_notifications')
    .update({ next_attempt_at: leaseUntil })
    .eq('id', row.id)
    .eq('next_attempt_at', row.next_attempt_at)
    .select('id, payload, email_status, hook_status, attempts, next_attempt_at')
    .maybeSingle();

  if (error) {
    console.error('[notifications/dispatch] claim failed:', error.message);
    return null;
  }
  return (data as NotificationRow | null) ?? null;
}

async function deliverRow(
  db: SupabaseClient,
  row: NotificationRow,
  now: Date
): Promise<boolean> {
  let emailStatus = row.email_status;
  let hookStatus = row.hook_status;
  let hadError = false;
  const errors: string[] = [];

  // Achado de code review: os dois canais são I/O independente sobre o
  // MESMO `row.payload` imutável — rodar em série (email, depois
  // webhook) soma os dois tempos de resposta à toa. `Promise.all`
  // dispara os dois de uma vez; nenhum dos dois lança (contrato de
  // `deliverSystemEmail`/`deliverSystemWebhook`), então não precisa de
  // `allSettled`.
  const [emailOutcome, hookOutcome] = await Promise.all([
    emailStatus === 'pending' ? deliverSystemEmail(row.payload) : null,
    hookStatus === 'pending' ? deliverSystemWebhook(row.payload) : null,
  ]);

  if (emailOutcome) {
    if (emailOutcome.ok) {
      emailStatus = emailOutcome.skipped ? 'skipped' : 'sent';
    } else {
      hadError = true;
      errors.push(`email: ${emailOutcome.error ?? 'unknown error'}`);
    }
  }

  if (hookOutcome) {
    if (hookOutcome.ok) {
      hookStatus = hookOutcome.skipped ? 'skipped' : 'sent';
    } else {
      hadError = true;
      errors.push(`hook: ${hookOutcome.error ?? 'unknown error'}`);
    }
  }

  const update: Record<string, unknown> = {
    email_status: emailStatus,
    hook_status: hookStatus,
  };

  if (hadError) {
    const attempts = row.attempts + 1;
    update.attempts = attempts;
    update.last_error = errors.join('; ');

    if (hasGivenUp(attempts)) {
      if (emailStatus === 'pending')
        update.email_status = emailStatus = 'failed';
      if (hookStatus === 'pending') update.hook_status = hookStatus = 'failed';
    } else {
      update.next_attempt_at = nextAttemptAt(attempts, now).toISOString();
    }
  }

  const resolved = emailStatus !== 'pending' && hookStatus !== 'pending';
  if (resolved) {
    update.delivered_at = now.toISOString();
  }

  const { error } = await db
    .from('system_notifications')
    .update(update)
    .eq('id', row.id);
  if (error) {
    console.error(
      '[notifications/dispatch] update failed:',
      row.id,
      error.message
    );
  }

  return resolved;
}

/** Porta 1 — entrega uma notificação específica, já com `id` conhecido. */
export async function deliverOne(
  id: string,
  db: SupabaseClient = supabaseAdmin(),
  now: Date = new Date()
): Promise<void> {
  try {
    const { data: row, error } = await db
      .from('system_notifications')
      .select(
        'id, payload, email_status, hook_status, attempts, next_attempt_at'
      )
      .eq('id', id)
      .maybeSingle();
    if (error || !row) return;

    const typed = row as NotificationRow;
    if (typed.email_status !== 'pending' && typed.hook_status !== 'pending') {
      return;
    }

    const claimed = await claimRow(db, typed, now);
    if (!claimed) return;

    await deliverRow(db, claimed, now);
  } catch (err) {
    console.error('[notifications/dispatch] deliverOne failed:', id, err);
  }
}

/** Porta 2 — varre e reentrega tudo que está devido. */
export async function deliverPending(
  now: Date = new Date(),
  limit: number = DEFAULT_LIMIT,
  db: SupabaseClient = supabaseAdmin()
): Promise<DeliverPendingResult> {
  const result = emptyResult();

  try {
    const { data: due, error } = await db
      .from('system_notifications')
      .select(
        'id, payload, email_status, hook_status, attempts, next_attempt_at'
      )
      .lte('next_attempt_at', now.toISOString())
      .or('email_status.eq.pending,hook_status.eq.pending')
      .order('created_at', { ascending: true })
      .limit(limit);

    if (error) {
      console.error(
        '[notifications/dispatch] sweep read failed:',
        error.message
      );
      return result;
    }

    for (const row of (due ?? []) as NotificationRow[]) {
      const claimed = await claimRow(db, row, now);
      if (!claimed) continue;
      result.claimed++;
      try {
        const resolved = await deliverRow(db, claimed, now);
        if (resolved) result.delivered++;
        else result.stillPending++;
      } catch (err) {
        console.error(
          '[notifications/dispatch] deliverRow failed:',
          row.id,
          err
        );
        result.stillPending++;
      }
    }
  } catch (err) {
    console.error('[notifications/dispatch] deliverPending failed:', err);
  }

  return result;
}
