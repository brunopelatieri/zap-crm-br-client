/**
 * Validação do valor de um campo de limite vindo do formulário do
 * painel (SPEC 060 §8.2) ou do corpo das rotas de retenção do console
 * (`/api/platform/retention` e `/api/platform/accounts/[accountId]/
 * retention[/preview]` — a SPEC 062 §3.8 mudou o dono da configuração,
 * não o formato do campo). Puro — a rota só decide o status HTTP a
 * partir do resultado.
 *
 * Vazio/`null`/`undefined` é uma entrada VÁLIDA que significa "herdar"
 * (§3.4) — nunca confundir com um valor inválido. `0` é igualmente
 * válido e significa "sem limite explícito", não "bloqueado" (essa
 * semântica é de outras quotas, não desta SPEC).
 */

export type ParsedRetentionLimit =
  { valid: true; value: number | null } | { valid: false };

/**
 * Teto de qualquer dimensão (achado de code review, SPEC 060). Sem ele,
 * um `retentionDays` absurdo (typo, ou confusão de unidade — dígitos
 * demais) chega intacto até `purge_channel_messages`, que faz
 * `NOW() - make_interval(days => p_retention_days)`: acima de ~2,46
 * milhões de dias isso estoura o intervalo representável de
 * `timestamptz` e a função lança em toda execução seguinte — falha
 * silenciosa e indefinida (`sweepOnePair` só loga e soma `errors++`).
 * Um teto bem abaixo disso, compartilhado pelas três dimensões, fecha
 * a porta sem precisar de um limite por campo.
 *
 * Exportado (achado de code review, SPEC 062): `global-defaults.ts`
 * (`parseConsoleDimension`/`validateRetentionDefaults`) reimplementava
 * a mesma validação de dimensão sem este teto — reusar a constante,
 * não só a ideia, é o que garante que as duas cópias não divergem de
 * novo no futuro.
 */
export const MAX_RETENTION_LIMIT_VALUE = 1_000_000;

export function parseRetentionLimitInput(value: unknown): ParsedRetentionLimit {
  if (value === null || value === undefined || value === '') {
    return { valid: true, value: null };
  }
  if (typeof value !== 'number' && typeof value !== 'string') {
    return { valid: false };
  }

  const parsed = typeof value === 'number' ? value : Number(value);
  if (
    !Number.isFinite(parsed) ||
    !Number.isInteger(parsed) ||
    parsed < 0 ||
    parsed > MAX_RETENTION_LIMIT_VALUE
  ) {
    return { valid: false };
  }
  return { valid: true, value: parsed };
}
