# Planos, quotas, limites, console `/admin`, bloqueio e exclusão de conta

> Domínio da SPEC 079. Rule: `.claude/rules/planos-quotas-admin.md`. Migração atual e cron: [`status.md`](./status.md). RLS e privilégios: [`supabase-rls-mcp.md`](./supabase-rls-mcp.md). Mapa: [`INDEX.md`](./INDEX.md).

## Onde mexer

- **Plano, uso, gate, ciclo, vencimento:** `src/lib/plans/` (`account-plan`, `gate`, `usage`, `billing*`, `lifecycle`, `period-end`)
- **Troca de plano pelo cliente:** `src/lib/plans/self-service.ts`, `src/components/plan/`, `src/hooks/use-account-plan*`
- **Pagamento manual e estorno:** `src/lib/plans/manual-billing.ts`, `payments.ts`, `payment-reversal.ts`
- **Console do proprietário:** `src/app/(platform)/admin/`, `src/app/api/platform/`, `src/lib/platform/`, `src/components/platform/`
- **Rotas de operador (script):** `src/app/api/admin/**`, `src/lib/auth/platform-admin.ts`
- **Bloquear conta/usuário, tela `/blocked`:** `src/lib/platform/block.ts`, `blocked.ts`, `guards.ts`, `src/app/blocked/`
- **Cascata de limites:** `src/lib/limits/` (`registry`, `resolve`, `load`)
- **Catálogo comercial:** `supabase/setup/plans-seed*.sql` — **não** é migração

## Regras que não podem quebrar

1. **O banco decide, o app explica** ([SPEC 059](../spec-059-motor-de-quotas.md) §1). Cota é trigger no Postgres: o navegador insere contato direto com a chave anônima, então guarda só em rota é contornável. O TypeScript antecipa, traduz o erro e esconde o que o plano não inclui.
2. **`platform_settings.quotas_enforced`** (linha única, nasce FALSE, opt-in por deployment): FALSE = nada bloqueia, toda conta age como `unlimited`. O valor **de cada ambiente** está no banco — consulte, não presuma ([guia](../guia-operacao-planos-e-quotas.md) §3–4).
3. **Catálogo comercial nunca em migração** (D-2): fork de terceiro herdaria seus preços. Vai em `supabase/setup/`.
4. **O console não afrouxa RLS** ([SPEC 062](../spec-062-console-do-proprietario.md) §1): nada de policy `is_platform_owner()`; leitura cross-account é rota de servidor com `service_role` atrás de `requirePlatformOwner()` (`src/lib/platform/owner.ts`).
5. **Proprietário = `PLATFORM_OWNER_EMAILS` no `.env`** (não tabela). Sem a variável, o console **não existe**: `/admin` e `/api/platform/**` respondem **404** de propósito (nunca 401/503). Exige `getUser()` (não `getSession()`) e e-mail confirmado.
6. **Bloqueio em três camadas, nenhuma basta sozinha:** RLS (`is_account_member()` recusa conta/usuário bloqueado) · sessão (`getCurrentAccount()` lança `AccountBlockedError` → `/blocked` explica; lista vazia seria lida como perda de dados) · motores com `service_role` param de **enviar**. Ao redefinir `is_account_member`, mantenha `STABLE` e repita `ALTER FUNCTION … OWNER TO postgres`.
7. **A ingestão de mensagens continua** em conta bloqueada. Bloqueio é reversível e não apaga nada; `suspended` do plano é sinalização comercial e **não** bloqueia ([PRD 061](../prd-061-console-do-proprietario-e-ciclo-de-plano.md) §7).
8. **O proprietário não bloqueia nem apaga a si mesmo** (`guards.ts`). Saída de emergência: `UPDATE accounts SET blocked_at = NULL` por SQL.
9. **`/api/admin/**` exige `x-admin-secret` = `PLATFORM_ADMIN_SECRET`**; sem a variável, `503` (falha alto).
10. **Vencimento:** `addMonths` (31/01 não vira 03/03); troca de plano **herda** o vencimento; renovação externa idempotente por `paymentRef`; renovação atrasada soma do vencimento anterior, não de hoje; datas do console em `America/Sao_Paulo` **no banco** ([SPEC 078](../spec-078-vencimento-pagamento-manual-e-identidade-de-usuarios.md) D-2).
11. **Pagamento manual:** o identificador externo vai **literal** (sem prefixo), senão o mesmo Pix aplica duas vezes; `console:<uuid>` nasce ao abrir o diálogo, não no clique.
12. **Identidade de usuário (SPEC 078):** e-mail de cliente não pode virar o reservado do proprietário (`email_reserved_for_platform_owner` — se falhar é **incidente de segurança**); o proprietário não edita o próprio e-mail pelo console.
13. **Cascata de limites sem "ilimitado" por acidente** (SPEC 069 §3.4): valor ausente/torto desce um nível até o padrão de código; `NULL` = "não configurado aqui". Limite fora de `registry.ts` é limite escondido.
14. **Excluir conta ou usuário nunca por MCP nem por API de plataforma** ([SPEC 091](../spec-091-assistente-da-plataforma-e-mcp-do-proprietario.md) A-19, ratificada pelo mantenedor em 2026-11-26): nada de endpoint, escopo de chave ou ferramenta de exclusão de conta, usuário ou membro, com ou sem opt-in. A exclusão continua só pelo console e pela "Zona de risco" do titular. O resto da SPEC 091 é proposta.

## Quotas de uso por trigger (referência)

Metadados do contador e do erro `QUOTA_EXCEEDED:<métrica>:<usado>:<limite>` em `src/lib/plans/errors.ts`. Quotas com trigger própria: `contacts` (067), `forms`, `form_responses_month` e `form_upload_mb` (098) e **`knowledge_documents`** (103, SPEC 089 D-20: documentos da base de conhecimento da IA; ausente = ilimitado; `AFTER INSERT OR DELETE` em `ai_knowledge_documents`, recontada por `recount_account_usage`) e **`ai_tool_calls_month`** (106, SPEC 089 F5: chamadas de ferramenta do agente no mês; contador `ai_tool_calls:YYYY-MM` em America/Sao_Paulo; decidida **dentro de `claim_ai_tool_call`**, que incrementa só se há vaga; ausente = ilimitado; não é recontada, como `form_responses_month`). Métrica nova de uso = trigger + `USAGE_QUOTA_KEYS` + `usedByKey` em `account-plan.ts` + rótulo `Plan.quotaLabel.*` nos dois dicionários.

## Exclusão da conta pelo titular (PRD 072 / SPEC 073)

Ordem canônica — **não troque**: guardas (papel `owner`, não ser a conta do proprietário, nome digitado idêntico, reautenticação) → leituras → `remove_account_member` por membro não-dono (client de **sessão**) → **`DELETE FROM accounts`** (uma instrução, sem retorno) → `auth.admin.deleteUser` do titular → Storage/VPS em melhor esforço → auditoria e evento. Após o `DELETE` o client de sessão está morto: o resto usa `supabaseAdmin()`. Sem carência nem desfazer ([SPEC 073](../spec-073-exclusao-da-conta-pelo-titular.md) §4, §7).

Excluir **usuário** (`auth.users`): `user_id ON DELETE CASCADE` já apagou 1.627 contatos de outra conta; a migração 088 reatribui as linhas ao dono da conta antes do delete.

## Armadilhas

- Conta nova sem plano: `handle_new_user` recriada de versão antiga.
- Uso diverge do `count(*)`: delete fora da trigger → `recount_account_usage`.

## Mais

[`../guia-console-do-proprietario.md`](../guia-console-do-proprietario.md) · [`../guia-operacao-planos-e-quotas.md`](../guia-operacao-planos-e-quotas.md) · [`catalogo-specs.md`](./catalogo-specs.md).
