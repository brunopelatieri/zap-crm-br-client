/**
 * Identidade do proprietário da plataforma (SPEC 062 §2.2).
 *
 * Server-only: importa o cliente SSR (`@/lib/supabase/server`), que lê
 * cookies via `next/headers`. `PLATFORM_OWNER_EMAILS` é a única fonte —
 * de propósito, sem tabela `platform_admins` (§2.2: uma tabela criaria
 * caminho de escalonamento de privilégio DENTRO do banco; o `.env`
 * exige acesso ao servidor, o mesmo nível de confiança que
 * `PLATFORM_ADMIN_SECRET` já exige hoje).
 *
 * A guarda exige, nesta ordem, e TODAS:
 *   1. PLATFORM_OWNER_EMAILS definida — ausente, o console NÃO EXISTE;
 *   2. sessão Supabase válida via getUser() (nunca getSession() — só
 *      getUser() valida no servidor de auth, não confia em cookie
 *      local não verificado);
 *   3. email_confirmed_at não nulo — email não confirmado não prova
 *      posse do endereço, e o endereço é a credencial aqui;
 *   4. email normalizado (trim + lowercase) presente na lista, com
 *      timingSafeEqual por item — o mesmo cuidado de
 *      `platform-admin.ts` contra vazamento por delta de tempo.
 */

import { timingSafeEqual } from 'node:crypto';

import { normalizeEmail } from '@/lib/auth/email';
import { createClient } from '@/lib/supabase/server';

export interface PlatformOwnerContext {
  /** E-mail normalizado (trim + lowercase) do proprietário autenticado. */
  email: string;
  userId: string;
}

/** `PLATFORM_OWNER_EMAILS` (lista separada por vírgula) já normalizada. */
export function parseOwnerEmails(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((e) => normalizeEmail(e))
    .filter((e) => e.length > 0);
}

function timingSafeIncludes(list: string[], candidate: string): boolean {
  const candidateBuf = Buffer.from(candidate);
  let found = false;
  for (const item of list) {
    const itemBuf = Buffer.from(item);
    // Compara TODOS os itens, sempre — parar no primeiro match
    // vazaria, pelo tempo total, em qual posição da lista o e-mail
    // está. timingSafeEqual exige buffers do mesmo tamanho; um
    // comprimento diferente já não bate, sem precisar comparar bytes.
    if (
      itemBuf.length === candidateBuf.length &&
      timingSafeEqual(itemBuf, candidateBuf)
    ) {
      found = true;
    }
  }
  return found;
}

/**
 * `true` só quando as quatro condições da §2.2 valem para este e-mail
 * — usado por `requirePlatformOwner` e por qualquer checagem pontual
 * que já tenha o e-mail confirmado em mãos (ex.: `guards.ts`).
 *
 * NÃO verifica confirmação de e-mail nem sessão — isso é
 * responsabilidade do chamador (`requirePlatformOwner` já resolve as
 * quatro condições juntas). Esta função isolada existe para o caso em
 * que o e-mail já vem de uma fonte confiável (ex.: comparar o dono
 * contra o alvo de um bloqueio).
 */
export function isPlatformOwnerEmail(
  email: string | null | undefined
): boolean {
  if (!email) return false;
  const owners = parseOwnerEmails(process.env.PLATFORM_OWNER_EMAILS);
  if (owners.length === 0) return false;
  return timingSafeIncludes(owners, normalizeEmail(email));
}

/**
 * Resolve o contexto do proprietário autenticado, ou lança.
 *
 * O chamador (rota de `/api/platform/**` ou o layout de `/admin`)
 * SEMPRE converte a falha em **404** (§2.4) — nunca 401/503. Um
 * estranho batendo em `/admin` não pode diferenciar "variável ausente"
 * de "sessão inválida" de "e-mail fora da lista": todos os três casos
 * têm que parecer "esta rota não existe".
 */
export async function requirePlatformOwner(): Promise<PlatformOwnerContext> {
  const owners = parseOwnerEmails(process.env.PLATFORM_OWNER_EMAILS);
  if (owners.length === 0) {
    throw new PlatformOwnerError('PLATFORM_OWNER_EMAILS not configured');
  }

  const supabase = await createClient();
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();

  if (error || !user || !user.email) {
    throw new PlatformOwnerError('No valid session');
  }
  if (!user.email_confirmed_at) {
    throw new PlatformOwnerError('Email not confirmed');
  }

  const normalized = normalizeEmail(user.email);
  if (!timingSafeIncludes(owners, normalized)) {
    throw new PlatformOwnerError('Not a platform owner');
  }

  return { email: normalized, userId: user.id };
}

/**
 * Erro único para toda falha de `requirePlatformOwner` — o chamador
 * mapeia SEMPRE para 404 (nunca lê `.message` na resposta HTTP; a
 * mensagem só vai para o log de servidor, que é onde o operador
 * diagnostica de verdade, §2.4).
 */
export class PlatformOwnerError extends Error {
  readonly status = 404 as const;
  constructor(message: string) {
    super(message);
    this.name = 'PlatformOwnerError';
  }
}
