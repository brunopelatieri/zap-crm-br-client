// ============================================================
// Limites da área do contato (SPEC 083 §5) — fonte única.
//
// O banco aplica (contadores em `contact_portal.attempts`, não o
// `rate-limit.ts` em memória, que não vale com mais de uma instância),
// mas não tem valor padrão: cada `portal_*` recebe este objeto em
// `p_limits` e falha com 22023 se faltar chave. Mudar um número é
// mudar aqui; o teste de contrato confere as chaves contra a migração.
// ============================================================

export const PORTAL_LIMITS = {
  /** Entre dois envios de código para o mesmo telefone. */
  send_phone_min_interval_s: 60,
  send_phone_per_hour: 5,
  send_ip_per_hour: 20,
  /** Código pedido pelo contato (J2, J3, J5). */
  code_ttl_s: 600,
  /** Convite da conta (J1): a pessoa pode abrir horas depois. */
  invite_code_ttl_s: 86_400,
  /** Erros que matam um código. */
  code_max_attempts: 5,
  code_ip_fail_max: 30,
  code_ip_window_s: 900,
  login_phone_fail_max: 10,
  login_ip_fail_max: 30,
  login_window_s: 900,
} as const satisfies Record<string, number>;

export type PortalLimitKey = keyof typeof PORTAL_LIMITS;

/**
 * Piso de tempo da resposta de `/area/api/request-code` (F6, achado A-3).
 * Acima do pedido que acha contato medido no `dev` (RPC + bcrypt 8 ≈
 * 18 ms no banco); fica fora de `PORTAL_LIMITS` porque o banco não o lê.
 */
export const PORTAL_REQUEST_CODE_MIN_MS = 750;

/** Validade deslizante da sessão (cookie e `contact_portal.sessions`). */
export const PORTAL_SESSION_TTL_S = 30 * 86_400;
