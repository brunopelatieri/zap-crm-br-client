---
name: nova-migracao-supabase
description: Criar migração Supabase, nova função SQL/RPC, SECURITY DEFINER, policy RLS, REVOKE/GRANT ou aplicar SQL no banco. Use ao pedir criar migração ou mexer no schema do banco.
---

# Nova migração Supabase

## Quando usar

Ao criar ou alterar migração em `supabase/migrations/`, função/RPC, trigger ou policy RLS, e ao aplicar SQL num projeto Supabase pelo MCP.

## Como funciona

1. **Número.** `ls supabase/migrations/` (a última linha é o `README.md`); o próximo livre está em `docs/context/status.md` — confira, outra sessão pode ter pego. Lacunas e sufixos: `supabase/migrations/README.md`. Nome: `NNN_descricao_curta.sql`.
2. **Função nova em `public`.** O Supabase concede `EXECUTE` nominalmente a `anon` e `authenticated`; `REVOKE … FROM PUBLIC` sozinho não fecha. Sempre dois comandos separados:

   ```sql
   REVOKE ALL ON FUNCTION public.minha_funcao(UUID) FROM PUBLIC;
   REVOKE ALL ON FUNCTION public.minha_funcao(UUID) FROM anon;
   -- interna (trigger, helper só de servidor): revogue também FROM authenticated
   -- chamada pela sessão do usuário (RPC da rota ou do browser):
   GRANT EXECUTE ON FUNCTION public.minha_funcao(UUID) TO authenticated, service_role;
   ```

   `SECURITY DEFINER`: fixe `SET search_path = public` e valide conta/papel no corpo.

3. **Policy.** Escreva `TO authenticated`, com `is_account_member(...)` ou `can_*`: a 090 revoga esses predicados de `anon`, e policy `PUBLIC` que os chame dá `42501` em leitura anônima. Tabela nova não dá nada a `anon` depois da 091; leitura sem login exige `GRANT SELECT … TO anon`. Antes de afirmar algo sobre a ACL, consulte no `vn`: `SELECT has_function_privilege('anon', 'public.is_account_member(uuid, account_role_enum)', 'EXECUTE');`.
4. **Quota e escopo** moram em RLS/trigger — o browser grava direto no banco; guarda só na rota é contornável.
5. **URL ou segredo do deploy** (agendamento de cron, catálogo comercial) **não é migração**: vai em `supabase/setup/`. Senão todo fork herda chamadas e dados do seu deploy.
6. **Antes de aplicar:** mostre o SQL e espere a confirmação. Rode `get_project_url` e confira que é o `vn`. Nunca outro conector Supabase.
7. **Aplicar** com `apply_migration` do MCP `vn`, só após o OK.
8. **Depois:** `get_advisors` (tipo `security`) **no mesmo projeto** e trate o que for novo; atualize `docs/context/status.md` (valor e data) e, se mudou tabela, `src/types/index.ts`.

Modelos para **ler**, não copiar:

- `supabase/migrations/044_messaging_limit_and_quota.sql` L128–144 — o comentário que explica a armadilha + `REVOKE`/`GRANT` de função chamada pela sessão.
- `supabase/migrations/084b_tighten_activity_function_grants.sql` L35–37 — função de trigger revogando `PUBLIC`, `anon` e `authenticated`.

Detalhe completo: `docs/context/supabase-rls-mcp.md`.

## Exemplos

- "Crie uma RPC que a rota chama como o usuário" → passos 1–3 com o `GRANT … TO authenticated, service_role`, corpo validando `is_account_member`.
- "Trigger que grava log" → função interna: os três `REVOKE` (`PUBLIC`, `anon`, `authenticated`) e nenhum `GRANT`.
- "Agende este cron" → arquivo em `supabase/setup/`, não migração; o operador edita URL/segredo e não commita os valores.
