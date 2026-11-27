-- verify-110-ai-agent-hardening.sql — conferência da F8 da SPEC 089. NÃO é migração.
--
-- Para o SQL Editor do `vn`. Rode DEPOIS de aplicar
-- `supabase/migrations/110_ai_agent_hardening.sql`. Uma consulta só.
-- Roda os testes DENTRO de um bloco que sempre termina em RAISE EXCEPTION: o
-- Postgres desfaz tudo (contador de vagas, pausa/atribuição temporárias da
-- conversa, linhas de auditoria, negócios de teste). O relatório vem na
-- mensagem do erro, que começa com `F8_TESTE_REVERTIDO`; cada linha começa
-- com `ok`, `FALHA` ou `info`, e a última diz quantas falharam. Depois,
-- confira que
--   select count(*) from ai_tool_calls where call_key like 'zz-f8-%'
--   select count(*) from deals where title like 'zz-f8-%'
-- são 0.
--
-- Usa uma conversa existente de uma conta com admin/owner (conta A), um
-- funil e uma etapa dessa conta (para o teste de negócio; sem funil o item 5
-- vira `info`) e, se houver, um membro `agent`/`viewer` de alguma conta.

DO $$
DECLARE
  v_conv    UUID;
  v_a       UUID;
  v_u       UUID;
  v_low     UUID;
  v_low_acc UUID;
  v_pipe    UUID;
  v_stage   UUID;
  v_ok      BOOLEAN;
  v_out     TEXT;
  v_id      UUID;
  v_n       BIGINT;
  v_d1      UUID;
  v_d2      UUID;
  v_r       TEXT := '';
  v_fail    INT;
  v_fn_slot TEXT := 'public.claim_ai_reply_slot(uuid,integer)';
  v_fn_call TEXT := 'public.claim_ai_tool_call(uuid,uuid,text,text,text,text,jsonb,integer)';
  v_fn_ex   TEXT := 'public.match_ai_examples(uuid,text,text,integer,real)';
  v_fn_pur  TEXT := 'public.purge_ai_tool_calls(integer,integer)';
  v_fn_trg  TEXT := 'public.clear_deal_ai_dedupe_key()';
BEGIN
  -- ---------- Dados ----------
  SELECT c.id, c.account_id INTO v_conv, v_a
    FROM conversations c
    JOIN profiles p ON p.account_id = c.account_id
                   AND p.account_role IN ('owner', 'admin')
                   AND p.blocked_at IS NULL
   WHERE c.contact_id IS NOT NULL
   ORDER BY c.created_at DESC LIMIT 1;
  IF v_conv IS NULL THEN
    RAISE EXCEPTION 'F8_TESTE_ABORTADO precisa de uma conversa de uma conta com um admin/owner';
  END IF;
  SELECT p.user_id INTO v_u
    FROM profiles p
   WHERE p.account_id = v_a AND p.account_role IN ('owner', 'admin') AND p.blocked_at IS NULL
   ORDER BY p.user_id LIMIT 1;
  SELECT p.user_id, p.account_id INTO v_low, v_low_acc
    FROM profiles p
   WHERE p.account_role IN ('agent', 'viewer') AND p.blocked_at IS NULL
   ORDER BY p.user_id LIMIT 1;
  SELECT s.pipeline_id, s.id INTO v_pipe, v_stage
    FROM pipeline_stages s JOIN pipelines pl ON pl.id = s.pipeline_id
   WHERE pl.account_id = v_a
   ORDER BY s.position NULLS LAST LIMIT 1;

  -- ---------- 1) privilégios ----------
  v_r := v_r || CASE WHEN NOT has_function_privilege('anon', v_fn_slot, 'EXECUTE')
                      AND NOT has_function_privilege('authenticated', v_fn_slot, 'EXECUTE')
                      AND has_function_privilege('service_role', v_fn_slot, 'EXECUTE')
                 THEN 'ok   ' ELSE 'FALHA' END || ' 1a. claim_ai_reply_slot: so service_role' || E'\n';
  v_r := v_r || CASE WHEN NOT has_function_privilege('anon', v_fn_call, 'EXECUTE')
                      AND NOT has_function_privilege('authenticated', v_fn_call, 'EXECUTE')
                      AND has_function_privilege('service_role', v_fn_call, 'EXECUTE')
                 THEN 'ok   ' ELSE 'FALHA' END || ' 1b. claim_ai_tool_call: so service_role' || E'\n';
  v_r := v_r || CASE WHEN NOT has_function_privilege('anon', v_fn_pur, 'EXECUTE')
                      AND NOT has_function_privilege('public', v_fn_pur, 'EXECUTE')
                      AND NOT has_function_privilege('authenticated', v_fn_pur, 'EXECUTE')
                      AND has_function_privilege('service_role', v_fn_pur, 'EXECUTE')
                 THEN 'ok   ' ELSE 'FALHA' END || ' 1c. purge_ai_tool_calls: so service_role' || E'\n';
  v_r := v_r || CASE WHEN NOT has_function_privilege('anon', v_fn_trg, 'EXECUTE')
                      AND NOT has_function_privilege('authenticated', v_fn_trg, 'EXECUTE')
                 THEN 'ok   ' ELSE 'FALHA' END || ' 1d. clear_deal_ai_dedupe_key: interna' || E'\n';
  v_r := v_r || CASE WHEN NOT has_function_privilege('anon', v_fn_ex, 'EXECUTE')
                      AND has_function_privilege('authenticated', v_fn_ex, 'EXECUTE')
                 THEN 'ok   ' ELSE 'FALHA' END || ' 1e. match_ai_examples: anon sem EXECUTE' || E'\n';
  v_r := v_r || CASE WHEN NOT EXISTS (
                        SELECT 1 FROM pg_proc
                         WHERE oid IN (v_fn_slot::regprocedure, v_fn_call::regprocedure, v_fn_ex::regprocedure,
                                       v_fn_pur::regprocedure,
                                       'public.enforce_knowledge_document_quota()'::regprocedure,
                                       'public.recount_account_usage(uuid)'::regprocedure)
                           AND NOT ('search_path=public, pg_temp' = ANY (proconfig)))
                 THEN 'ok   ' ELSE 'FALHA' END || ' 1f. search_path = public, pg_temp nas 6 funcoes' || E'\n';

  -- ---------- 2) claim_ai_reply_slot respeita pausa e atribuição ----------
  UPDATE conversations SET ai_reply_count = 0, ai_autoreply_disabled = true, assigned_agent_id = NULL WHERE id = v_conv;
  v_ok := claim_ai_reply_slot(v_conv, 5);
  v_r := v_r || CASE WHEN v_ok = false THEN 'ok   ' ELSE 'FALHA' END || ' 2a. conversa pausada: sem vaga' || E'\n';
  UPDATE conversations SET ai_autoreply_disabled = false, assigned_agent_id = v_u WHERE id = v_conv;
  v_ok := claim_ai_reply_slot(v_conv, 5);
  v_r := v_r || CASE WHEN v_ok = false THEN 'ok   ' ELSE 'FALHA' END || ' 2b. conversa atribuida: sem vaga' || E'\n';
  UPDATE conversations SET assigned_agent_id = NULL WHERE id = v_conv;
  v_ok := claim_ai_reply_slot(v_conv, 5);
  v_r := v_r || CASE WHEN v_ok = true THEN 'ok   ' ELSE 'FALHA' END || ' 2c. conversa livre: vaga concedida' || E'\n';
  UPDATE conversations SET ai_reply_count = 5 WHERE id = v_conv;
  v_ok := claim_ai_reply_slot(v_conv, 5);
  v_r := v_r || CASE WHEN v_ok = false THEN 'ok   ' ELSE 'FALHA' END || ' 2d. teto atingido: sem vaga' || E'\n';

  -- ---------- 3) claim_ai_tool_call em conversa pausada ----------
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
  UPDATE conversations SET ai_autoreply_disabled = true WHERE id = v_conv;
  SELECT outcome INTO v_out FROM claim_ai_tool_call(v_a, v_conv, 'auto_reply', 'add_contact_tags', 'write', 'zz-f8-1', '{}'::jsonb, 10);
  v_r := v_r || CASE WHEN v_out = 'conversation_paused' THEN 'ok   ' ELSE 'FALHA' END
        || format(' 3a. escrita do auto-reply em conversa pausada: %s', v_out) || E'\n';
  SELECT outcome INTO v_out FROM claim_ai_tool_call(v_a, v_conv, 'auto_reply', 'get_contact_profile', 'read', 'zz-f8-2', '{}'::jsonb, 10);
  v_r := v_r || CASE WHEN v_out = 'conversation_paused' THEN 'ok   ' ELSE 'FALHA' END
        || format(' 3b. leitura do auto-reply em conversa pausada: %s', v_out) || E'\n';
  SELECT outcome INTO v_out FROM claim_ai_tool_call(v_a, v_conv, 'auto_reply', 'handoff_to_human', 'write', 'zz-f8-3', '{}'::jsonb, 10);
  v_r := v_r || CASE WHEN v_out = 'claimed' THEN 'ok   ' ELSE 'FALHA' END
        || format(' 3c. handoff_to_human segue isento: %s', v_out) || E'\n';
  SELECT outcome INTO v_out FROM claim_ai_tool_call(v_a, v_conv, 'draft', 'consultar_pedido', 'read', 'zz-f8-4', '{}'::jsonb, 10);
  v_r := v_r || CASE WHEN v_out = 'claimed' THEN 'ok   ' ELSE 'FALHA' END
        || format(' 3d. rascunho (humano operando) nao e afetado: %s', v_out) || E'\n';
  UPDATE conversations SET ai_autoreply_disabled = false, assigned_agent_id = v_u WHERE id = v_conv;
  SELECT outcome INTO v_out FROM claim_ai_tool_call(v_a, v_conv, 'auto_reply', 'add_internal_note', 'write', 'zz-f8-5', '{}'::jsonb, 10);
  v_r := v_r || CASE WHEN v_out = 'conversation_paused' THEN 'ok   ' ELSE 'FALHA' END
        || format(' 3e. escrita do auto-reply em conversa atribuida: %s', v_out) || E'\n';
  SELECT count(*) INTO v_n FROM ai_tool_calls WHERE call_key IN ('zz-f8-1', 'zz-f8-2', 'zz-f8-5')
     AND status = 'refused' AND error_code = 'conversation_paused';
  v_r := v_r || CASE WHEN v_n = 3 THEN 'ok   ' ELSE 'FALHA' END
        || format(' 3f. recusas auditadas como refused/conversation_paused: %s (esperado 3)', v_n) || E'\n';
  UPDATE conversations SET assigned_agent_id = NULL WHERE id = v_conv;

  -- ---------- 4) match_ai_examples exige admin ----------
  IF v_low IS NULL THEN
    v_r := v_r || 'info  4a. nenhum membro agent/viewer para testar a recusa' || E'\n';
  ELSE
    BEGIN
      SET LOCAL ROLE authenticated;
      PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', v_low)::text, true);
      PERFORM * FROM match_ai_examples(v_low_acc, NULL, 'text-embedding-3-small', 3, NULL);
      RESET ROLE;
      v_r := v_r || 'FALHA 4a. agent/viewer executou match_ai_examples' || E'\n';
    EXCEPTION WHEN insufficient_privilege THEN
      RESET ROLE;
      v_r := v_r || 'ok    4a. agent/viewer recusado (42501)' || E'\n';
    END;
  END IF;
  BEGIN
    SET LOCAL ROLE authenticated;
    PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', v_u)::text, true);
    PERFORM * FROM match_ai_examples(v_a, NULL, 'text-embedding-3-small', 3, NULL);
    RESET ROLE;
    v_r := v_r || 'ok    4b. admin da conta executa' || E'\n';
  EXCEPTION WHEN insufficient_privilege THEN
    RESET ROLE;
    v_r := v_r || 'FALHA 4b. admin da conta recusado' || E'\n';
  END;
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);

  -- ---------- 5) deals.ai_dedupe_key ----------
  IF v_pipe IS NULL THEN
    v_r := v_r || 'info  5. a conta A nao tem funil: teste de negocio pulado' || E'\n';
  ELSE
    INSERT INTO deals (account_id, pipeline_id, stage_id, title, ai_dedupe_key, status, user_id)
    VALUES (v_a, v_pipe, v_stage, 'zz-f8-deal', 'zz-f8-key', 'open', v_u) RETURNING id INTO v_d1;
    BEGIN
      INSERT INTO deals (account_id, pipeline_id, stage_id, title, ai_dedupe_key, status, user_id)
      VALUES (v_a, v_pipe, v_stage, 'zz-f8-deal', 'zz-f8-key', 'open', v_u);
      v_r := v_r || 'FALHA 5a. segundo negocio aberto com a mesma chave aceito' || E'\n';
    EXCEPTION WHEN unique_violation THEN
      v_r := v_r || 'ok    5a. segundo negocio aberto com a mesma chave recusado (23505)' || E'\n';
    END;
    INSERT INTO deals (account_id, pipeline_id, stage_id, title, status, user_id)
    VALUES (v_a, v_pipe, v_stage, 'zz-f8-human', 'open', v_u);
    INSERT INTO deals (account_id, pipeline_id, stage_id, title, status, user_id)
    VALUES (v_a, v_pipe, v_stage, 'zz-f8-human', 'open', v_u);
    v_r := v_r || 'ok    5b. negocio de humano (chave NULL) repetido continua aceito' || E'\n';
    UPDATE deals SET status = 'won' WHERE id = v_d1;
    SELECT ai_dedupe_key IS NULL INTO v_ok FROM deals WHERE id = v_d1;
    v_r := v_r || CASE WHEN v_ok THEN 'ok   ' ELSE 'FALHA' END || ' 5c. chave limpa ao sair de open' || E'\n';
    INSERT INTO deals (account_id, pipeline_id, stage_id, title, ai_dedupe_key, status, user_id)
    VALUES (v_a, v_pipe, v_stage, 'zz-f8-deal', 'zz-f8-key', 'open', v_u) RETURNING id INTO v_d2;
    UPDATE deals SET status = 'open' WHERE id = v_d1;
    v_r := v_r || 'ok    5d. reabrir o negocio fechado nao colide com o novo' || E'\n';
  END IF;

  -- ---------- 6) purge_ai_tool_calls ----------
  INSERT INTO ai_tool_calls (account_id, conversation_id, mode, tool, risk, call_key, status, created_at, finished_at)
  VALUES (v_a, v_conv, 'auto_reply', 'get_contact_profile', 'read', 'zz-f8-old', 'ok', now() - interval '100 days', now() - interval '100 days');
  SET LOCAL ROLE service_role;
  v_n := purge_ai_tool_calls(90, 5000);
  RESET ROLE;
  SELECT count(*) INTO v_out FROM ai_tool_calls WHERE call_key = 'zz-f8-old';
  v_r := v_r || CASE WHEN v_out = '0' AND v_n >= 1 THEN 'ok   ' ELSE 'FALHA' END
        || format(' 6a. linha de 100 dias apagada (%s apagada(s))', v_n) || E'\n';
  SELECT count(*) INTO v_n FROM ai_tool_calls WHERE call_key LIKE 'zz-f8-%';
  v_r := v_r || CASE WHEN v_n >= 5 THEN 'ok   ' ELSE 'FALHA' END
        || format(' 6b. linhas recentes ficam: %s', v_n) || E'\n';
  BEGIN
    SET LOCAL ROLE authenticated;
    PERFORM purge_ai_tool_calls(90, 10);
    RESET ROLE;
    v_r := v_r || 'FALHA 6c. authenticated executou purge_ai_tool_calls' || E'\n';
  EXCEPTION WHEN insufficient_privilege THEN
    RESET ROLE;
    v_r := v_r || 'ok    6c. authenticated barrado' || E'\n';
  END;

  -- ---------- 7) nome nativo reservado e veredito assinado ----------
  v_r := v_r || CASE WHEN EXISTS (SELECT 1 FROM pg_constraint
                                   WHERE conrelid = 'public.ai_custom_tools'::regclass
                                     AND conname = 'ai_custom_tools_name_not_native')
                 THEN 'ok   ' ELSE 'FALHA' END || ' 7a. ai_custom_tools recusa nome de ferramenta nativa' || E'\n';
  v_r := v_r || CASE WHEN EXISTS (SELECT 1 FROM pg_policies
                                   WHERE schemaname = 'public' AND tablename = 'ai_eval_results'
                                     AND policyname = 'ai_eval_results_update'
                                     AND with_check LIKE '%judged_by%auth.uid()%')
                 THEN 'ok   ' ELSE 'FALHA' END || ' 7b. ai_eval_results: judged_by amarrado a auth.uid()' || E'\n';

  v_fail := (length(v_r) - length(replace(v_r, 'FALHA', ''))) / 5;
  RAISE EXCEPTION E'F8_TESTE_REVERTIDO\n%\nFalhas: %', v_r, v_fail;
END;
$$;
