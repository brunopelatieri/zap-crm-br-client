/**
 * Camada 3 do enforcement de bloqueio (SPEC 062 §4, §4.3).
 *
 * **Por que este módulo existe.** A camada 1 é a RLS: a 069 pôs
 * `blocked_at IS NULL` dentro de `is_account_member()`, e com isso conta
 * bloqueada para de entregar dado para QUALQUER sessão de cliente, em
 * todas as tabelas de uma vez — inclusive no `insert` direto que o
 * navegador faz. Só que **`service_role` não passa por RLS**. Os motores
 * (disparo, automações, flows), a API pública e a auto-resposta de IA
 * rodam justamente com `service_role` — para eles a conta bloqueada
 * continua perfeitamente visível e perfeitamente operante. Sem código
 * explícito, uma conta bloqueada segue disparando campanha.
 *
 * É esse buraco que este arquivo fecha. A tabela da §4.3 é o que define
 * "pronto": **uma linha esquecida ali é uma conta bloqueada que continua
 * enviando.**
 *
 * **Leaf de propósito.** Nada de `next/*`, nada de `supabaseAdmin()` —
 * só o tipo do cliente, recebido por parâmetro. É o que permite importar
 * daqui tanto de dentro de um request (dashboard) quanto de um `after()`
 * de cron ou de um webhook, sem arrastar `next/headers` para caminhos
 * que rodam fora de escopo de requisição.
 *
 * **O que NÃO passa por aqui, por decisão de produto:**
 *
 * - **Ingestão de mensagem recebida** (`channels/ingest.ts`,
 *   `whatsapp/resolve-conversation.ts`) — D-9 do PRD: a mensagem do
 *   cliente final ENTRA e fica guardada. Quem está sendo punido é o
 *   assinante, não quem mandou mensagem para ele; descartar inbound
 *   perderia dado de terceiro que não tem nada com a inadimplência.
 * - **Varredura de retenção** (`retention/sweep.ts`) — continua rodando
 *   normalmente: não apagar seria acumular custo de armazenamento numa
 *   conta que, por hipótese, não está pagando.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Erro tipado de bloqueio. O `code` é **estável** e é o que a UI usa
 * para distinguir "bloqueado" de "sem permissão" — que são coisas
 * diferentes para quem está do outro lado da tela (§4.1).
 *
 * Vive aqui, e não em `@/lib/auth/account.ts` (onde a SPEC §4.1 o
 * desenha), por um motivo de dependência: `account.ts` importa
 * `@/lib/supabase/server`, que lê `next/headers`. Motor de automação e
 * webhook precisam lançar/capturar este erro fora de escopo de
 * requisição, e não podem depender daquele módulo. `account.ts`
 * **reexporta** esta classe, então o call site do dashboard continua
 * lendo exatamente como a SPEC escreveu.
 */
export class AccountBlockedError extends Error {
  readonly status = 403 as const;
  readonly code: 'account_blocked' | 'user_blocked';

  constructor(
    code: 'account_blocked' | 'user_blocked' = 'account_blocked',
    message = 'This account is blocked'
  ) {
    super(message);
    this.name = 'AccountBlockedError';
    this.code = code;
  }
}

/**
 * A conta está bloqueada?
 *
 * `db` precisa ser `service_role` para ter resposta útil: com o cliente
 * do navegador a linha de `accounts` já é invisível quando a conta está
 * bloqueada (a RLS da 069), e a função devolveria `false` por não achar
 * nada — o oposto do pretendido. Todos os call sites da §4.3 são
 * service-role.
 *
 * Falha **fechada**: erro de consulta devolve `true` (tratar como
 * bloqueado). Um banco fora do ar não pode virar "libera o disparo".
 */
export async function isAccountBlocked(
  db: SupabaseClient,
  accountId: string
): Promise<boolean> {
  const { data, error } = await db
    .from('accounts')
    .select('blocked_at')
    .eq('id', accountId)
    .maybeSingle();

  if (error) {
    console.error(
      `[platform/blocked] falha ao checar bloqueio da conta ${accountId}:`,
      error.message
    );
    return true;
  }
  // Conta inexistente também não recebe envio.
  if (!data) return true;
  return data.blocked_at !== null;
}

/** Lança `AccountBlockedError` quando a conta está bloqueada. */
export async function assertAccountNotBlocked(
  db: SupabaseClient,
  accountId: string
): Promise<void> {
  if (await isAccountBlocked(db, accountId)) {
    throw new AccountBlockedError('account_blocked');
  }
}

/**
 * O conjunto de contas bloqueadas — para as VARREDURAS (§4.3 pontos
 * 1–3), que enumeram trabalho de muitas contas por ciclo.
 *
 * Uma consulta por ciclo, não uma por conta: o predicado
 * `blocked_at IS NOT NULL` casa exatamente com o índice parcial
 * `idx_accounts_blocked` da 069, e o resultado tem o tamanho do
 * conjunto de bloqueados (quase sempre zero), não o da tabela.
 *
 * Falha **fechada** aqui é impossível de fazer bem (não há como
 * devolver "todas as contas"), então erro devolve conjunto vazio e
 * **avisa alto**: a varredura segue, e o backstop da §4.3 ponto 4
 * (`resolveChannelContext` / `assertAccountCanBroadcast`) ainda recusa
 * o envio conta a conta. Duas camadas justamente porque esta pode
 * degradar.
 */
export async function loadBlockedAccountIds(
  db: SupabaseClient
): Promise<Set<string>> {
  const { data, error } = await db
    .from('accounts')
    .select('id')
    .not('blocked_at', 'is', null);

  if (error) {
    console.error(
      '[platform/blocked] falha ao carregar contas bloqueadas — a varredura segue e o backstop de envio decide conta a conta:',
      error.message
    );
    return new Set();
  }

  return new Set((data ?? []).map((row) => row.id as string));
}
