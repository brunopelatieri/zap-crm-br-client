-- verify-111-ai-configs-secret-columns.sql — conferência do P-14 da SPEC 089. NÃO é migração.
--
-- Para o SQL Editor do `vn`. Rode DEPOIS de aplicar
-- `supabase/migrations/111_ai_configs_secret_columns.sql`. Uma consulta só.
-- Roda os testes DENTRO de um bloco que sempre termina em RAISE EXCEPTION: o
-- Postgres desfaz tudo (linhas de teste em ai_configs e a troca temporária de
-- papel do admin para viewer). O relatório vem na mensagem do erro, que começa
-- com `P14_TESTE_REVERTIDO`; cada linha começa com `ok`, `FALHA` ou `info`, e
-- a última diz quantas falharam. Depois, confira que
--   select count(*) from ai_configs where model like 'zz-111-%'
-- é 0 e que o papel do admin usado não mudou (a troca some no rollback).
--
-- Usa uma conta A com um admin (não owner; se só houver owner, usa o owner) e
-- uma segunda conta B da qual esse usuário NÃO é membro. Se uma das contas
-- não tiver linha em ai_configs, o teste cria uma de teste (some no rollback);
-- se tiver, troca as duas colunas cifradas por valores de teste (também some).
-- NENHUM valor de chave real é lido nem impresso: o relatório só diz
-- "legível" ou "negado".
--
-- Cobre: privilégios no catálogo (anon sem nada nas 4 tabelas antigas de IA;
-- authenticated sem as duas colunas cifradas e com as demais; service_role
-- com tudo; escrita de admin+ preservada), leitura simulando o papel
-- `authenticated` como admin e como viewer (colunas comuns sim; `api_key`,
-- `embeddings_api_key` e `select *` com 42501), escrita do admin (UPDATE e
-- RETURNING comuns, troca de chave) e do viewer (barrado pela RLS), o papel
-- `anon` (42501), o isolamento entre contas (a linha da B nunca aparece para
-- o admin da A) e o service_role lendo as colunas cifradas.

DO $$
DECLARE
  v_a       UUID;
  v_u       UUID;
  v_role    TEXT;
  v_b       UUID;
  v_n       BIGINT;
  v_rows    INT;
  v_txt     TEXT;
  v_hit     BOOLEAN;
  v_r       TEXT := '';
  v_fail    INT;
  v_viewer  BOOLEAN := FALSE;
BEGIN
  -- ---------- Dados ----------
  SELECT p.account_id, p.user_id, p.account_role::text INTO v_a, v_u, v_role
    FROM profiles p
   WHERE p.account_role IN ('admin', 'owner') AND p.blocked_at IS NULL
   ORDER BY (p.account_role = 'admin') DESC, p.user_id LIMIT 1;
  IF v_a IS NULL THEN
    RAISE EXCEPTION 'P14_TESTE_ABORTADO precisa de uma conta com um admin/owner';
  END IF;
  SELECT a.id INTO v_b
    FROM accounts a
   WHERE a.id <> v_a
     AND NOT EXISTS (SELECT 1 FROM profiles p WHERE p.account_id = a.id AND p.user_id = v_u)
   ORDER BY a.id LIMIT 1;
  IF v_b IS NULL THEN
    RAISE EXCEPTION 'P14_TESTE_ABORTADO precisa de uma segunda conta da qual o admin nao e membro';
  END IF;

  -- Linhas de teste (como o papel da sessão do SQL Editor; some no rollback).
  IF EXISTS (SELECT 1 FROM ai_configs WHERE account_id = v_a) THEN
    UPDATE ai_configs
       SET api_key = 'zz-111-cipher-a', embeddings_api_key = 'zz-111-emb-a'
     WHERE account_id = v_a;
  ELSE
    INSERT INTO ai_configs (account_id, provider, model, api_key, embeddings_api_key)
    VALUES (v_a, 'openai', 'zz-111-a', 'zz-111-cipher-a', 'zz-111-emb-a');
  END IF;
  IF EXISTS (SELECT 1 FROM ai_configs WHERE account_id = v_b) THEN
    UPDATE ai_configs
       SET api_key = 'zz-111-cipher-b', embeddings_api_key = 'zz-111-emb-b'
     WHERE account_id = v_b;
  ELSE
    INSERT INTO ai_configs (account_id, provider, model, api_key, embeddings_api_key)
    VALUES (v_b, 'openai', 'zz-111-b', 'zz-111-cipher-b', 'zz-111-emb-b');
  END IF;

  v_r := v_r || 'info 0. admin usado tem papel ' || v_role || E' na conta A\n';

  -- ---------- 1) privilégios no catálogo ----------
  v_r := v_r || CASE WHEN NOT has_any_column_privilege('anon', 'public.ai_configs', 'SELECT, INSERT, UPDATE, REFERENCES')
                      AND NOT has_table_privilege('anon', 'public.ai_configs', 'DELETE')
                      AND NOT has_any_column_privilege('anon', 'public.ai_knowledge_documents', 'SELECT, INSERT, UPDATE, REFERENCES')
                      AND NOT has_any_column_privilege('anon', 'public.ai_knowledge_chunks', 'SELECT, INSERT, UPDATE, REFERENCES')
                      AND NOT has_any_column_privilege('anon', 'public.ai_usage_log', 'SELECT, INSERT, UPDATE, REFERENCES')
                 THEN 'ok   ' ELSE 'FALHA' END
        || ' 1a. anon sem privilegio nas 4 tabelas antigas de IA' || E'\n';
  v_r := v_r || CASE WHEN NOT has_table_privilege('authenticated', 'public.ai_configs', 'SELECT')
                      AND NOT has_column_privilege('authenticated', 'public.ai_configs', 'api_key', 'SELECT')
                      AND NOT has_column_privilege('authenticated', 'public.ai_configs', 'embeddings_api_key', 'SELECT')
                 THEN 'ok   ' ELSE 'FALHA' END
        || ' 1b. authenticated: sem SELECT de tabela e sem as colunas api_key e embeddings_api_key' || E'\n';
  v_r := v_r || CASE WHEN NOT EXISTS (
                            SELECT 1 FROM pg_attribute a
                             WHERE a.attrelid = 'public.ai_configs'::regclass AND a.attnum > 0
                               AND NOT a.attisdropped
                               AND a.attname NOT IN ('api_key', 'embeddings_api_key')
                               AND NOT has_column_privilege('authenticated', 'public.ai_configs', a.attname, 'SELECT'))
                 THEN 'ok   ' ELSE 'FALHA' END
        || ' 1c. authenticated le todas as outras colunas (a tela de Configuracao segue inteira)' || E'\n';
  v_r := v_r || CASE WHEN has_table_privilege('authenticated', 'public.ai_configs', 'INSERT')
                      AND has_table_privilege('authenticated', 'public.ai_configs', 'UPDATE')
                      AND has_table_privilege('authenticated', 'public.ai_configs', 'DELETE')
                 THEN 'ok   ' ELSE 'FALHA' END
        || ' 1d. authenticated mantem INSERT/UPDATE/DELETE (a RLS de admin+ decide)' || E'\n';
  v_r := v_r || CASE WHEN has_column_privilege('service_role', 'public.ai_configs', 'api_key', 'SELECT')
                      AND has_column_privilege('service_role', 'public.ai_configs', 'embeddings_api_key', 'SELECT')
                      AND has_table_privilege('service_role', 'public.ai_configs', 'UPDATE')
                 THEN 'ok   ' ELSE 'FALHA' END
        || ' 1e. service_role le as colunas cifradas e escreve (o servidor depende disso)' || E'\n';
  v_r := v_r || CASE WHEN EXISTS (SELECT 1 FROM pg_policies
                                   WHERE schemaname = 'public' AND tablename = 'ai_configs'
                                     AND cmd = 'SELECT')
                      AND (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.ai_configs'::regclass)
                 THEN 'ok   ' ELSE 'FALHA' END
        || ' 1f. RLS de ai_configs ligada, com policy de SELECT (a 111 nao mexe nela)' || E'\n';

  -- ---------- 2) admin (authenticated) da conta A ----------
  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claims',
                     json_build_object('role', 'authenticated', 'sub', v_u)::text, true);

  SELECT count(*) INTO v_n FROM ai_configs WHERE account_id = v_a;
  v_r := v_r || CASE WHEN v_n = 1 THEN 'ok   ' ELSE 'FALHA' END
        || ' 2a. admin le a linha da propria conta pelas colunas comuns (' || v_n || ' linha)' || E'\n';

  SELECT count(*) INTO v_n FROM ai_configs WHERE account_id = v_b;
  v_r := v_r || CASE WHEN v_n = 0 THEN 'ok   ' ELSE 'FALHA' END
        || ' 2b. admin da A nao ve a linha da conta B (' || v_n || ' linhas)' || E'\n';

  v_hit := FALSE;
  BEGIN
    SELECT api_key INTO v_txt FROM ai_configs WHERE account_id = v_a;
    v_hit := TRUE;
  EXCEPTION WHEN insufficient_privilege THEN
    v_hit := FALSE;
  END;
  v_r := v_r || CASE WHEN NOT v_hit THEN 'ok   ' ELSE 'FALHA' END
        || ' 2c. admin: SELECT api_key negado (42501)' || E'\n';

  v_hit := FALSE;
  BEGIN
    SELECT embeddings_api_key INTO v_txt FROM ai_configs WHERE account_id = v_a;
    v_hit := TRUE;
  EXCEPTION WHEN insufficient_privilege THEN
    v_hit := FALSE;
  END;
  v_r := v_r || CASE WHEN NOT v_hit THEN 'ok   ' ELSE 'FALHA' END
        || ' 2d. admin: SELECT embeddings_api_key negado (42501)' || E'\n';

  v_hit := FALSE;
  BEGIN
    PERFORM * FROM ai_configs WHERE account_id = v_a;
    v_hit := TRUE;
  EXCEPTION WHEN insufficient_privilege THEN
    v_hit := FALSE;
  END;
  v_r := v_r || CASE WHEN NOT v_hit THEN 'ok   ' ELSE 'FALHA' END
        || ' 2e. admin: SELECT * negado (quem quiser a linha toda tem de listar as colunas)' || E'\n';

  v_hit := FALSE;
  BEGIN
    -- o truque de filtro/ordenação tampouco vaza: a coluna não pode nem ser referenciada
    PERFORM 1 FROM ai_configs WHERE account_id = v_a AND api_key IS NOT NULL;
    v_hit := TRUE;
  EXCEPTION WHEN insufficient_privilege THEN
    v_hit := FALSE;
  END;
  v_r := v_r || CASE WHEN NOT v_hit THEN 'ok   ' ELSE 'FALHA' END
        || ' 2f. admin: nem WHERE api_key IS NOT NULL (sem oraculo de presenca pelo JWT)' || E'\n';

  -- Escrita comum do admin: UPDATE + RETURNING de colunas permitidas.
  v_hit := FALSE;
  BEGIN
    UPDATE ai_configs SET system_prompt = 'zz-111-prompt' WHERE account_id = v_a RETURNING id INTO v_txt;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    v_hit := (v_rows = 1 AND v_txt IS NOT NULL);
  EXCEPTION WHEN insufficient_privilege THEN
    v_hit := FALSE;
  END;
  v_r := v_r || CASE WHEN v_hit THEN 'ok   ' ELSE 'FALHA' END
        || ' 2g. admin: UPDATE system_prompt ... RETURNING id funciona (rotas de config e de tools)' || E'\n';

  -- Gravar uma chave nova continua possível (a rota POST /api/ai/config).
  v_hit := FALSE;
  BEGIN
    UPDATE ai_configs SET api_key = 'zz-111-novo' WHERE account_id = v_a;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    v_hit := (v_rows = 1);
  EXCEPTION WHEN insufficient_privilege THEN
    v_hit := FALSE;
  END;
  v_r := v_r || CASE WHEN v_hit THEN 'ok   ' ELSE 'FALHA' END
        || ' 2h. admin: UPDATE api_key (gravar chave nova) continua funcionando' || E'\n';

  -- Conta alheia: UPDATE não acha a linha (RLS).
  UPDATE ai_configs SET system_prompt = 'zz-111-invasor' WHERE account_id = v_b;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  v_r := v_r || CASE WHEN v_rows = 0 THEN 'ok   ' ELSE 'FALHA' END
        || ' 2i. admin da A nao atualiza a linha da B (' || v_rows || ' linhas)' || E'\n';
  RESET ROLE;

  -- ---------- 3) viewer da conta A (papel trocado, desfeito no rollback) ----------
  BEGIN
    UPDATE profiles SET account_role = 'viewer' WHERE user_id = v_u AND account_id = v_a;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    v_viewer := (v_rows = 1);
  EXCEPTION WHEN OTHERS THEN
    v_viewer := FALSE;
    v_r := v_r || 'info 3. nao foi possivel rebaixar o usuario a viewer (' || SQLSTATE || '); itens 3a-3d nao rodaram' || E'\n';
  END;

  IF v_viewer THEN
    SET LOCAL ROLE authenticated;
    PERFORM set_config('request.jwt.claims',
                       json_build_object('role', 'authenticated', 'sub', v_u)::text, true);

    SELECT count(*) INTO v_n FROM ai_configs WHERE account_id = v_a;
    v_r := v_r || CASE WHEN v_n = 1 THEN 'ok   ' ELSE 'FALHA' END
          || ' 3a. viewer le a linha da propria conta pelas colunas comuns (a tela segue funcionando)' || E'\n';

    v_hit := FALSE;
    BEGIN
      SELECT api_key INTO v_txt FROM ai_configs WHERE account_id = v_a;
      v_hit := TRUE;
    EXCEPTION WHEN insufficient_privilege THEN
      v_hit := FALSE;
    END;
    v_r := v_r || CASE WHEN NOT v_hit THEN 'ok   ' ELSE 'FALHA' END
          || ' 3b. viewer: SELECT api_key negado (42501)' || E'\n';

    v_hit := FALSE;
    BEGIN
      SELECT embeddings_api_key INTO v_txt FROM ai_configs WHERE account_id = v_a;
      v_hit := TRUE;
    EXCEPTION WHEN insufficient_privilege THEN
      v_hit := FALSE;
    END;
    v_r := v_r || CASE WHEN NOT v_hit THEN 'ok   ' ELSE 'FALHA' END
          || ' 3c. viewer: SELECT embeddings_api_key negado (42501)' || E'\n';

    UPDATE ai_configs SET system_prompt = 'zz-111-viewer' WHERE account_id = v_a;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    v_r := v_r || CASE WHEN v_rows = 0 THEN 'ok   ' ELSE 'FALHA' END
          || ' 3d. viewer nao escreve em ai_configs (RLS de admin+, ' || v_rows || ' linhas)' || E'\n';
    RESET ROLE;
  END IF;

  -- ---------- 4) anon ----------
  v_hit := FALSE;
  BEGIN
    SET LOCAL ROLE anon;
    PERFORM id FROM ai_configs;
    v_hit := TRUE;
  EXCEPTION WHEN insufficient_privilege THEN
    v_hit := FALSE;
  END;
  RESET ROLE;
  v_r := v_r || CASE WHEN NOT v_hit THEN 'ok   ' ELSE 'FALHA' END
        || ' 4a. anon: SELECT em ai_configs negado (42501, ja na tabela, nao so na policy)' || E'\n';

  v_hit := FALSE;
  BEGIN
    SET LOCAL ROLE anon;
    INSERT INTO ai_configs (account_id, provider, model, api_key)
    VALUES (v_a, 'openai', 'zz-111-anon', 'zz-111-anon');
    v_hit := TRUE;
  EXCEPTION WHEN insufficient_privilege OR unique_violation THEN
    v_hit := FALSE;
  END;
  RESET ROLE;
  v_r := v_r || CASE WHEN NOT v_hit THEN 'ok   ' ELSE 'FALHA' END
        || ' 4b. anon: INSERT em ai_configs negado' || E'\n';

  -- ---------- 5) service_role ----------
  SET LOCAL ROLE service_role;
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);

  v_hit := FALSE;
  BEGIN
    SELECT (api_key = 'zz-111-novo'), embeddings_api_key
      INTO v_hit, v_txt
      FROM ai_configs WHERE account_id = v_a;
  EXCEPTION WHEN insufficient_privilege THEN
    v_hit := FALSE;
  END;
  v_r := v_r || CASE WHEN v_hit AND v_txt = 'zz-111-emb-a' THEN 'ok   ' ELSE 'FALHA' END
        || ' 5a. service_role le api_key e embeddings_api_key da conta A (o que o servidor decifra)' || E'\n';

  SELECT count(*) INTO v_n FROM ai_configs WHERE account_id IN (v_a, v_b);
  v_r := v_r || CASE WHEN v_n = 2 THEN 'ok   ' ELSE 'FALHA' END
        || ' 5b. service_role enxerga as duas contas (por isso o codigo SEMPRE filtra por account_id)' || E'\n';
  RESET ROLE;

  v_fail := (length(v_r) - length(replace(v_r, 'FALHA', ''))) / 5;
  RAISE EXCEPTION E'P14_TESTE_REVERTIDO\n%\nFalhas: %', v_r, v_fail;
END;
$$;
