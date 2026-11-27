---
paths:
  - 'supabase/**'
  - 'src/lib/supabase/**'
  - 'scripts/verify-*.sql'
---

# Supabase, RLS, migrações e MCP

- Cliente certo: `client.ts` (browser) e `server.ts` (cookies) sofrem RLS; `admin.ts` é service role, só no servidor com autorização já validada, nunca no browser.
- MCP: o único projeto é o `vn`. Confirme antes de migração, DML, DDL, deploy de função ou branch e rode `get_project_url` antes de ler ou escrever. Nunca outro conector Supabase.
- Próximo número de migração: `ls supabase/migrations/` (fato vivo em `status.md`).
- Função nova em `public`: `REVOKE ALL … FROM PUBLIC` **e** `FROM anon` (+ `FROM authenticated` se for interna); `GRANT EXECUTE … TO authenticated` só se a sessão chama. `SECURITY DEFINER` fixa `search_path` e valida conta no corpo.
- Policy com `is_account_member` / `can_*` vai `TO authenticated`: a 090 revoga esses predicados de `anon`, e policy `PUBLIC` que os chame dá `42501` em leitura anônima. Tabela nova não dá nada a `anon` depois da 091 (leitura sem login: `GRANT SELECT … TO anon`). Confira a ACL no `vn`.
- Coluna cifrada/secreta (token, chave, secret): `REVOKE SELECT` de tabela + `GRANT SELECT` por coluna sem ela para `authenticated`; leitura só por `supabaseAdmin()` com `account_id` validado; migração depois do código em produção (111, 112).
- Depois de DDL, `get_advisors` (security) no `vn`.
- URL ou segredo do deploy vai em `supabase/setup/`, nunca em migração. Regra de escopo ou quota mora em RLS/trigger, não só na rota.

Detalhe: leia `docs/context/supabase-rls-mcp.md`. Procedimento: skill `nova-migracao-supabase`.
