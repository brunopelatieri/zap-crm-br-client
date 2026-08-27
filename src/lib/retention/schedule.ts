/**
 * Decisões de ritmo da varredura (SPEC 060 §3.3, §6) — puras, sem
 * `Date.now()` por dentro, para o teste controlar `now` sem mockar o
 * relógio global.
 */

/**
 * A porta 1 (fase 4 de `/api/automations/cron`) é pingada a cada 5 min,
 * mas só deve rodar quando o intervalo configurado já venceu.
 * `lastRunAt === null` (nunca rodou) sempre dispara.
 */
export function shouldRunNow(
  lastRunAt: Date | null,
  intervalHours: number,
  now: Date
): boolean {
  if (lastRunAt === null) return true;
  const elapsedMs = now.getTime() - lastRunAt.getTime();
  return elapsedMs >= intervalHours * 60 * 60 * 1000;
}

/**
 * Claim vencido — mesmo formato dos claims da 054 (30 min de teto).
 * Exportado para `sweep.ts` construir o corte da mesma janela ao
 * reivindicar `message_retention_state.running_since`.
 */
export const CLAIM_STALE_MINUTES = 30;

export function isClaimStale(runningSince: Date | null, now: Date): boolean {
  if (runningSince === null) return false;
  const elapsedMs = now.getTime() - runningSince.getTime();
  return elapsedMs >= CLAIM_STALE_MINUTES * 60 * 1000;
}
