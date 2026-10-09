/**
 * Guardas puras da edição de nome/e-mail de usuário pelo console
 * (SPEC 078 §5.2).
 *
 * Mesmo desenho de `guards.ts`: recebe dados já resolvidos (a lista de
 * e-mails do proprietário, o e-mail atual do alvo) e devolve um código
 * estável — nenhuma chamada de rede aqui. A rota
 * `PATCH /api/platform/users/[userId]` resolve os dados, chama estas
 * funções e só então escreve (`user-identity-actions.ts`).
 *
 * Duas das guardas existem por segurança, não por conveniência:
 *
 *  - `cannot_edit_platform_owner_email`: trocar o e-mail do proprietário
 *    pela tela o tira do console no clique seguinte (a guarda de
 *    `owner.ts` compara a sessão com `PLATFORM_OWNER_EMAILS`).
 *  - `email_reserved_for_platform_owner`: se o proprietário não tem
 *    usuário NESTE banco, dar o e-mail dele a um cliente daria ao
 *    cliente o console inteiro assim que confirmasse o login —
 *    escalonamento de privilégio.
 */

import { normalizeEmail, EMAIL_RE } from '@/lib/auth/email';

export const MAX_FULL_NAME_LENGTH = 120;

/** Caracteres de controle C0 (0–31), DEL e C1 (127–159). */
function hasControlCharacter(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 32 || (code >= 127 && code <= 159)) return true;
  }
  return false;
}

export type FullNameResult =
  { ok: true; value: string } | { ok: false; code: 'name_invalid' };

/**
 * Nome aparece no inbox, no PDF de exportação (SPEC 067) e em e-mails:
 * não vazio depois do `trim`, até 120 caracteres, sem caractere de
 * controle (quebra de linha, NUL — vazam para cabeçalho de e-mail e PDF).
 */
export function validateFullName(name: unknown): FullNameResult {
  if (typeof name !== 'string') return { ok: false, code: 'name_invalid' };
  const trimmed = name.trim();
  if (
    trimmed === '' ||
    trimmed.length > MAX_FULL_NAME_LENGTH ||
    hasControlCharacter(trimmed)
  ) {
    return { ok: false, code: 'name_invalid' };
  }
  return { ok: true, value: trimmed };
}

export type EditIdentityErrorCode =
  | 'email_invalid'
  | 'email_unchanged'
  | 'cannot_edit_platform_owner_email'
  | 'email_reserved_for_platform_owner';

export type EditIdentityGuardResult =
  { ok: true; email: string } | { ok: false; code: EditIdentityErrorCode };

export interface CanEditUserIdentityInput {
  /** `PLATFORM_OWNER_EMAILS` já separada em itens (`parseOwnerEmails`). */
  ownerEmails: readonly string[];
  /** E-mail atual do usuário-alvo (`auth.users.email`). */
  targetCurrentEmail: string;
  /** E-mail pedido, como veio no corpo da requisição. */
  nextEmail: string;
}

/**
 * Decide se o e-mail de um usuário pode mudar de `targetCurrentEmail`
 * para `nextEmail`. Só o e-mail passa por aqui — o NOME do proprietário
 * pode ser editado normalmente.
 *
 * Ordem das checagens: formato → igualdade → alvo é o proprietário →
 * destino é o proprietário. "Igual ao atual" vem antes das guardas do
 * proprietário de propósito: reenviar o próprio e-mail do proprietário é
 * um no-op (`email_unchanged`), não uma tentativa de edição proibida.
 *
 * Em caso de sucesso devolve o e-mail NORMALIZADO — é o valor que vai
 * para o Auth e para a auditoria.
 */
export function canEditUserIdentity(
  input: CanEditUserIdentityInput
): EditIdentityGuardResult {
  const next = normalizeEmail(input.nextEmail);
  if (!EMAIL_RE.test(next)) return { ok: false, code: 'email_invalid' };

  const current = normalizeEmail(input.targetCurrentEmail);
  if (next === current) return { ok: false, code: 'email_unchanged' };

  // Item exato, não prefixo/sufixo: `bruno@zapcrmbr.com.br` não casa com
  // `bruno@zapcrmbr.com` (mesma armadilha coberta em `owner.test.ts`).
  const owners = input.ownerEmails.map(normalizeEmail);
  if (owners.includes(current)) {
    return { ok: false, code: 'cannot_edit_platform_owner_email' };
  }
  if (owners.includes(next)) {
    return { ok: false, code: 'email_reserved_for_platform_owner' };
  }

  return { ok: true, email: next };
}
