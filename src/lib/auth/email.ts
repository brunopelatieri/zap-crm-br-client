/**
 * Regra única de "e-mail válido" e de normalização do app (SPEC 078 §7).
 *
 * Antes vivia como `EMAIL_RE` privado de `profile-form.tsx`; o console do
 * proprietário (edição de e-mail de usuário) precisa da MESMA regra, senão
 * o autosserviço aceita um endereço que o console recusa (ou o contrário).
 *
 * Verificação grosseira de formato — o validador de verdade é o Supabase
 * Auth, que rejeita o malformado em `updateUser`/`updateUserById`. Serve
 * para barrar erro de digitação óbvio antes da ida ao servidor.
 *
 * Puro, sem I/O: server e client podem importar.
 */

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** `trim` + `toLowerCase` — a forma que o app compara e-mails. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}
