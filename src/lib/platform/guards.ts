/**
 * Guardas puras do console (SPEC 062 §4.4, §5.2).
 *
 * O que o console impede, com 400 e sem discussão: o proprietário da
 * plataforma bloquear a si mesmo ou à conta em que o próprio usuário
 * dele está (§7.3). "O próprio usuário dele" é uma possibilidade real:
 * `PLATFORM_OWNER_EMAILS` é só uma lista de e-mails — nada impede que
 * esse e-mail também tenha uma conta de cliente normal neste mesmo
 * banco (`profiles`/`accounts`), e é justamente esse caso que os
 * `ownerAccountId`/`ownerUserId` abaixo cobrem quando não-nulos.
 *
 * Puro: recebe dados já resolvidos (accountId do perfil do
 * proprietário, se existir; e-mail do alvo, se disponível) — nenhuma
 * chamada de rede aqui. As rotas (`/api/platform/accounts/[id]/block`,
 * `/api/platform/users/[id]/block`) resolvem esses dados e chamam
 * `canBlockAccount`/`canBlockUser` antes de escrever.
 */

export interface GuardResult {
  ok: boolean;
  /** Motivo estável para a UI/rota decidir a mensagem — nunca exposto cru ao usuário final. */
  reason: 'self_account' | 'self_user' | null;
}

const OK: GuardResult = { ok: true, reason: null };

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * `true` quando `candidateEmail` é o mesmo e-mail do proprietário —
 * comparação normalizada (trim + lowercase), a mesma forma que
 * `owner.ts` usa para casar contra `PLATFORM_OWNER_EMAILS`. É esta
 * normalização que cobre "e-mail com caixa diferente" e "e-mail com
 * espaço" nos dois guards abaixo.
 */
export function assertNotSelf(
  ownerEmail: string,
  candidateEmail: string | null | undefined
): boolean {
  if (!candidateEmail) return false;
  return normalizeEmail(ownerEmail) === normalizeEmail(candidateEmail);
}

export interface CanBlockAccountInput {
  ownerEmail: string;
  /** account_id do perfil do proprietário neste banco, se ele tiver um. */
  ownerAccountId: string | null;
  target: {
    accountId: string;
    /** e-mail do dono (account_role='owner') da conta-alvo, quando conhecido. */
    ownerEmail?: string | null;
  };
}

/**
 * Recusa bloquear a própria conta do proprietário — por id (quando o
 * chamador já sabe a qual conta o perfil dele pertence) OU por e-mail
 * do dono da conta-alvo (quando só o e-mail está disponível, ex.: uma
 * tela que ainda não resolveu o `ownerAccountId`).
 */
export function canBlockAccount(input: CanBlockAccountInput): GuardResult {
  if (input.ownerAccountId && input.ownerAccountId === input.target.accountId) {
    return { ok: false, reason: 'self_account' };
  }
  if (assertNotSelf(input.ownerEmail, input.target.ownerEmail)) {
    return { ok: false, reason: 'self_account' };
  }
  return OK;
}

export interface CanBlockUserInput {
  ownerEmail: string;
  /** user_id do perfil do proprietário neste banco, se ele tiver um. */
  ownerUserId: string | null;
  target: {
    userId: string;
    email?: string | null;
  };
}

/** Recusa bloquear o próprio usuário do proprietário — por id ou por e-mail. */
export function canBlockUser(input: CanBlockUserInput): GuardResult {
  if (input.ownerUserId && input.ownerUserId === input.target.userId) {
    return { ok: false, reason: 'self_user' };
  }
  if (assertNotSelf(input.ownerEmail, input.target.email)) {
    return { ok: false, reason: 'self_user' };
  }
  return OK;
}
