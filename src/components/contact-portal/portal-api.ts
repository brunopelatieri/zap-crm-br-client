// Chamadas das telas da área às rotas `/area/api/*` (SPEC 083 §8.2).
//
// A rota responde em inglês com `code`; a tela traduz pelo `code`
// (`ContactPortal.errors.<code>`). Código desconhecido vira `unexpected`
// — uma rota nova não pode quebrar a tela com chave de i18n ausente.

export const PORTAL_ERROR_CODES = [
  'invalid_input',
  'forbidden_origin',
  'invalid_credentials',
  'throttled',
  'invalid_code',
  'weak_password',
  'password_mismatch',
  'terms_required',
  'invalid_current',
  'no_session',
  'not_found',
  'unexpected',
] as const;

export type PortalErrorCode = (typeof PORTAL_ERROR_CODES)[number];

export type PortalCallResult<T> =
  { ok: true; data: T } | { ok: false; code: PortalErrorCode };

function toErrorCode(raw: unknown): PortalErrorCode {
  return (PORTAL_ERROR_CODES as readonly string[]).includes(raw as string)
    ? (raw as PortalErrorCode)
    : 'unexpected';
}

export async function postPortal<T = { ok: true; next?: string }>(
  path: string,
  body: Record<string, unknown>
): Promise<PortalCallResult<T>> {
  try {
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(body),
    });
    const json: unknown = await res.json().catch(() => null);
    if (!res.ok) {
      return {
        ok: false,
        code: toErrorCode((json as { code?: unknown } | null)?.code),
      };
    }
    return { ok: true, data: json as T };
  } catch {
    return { ok: false, code: 'unexpected' };
  }
}

// O telefone passa da tela de pedir código para a de digitar o código
// pela aba (sessionStorage), nunca pela URL: telefone é dado pessoal.
const PHONE_KEY = 'zapcrm:area:phone';

export function rememberPhone(phone: string): void {
  try {
    sessionStorage.setItem(PHONE_KEY, phone);
  } catch {
    /* aba privada / storage bloqueado: a tela de código pede de novo */
  }
}

export function recallPhone(): string {
  try {
    return sessionStorage.getItem(PHONE_KEY) ?? '';
  } catch {
    return '';
  }
}

/** `?conta=<código>` quando a tela veio pelo endereço de uma conta. */
export function accountQuery(publicCode: string | null): string {
  return publicCode ? `?conta=${encodeURIComponent(publicCode)}` : '';
}
