/**
 * Apresentação das linhas de `platform_audit_log` no card "Histórico" do
 * console (SPEC 078 §9.4) — a parte PURA, no molde de `activity/feed.ts`:
 * a linha vira uma CHAVE de tradução (`Platform.audit.<chave>`) mais os
 * VALORES dos placeholders. Quem traduz é o componente.
 *
 * Os formatadores chegam por parâmetro porque datas, formas de pagamento
 * e nomes de campo dependem do `locale`/`t` do componente. Nunca lança:
 * `payload` é JSONB gravado por rotas diferentes, e um campo ausente ou
 * de tipo inesperado vira "—" em vez de derrubar a tela.
 */

import type { AccountAuditEvent } from './accounts';

export interface AuditFormatters {
  /** ISO → data legível no locale do operador. */
  date: (iso: string) => string;
  /** Código da forma de pagamento → rótulo traduzido. */
  method: (code: string) => string;
  /** `'email'` / `'fullName'` → rótulo traduzido. */
  field: (code: string) => string;
}

export interface AuditDescription {
  /** Chave dentro de `Platform.audit`. */
  key: string;
  values: Record<string, string | number>;
}

const DASH = '—';

/** `billing.period_end.set` → `billing_period_end_set` (chave ICU sem ponto). */
function keyFor(action: string): string {
  return action.replace(/\./g, '_');
}

export function describeAuditEvent(
  event: Pick<AccountAuditEvent, 'action' | 'payload'>,
  fmt: AuditFormatters
): AuditDescription {
  const payload = event.payload ?? {};
  const str = (name: string): string => {
    const value = payload[name];
    return typeof value === 'string' && value !== '' ? value : '';
  };
  const date = (name: string): string => {
    const iso = str(name);
    return iso ? fmt.date(iso) : DASH;
  };

  switch (event.action) {
    case 'billing.period_end.set':
      return {
        key: keyFor(event.action),
        values: { from: date('previousPeriodEnd'), to: date('newPeriodEnd') },
      };
    case 'billing.payment.manual': {
      const periods = payload.periods;
      return {
        key: keyFor(event.action),
        values: {
          method: str('method') ? fmt.method(str('method')) : DASH,
          periods: typeof periods === 'number' ? periods : 1,
          ref: str('paymentRef') || DASH,
        },
      };
    }
    case 'billing.payment.reverse':
    case 'billing.renew':
      return {
        key: keyFor(event.action),
        values: { ref: str('paymentRef') || DASH },
      };
    case 'user.profile_update': {
      const fields = Array.isArray(payload.fields)
        ? payload.fields.filter((f): f is string => typeof f === 'string')
        : [];
      return {
        key: keyFor(event.action),
        values: {
          fields: fields.length > 0 ? fields.map(fmt.field).join(', ') : DASH,
        },
      };
    }
    default:
      return { key: 'unknown', values: { action: event.action } };
  }
}

export type HistoryItem<P, A> =
  | { kind: 'plan'; at: string; event: P }
  | { kind: 'audit'; at: string; event: A };

/**
 * Intercala eventos de plano e ações do console num só histórico, do
 * mais novo para o mais antigo.
 *
 * As duas leituras têm teto (`limits.plan` / `limits.audit`). Se uma delas
 * encheu, ela pode ter cortado eventos mais antigos que ainda caberiam
 * na outra — e a linha do tempo mostraria lacunas (uma mudança de
 * vencimento sem a mudança de plano em volta, por exemplo). Por isso o
 * histórico só vai até o evento mais antigo da(s) fonte(s) que
 * encheram: dali para trás não dá para garantir que está completo.
 */
export function mergeAccountHistory<
  P extends { created_at: string },
  A extends { created_at: string },
>(
  planEvents: readonly P[],
  auditEvents: readonly A[],
  limits: { plan: number; audit: number }
): HistoryItem<P, A>[] {
  const time = (iso: string) => new Date(iso).getTime();

  let cutoff = -Infinity;
  const oldest = (events: readonly { created_at: string }[]) =>
    events.reduce((min, e) => Math.min(min, time(e.created_at)), Infinity);
  if (planEvents.length >= limits.plan) {
    cutoff = Math.max(cutoff, oldest(planEvents));
  }
  if (auditEvents.length >= limits.audit) {
    cutoff = Math.max(cutoff, oldest(auditEvents));
  }

  return [
    ...planEvents.map((event): HistoryItem<P, A> => ({
      kind: 'plan',
      at: event.created_at,
      event,
    })),
    ...auditEvents.map((event): HistoryItem<P, A> => ({
      kind: 'audit',
      at: event.created_at,
      event,
    })),
  ]
    .filter((item) => time(item.at) >= cutoff)
    .sort((a, b) => time(b.at) - time(a.at));
}
