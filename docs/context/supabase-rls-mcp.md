# Supabase — clientes, RLS, migrações, privilégios e MCP

> Domínio sob demanda (SPEC 079). Fatos que envelhecem — última migração, próximo número livre, registro de migrações — ficam **só** em [`status.md`](./status.md). Rule: `.claude/rules/supabase-rls-mcp.md`. Skill: `nova-migracao-supabase`.

## Qual cliente usar (RLS depende disso)

| Arquivo                      | Uso                               | Cuidado                                                                               |
| ---------------------------- | --------------------------------- | ------------------------------------------------------------------------------------- |
| `src/lib/supabase/client.ts` | Browser / Client Components       | Sujeito a RLS (`createBrowserClient`)                                                 |
| `src/lib/supabase/server.ts` | Server Components, Route Handlers | Sujeito a RLS, usa os cookies da sessão (`createServerClient`)                        |
| `src/lib/supabase/admin.ts`  | **service_role** — **ignora RLS** | Só no servidor, com autorização já validada. **Nunca** em código que chega ao browser |

- `admin.ts` é o canônico fora de requisição autenticada (webhooks, motores, fan-out em `after()`; o topo do arquivo diz por quê); `src/lib/automations/admin-client.ts` só o reexporta. Código novo importa `admin.ts` — não crie outro cliente lendo `SUPABASE_SERVICE_ROLE_KEY`.
- O browser lê e grava direto no banco: regra de escopo/quota mora em **RLS/trigger**, não só na rota.

## MCP Supabase — invariante 1

O projeto tem um único Supabase, o `vn`.

1. **Confirme com o mantenedor** antes de migração, DML, DDL, deploy de Edge Function ou criar/mexer em branch.
2. Rode `get_project_url` **antes** de ler ou escrever e confira que é o `vn`.
3. Nunca use outro projeto nem um conector Supabase identificado só por UUID (sem nome). Os conectores do claude.ai são desligados a partir de sessão nova (detalhe em `status.md`); se ainda aparecerem ferramentas `mcp__<UUID>__*`, não as use.
4. Depois de DDL, rode `get_advisors` (tipo **security**) e trate o que for novo.

## Migrações

- Numeração sequencial em `supabase/migrations/`; a ordem numérica **é** a ordem de aplicação. Antes de criar, `ls supabase/migrations/` (outra sessão pode ter pego o número) — próximo livre em [`status.md`](./status.md).
- Lacunas e sufixos documentados em [`supabase/migrations/README.md`](../../supabase/migrations/README.md) (as exceções de numeração estão em [`status.md`](./status.md)). Esse README trata **só** de numeração — privilégios estão abaixo.
- **Invariante 10 — template de fork:** script que carrega URL ou segredo do deploy específico **não é migração**. Vai em `supabase/setup/` (ex.: `cron-jobs.sql`, `plans-seed*.sql`); senão todo fork agendaria chamadas ou gravaria dados do seu deploy.
- `apply_migration` só após o item 1 acima.

## Privilégios de função em `public` (D-19)

O Supabase mantém `ALTER DEFAULT PRIVILEGES` que concede `EXECUTE` **nominalmente** a `anon` e `authenticated` em toda função nova de `public`. Por isso, até a 091, `REVOKE … FROM PUBLIC` sozinho **não** fechava a função. A 091 tira os dois do padrão, mas toda função ainda nasce com `EXECUTE` implícito de `PUBLIC`: sem o `REVOKE … FROM PUBLIC` ela fica aberta, e só o advisor pega. A 091 só vale em banco onde foi aplicada, então mantenha os dois comandos abaixo.

- **Toda função nova:** `REVOKE ALL ON FUNCTION … FROM PUBLIC;` **e** `… FROM anon;` (dois comandos).
- **A sessão do usuário chama** (RPC da rota ou do browser): `GRANT EXECUTE … TO authenticated, service_role;` — o escopo de conta é uma guarda no corpo.
- **Interna** (trigger, helper só de servidor): revogue também `FROM authenticated`.
- **`SECURITY DEFINER`:** fixe `search_path` (`ALTER FUNCTION … SET search_path = public`) e valide conta/papel no corpo.

Modelos para ler (não copiar): `supabase/migrations/044_messaging_limit_and_quota.sql` L128–144 (comentário que explica a armadilha + `REVOKE`/`GRANT`) e `supabase/migrations/084b_tighten_activity_function_grants.sql` L35–37 (função de trigger revogando `PUBLIC`, `anon` e `authenticated`).

## Policies com `is_account_member` / `can_*` (D-20)

- Escreva policy que usa `is_account_member(…)`, `can_access_conversation`, `can_write_conversation` ou `can_access_contact_notes` com `TO authenticated`.
- A 090 revoga o `EXECUTE` de `anon` nesses predicados. Onde ela foi aplicada, uma tabela que `anon` precise ler **não pode** ter policy `PUBLIC` que chame um deles: o Postgres checa `EXECUTE` de toda função das policies permissivas ao iniciar o executor, sem curto-circuito pelo `OR`, e o `SELECT` anônimo dá `42501`. Foi o caso de `plans_select_own` (corrigida na 090). Nunca devolva o `EXECUTE` a `anon`: mova a policy para `TO authenticated`.
- Em tabela de tenant, o `SELECT` anônimo passa de 0 linhas para `42501`. Continua fail-closed.
- Tabela e sequência novas não dão nada a `anon` depois da 091: leitura sem login exige `GRANT SELECT … TO anon` na própria migração.
- Antes de afirmar algo sobre essa ACL, verifique no `vn`: `SELECT has_function_privilege('anon', 'public.is_account_member(uuid, account_role_enum)', 'EXECUTE');` (idem para as `can_*`). Fechar a ACL é migração própria, com confirmação.

## Colunas cifradas ou secretas: GRANT por coluna, leitura só por service role (SPEC 089 P-14/P-15)

Policy de `SELECT` com só `is_account_member` deixa **qualquer** membro (`viewer` inclusive) ler a linha inteira pelo JWT, e o texto cifrado (AES-256-GCM) não precisa sair do servidor. Padrão das migrações 107, 111 e 112:

- `REVOKE SELECT ON TABLE … FROM authenticated;` e `GRANT SELECT (todas as colunas menos as secretas) ON … TO authenticated;`. `REVOKE ALL … FROM anon`. INSERT/UPDATE/DELETE seguem (a RLS de admin+ decide; gravar um segredo novo não exige `SELECT` na coluna).
- O servidor lê o segredo só com `supabaseAdmin()`, **sempre** filtrando por `account_id` já validado (o service role não tem RLS). `resolveCloudConfig` (`whatsapp_config`) é o exemplo: o `db` recebido decide o escopo (canal da conta), a credencial vem do service role. A API devolve só indicador ("configurado"), nunca o valor.
- `select('*')` com o cliente de sessão nessas tabelas passa a dar `42501` (de propósito): liste as colunas ou use service role.
- Coluna **nova** não herda o `GRANT` por coluna: nasce ilegível (falha fechada). Coluna comum nova precisa de `GRANT SELECT (coluna) … TO authenticated` na migração que a cria; coluna secreta nova não precisa de nada.
- Tabelas hoje cobertas: `ai_configs.api_key`/`embeddings_api_key` (111), `whatsapp_config.access_token`/`app_secret`/`verify_token` e `webhook_endpoints.secret` (112), `ai_custom_tools.headers_encrypted` (107). Tabelas com RLS ligada e **zero** policy (`evolution_instance_secrets`) e hashes aleatórios de 256 bits (`api_keys.key_hash`, `account_invitations.token_hash`) não entram.
- **Ordem de deploy:** código novo primeiro, migração depois. O código novo funciona com o banco antigo; a migração com o código antigo derruba a rota (a 112 derrubaria o envio de WhatsApp). Dev e produção compartilham o mesmo banco.
- Prova: `scripts/verify-1xx-…sql` (bloco que termina em `RAISE EXCEPTION`, rebaixa o admin a `viewer`/`agent` e simula o papel) e `get_advisors` (security).

## Verificação e diagnóstico

- `scripts/verify-039-rls.sql`, `scripts/verify-040-media.sql`: conferências (não migração) para o SQL Editor do `vn`; a PARTE A só lê.
- `scripts/verify-090-rpc-grants.sql`: só lê. Mostra o que `anon` executa, o privilégio padrão e as policies de `plans`, antes da 090 e depois da 091.

## Armadilha conhecida

| Sintoma                             | Causa provável                                                              |
| ----------------------------------- | --------------------------------------------------------------------------- |
| Query retorna vazio inesperadamente | Cliente Supabase errado (RLS barrando) ou membership de conta não resolvida |
