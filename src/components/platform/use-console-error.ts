'use client';

import { useTranslations } from 'next-intl';

/**
 * Traduz o `code` estável que as rotas `/api/platform/**` devolvem
 * (SPEC 078 §8). As rotas falam inglês — são para integrações; a UI
 * traduz pelo `code`. Código desconhecido cai no `fallback` do chamador
 * (nunca na mensagem em inglês do servidor).
 */
export function useConsoleErrorMessage() {
  const t = useTranslations('Platform.consoleErrors');
  return (code: unknown, fallback: string): string =>
    typeof code === 'string' && t.has(code) ? t(code) : fallback;
}
