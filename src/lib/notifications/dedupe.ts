/**
 * `dedupeKeyFor` — a tabela da SPEC 063 §3.1 em código. Puro.
 *
 * `null` = sempre entrega (evento pontual: toda troca/bloqueio/renovação
 * é um fato novo, não faz sentido "deduplicar"). Uma chave presente
 * garante, via `idx_system_notifications_dedupe` (070), que aquele
 * evento entra na outbox no máximo uma vez para sempre.
 *
 * Lê os campos de detalhe do MESMO formato aninhado que
 * `buildEventPayload` grava no payload (`data.plan.*`/`data.quota.*` —
 * ver `render.ts`, que lê o payload gravado da mesma forma): `data` aqui
 * é exatamente o `EmitSystemEventInput.data` que o chamador passa para
 * `emitSystemEvent`, e vira o corpo entregue tal e qual (§3.2) — os dois
 * lados têm que concordar no formato, ou a chave de dedupe lê `undefined`
 * onde devia ler a data do período.
 *
 * Duas armadilhas que os testes existem para travar (§9):
 *   - `plan.expiring` PRECISA da data do período na chave — sem ela, uma
 *     conta que renova nunca mais receberia o aviso (a chave já teria
 *     sido usada no período anterior).
 *   - `quota.exceeded` PRECISA da data (YYYY-MM-DD) na chave — sem ela,
 *     uma importação de contatos que estoura a quota repetidamente no
 *     mesmo dia produziria um e-mail por tentativa (D-10 do PRD).
 */

import type { EmitSystemEventInput } from './types';

/** `YYYY-MM-DD` em UTC — puro, recebe `now` do chamador. */
function isoDate(now: Date): string {
  return now.toISOString().slice(0, 10);
}

export function dedupeKeyFor(
  input: Pick<EmitSystemEventInput, 'type' | 'accountId' | 'data'>,
  now: Date
): string | null {
  const accountId = input.accountId ?? 'none';
  const plan = (input.data?.plan ?? {}) as Record<string, unknown>;
  const quota = (input.data?.quota ?? {}) as Record<string, unknown>;

  switch (input.type) {
    case 'account.created':
      return `account.created:${accountId}`;

    case 'plan.canceled_applied': {
      const periodEnd = plan.periodEnd as string | undefined;
      return `plan.canceled_applied:${accountId}:${periodEnd ?? ''}`;
    }

    case 'plan.renewed': {
      const paymentRef = plan.paymentRef as string | undefined;
      return `plan.renewed:${accountId}:${paymentRef ?? ''}`;
    }

    case 'plan.expiring': {
      const periodEnd = plan.periodEnd as string | undefined;
      const daysUntil = plan.daysUntil as number | undefined;
      return `plan.expiring:${accountId}:${periodEnd ?? ''}:${daysUntil ?? ''}`;
    }

    case 'plan.expired': {
      const periodEnd = plan.periodEnd as string | undefined;
      return `plan.expired:${accountId}:${periodEnd ?? ''}`;
    }

    case 'plan.grace_ended': {
      const graceUntil = plan.graceUntil as string | undefined;
      return `plan.grace_ended:${accountId}:${graceUntil ?? ''}`;
    }

    case 'quota.exceeded': {
      const metric = quota.metric as string | undefined;
      return `quota.exceeded:${accountId}:${metric ?? ''}:${isoDate(now)}`;
    }

    // plan.changed, plan.requested, plan.canceled, plan.cancel_reverted,
    // account.blocked/unblocked, member.blocked/unblocked: todo evento
    // pontual, sempre entrega (§3.1: dedupe_key = null).
    default:
      return null;
  }
}
