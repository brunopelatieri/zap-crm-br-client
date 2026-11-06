// ============================================================
// Tipos da área do contato (SPEC 083).
//
// O contato não é usuário do Supabase Auth: a "sessão" aqui é a linha
// de `contact_portal.sessions` resolvida pelo hash do token do cookie,
// e os "acessos" são as credenciais (uma por contato, logo por conta)
// que essa sessão abriu. Tudo que a área faz recebe `PortalSession`
// como primeiro parâmetro — nunca um `contact_id`/`account_id` vindo do
// cliente (SPEC 083 §6, §12).
// ============================================================

/** Motivo do código pedido pelo próprio contato (o convite é da conta). */
export type PortalCodePurpose = 'first_access' | 'reset';

/** Estado do acesso na ficha do contato (`portal_access_status`). */
export type AccessStatus = 'none' | 'invited' | 'active' | 'blocked';

/** Um acesso que a sessão abriu e que ainda é elegível (SPEC 083 E-1). */
export interface PortalAccess {
  contactId: string;
  accountId: string;
  contactName: string | null;
  accountName: string;
  isCurrent: boolean;
}

export interface PortalSession {
  sessionId: string;
  /** sha256 do token do cookie, em hex — o token em si não sai do cookie. */
  tokenHash: string;
  /** Só os acessos ainda elegíveis, conferidos no banco nesta requisição. */
  accesses: PortalAccess[];
  /**
   * O acesso escolhido. `null` quando a sessão abriu mais de uma conta e
   * a pessoa ainda não escolheu (tela "Escolher conta").
   */
  current: PortalAccess | null;
}

export type RequestCodeStatus = 'sent' | 'no_match' | 'throttled';
export type CompleteCodeStatus = 'ok' | 'invalid' | 'throttled';
export type LoginStatus = 'ok' | 'invalid' | 'throttled';
export type ChangePasswordStatus =
  'ok' | 'invalid' | 'throttled' | 'no_session';
