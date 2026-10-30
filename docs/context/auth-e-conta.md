# Autenticação, papéis, convites, membros e conta

> Domínio da SPEC 079. Rule: `.claude/rules/auth-e-conta.md`. Versões e projetos Supabase: [`status.md`](./status.md). Bloqueio, console e exclusão da conta: [`planos-quotas-admin.md`](./planos-quotas-admin.md). Mapa: [`INDEX.md`](./INDEX.md).

## Onde mexer

- **Gate de sessão em toda request:** `src/middleware.ts` (**não há `proxy.ts`**)
- **Conta/papel da sessão, bloqueio:** `src/lib/auth/account.ts` (`getCurrentAccount`), `src/hooks/use-auth.tsx`, `use-can.ts`
- **Papéis e predicados:** `src/lib/auth/roles.ts` — única fonte; rota e UI chamam os predicados, não comparam papel
- **Login, cadastro, reset:** `src/app/(auth)/` (`login`, `signup`, `forgot-password`, `reset-password`)
- **Troca de token do e-mail:** `src/app/auth/callback/route.ts`, `src/app/auth/confirm/page.tsx`
- **Senha forte (SPEC 054):** `src/lib/auth/password-policy.ts`, `src/components/auth/`
- **Mensagens de erro do Auth:** `src/lib/auth/error-messages.ts`
- **Convites e membros:** `src/lib/auth/invitations.ts`, `src/lib/account/members.ts`, `src/app/join/`, `src/app/api/account/{invitations,members}`, `src/app/api/invitations/`
- **Excluir conta / transferir titularidade:** `src/lib/account/delete*.ts`, `src/app/api/account/{delete,transfer-ownership}`
- **Cadastro público liga/desliga:** `src/lib/auth/signup-flag.ts`

## Regras que não podem quebrar

1. **Quatro papéis, ordem fixa:** `viewer < agent < admin < owner`, espelhando o `CASE` de `is_account_member(account_id, min_role)` no SQL. Use `hasMinRole` e os predicados (`canEditSettings`, `canSendMessages`, `canDeleteAccount`…). Um `role === 'admin' || role === 'owner'` escrito à mão diverge da RLS na próxima mudança de política.
2. **O servidor repete toda guarda da UI.** `minRole` na interface só esconde o item; a rota (`requireRole`) responde 403 a quem chamar com `curl`.
3. **O middleware não faz nada pelas rotas `/auth/callback` e `/auth/confirm`: retorna cedo, antes de criar o client e antes de `getUser()`.** `getUser()` com cookie de sessão obsoleto apaga também o cookie `-code-verifier` e a troca PKCE falha com `auth_callback_failed` ([SPEC 053](../spec-053-validacao-deploy-reset-senha.md) §2.1.2). Rota nova de troca de token entra nessa exceção.
4. **Cookies renovados precisam ir na resposta.** O middleware copia os `Set-Cookie` do `supabaseResponse` para qualquer redirect (`withRefreshedCookies`); redirecionar com um `NextResponse` novo perde o refresh token e a sessão "trava" após ficar ociosa.
5. **Link de e-mail não consome o token no GET.** Scanner de e-mail (Safe Links, proxy) dispara o link antes do usuário; o template de redefinição aponta para `/auth/confirm?token_hash=…&type=recovery`, que só chama `verifyOtp` no clique do botão. Os demais templates ainda usam `{{ .ConfirmationURL }}`. Colar o template no painel do Supabase é passo manual ([`../templates_email_send/`](../templates_email_send/)).
6. **Origem pública vem de `resolveRequestOrigin`**: `NEXT_PUBLIC_SITE_URL`, depois `X-Forwarded-Host/Proto`, nunca `request.nextUrl.origin` (atrás do proxy vira `0.0.0.0:3000`). Vale para callback e para links de convite.
7. **Convite:** o banco guarda só o **hash SHA-256** do token (32 bytes, base64url); o texto puro é devolvido uma vez. Usuário já logado com `?invite=` é enviado a `/join/<token>`.
8. **`/reset-password` exige sessão de recuperação** (está na lista protegida do middleware). A lista `protectedPaths` do middleware **não** cobre tudo; o `layout` do dashboard também chama `getCurrentAccount()` e manda conta/usuário bloqueado para `/blocked` — sem depender do middleware.
9. **Senha:** regras e medidor vêm de `password-policy.ts` (única fonte; cadastro, reset e Configurações). Limite em **bytes UTF-8** (o bcrypt do Supabase trunca em 72), não em `length`; caracteres de controle são recusados. Mudar o conjunto de símbolos exige que continue aceito pela política de "Symbols" do Supabase ([SPEC 054](../spec-054-senha-forte.md) D-3/D-4).
10. **Erro de Auth sem chave no namespace = `MISSING_MESSAGE` em runtime.** O `i18n:check` valida `CODE_TO_MESSAGE_KEY` em cada namespace que usa o helper (ver [`i18n.md`](./i18n.md)).
11. **Excluir/transferir conta é só do `owner`** (`canDeleteAccount`, `canTransferOwnership`); fluxo e ordem em [`planos-quotas-admin.md`](./planos-quotas-admin.md).

## Armadilhas

| Sintoma                                       | Causa provável                                                                           |
| --------------------------------------------- | ---------------------------------------------------------------------------------------- |
| E-mail de confirmação aponta para `localhost` | **Site URL** do Supabase não trocada para produção (independe de `NEXT_PUBLIC_SITE_URL`) |

Outras: `otp_expired` no clique = scanner consumiu o token (regra 5); `auth_callback_failed` com domínio certo = verifier apagado (regra 3); sessão "travada" = cookies renovados não copiados (regra 4). A **Redirect URL** do callback precisa estar na allowlist do Supabase de cada ambiente.

## Mais

[`../spec-053-validacao-deploy-reset-senha.md`](../spec-053-validacao-deploy-reset-senha.md) · [`../spec-054-senha-forte.md`](../spec-054-senha-forte.md).
