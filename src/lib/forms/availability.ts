// ============================================================
// Disponibilidade da página pública (SPEC 085 E-8; PRD 084 D-11, L5).
//
// Tipagem do retorno de `form_public_availability(slug, generic_link)`
// (097, reescrita na 098) e a regra que importa: TODO motivo de
// indisponibilidade vira a MESMA página neutra, com as mesmas chaves de
// tradução, sem distinguir "não existe" de "plano não inclui" nem de
// "quota cheia". O `reason` fica para log do servidor e para teste.
// ============================================================

export type AvailabilityStatus = 'available' | 'unavailable';

export type AvailabilityReason =
  | 'ok'
  | 'not_found'
  | 'not_published'
  | 'account_blocked'
  | 'feature_not_in_plan'
  | 'responses_quota'
  | 'contacts_quota';

export const UNAVAILABLE_REASONS: readonly Exclude<AvailabilityReason, 'ok'>[] =
  [
    'not_found',
    'not_published',
    'account_blocked',
    'feature_not_in_plan',
    'responses_quota',
    'contacts_quota',
  ];

export type FormAvailability =
  | { status: 'available'; reason: 'ok'; formId: string; accountId: string }
  | {
      status: 'unavailable';
      reason: Exclude<AvailabilityReason, 'ok'>;
      formId: string | null;
      accountId: string | null;
    };

/** Chaves de `PublicForm` que a página neutra usa — iguais para todo motivo. */
export const UNAVAILABLE_MESSAGE_KEYS = {
  title: 'unavailable.title',
  body: 'unavailable.body',
} as const;

const KNOWN_REASONS = new Set<string>(['ok', ...UNAVAILABLE_REASONS]);

/**
 * Converte a linha crua da RPC. Qualquer coisa fora do contrato (linha
 * ausente, status desconhecido, `available` sem ids) é tratada como
 * indisponível — fail-closed, como toda porta pública da casa.
 */
export function parseAvailabilityRow(
  row:
    | {
        status?: unknown;
        reason?: unknown;
        form_id?: unknown;
        account_id?: unknown;
      }
    | null
    | undefined
): FormAvailability {
  const status = row?.status;
  const reason = typeof row?.reason === 'string' ? row.reason : '';
  const formId = typeof row?.form_id === 'string' ? row.form_id : null;
  const accountId = typeof row?.account_id === 'string' ? row.account_id : null;

  if (status === 'available' && reason === 'ok' && formId && accountId) {
    return { status: 'available', reason: 'ok', formId, accountId };
  }
  const known = KNOWN_REASONS.has(reason) && reason !== 'ok';
  return {
    status: 'unavailable',
    reason: known ? (reason as Exclude<AvailabilityReason, 'ok'>) : 'not_found',
    formId,
    accountId,
  };
}

export function isFormAvailable(
  a: FormAvailability
): a is Extract<FormAvailability, { status: 'available' }> {
  return a.status === 'available';
}

/**
 * Chaves de tradução por motivo. Hoje todos apontam para a mesma tela
 * (PRD D-11) e o teste prova isso; a tabela existe para que um motivo
 * ganhar texto próprio no futuro seja uma linha aqui, não um `if` na UI.
 */
const MESSAGE_KEYS_BY_REASON: Record<
  Exclude<AvailabilityReason, 'ok'>,
  typeof UNAVAILABLE_MESSAGE_KEYS
> = {
  not_found: UNAVAILABLE_MESSAGE_KEYS,
  not_published: UNAVAILABLE_MESSAGE_KEYS,
  account_blocked: UNAVAILABLE_MESSAGE_KEYS,
  feature_not_in_plan: UNAVAILABLE_MESSAGE_KEYS,
  responses_quota: UNAVAILABLE_MESSAGE_KEYS,
  contacts_quota: UNAVAILABLE_MESSAGE_KEYS,
};

export function unavailableMessageKeys(
  reason: Exclude<AvailabilityReason, 'ok'>
): typeof UNAVAILABLE_MESSAGE_KEYS {
  return MESSAGE_KEYS_BY_REASON[reason] ?? UNAVAILABLE_MESSAGE_KEYS;
}
