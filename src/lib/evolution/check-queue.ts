/**
 * O corte do lote de checagem (SPEC 069 §4.6, R3/R6) — módulo PURO:
 * recebe a fila pendente e a decisão de cota já calculadas, decide o
 * que sai agora, o que fica, e o que muda de status por idade/tentativa
 * sem nunca ser processado.
 *
 * Três decisões, nesta ordem
 *
 *   1. **Higiene primeiro.** Um item que já estourou `max_attempts` ou
 *      o TTL da fila não compete pelo lote — ele sai da fila (`failed`
 *      ou `expired`) antes de qualquer corte por cota. Um item
 *      envenenado (número que sempre falha) não pode ocupar o lote de
 *      hoje pela enésima vez.
 *   2. **Prioridade: campanha antes de importação.** Um item de
 *      `broadcast` tem uma campanha em `awaiting_check` esperando por
 *      ele (R6); um item de `contacts_import` só tem alguém que vai
 *      olhar o resultado mais tarde. Dentro de cada fonte, FIFO por
 *      `createdAt` — quem entrou primeiro sai primeiro.
 *   3. **O corte é o MENOR dos três tetos**, nunca a soma: `batchSize`
 *      (duração da rota), `remainingThisHour` e `remainingToday` (a
 *      cota em si). Um lote de 25 com só 3 restantes na hora processa
 *      3, não 25 — o resto espera o próximo ciclo.
 */

import type { ColdSendDecision } from '@/lib/channels/cold-send-limit';

export type CheckQueueSource = 'contacts_import' | 'broadcast';
export type CheckQueueStatus =
  'pending' | 'in_progress' | 'done' | 'failed' | 'expired' | 'skipped';

export interface CheckQueueItem {
  id: string;
  source: CheckQueueSource;
  attempts: number;
  createdAt: Date;
}

export interface CheckBatchPlan {
  /** Itens a processar agora, já na ordem em que devem ser chamados. */
  toProcess: CheckQueueItem[];
  /** Estourou `max_attempts` — vira `failed`, motivo `max_attempts_exceeded`. */
  toFail: CheckQueueItem[];
  /** Mais velho que o TTL — vira `expired`, sem nunca ter sido tentado
   *  (ou tentado e nunca concluído). */
  toExpire: CheckQueueItem[];
  /** Candidatos que sobraram do corte — continuam `pending`. */
  remaining: number;
}

export interface PlanCheckBatchInput {
  pending: CheckQueueItem[];
  /** A decisão já calculada pela cascata de limites para este canal. */
  decision: ColdSendDecision;
  batchSize: number;
  maxAttempts: number;
  ttlHours: number;
  now: Date;
}

const SOURCE_PRIORITY: Record<CheckQueueSource, number> = {
  broadcast: 0,
  contacts_import: 1,
};

export function planCheckBatch({
  pending,
  decision,
  batchSize,
  maxAttempts,
  ttlHours,
  now,
}: PlanCheckBatchInput): CheckBatchPlan {
  const ttlMs = ttlHours * 3_600_000;

  const toFail: CheckQueueItem[] = [];
  const toExpire: CheckQueueItem[] = [];
  const candidates: CheckQueueItem[] = [];

  for (const item of pending) {
    if (item.attempts >= maxAttempts) {
      toFail.push(item);
      continue;
    }
    if (now.getTime() - item.createdAt.getTime() > ttlMs) {
      toExpire.push(item);
      continue;
    }
    candidates.push(item);
  }

  candidates.sort((a, b) => {
    const priorityDiff = SOURCE_PRIORITY[a.source] - SOURCE_PRIORITY[b.source];
    if (priorityDiff !== 0) return priorityDiff;
    return a.createdAt.getTime() - b.createdAt.getTime();
  });

  // allowed nunca é negativo: um `remainingToday`/`remainingThisHour`
  // zerado (cota já estourada) corta em zero, não em "sem limite".
  //
  // ✅ Correção (code review): `decision.allowed` cobre um motivo que
  // `remainingToday`/`remainingThisHour` sozinhos NÃO capturam —
  // `min_interval`. Diferente de `daily_limit`/`hourly_limit` (que já
  // zeram um dos dois campos), uma negativa por intervalo mínimo deixa
  // os dois positivos, e o corte por `Math.min` sozinho deixaria passar
  // um lote inteiro — furando exatamente o antispam que o intervalo
  // mínimo existe para impedir (a pausa entre itens do MESMO lote, em
  // `check-run.ts`, só cobre o segundo item em diante).
  const allowed = decision.allowed
    ? Math.max(
        0,
        Math.min(batchSize, decision.remainingToday, decision.remainingThisHour)
      )
    : 0;

  return {
    toProcess: candidates.slice(0, allowed),
    toFail,
    toExpire,
    remaining: Math.max(0, candidates.length - allowed),
  };
}
