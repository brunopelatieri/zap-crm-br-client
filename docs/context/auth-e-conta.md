# Autenticação, papéis, convites, membros e conta

> Domínio da SPEC 079. Rule: `.claude/rules/auth-e-conta.md`. Versões: [`status.md`](./status.md). Bloqueio, console e exclusão da conta: [`planos-quotas-admin.md`](./planos-quotas-admin.md). Mapa: [`INDEX.md`](./INDEX.md).

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

## Área do contato (`/area`) — PRD 082 / SPEC 083

O cliente final da conta entra em `/area` com telefone + senha; o código de primeiro acesso e de recuperação sai pelo WhatsApp da própria conta. É uma identidade **à parte** do Supabase Auth: o contato não ganha `auth.users`, `profiles`, JWT nem papel Postgres, então nenhuma policy ou grant da CRM o alcança. Código em `src/lib/contact-portal/` (regra de negócio + testes), `src/app/(portal)/` (telas e `area/api/*`), `src/app/api/contact-portal/` (lado da conta), `src/components/contact-portal/`. Banco: schema `contact_portal` (migrações 093–096), alcançado só por funções `public.portal_*` que **só `service_role`** executa.

Regras de isolamento (SPEC 083 §7.2; `isolation.test.ts` e `middleware.contact-portal.test.ts` as prendem por varredura estática e por teste de rota):

1. **`/area` sai cedo do middleware, sem `getUser()`.** A sessão da área não abre nenhuma rota da CRM; usuário da conta e contato convivem no mesmo navegador.
2. **Cookie `zap_area_session`**: não começa com `sb-`, só vale em `Path=/area`, `HttpOnly`, `SameSite=Lax`, `Secure` fora de `http://localhost`. O nome só aparece em `session.ts`. O banco guarda só o sha256 do token; todo login gera token novo.
3. **Toda escrita em `/area/api/*` confere `Origin`** (`guardWrite`); ausente ou `null` responde 403. O link da mensagem usa só `NEXT_PUBLIC_SITE_URL` (`configuredSiteOrigin`), nunca o host da requisição.
4. **Rotas `/area/api/*` importam só `@/lib/contact-portal/*`.** Dentro da área, só `service.ts` e `account.ts` tocam `@/lib/supabase/*`; `plan-gate.ts` passa por `portalDb()` de `service.ts`. Nenhuma rota de `/api/**` fora de `/api/contact-portal/` importa o lado do contato (só `contact-portal/account`, para o resumo do console).
5. **Rotas da conta (`/api/contact-portal/*`)**: `requireRole`, depois **guarda de plano** (`requireContactPortalFeature` → `plan_feature_strict`, 403 `FEATURE_NOT_IN_PLAN`), depois contato conferido pela RLS da sessão (`visibleContact[Ids]`), depois `portal_*`. Única exceção: `GET /api/contact-portal/settings` responde 200 com `featureInPlan: false` para a aba mostrar o aviso.
6. **Elegibilidade reconferida a cada requisição, sem cache**: `plan_feature_strict(account, 'contact_portal_enabled')` + `contact_portal.settings.enabled` + `accounts.blocked_at IS NULL` (`account_is_eligible`). Chave ausente, `quotas_enforced` desligado ou conta sem `account_plans` **negam** (PRD 082 D-2); `plan_feature()` da 067 não serve para porta de login. Perder o item nega e **não apaga** senha nem sessões (D-6).
7. **O código nunca fica em claro no inbox**: `sendAndPersistOutbound` grava `[código de acesso enviado]`; `ingest.ts` descarta o eco `fromMe` que `looksLikePortalCodeMessage` reconhece (marcador fixo `🔐` + seis dígitos, fora da tradução de propósito).

Armadilhas próprias: a mensagem sai sem link se `NEXT_PUBLIC_SITE_URL` faltar; limites por IP caem se o proxy repassar `X-Forwarded-For` do cliente (Traefik é a borda, A-5); `PORTAL_TERMS_VERSION` vira a data do texto de aceite aprovado (D-9) antes da primeira conta real.

## Armadilhas

| Sintoma                                                 | Causa provável                                                                                                                   |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| E-mail de confirmação aponta para `localhost`           | **Site URL** do Supabase não trocada para produção (independe de `NEXT_PUBLIC_SITE_URL`)                                         |
| `/area` responde "conta não elegível" com a área ligada | Plano sem `contact_portal_enabled` (ou 096 não aplicada); conferir `plan_feature_strict` no `vn`, não `plan.features` do cliente |

Outras: `otp_expired` no clique = scanner consumiu o token (regra 5); `auth_callback_failed` com domínio certo = verifier apagado (regra 3); sessão "travada" = cookies renovados não copiados (regra 4). A **Redirect URL** do callback precisa estar na allowlist do Supabase de cada ambiente.

## Mais

[`../spec-053-validacao-deploy-reset-senha.md`](../spec-053-validacao-deploy-reset-senha.md) · [`../spec-054-senha-forte.md`](../spec-054-senha-forte.md).
