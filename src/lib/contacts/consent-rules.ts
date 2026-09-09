/**
 * Regras puras de consentimento (SPEC 044 §6.8) — sem I/O.
 *
 * Separado de `consent.ts` de propósito: `consent.ts` grava atividade via
 * `recordActivity`, que importa `supabaseAdmin` (service_role) no topo do
 * módulo. Um componente `'use client'` que só precisa de `excludesOptedOut`/
 * `isOptedOut` deve importar DESTE arquivo, nunca de `consent.ts` — importar
 * de lá puxaria o service_role para o bundle do browser (AGENTS.md,
 * "Nunca importar [admin.ts] em código que chega ao browser").
 */

export type OptInStatus = 'opted_in' | 'opted_out' | 'unknown';

export type ConsentSource =
  'inbound_keyword' | 'manual' | 'import' | 'api' | 'automation';

/** Categorias que NÃO são marketing e portanto alcançam quem optou por sair. */
const NON_MARKETING_CATEGORIES = new Set(['utility', 'authentication']);

/**
 * `true` quando esta categoria de template precisa excluir contatos em
 * opt-out da audiência.
 */
export function excludesOptedOut(category: string | null | undefined): boolean {
  if (!category) return true;
  return !NON_MARKETING_CATEGORIES.has(category.trim().toLowerCase());
}

/** Predicado sobre uma linha de contato já carregada. */
export function isOptedOut(contact: {
  opt_in_status?: string | null;
}): boolean {
  return contact.opt_in_status === 'opted_out';
}
