-- verify-107-ai-custom-tools.sql — conferência da F6 da SPEC 089. NÃO é migração.
--
-- Para o SQL Editor (ou MCP) do projeto confirmado: o `vn`. Rode DEPOIS de
-- aplicar `supabase/migrations/107_ai_custom_tools.sql`. Uma consulta só.
-- Roda os testes DENTRO de um bloco que sempre termina em RAISE EXCEPTION: o
-- Postgres desfaz tudo (linhas inseridas, troca de papel). O relatório vem na
-- mensagem do erro, que começa com `F6_TESTE_REVERTIDO`; cada linha começa
-- com `ok` ou `FALHA`, e a última diz quantas falharam. Depois de rodar,
-- confira que
--   select count(*) from ai_custom_tools where name like 'zz_f6_%'
-- é 0.
--
-- Usa uma conta existente (A) com um admin/owner e uma segunda conta (B) da
-- qual esse admin NÃO é membro.
--
-- Cobre: privilégios (anon sem acesso; authenticated lê só as colunas SEM
-- segredo e não escreve; service_role faz tudo; as duas funções internas sem
-- EXECUTE para anon/PUBLIC/authenticated), RLS (admin da conta lê as linhas
-- dela e não as da B), `headers_encrypted` ilegível para o navegador, CHECKs
-- (https, nome, timeout, método, risco, formato GCM do cabeçalho cifrado,
-- nomes consistentes), nome único por conta, teto de 20 por conta, nasce
-- desligada e `write`, `updated_at`, e CASCADE com a conta.

DO $$
DECLARE
  v_a      UUID;
  v_b      UUID;
  v_u      UUID;
  v_agent  UUID;
  v_id_a   UUID;
  v_id_b   UUID;
  v_n      BIGINT;
  v_txt    TEXT;
  v_ts     TIMESTAMPTZ;
  v_row    RECORD;
  v_cipher TEXT := repeat('ab', 12) || ':' || repeat('cd', 20) || ':' || repeat('ef', 16);
  v_fn1    TEXT := 'public.enforce_ai_custom_tool_limit()';
  v_fn2    TEXT := 'public.update_ai_custom_tools_updated_at()';
  v_cols   TEXT := 'id, account_id, name, description, input_schema, url, method, risk, header_names, timeout_ms, is_active, created_by, created_at, updated_at';
  v_r      TEXT := '';
  v_fail   INT;
BEGIN
  -- ---------- Dados ----------
  SELECT p.account_id, p.user_id INTO v_a, v_u
    FROM profiles p
   WHERE p.account_role IN ('owner', 'admin') AND p.blocked_at IS NULL
   ORDER BY p.created_at DESC NULLS LAST LIMIT 1;
  IF v_a IS NULL THEN
    RAISE EXCEPTION 'F6_TESTE_ABORTADO precisa de uma conta com um admin/owner';
  END IF;
  SELECT a.id INTO v_b
    FROM accounts a
   WHERE a.id <> v_a
     AND NOT EXISTS (SELECT 1 FROM profiles p WHERE p.account_id = a.id AND p.user_id = v_u)
   ORDER BY a.id LIMIT 1;
  IF v_b IS NULL THEN
    RAISE EXCEPTION 'F6_TESTE_ABORTADO precisa de uma segunda conta da qual o admin nao e membro';
  END IF;
  SELECT p.user_id INTO v_agent
    FROM profiles p
   WHERE p.account_id = v_a AND p.account_role = 'agent' AND p.blocked_at IS NULL
   LIMIT 1;

  -- ---------- 1) privilégios e estrutura ----------
  v_r := v_r || CASE WHEN (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.ai_custom_tools'::regclass)
                 THEN 'ok   ' ELSE 'FALHA' END || ' 1a. RLS ligada em ai_custom_tools' || E'\n';
  v_r := v_r || CASE WHEN NOT has_table_privilege('anon', 'public.ai_custom_tools', 'SELECT')
                      AND NOT has_table_privilege('anon', 'public.ai_custom_tools', 'INSERT')
                      AND NOT has_table_privilege('anon', 'public.ai_custom_tools', 'UPDATE')
                      AND NOT has_table_privilege('anon', 'public.ai_custom_tools', 'DELETE')
                      AND NOT has_column_privilege('anon', 'public.ai_custom_tools', 'name', 'SELECT')
                 THEN 'ok   ' ELSE 'FALHA' END || ' 1b. anon sem nenhum acesso' || E'\n';
  v_r := v_r || CASE WHEN has_column_privilege('authenticated', 'public.ai_custom_tools', 'name', 'SELECT')
                      AND has_column_privilege('authenticated', 'public.ai_custom_tools', 'url', 'SELECT')
                      AND NOT has_column_privilege('authenticated', 'public.ai_custom_tools', 'headers_encrypted', 'SELECT')
                      AND NOT has_table_privilege('authenticated', 'public.ai_custom_tools', 'INSERT')
                      AND NOT has_table_privilege('authenticated', 'public.ai_custom_tools', 'UPDATE')
                      AND NOT has_table_privilege('authenticated', 'public.ai_custom_tools', 'DELETE')
                 THEN 'ok   ' ELSE 'FALHA' END
        || ' 1c. authenticated: SELECT so nas colunas sem segredo (headers_encrypted ilegivel), sem escrita' || E'\n';
  v_r := v_r || CASE WHEN has_column_privilege('service_role', 'public.ai_custom_tools', 'headers_encrypted', 'SELECT')
                      AND has_table_privilege('service_role', 'public.ai_custom_tools', 'INSERT')
                      AND has_table_privilege('service_role', 'public.ai_custom_tools', 'UPDATE')
                      AND has_table_privilege('service_role', 'public.ai_custom_tools', 'DELETE')
                 THEN 'ok   ' ELSE 'FALHA' END || ' 1d. service_role le e escreve (le o cabecalho cifrado so na hora da chamada)' || E'\n';
  v_r := v_r || CASE WHEN NOT has_function_privilege('anon', v_fn1, 'EXECUTE')
                      AND NOT has_function_privilege('public', v_fn1, 'EXECUTE')
                      AND NOT has_function_privilege('authenticated', v_fn1, 'EXECUTE')
                      AND NOT has_function_privilege('anon', v_fn2, 'EXECUTE')
                      AND NOT has_function_privilege('public', v_fn2, 'EXECUTE')
                      AND NOT has_function_privilege('authenticated', v_fn2, 'EXECUTE')
                 THEN 'ok   ' ELSE 'FALHA' END || ' 1e. as duas funcoes de trigger: sem EXECUTE para anon/PUBLIC/authenticated' || E'\n';
  v_r := v_r || CASE WHEN EXISTS (SELECT 1 FROM pg_constraint
                                   WHERE conrelid = 'public.ai_custom_tools'::regclass
                                     AND contype = 'f' AND confrelid = 'public.accounts'::regclass
                                     AND confdeltype = 'c')
                 THEN 'ok   ' ELSE 'FALHA' END || ' 1f. a conta apagada leva as ferramentas junto (FK ON DELETE CASCADE)' || E'\n';
  v_r := v_r || CASE WHEN EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.ai_custom_tools'::regclass
                                     AND tgname = 'enforce_ai_custom_tool_limit_trigger' AND NOT tgisinternal)
                      AND EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.ai_custom_tools'::regclass
                                     AND tgname = 'ai_custom_tools_updated_at' AND NOT tgisinternal)
                 THEN 'ok   ' ELSE 'FALHA' END || ' 1g. triggers do teto e de updated_at presentes' || E'\n';
  -- Nada em texto claro: todo valor existente tem o formato GCM (o CHECK garante).
  SELECT count(*) INTO v_n FROM public.ai_custom_tools
   WHERE headers_encrypted IS NOT NULL
     AND (headers_encrypted !~ '^[0-9a-f]{24}:[0-9a-f]+:[0-9a-f]{32}$'
          OR headers_encrypted ILIKE '%bearer%' OR headers_encrypted ILIKE '%authorization%');
  v_r := v_r || CASE WHEN v_n = 0 THEN 'ok   ' ELSE 'FALHA' END
        || format(' 1h. cabecalhos guardados ilegiveis sem a chave (formato iv:cifra:tag, sem texto claro): %s fora do padrao (esperado 0)', v_n) || E'\n';

  -- ---------- 2) service_role: CHECKs, padrões, unicidade ----------
  SET LOCAL ROLE service_role;
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);

  INSERT INTO ai_custom_tools (account_id, name, description, url, headers_encrypted, header_names)
  VALUES (v_a, 'zz_f6_stock', 'Check the stock of a product.', 'https://api.example.test/v1/stock', v_cipher, ARRAY['Authorization'])
  RETURNING id INTO v_id_a;
  SELECT is_active, risk, method, timeout_ms, created_at, updated_at INTO v_row FROM ai_custom_tools WHERE id = v_id_a;
  v_r := v_r || CASE WHEN v_row.is_active = FALSE AND v_row.risk = 'write' AND v_row.method = 'POST' AND v_row.timeout_ms = 8000
                 THEN 'ok   ' ELSE 'FALHA' END || ' 2a. nasce DESLIGADA, risco write, POST, timeout 8000' || E'\n';

  INSERT INTO ai_custom_tools (account_id, name, description, url)
  VALUES (v_b, 'zz_f6_other', 'The other account tool.', 'https://api.example.test/v1/other')
  RETURNING id INTO v_id_b;
  -- O mesmo nome em OUTRA conta é permitido; na mesma conta não.
  BEGIN
    INSERT INTO ai_custom_tools (account_id, name, description, url)
    VALUES (v_b, 'zz_f6_stock', 'Same name, other account.', 'https://api.example.test/v1/x');
    v_r := v_r || 'ok    2b. o mesmo nome em outra conta e permitido' || E'\n';
  EXCEPTION WHEN unique_violation THEN
    v_r := v_r || 'FALHA 2b. nome repetido recusado entre contas diferentes' || E'\n';
  END;
  BEGIN
    INSERT INTO ai_custom_tools (account_id, name, description, url)
    VALUES (v_a, 'zz_f6_stock', 'Duplicate name.', 'https://api.example.test/v1/x');
    v_r := v_r || 'FALHA 2c. nome repetido na MESMA conta foi aceito' || E'\n';
  EXCEPTION WHEN unique_violation THEN
    v_r := v_r || 'ok    2c. nome unico por conta' || E'\n';
  END;

  -- Cada um dos CHECKs recusa um valor ruim.
  PERFORM 1;
  FOR v_row IN
    SELECT * FROM (VALUES
      ('3a url http (texto claro)',        $q$INSERT INTO ai_custom_tools (account_id, name, description, url) VALUES ('%s', 'zz_f6_bad1', 'Valid description.', 'http://api.example.test/x')$q$),
      ('3b nome com maiuscula',            $q$INSERT INTO ai_custom_tools (account_id, name, description, url) VALUES ('%s', 'Zz_F6_Bad', 'Valid description.', 'https://api.example.test/x')$q$),
      ('3c nome curto',                    $q$INSERT INTO ai_custom_tools (account_id, name, description, url) VALUES ('%s', 'ab', 'Valid description.', 'https://api.example.test/x')$q$),
      ('3d timeout acima de 10 s',         $q$INSERT INTO ai_custom_tools (account_id, name, description, url, timeout_ms) VALUES ('%s', 'zz_f6_bad4', 'Valid description.', 'https://api.example.test/x', 30000)$q$),
      ('3e metodo DELETE',                 $q$INSERT INTO ai_custom_tools (account_id, name, description, url, method) VALUES ('%s', 'zz_f6_bad5', 'Valid description.', 'https://api.example.test/x', 'DELETE')$q$),
      ('3f risco invalido',                $q$INSERT INTO ai_custom_tools (account_id, name, description, url, risk) VALUES ('%s', 'zz_f6_bad6', 'Valid description.', 'https://api.example.test/x', 'danger')$q$),
      ('3g cabecalho em TEXTO CLARO',      $q$INSERT INTO ai_custom_tools (account_id, name, description, url, headers_encrypted, header_names) VALUES ('%s', 'zz_f6_bad7', 'Valid description.', 'https://api.example.test/x', 'Bearer sk_live_plain', ARRAY['Authorization'])$q$),
      ('3h cifra sem nomes (inconsistente)', $q$INSERT INTO ai_custom_tools (account_id, name, description, url, headers_encrypted) VALUES ('%s', 'zz_f6_bad8', 'Valid description.', 'https://api.example.test/x', repeat('ab',12)||':'||repeat('cd',20)||':'||repeat('ef',16))$q$),
      ('3i descricao curta',               $q$INSERT INTO ai_custom_tools (account_id, name, description, url) VALUES ('%s', 'zz_f6_bad9', 'short', 'https://api.example.test/x')$q$),
      ('3j esquema que nao e objeto',      $q$INSERT INTO ai_custom_tools (account_id, name, description, url, input_schema) VALUES ('%s', 'zz_f6_bad10', 'Valid description.', 'https://api.example.test/x', '[]'::jsonb)$q$)
    ) AS t(label, sql)
  LOOP
    BEGIN
      EXECUTE format(v_row.sql, v_a);
      v_r := v_r || 'FALHA ' || v_row.label || ': foi aceito' || E'\n';
    EXCEPTION WHEN check_violation THEN
      v_r := v_r || 'ok    ' || v_row.label || ': recusado pelo CHECK' || E'\n';
    END;
  END LOOP;

  -- updated_at é mantido pelo trigger.
  UPDATE ai_custom_tools SET updated_at = '2000-01-01'::timestamptz WHERE id = v_id_a;
  SELECT updated_at INTO v_ts FROM ai_custom_tools WHERE id = v_id_a;
  v_r := v_r || CASE WHEN v_ts > '2020-01-01'::timestamptz THEN 'ok   ' ELSE 'FALHA' END
        || ' 4. UPDATE renova updated_at pelo trigger' || E'\n';

  -- ---------- 5) teto de 20 por conta ----------
  SELECT count(*) INTO v_n FROM ai_custom_tools WHERE account_id = v_a;
  FOR i IN (v_n + 1)..20 LOOP
    INSERT INTO ai_custom_tools (account_id, name, description, url)
    VALUES (v_a, 'zz_f6_cap_' || i, 'Fills the per-account cap.', 'https://api.example.test/v1/cap');
  END LOOP;
  BEGIN
    INSERT INTO ai_custom_tools (account_id, name, description, url)
    VALUES (v_a, 'zz_f6_cap_over', 'The twenty-first tool.', 'https://api.example.test/v1/cap');
    v_r := v_r || 'FALHA 5a. a 21a ferramenta da conta foi aceita' || E'\n';
  EXCEPTION WHEN OTHERS THEN
    v_txt := SQLERRM;
    v_r := v_r || CASE WHEN v_txt LIKE 'AI_CUSTOM_TOOL_LIMIT:20%' THEN 'ok   ' ELSE 'FALHA' END
          || format(' 5a. a 21a recusada pelo trigger: %s', v_txt) || E'\n';
  END;
  -- O teto é POR conta: a B segue livre.
  BEGIN
    INSERT INTO ai_custom_tools (account_id, name, description, url)
    VALUES (v_b, 'zz_f6_b_free', 'The other account is not affected.', 'https://api.example.test/v1/b');
    v_r := v_r || 'ok    5b. o teto e por conta (a B continua livre)' || E'\n';
  EXCEPTION WHEN OTHERS THEN
    v_r := v_r || 'FALHA 5b. a conta B foi barrada pelo teto da A: ' || SQLERRM || E'\n';
  END;
  DELETE FROM ai_custom_tools WHERE account_id = v_a AND name = 'zz_f6_cap_20';
  BEGIN
    INSERT INTO ai_custom_tools (account_id, name, description, url)
    VALUES (v_a, 'zz_f6_cap_again', 'Fits after a delete.', 'https://api.example.test/v1/cap');
    v_r := v_r || 'ok    5c. apagar uma libera a vaga' || E'\n';
  EXCEPTION WHEN OTHERS THEN
    v_r := v_r || 'FALHA 5c. apagar nao liberou a vaga: ' || SQLERRM || E'\n';
  END;
  RESET ROLE;

  -- ---------- 6) anon: nada ----------
  BEGIN
    SET LOCAL ROLE anon;
    PERFORM count(*) FROM ai_custom_tools;
    RESET ROLE;
    v_r := v_r || 'FALHA 6. anon leu ai_custom_tools' || E'\n';
  EXCEPTION WHEN insufficient_privilege THEN
    RESET ROLE;
    v_r := v_r || 'ok    6. anon barrado (permission denied)' || E'\n';
  END;

  -- ---------- 7) authenticated (admin da conta A) ----------
  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', v_u)::text, true);

  EXECUTE format('SELECT count(*) FROM ai_custom_tools WHERE account_id = %L', v_a) INTO v_n;
  v_r := v_r || CASE WHEN v_n >= 1 THEN 'ok   ' ELSE 'FALHA' END
        || format(' 7a. o admin da conta le as ferramentas dela: %s linha(s)', v_n) || E'\n';
  EXECUTE format('SELECT count(*) FROM ai_custom_tools WHERE account_id = %L', v_b) INTO v_n;
  v_r := v_r || CASE WHEN v_n = 0 THEN 'ok   ' ELSE 'FALHA' END
        || format(' 7b. o mesmo admin NAO le as da conta B (RLS): %s (esperado 0)', v_n) || E'\n';
  BEGIN
    EXECUTE format('SELECT %s FROM ai_custom_tools WHERE account_id = %L', v_cols, v_a);
    v_r := v_r || 'ok    7c. as colunas sem segredo sao legiveis' || E'\n';
  EXCEPTION WHEN OTHERS THEN
    v_r := v_r || 'FALHA 7c. coluna publica ilegivel: ' || SQLERRM || E'\n';
  END;
  BEGIN
    EXECUTE format('SELECT headers_encrypted FROM ai_custom_tools WHERE account_id = %L', v_a);
    v_r := v_r || 'FALHA 7d. authenticated leu headers_encrypted' || E'\n';
  EXCEPTION WHEN insufficient_privilege THEN
    v_r := v_r || 'ok    7d. headers_encrypted ilegivel para authenticated (permission denied)' || E'\n';
  END;
  BEGIN
    EXECUTE format('SELECT * FROM ai_custom_tools WHERE account_id = %L', v_a);
    v_r := v_r || 'FALHA 7e. SELECT * funcionou (vazaria o segredo cifrado)' || E'\n';
  EXCEPTION WHEN insufficient_privilege THEN
    v_r := v_r || 'ok    7e. SELECT * recusado (a tela e as rotas listam as colunas)' || E'\n';
  END;
  BEGIN
    INSERT INTO ai_custom_tools (account_id, name, description, url)
    VALUES (v_a, 'zz_f6_auth_ins', 'Direct insert must fail.', 'https://api.example.test/x');
    v_r := v_r || 'FALHA 7f. authenticated inseriu direto' || E'\n';
  EXCEPTION WHEN insufficient_privilege THEN
    v_r := v_r || 'ok    7f. INSERT direto recusado para authenticated' || E'\n';
  END;
  BEGIN
    UPDATE ai_custom_tools SET is_active = TRUE WHERE id = v_id_a;
    v_r := v_r || 'FALHA 7g. authenticated atualizou direto' || E'\n';
  EXCEPTION WHEN insufficient_privilege THEN
    v_r := v_r || 'ok    7g. UPDATE direto recusado para authenticated' || E'\n';
  END;
  BEGIN
    DELETE FROM ai_custom_tools WHERE id = v_id_a;
    v_r := v_r || 'FALHA 7h. authenticated apagou direto' || E'\n';
  EXCEPTION WHEN insufficient_privilege THEN
    v_r := v_r || 'ok    7h. DELETE direto recusado para authenticated' || E'\n';
  END;
  RESET ROLE;

  -- ---------- 8) um membro sem papel de admin não lê ----------
  IF v_agent IS NULL THEN
    v_r := v_r || 'ok    8. a conta A nao tem agente: leitura por nao-admin nao testada (nada a conferir)' || E'\n';
  ELSE
    SET LOCAL ROLE authenticated;
    PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', v_agent)::text, true);
    EXECUTE format('SELECT count(*) FROM ai_custom_tools WHERE account_id = %L', v_a) INTO v_n;
    RESET ROLE;
    v_r := v_r || CASE WHEN v_n = 0 THEN 'ok   ' ELSE 'FALHA' END
          || format(' 8. um agente (nao admin) da conta nao le as ferramentas: %s (esperado 0)', v_n) || E'\n';
  END IF;

  -- ---------- 9) a conta apagada leva as ferramentas ----------
  -- (FK ON DELETE CASCADE conferida em 1f; apagar uma conta de verdade fica
  -- de fora de proposito.)

  v_fail := (length(v_r) - length(replace(v_r, 'FALHA', ''))) / 5;
  RAISE EXCEPTION E'F6_TESTE_REVERTIDO\n%\nFalhas: %', v_r, v_fail;
END;
$$;
