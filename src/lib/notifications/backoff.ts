/**
 * Recuo exponencial da entrega (SPEC 063 §5, passos 3-4). Puro.
 *
 *   next_attempt_at = now + 2^attempts minutos, teto de 6h
 *   attempts >= 6 → desiste (marca 'failed', para de tentar)
 */

const CAP_MINUTES = 6 * 60;
const GIVE_UP_AT_ATTEMPTS = 6;

/** `attempts` já é o valor PÓS-incremento desta tentativa que falhou. */
export function nextAttemptAt(attempts: number, now: Date): Date {
  const minutes = Math.min(2 ** attempts, CAP_MINUTES);
  return new Date(now.getTime() + minutes * 60_000);
}

export function hasGivenUp(attempts: number): boolean {
  return attempts >= GIVE_UP_AT_ATTEMPTS;
}
