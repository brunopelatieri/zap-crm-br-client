/**
 * Ponte entre `parseQuotaError` (puro, `@/lib/plans/errors`) e a outbox
 * (SPEC 063 §3.1, tipo `quota.exceeded`) — chamada dos pontos de
 * enforcement que a SPEC lista (`api/v1/contacts.ts`,
 * `audience/resolve.ts`, `whatsapp/resolve-conversation.ts`).
 *
 * Fire-and-forget de propósito: o chamador já está prestes a lançar o
 * erro de quota para quem pediu — o aviso ao proprietário não pode
 * atrasar nem, pior, quebrar essa resposta (§1, o princípio que
 * organiza a SPEC inteira). `emitSystemEvent` já nunca lança; não
 * `await`-ar aqui é o que garante que nem uma volta de microtask atrasa
 * o `throw` do chamador.
 */

import { emitSystemEvent } from './emit';
import type { QuotaError } from '@/lib/plans/errors';

export function emitQuotaExceeded(accountId: string, quota: QuotaError): void {
  void emitSystemEvent({
    type: 'quota.exceeded',
    accountId,
    data: {
      quota: { metric: quota.metric, used: quota.used, limit: quota.limit },
    },
  });
}
