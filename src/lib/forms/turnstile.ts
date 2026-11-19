// ============================================================
// Cloudflare Turnstile (SPEC 085 §7.2).
//
// A ÚNICA chamada externa do envio. Duas decisões fixas:
//   - `AbortSignal.timeout(5000)`: um verificador lento não pode segurar
//     a requisição do visitante nem o processo;
//   - fail-CLOSED: qualquer falha (rede, timeout, resposta ilegível,
//     `success` falso) RECUSA o envio — o dono do formulário pediu
//     proteção, e uma queda do verificador não pode virar porta aberta.
//
// Só entra em jogo quando o formulário liga `settings.turnstile` E o
// deploy tem as duas chaves; sem chave o interruptor fica desabilitado
// no construtor e o widget nem aparece na página.
// ============================================================

export const TURNSTILE_VERIFY_URL =
  'https://challenges.cloudflare.com/turnstile/v0/siteverify';
export const TURNSTILE_TIMEOUT_MS = 5000;
const TOKEN_MAX = 2048;

export function turnstileSiteKey(): string | null {
  const key = process.env.TURNSTILE_SITE_KEY?.trim();
  return key && process.env.TURNSTILE_SECRET_KEY?.trim() ? key : null;
}

/** Turnstile só liga com as DUAS chaves no deploy. */
export function isTurnstileConfigured(): boolean {
  return turnstileSiteKey() !== null;
}

export async function verifyTurnstile(
  token: unknown,
  remoteIp?: string | null,
  fetchImpl: typeof fetch = fetch
): Promise<boolean> {
  const secret = process.env.TURNSTILE_SECRET_KEY?.trim();
  if (!secret) return false;
  if (typeof token !== 'string' || !token || token.length > TOKEN_MAX) {
    return false;
  }
  try {
    const body = new URLSearchParams({ secret, response: token });
    if (remoteIp && remoteIp !== 'unknown') body.set('remoteip', remoteIp);
    const res = await fetchImpl(TURNSTILE_VERIFY_URL, {
      method: 'POST',
      body,
      signal: AbortSignal.timeout(TURNSTILE_TIMEOUT_MS),
    });
    if (!res.ok) return false;
    const json = (await res.json()) as { success?: unknown };
    return json.success === true;
  } catch {
    return false;
  }
}
