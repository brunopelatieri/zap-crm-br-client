-- ============================================================
-- 091_default_privileges_closed.sql
--
-- Porte do Valen Ranch (migrações 091 e 092, SPEC 080 daquele
-- repositório). A 090 fechou as funções que já existem; esta fecha a
-- CAUSA. O Supabase deixa, no schema `public`, privilégios padrão para
-- tudo que o `postgres` cria:
--
--   função:    {postgres, anon, authenticated, service_role}
--   tabela:    anon=arwdDxtm, authenticated, service_role
--   sequência: anon=rwU, authenticated, service_role
--
-- É por isso que `REVOKE ALL ... FROM PUBLIC` (067 e várias outras) nunca
-- bastou: o grant a anon/authenticated é explícito e nasce junto com a
-- função. E toda tabela nova nasce aberta para anon, com só a RLS no
-- meio: uma migração que esqueça o `ENABLE ROW LEVEL SECURITY` abre
-- leitura e escrita para a internet.
--
-- O que muda
--
--   * Função criada por `postgres` em `public` DEPOIS desta migração
--     deixa de nascer com grant EXPLÍCITO para `anon` e `authenticated`;
--     o padrão passa a ser só `postgres` e `service_role`. Sobra o
--     EXECUTE implícito de PUBLIC (toda função nasce com ele), que a
--     convenção da casa fecha: `REVOKE ALL ON FUNCTION ... FROM PUBLIC`.
--     Antes da 091 essa convenção não bastava; agora basta. Quem precisa
--     de `authenticated` (RPC de sessão, função-predicado de RLS) escreve
--     o `GRANT EXECUTE ... TO authenticated` na própria migração.
--   * Tabela e sequência novas em `public` não dão mais nada a `anon`.
--     `authenticated` FICA: o modelo do Supabase é grant + RLS para quem
--     tem sessão. Tabela que precise de leitura sem login (um catálogo)
--     escreve `GRANT SELECT ... TO anon` na própria migração.
--
-- O que NÃO muda
--
--   * O que já existe: nada é revogado aqui. O grant de anon em `plans`
--     (o catálogo público) continua.
--   * `service_role` e `postgres` mantêm o padrão (o app usa
--     `supabaseAdmin()`).
--   * Privilégio padrão do `supabase_admin` em `public`: só esse papel
--     pode alterá-lo, e as migrações rodam como `postgres`. Funções
--     criadas por ele (extensões, internos do Supabase) ficam como estão.
--   * Padrão implícito de PUBLIC em função: REVOKE com `IN SCHEMA` não o
--     alcança. Fechar PUBLIC sem `IN SCHEMA` valeria para todos os
--     schemas do `postgres`, inclusive extensões instaladas depois
--     (pg_trgm, por exemplo), e foi descartado.
--
-- Atenção para migrações futuras: duas coisas podem ser esquecidas, e
-- elas não são simétricas.
--   * Esquecer o `REVOKE ALL ... FROM PUBLIC` deixa a função ABERTA para
--     anon e authenticated (via PUBLIC). Nada falha, nada avisa: só o
--     advisor de segurança (0028/0029) pega, depois de aplicado.
--   * Esquecer o `GRANT EXECUTE ... TO authenticated` (depois de fazer o
--     REVOKE de PUBLIC) em função usada em policy de RLS ou chamada pelo
--     browser dá 42501 para o usuário logado. Essa é a falha certa: fecha
--     e aparece no primeiro teste.
--
-- Precisa rodar como `postgres` (é o dono da entrada alterada); se rodar
-- com outro papel, a sonda denuncia e tudo reverte. Idempotente.
-- ============================================================

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE EXECUTE ON FUNCTIONS FROM anon;

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE EXECUTE ON FUNCTIONS FROM authenticated;

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE ALL ON TABLES FROM anon;

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE ALL ON SEQUENCES FROM anon;

-- ============================================================
-- Asserções finais — falham alto, no padrão da 042/082/084b/090.
-- ============================================================
DO $assert$
DECLARE
  v_grantees TEXT[];
  v_bad      TEXT;
BEGIN
  -- 1. Catálogo, funções: quem tem EXECUTE no padrão do postgres em
  --    public é exatamente {postgres, service_role}. Sobra anon ou
  --    authenticated → o ALTER não pegou; falta service_role → o servidor
  --    (supabaseAdmin) quebraria.
  SELECT array_agg(g ORDER BY g)
    INTO v_grantees
    FROM (
      SELECT DISTINCT
             CASE WHEN a.grantee = 0 THEN 'PUBLIC'::text
                  ELSE pg_get_userbyid(a.grantee)::text END AS g
        FROM pg_default_acl d
        CROSS JOIN LATERAL aclexplode(d.defaclacl) a
       WHERE pg_get_userbyid(d.defaclrole) = 'postgres'
         AND d.defaclnamespace = 'public'::regnamespace
         AND d.defaclobjtype = 'f'
         AND a.privilege_type = 'EXECUTE'
    ) s;

  IF v_grantees IS DISTINCT FROM ARRAY['postgres', 'service_role']::text[] THEN
    RAISE EXCEPTION '091: o padrao de funcoes em public deveria ser {postgres, service_role}, mas e {%}.',
      COALESCE(array_to_string(v_grantees, ', '), 'vazio')
      USING ERRCODE = '55006';
  END IF;

  -- 2. Catálogo, tabelas e sequências: padrão do postgres em public sem
  --    anon. `defaclobjtype` é "char": sem o ::text o `||` é ambíguo.
  SELECT string_agg(d.defaclobjtype::text || ':' || pg_get_userbyid(a.grantee), ', ')
    INTO v_bad
    FROM pg_default_acl d
    CROSS JOIN LATERAL aclexplode(d.defaclacl) a
   WHERE pg_get_userbyid(d.defaclrole) = 'postgres'
     AND d.defaclnamespace = 'public'::regnamespace
     AND d.defaclobjtype IN ('r', 'S')
     AND a.grantee = 'anon'::regrole;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION '091: padrao de tabela/sequencia em public ainda concede a anon (%).', v_bad
      USING ERRCODE = '55006';
  END IF;

  -- 3. Ponta a ponta, função. Sem o REVOKE de PUBLIC a sonda ainda seria
  --    executável por anon e authenticated, via PUBLIC e não via grant
  --    explícito, e é isso que a convenção da casa fecha. Então a sonda
  --    faz o que uma migração de verdade faz: cria, revoga de PUBLIC e só
  --    então confere que não sobra grant de anon/authenticated. Antes da
  --    091, este mesmo teste deixava os dois com EXECUTE (o bug da 067).
  CREATE FUNCTION public._091_probe() RETURNS INTEGER
    LANGUAGE sql AS 'SELECT 1';

  REVOKE ALL ON FUNCTION public._091_probe() FROM PUBLIC;

  IF has_function_privilege('anon', 'public._091_probe()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public._091_probe()', 'EXECUTE') THEN
    RAISE EXCEPTION '091: funcao nova em public ainda herda EXECUTE explicito de anon/authenticated.'
      USING ERRCODE = '55006';
  END IF;
  IF NOT has_function_privilege('service_role', 'public._091_probe()', 'EXECUTE') THEN
    RAISE EXCEPTION '091: funcao nova em public nasce sem EXECUTE para service_role.'
      USING ERRCODE = '55006';
  END IF;

  DROP FUNCTION public._091_probe();

  -- 4. Ponta a ponta, tabela: nasce sem anon e com authenticated e
  --    service_role (PUBLIC não tem padrão implícito em tabela, então
  --    aqui não há a ressalva da sonda de função).
  CREATE TABLE public._091_probe_table (id INTEGER);

  IF has_table_privilege('anon', 'public._091_probe_table', 'SELECT')
     OR has_table_privilege('anon', 'public._091_probe_table', 'INSERT') THEN
    RAISE EXCEPTION '091: tabela nova em public ainda nasce acessivel por anon.'
      USING ERRCODE = '55006';
  END IF;
  IF NOT has_table_privilege('authenticated', 'public._091_probe_table', 'SELECT')
     OR NOT has_table_privilege('service_role', 'public._091_probe_table', 'SELECT') THEN
    RAISE EXCEPTION '091: tabela nova em public perdeu o padrao de authenticated/service_role.'
      USING ERRCODE = '55006';
  END IF;

  DROP TABLE public._091_probe_table;

  RAISE NOTICE '091: funcoes novas em public sem grant explicito de anon/authenticated (REVOKE FROM PUBLIC agora basta); tabelas e sequencias novas sem anon; service_role preservado.';
END $assert$;
