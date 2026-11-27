-- verify-106-ai-tool-calls.sql — conferência da F5 da SPEC 089. NÃO é migração.
--
-- Para o SQL Editor (ou MCP) do projeto confirmado: o `vn`. Rode DEPOIS de
-- aplicar `supabase/migrations/106_ai_tool_calls.sql`. Uma consulta só.
-- Roda os testes DENTRO de um bloco que sempre termina em RAISE EXCEPTION: o
-- Postgres desfaz tudo (linhas de auditoria, contador do mês, plano e troca
-- de papel). O relatório vem na mensagem do erro, que começa com
-- `F5_TESTE_REVERTIDO`; cada linha começa com `ok` ou `FALHA`, e a última
-- diz quantas falharam. Depois de rodar, confira que
--   select count(*) from ai_tool_calls where call_key like 'zz-f5-%'
-- é 0.
--
-- Usa uma conversa existente (conta A, só trava a linha dentro da transação
-- desfeita), um admin/owner dessa conta e uma segunda conta (B) da qual ele
-- NÃO é membro.
--
-- Cobre: privilégios (anon/PUBLIC/authenticated sem EXECUTE nas duas RPCs;
-- tabela só com SELECT para authenticated e service_role), recusa de
-- chamador sem papel, reivindicação atômica (claimed, duplicate, conversa de
-- outra conta), contato tirado da linha da conversa, teto de escritas por
-- conversa (leitura segue passando), quota mensal `ai_tool_calls_month`
-- decidida pelo banco (estoura, e ausente = ilimitado), fechamento único,
-- tabela sem escrita direta (nem para service_role), RLS de leitura (admin
-- da conta vê as linhas dela, não as da B) e o `resource_type 'ai'` do
-- registro de atividade.

DO $$
DECLARE
  v_conv   UUID;
  v_a      UUID;
  v_contact UUID;
  v_u      UUID;
  v_b      UUID;
  v_conv_b UUID;
  v_plan   UUID;
  v_id     UUID;
  v_id2    UUID;
  v_out    TEXT;
  v_used   INTEGER;
  v_lim    INTEGER;
  v_n      BIGINT;
  v_row    RECORD;
  v_ok     BOOLEAN;
  v_msg    TEXT;
  v_fn1    TEXT := 'public.claim_ai_tool_call(uuid,uuid,text,text,text,text,jsonb,integer)';
  v_fn2    TEXT := 'public.finish_ai_tool_call(uuid,text,text,text,integer)';
  v_r      TEXT := '';
  v_fail   INT;
BEGIN
  -- ---------- Dados ----------
  SELECT c.id, c.account_id, c.contact_id INTO v_conv, v_a, v_contact
    FROM conversations c
    JOIN profiles p ON p.account_id = c.account_id
                   AND p.account_role IN ('owner', 'admin')
                   AND p.blocked_at IS NULL
   WHERE c.contact_id IS NOT NULL
   ORDER BY c.created_at DESC LIMIT 1;
  IF v_conv IS NULL THEN
    RAISE EXCEPTION 'F5_TESTE_ABORTADO precisa de uma conversa de uma conta com um admin/owner';
  END IF;
  SELECT p.user_id INTO v_u
    FROM profiles p
   WHERE p.account_id = v_a AND p.account_role IN ('owner', 'admin') AND p.blocked_at IS NULL
   ORDER BY p.user_id LIMIT 1;
  SELECT a.id INTO v_b
    FROM accounts a
   WHERE a.id <> v_a
     AND NOT EXISTS (SELECT 1 FROM profiles p WHERE p.account_id = a.id AND p.user_id = v_u)
   ORDER BY a.id LIMIT 1;
  IF v_b IS NULL THEN
    RAISE EXCEPTION 'F5_TESTE_ABORTADO precisa de uma segunda conta da qual o admin nao e membro';
  END IF;
  SELECT c.id INTO v_conv_b FROM conversations c WHERE c.account_id = v_b LIMIT 1;

  -- ---------- 1) privilégios ----------
  v_r := v_r || CASE WHEN NOT has_function_privilege('anon', v_fn1, 'EXECUTE')
                      AND NOT has_function_privilege('public', v_fn1, 'EXECUTE')
                      AND NOT has_function_privilege('authenticated', v_fn1, 'EXECUTE')
                      AND has_function_privilege('service_role', v_fn1, 'EXECUTE')
                 THEN 'ok   ' ELSE 'FALHA' END
        || ' 1a. claim_ai_tool_call: so service_role executa' || E'\n';
  v_r := v_r || CASE WHEN NOT has_function_privilege('anon', v_fn2, 'EXECUTE')
                      AND NOT has_function_privilege('public', v_fn2, 'EXECUTE')
                      AND NOT has_function_privilege('authenticated', v_fn2, 'EXECUTE')
                      AND has_function_privilege('service_role', v_fn2, 'EXECUTE')
                 THEN 'ok   ' ELSE 'FALHA' END
        || ' 1b. finish_ai_tool_call: so service_role executa' || E'\n';
  v_r := v_r || CASE WHEN NOT has_table_privilege('anon', 'public.ai_tool_calls', 'SELECT')
                      AND has_table_privilege('authenticated', 'public.ai_tool_calls', 'SELECT')
                      AND NOT has_table_privilege('authenticated', 'public.ai_tool_calls', 'INSERT')
                      AND NOT has_table_privilege('authenticated', 'public.ai_tool_calls', 'UPDATE')
                      AND NOT has_table_privilege('authenticated', 'public.ai_tool_calls', 'DELETE')
                      AND NOT has_table_privilege('service_role', 'public.ai_tool_calls', 'INSERT')
                      AND NOT has_table_privilege('service_role', 'public.ai_tool_calls', 'UPDATE')
                      AND NOT has_table_privilege('service_role', 'public.ai_tool_calls', 'DELETE')
                 THEN 'ok   ' ELSE 'FALHA' END
        || ' 1c. ai_tool_calls: anon sem acesso; authenticated e service_role so com SELECT' || E'\n';
  v_r := v_r || CASE WHEN EXISTS (SELECT 1 FROM pg_proc
                                   WHERE oid = v_fn1::regprocedure AND prosecdef
                                     AND EXISTS (SELECT 1 FROM unnest(proconfig) c WHERE c LIKE 'search_path=%'))
                      AND EXISTS (SELECT 1 FROM pg_proc
                                   WHERE oid = v_fn2::regprocedure AND prosecdef
                                     AND EXISTS (SELECT 1 FROM unnest(proconfig) c WHERE c LIKE 'search_path=%'))
                 THEN 'ok   ' ELSE 'FALHA' END
        || ' 1d. as duas RPCs: SECURITY DEFINER com search_path fixo' || E'\n';
  v_r := v_r || CASE WHEN (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.ai_tool_calls'::regclass)
                 THEN 'ok   ' ELSE 'FALHA' END || ' 1e. RLS ligada em ai_tool_calls' || E'\n';

  -- ---------- 2) anon e authenticated não executam ----------
  BEGIN
    SET LOCAL ROLE anon;
    PERFORM * FROM claim_ai_tool_call(v_a, v_conv, 'auto_reply', 't', 'read', 'zz-f5-anon', '{}'::jsonb, 10);
    RESET ROLE;
    v_r := v_r || 'FALHA 2a. anon executou claim_ai_tool_call' || E'\n';
  EXCEPTION WHEN insufficient_privilege THEN
    RESET ROLE;
    v_r := v_r || 'ok    2a. anon barrado (permission denied)' || E'\n';
  END;
  BEGIN
    SET LOCAL ROLE authenticated;
    PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', v_u)::text, true);
    PERFORM * FROM claim_ai_tool_call(v_a, v_conv, 'auto_reply', 't', 'read', 'zz-f5-auth', '{}'::jsonb, 10);
    RESET ROLE;
    v_r := v_r || 'FALHA 2b. authenticated executou claim_ai_tool_call' || E'\n';
  EXCEPTION WHEN insufficient_privilege THEN
    RESET ROLE;
    v_r := v_r || 'ok    2b. authenticated barrado (permission denied)' || E'\n';
  END;

  -- ---------- 3) service_role: reivindicação ----------
  SET LOCAL ROLE service_role;
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);

  SELECT outcome, call_id INTO v_out, v_id
    FROM claim_ai_tool_call(v_a, v_conv, 'auto_reply', 'get_contact_profile', 'read', 'zz-f5-1', '{"a":1}'::jsonb, 10);
  v_r := v_r || CASE WHEN v_out = 'claimed' AND v_id IS NOT NULL THEN 'ok   ' ELSE 'FALHA' END
        || format(' 3a. reivindica uma leitura: %s', v_out) || E'\n';

  SELECT status, contact_id, account_id, conversation_id INTO v_row
    FROM ai_tool_calls WHERE id = v_id;
  v_r := v_r || CASE WHEN v_row.status = 'started' AND v_row.contact_id = v_contact
                      AND v_row.account_id = v_a AND v_row.conversation_id = v_conv
                 THEN 'ok   ' ELSE 'FALHA' END
        || ' 3b. linha started, com o contato TIRADO DA LINHA da conversa (nao de parametro)' || E'\n';

  SELECT outcome, call_id INTO v_out, v_id2
    FROM claim_ai_tool_call(v_a, v_conv, 'auto_reply', 'get_contact_profile', 'read', 'zz-f5-1', '{}'::jsonb, 10);
  v_r := v_r || CASE WHEN v_out = 'duplicate' AND v_id2 = v_id THEN 'ok   ' ELSE 'FALHA' END
        || format(' 3c. o mesmo call_key nao executa duas vezes: %s', v_out) || E'\n';

  SELECT outcome INTO v_out
    FROM claim_ai_tool_call(v_b, v_conv, 'auto_reply', 't', 'read', 'zz-f5-x', '{}'::jsonb, 10);
  v_r := v_r || CASE WHEN v_out = 'conversation_not_found' THEN 'ok   ' ELSE 'FALHA' END
        || format(' 3d. conversa da A reivindicada como conta B: %s (esperado conversation_not_found)', v_out) || E'\n';
  SELECT count(*) INTO v_n FROM ai_tool_calls WHERE call_key = 'zz-f5-x';
  v_r := v_r || CASE WHEN v_n = 0 THEN 'ok   ' ELSE 'FALHA' END
        || format(' 3e. a recusa por conta nao grava linha: %s (esperado 0)', v_n) || E'\n';

  -- ---------- 4) teto de escritas por conversa ----------
  SELECT outcome INTO v_out FROM claim_ai_tool_call(v_a, v_conv, 'auto_reply', 'add_internal_note', 'write', 'zz-f5-w1', '{}'::jsonb, 2);
  v_ok := v_out = 'claimed';
  SELECT outcome INTO v_out FROM claim_ai_tool_call(v_a, v_conv, 'auto_reply', 'add_internal_note', 'write', 'zz-f5-w2', '{}'::jsonb, 2);
  v_ok := v_ok AND v_out = 'claimed';
  SELECT outcome, call_id INTO v_out, v_id2 FROM claim_ai_tool_call(v_a, v_conv, 'auto_reply', 'add_internal_note', 'write', 'zz-f5-w3', '{}'::jsonb, 2);
  v_r := v_r || CASE WHEN v_ok AND v_out = 'write_cap_reached' THEN 'ok   ' ELSE 'FALHA' END
        || format(' 4a. teto 2: duas escritas passam, a terceira %s', v_out) || E'\n';
  SELECT status, error_code INTO v_row FROM ai_tool_calls WHERE id = v_id2;
  v_r := v_r || CASE WHEN v_row.status = 'refused' AND v_row.error_code = 'write_cap_reached' THEN 'ok   ' ELSE 'FALHA' END
        || ' 4b. a escrita recusada vira linha refused (auditoria da tentativa)' || E'\n';
  SELECT outcome INTO v_out FROM claim_ai_tool_call(v_a, v_conv, 'auto_reply', 'search_knowledge', 'read', 'zz-f5-r2', '{}'::jsonb, 2);
  v_r := v_r || CASE WHEN v_out = 'claimed' THEN 'ok   ' ELSE 'FALHA' END
        || format(' 4c. o teto e so de ESCRITA: uma leitura ainda passa (%s)', v_out) || E'\n';

  -- O handoff é a saída de emergência: passa mesmo com o teto estourado.
  SELECT outcome INTO v_out FROM claim_ai_tool_call(v_a, v_conv, 'auto_reply', 'handoff_to_human', 'write', 'zz-f5-h1', '{}'::jsonb, 2);
  v_r := v_r || CASE WHEN v_out = 'claimed' THEN 'ok   ' ELSE 'FALHA' END
        || format(' 4d. handoff_to_human passa mesmo acima do teto de escritas: %s', v_out) || E'\n';

  -- ---------- 5) quota mensal decidida pelo banco ----------
  RESET ROLE;
  SELECT id INTO v_plan FROM plans ORDER BY created_at LIMIT 1;
  IF v_plan IS NULL THEN
    v_r := v_r || 'ok    5. sem plano cadastrado: quota nao testada (nada a conferir)' || E'\n';
  ELSE
    UPDATE platform_settings SET quotas_enforced = TRUE;
    INSERT INTO account_plans (account_id, plan_id, limit_overrides)
    VALUES (v_a, v_plan, '{"ai_tool_calls_month": 3}'::jsonb)
    ON CONFLICT (account_id) DO UPDATE
      SET limit_overrides = account_plans.limit_overrides || '{"ai_tool_calls_month": 3}'::jsonb;
    -- Zera o contador do mes dentro da transacao desfeita.
    DELETE FROM account_usage_counters
     WHERE account_id = v_a AND metric = 'ai_tool_calls:' || to_char(now() AT TIME ZONE 'America/Sao_Paulo', 'YYYY-MM');

    SET LOCAL ROLE service_role;
    PERFORM set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
    v_ok := TRUE;
    FOR i IN 1..3 LOOP
      SELECT outcome INTO v_out FROM claim_ai_tool_call(v_a, v_conv, 'auto_reply', 'search_knowledge', 'read', 'zz-f5-q' || i, '{}'::jsonb, 100);
      v_ok := v_ok AND v_out = 'claimed';
    END LOOP;
    SELECT outcome, used, "limit" INTO v_out, v_used, v_lim
      FROM claim_ai_tool_call(v_a, v_conv, 'auto_reply', 'search_knowledge', 'read', 'zz-f5-q4', '{}'::jsonb, 100);
    v_r := v_r || CASE WHEN v_ok AND v_out = 'quota_exceeded' AND v_used = 3 AND v_lim = 3 THEN 'ok   ' ELSE 'FALHA' END
          || format(' 5a. limite 3 no mes: 3 passam, a 4a e %s (usado %s, limite %s)', v_out, v_used, v_lim) || E'\n';
    SELECT value INTO v_used FROM account_usage_counters
     WHERE account_id = v_a AND metric = 'ai_tool_calls:' || to_char(now() AT TIME ZONE 'America/Sao_Paulo', 'YYYY-MM');
    v_r := v_r || CASE WHEN v_used = 3 THEN 'ok   ' ELSE 'FALHA' END
          || format(' 5b. o contador nao passa do limite: %s (esperado 3)', v_used) || E'\n';
    SELECT status, error_code INTO v_row FROM ai_tool_calls WHERE call_key = 'zz-f5-q4';
    v_r := v_r || CASE WHEN v_row.status = 'refused' AND v_row.error_code = 'quota_exceeded' THEN 'ok   ' ELSE 'FALHA' END
          || ' 5c. a chamada recusada pela quota vira linha refused' || E'\n';

    -- Com a quota estourada, o handoff ainda passa e não gasta quota.
    SELECT outcome INTO v_out FROM claim_ai_tool_call(v_a, v_conv, 'auto_reply', 'handoff_to_human', 'write', 'zz-f5-h2', '{}'::jsonb, 100);
    SELECT value INTO v_used FROM account_usage_counters
     WHERE account_id = v_a AND metric = 'ai_tool_calls:' || to_char(now() AT TIME ZONE 'America/Sao_Paulo', 'YYYY-MM');
    v_r := v_r || CASE WHEN v_out = 'claimed' AND v_used = 3 THEN 'ok   ' ELSE 'FALHA' END
          || format(' 5e. handoff com a quota estourada: %s, contador segue em %s (esperado claimed, 3)', v_out, v_used) || E'\n';

    -- Ausente = ilimitado (D-20).
    RESET ROLE;
    UPDATE account_plans SET limit_overrides = limit_overrides - 'ai_tool_calls_month' WHERE account_id = v_a;
    UPDATE plans SET limits = limits - 'ai_tool_calls_month' WHERE id = (SELECT plan_id FROM account_plans WHERE account_id = v_a);
    SET LOCAL ROLE service_role;
    PERFORM set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
    SELECT outcome, "limit" INTO v_out, v_lim
      FROM claim_ai_tool_call(v_a, v_conv, 'auto_reply', 'search_knowledge', 'read', 'zz-f5-q5', '{}'::jsonb, 100);
    v_r := v_r || CASE WHEN v_out = 'claimed' AND v_lim IS NULL THEN 'ok   ' ELSE 'FALHA' END
          || format(' 5d. chave ausente = ilimitado: %s, limite %s', v_out, coalesce(v_lim::text, 'NULL')) || E'\n';
    RESET ROLE;
    UPDATE platform_settings SET quotas_enforced = FALSE;
  END IF;

  -- ---------- 6) fechamento ----------
  SET LOCAL ROLE service_role;
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
  SELECT finish_ai_tool_call(v_id, 'ok', NULL, 'resumo', 12) INTO v_ok;
  SELECT status, duration_ms, finished_at INTO v_row FROM ai_tool_calls WHERE id = v_id;
  v_r := v_r || CASE WHEN v_ok AND v_row.status = 'ok' AND v_row.duration_ms = 12 AND v_row.finished_at IS NOT NULL
                 THEN 'ok   ' ELSE 'FALHA' END || ' 6a. finish fecha a linha started' || E'\n';
  SELECT finish_ai_tool_call(v_id, 'error', 'x', 'outro', 1) INTO v_ok;
  SELECT status INTO v_out FROM ai_tool_calls WHERE id = v_id;
  v_r := v_r || CASE WHEN NOT v_ok AND v_out = 'ok' THEN 'ok   ' ELSE 'FALHA' END
        || ' 6b. uma linha fechada nao muda mais (append-only na pratica)' || E'\n';

  -- ---------- 7) sem escrita direta, nem para service_role ----------
  BEGIN
    INSERT INTO ai_tool_calls (account_id, mode, tool, risk, call_key) VALUES (v_a, 'auto_reply', 't', 'read', 'zz-f5-direct');
    v_r := v_r || 'FALHA 7a. service_role inseriu direto na tabela' || E'\n';
  EXCEPTION WHEN insufficient_privilege THEN
    v_r := v_r || 'ok    7a. INSERT direto recusado ate para service_role' || E'\n';
  END;
  BEGIN
    UPDATE ai_tool_calls SET status = 'ok' WHERE call_key = 'zz-f5-1';
    v_r := v_r || 'FALHA 7b. service_role fez UPDATE direto' || E'\n';
  EXCEPTION WHEN insufficient_privilege THEN
    v_r := v_r || 'ok    7b. UPDATE direto recusado' || E'\n';
  END;
  BEGIN
    DELETE FROM ai_tool_calls WHERE call_key = 'zz-f5-1';
    v_r := v_r || 'FALHA 7c. service_role fez DELETE direto' || E'\n';
  EXCEPTION WHEN insufficient_privilege THEN
    v_r := v_r || 'ok    7c. DELETE direto recusado' || E'\n';
  END;
  BEGIN
    PERFORM claim_ai_tool_call(v_a, v_conv, 'auto_reply', 't', 'read', 'zz-f5-big', jsonb_build_object('x', repeat('a', 5000)), 10);
    v_r := v_r || 'FALHA 7d. entrada gigante foi aceita' || E'\n';
  EXCEPTION WHEN check_violation THEN
    v_r := v_r || 'ok    7d. entrada acima de 4 KB recusada pelo CHECK' || E'\n';
  END;
  RESET ROLE;

  -- ---------- 8) RLS de leitura ----------
  IF v_conv_b IS NOT NULL THEN
    SET LOCAL ROLE service_role;
    PERFORM set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
    PERFORM claim_ai_tool_call(v_b, v_conv_b, 'auto_reply', 't', 'read', 'zz-f5-b1', '{}'::jsonb, 10);
    RESET ROLE;
  END IF;
  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', v_u)::text, true);
  SELECT count(*) INTO v_n FROM ai_tool_calls WHERE account_id = v_a;
  v_r := v_r || CASE WHEN v_n >= 1 THEN 'ok   ' ELSE 'FALHA' END
        || format(' 8a. admin da conta le o historico dela: %s linha(s)', v_n) || E'\n';
  SELECT count(*) INTO v_n FROM ai_tool_calls WHERE account_id = v_b;
  v_r := v_r || CASE WHEN v_n = 0 THEN 'ok   ' ELSE 'FALHA' END
        || format(' 8b. o mesmo admin nao le a conta B: %s (esperado 0)', v_n) || E'\n';
  BEGIN
    INSERT INTO ai_tool_calls (account_id, mode, tool, risk, call_key) VALUES (v_a, 'auto_reply', 't', 'read', 'zz-f5-auth-ins');
    v_r := v_r || 'FALHA 8c. authenticated inseriu direto' || E'\n';
  EXCEPTION WHEN insufficient_privilege THEN
    v_r := v_r || 'ok    8c. INSERT direto recusado para authenticated' || E'\n';
  END;
  RESET ROLE;

  -- ---------- 9) registro de atividade aceita o recurso `ai` ----------
  BEGIN
    INSERT INTO account_activity_log (account_id, actor_kind, actor_name, resource_type, action)
    VALUES (v_a, 'system', 'ai-agent', 'ai', 'ai.tool_note_added');
    v_r := v_r || 'ok    9. account_activity_log aceita resource_type ai' || E'\n';
  EXCEPTION WHEN check_violation THEN
    v_r := v_r || 'FALHA 9. account_activity_log recusou resource_type ai (a 106 nao estendeu o CHECK)' || E'\n';
  END;

  v_fail := (length(v_r) - length(replace(v_r, 'FALHA', ''))) / 5;
  RAISE EXCEPTION E'F5_TESTE_REVERTIDO\n%\nFalhas: %', v_r, v_fail;
END;
$$;
