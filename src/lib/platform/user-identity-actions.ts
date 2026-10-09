/**
 * Escrita da edição de nome/e-mail de usuário pelo console (SPEC 078
 * §5.3).
 *
 * Server-only: recebe um cliente `service_role` (`supabaseAdmin()`).
 * Chamado por `PATCH /api/platform/users/[userId]` DEPOIS das guardas
 * puras de `user-identity.ts` — aqui o `email` já chega validado e
 * normalizado, e o `fullName` já aparado.
 *
 * Não há transação entre o Auth (GoTrue) e o Postgres, então a ORDEM
 * das escritas é o que minimiza o estado parcial:
 *
 *   1. **E-mail primeiro** — é a escrita que pode falhar por regra de
 *      negócio (`email_taken`). Se falhar, nada foi gravado.
 *   2. **Nome depois** — `profiles.full_name` (fonte de verdade) e a
 *      cópia em `auth.users.raw_user_meta_data`, esta de melhor esforço
 *      (a falha só é logada: o nome do app já mudou).
 *   3. Se o nome falhar com o e-mail já gravado → `partial_update` com
 *      `emailUpdated: true`; a UI recarrega e mostra o que ficou.
 *
 * `profiles.email` NÃO é escrito aqui: o trigger
 * `on_auth_user_email_updated` (migração 089) copia a mudança de
 * `auth.users.email` — escrever também daqui criaria dois caminhos para
 * o mesmo dado.
 *
 * `email_confirm: true` (D-10): a troca vale na hora, sem link de
 * confirmação — o operador responde pela identidade, e o caso de uso
 * principal é justamente o cliente que perdeu acesso ao e-mail antigo.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export interface UpdateUserIdentityInput {
  userId: string;
  /** Já validado por `validateFullName`. Omitido = não mexe no nome. */
  fullName?: string | null;
  /** Já validado e normalizado por `canEditUserIdentity`. Omitido = não mexe. */
  email?: string | null;
}

export type UpdateUserIdentityResult =
  | { ok: true; emailUpdated: boolean; nameUpdated: boolean }
  | {
      ok: false;
      error: 'no_changes' | 'email_taken' | 'user_not_found' | 'update_failed';
      emailUpdated: false;
    }
  | { ok: false; error: 'partial_update'; emailUpdated: true };

interface AuthErrorLike {
  message?: string;
  status?: number;
  code?: string;
}

interface AdminUserAttributes {
  email?: string;
  email_confirm?: boolean;
  user_metadata?: Record<string, unknown>;
}

type UpdateUserById = (
  id: string,
  attributes: AdminUserAttributes
) => Promise<{ error: AuthErrorLike | null }>;

/**
 * GoTrue recusa e-mail repetido com `422` + `code: 'email_exists'`;
 * versões antigas só mandam o texto "already been registered".
 */
function isEmailTaken(error: AuthErrorLike): boolean {
  if (error.code === 'email_exists') return true;
  const message = (error.message ?? '').toLowerCase();
  return (
    message.includes('already been registered') ||
    message.includes('already registered')
  );
}

function isUserNotFound(error: AuthErrorLike): boolean {
  return error.code === 'user_not_found' || error.status === 404;
}

export async function updateUserIdentity(
  db: SupabaseClient,
  input: UpdateUserIdentityInput
): Promise<UpdateUserIdentityResult> {
  const wantsEmail = input.email != null;
  const wantsName = input.fullName != null;
  if (!wantsEmail && !wantsName) {
    return { ok: false, error: 'no_changes', emailUpdated: false };
  }

  // Mesmo cast de `accounts/[accountId]/delete/route.ts`: o tipo
  // genérico de `SupabaseClient` não expõe a assinatura do admin API.
  const updateUserById = db.auth.admin.updateUserById.bind(
    db.auth.admin
  ) as unknown as UpdateUserById;

  // ── 1. E-mail ──────────────────────────────────────────────────
  if (wantsEmail) {
    const { error } = await updateUserById(input.userId, {
      email: input.email as string,
      email_confirm: true,
    });
    if (error) {
      if (isEmailTaken(error)) {
        return { ok: false, error: 'email_taken', emailUpdated: false };
      }
      if (isUserNotFound(error)) {
        return { ok: false, error: 'user_not_found', emailUpdated: false };
      }
      console.error(
        '[platform/user-identity] auth email update failed:',
        error.message
      );
      return { ok: false, error: 'update_failed', emailUpdated: false };
    }
  }

  // ── 2. Nome ────────────────────────────────────────────────────
  if (wantsName) {
    const failure = await writeName(
      db,
      updateUserById,
      input.userId,
      input.fullName as string
    );
    if (failure) {
      // O e-mail já foi gravado: o chamador precisa saber, senão a UI
      // diria "nada mudou" sobre um login que JÁ mudou.
      if (wantsEmail) {
        return { ok: false, error: 'partial_update', emailUpdated: true };
      }
      return { ok: false, error: failure, emailUpdated: false };
    }
  }

  return { ok: true, emailUpdated: wantsEmail, nameUpdated: wantsName };
}

/** `null` = gravado; senão o código do erro (já logado). */
async function writeName(
  db: SupabaseClient,
  updateUserById: UpdateUserById,
  userId: string,
  fullName: string
): Promise<'user_not_found' | 'update_failed' | null> {
  // `.select()` depois do `update`: sem ele não há como distinguir "zero
  // linhas casaram" (usuário sem perfil) de sucesso.
  const { data, error } = await db
    .from('profiles')
    .update({ full_name: fullName })
    .eq('user_id', userId)
    .select('user_id');
  if (error) {
    console.error(
      '[platform/user-identity] profiles.full_name update failed:',
      error.message
    );
    return 'update_failed';
  }
  if (!data || data.length === 0) return 'user_not_found';

  // Cópia que o painel do Supabase mostra; só `handle_new_user` a lê, e
  // só no cadastro. O Auth mescla `user_metadata` (não substitui).
  //
  // Melhor esforço: `profiles.full_name` (acima) é o que o app lê, e já
  // foi gravado. Falhar aqui reportaria `update_failed` — e, sem
  // auditoria nem atividade, um nome que JÁ mudou ficaria sem rastro
  // (ou, junto de um e-mail, seria dado como `partial_update` sem o nome).
  const { error: metaError } = await updateUserById(userId, {
    user_metadata: { full_name: fullName },
  });
  if (metaError) {
    console.error(
      '[platform/user-identity] auth user_metadata copy failed (profile name saved):',
      metaError.message
    );
  }
  return null;
}
