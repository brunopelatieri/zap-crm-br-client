-- verify-108-ai-tuning.sql — conferência da F7 da SPEC 089. NÃO é migração.
--
-- Para o SQL Editor (ou MCP) do projeto confirmado: o `vn`. Rode DEPOIS de
-- aplicar `supabase/migrations/108_ai_tuning.sql`. Uma consulta só.
-- Roda os testes DENTRO de um bloco que sempre termina em RAISE EXCEPTION: o
-- Postgres desfaz tudo (exemplos, rascunhos, casos, rodadas, troca de papel).
-- O relatório vem na mensagem do erro, que começa com `F7_TESTE_REVERTIDO`;
-- cada linha começa com `ok` ou `FALHA`, e a última diz quantas falharam.
-- Depois de rodar, confira que
--   select count(*) from ai_examples where customer_message like 'zz-f7-%'
-- é 0.
--
-- Usa uma conta A com um admin/owner e uma segunda conta B da qual esse
-- usuário NÃO é membro. Mensagens e conversas reais só são LIDAS (para pegar
-- um id de mensagem); tudo que se escreve é de teste e some no rollback.
--
-- Cobre: privilégios (anon sem acesso a nada; ai_drafts só service_role;
-- ai_eval_runs só SELECT; ai_eval_results só o veredito atualizável),
-- RLS ligada, RPC `match_ai_examples` (anon e PUBLIC sem EXECUTE, DEFINER com
-- search_path fixo, recusa conta alheia, só `approved`, modelo igual com ou
-- sem `openai/`, sem embedding fora, limiar de distância, no máximo 3, mais
-- parecido primeiro, conta B nunca aparece), isolamento das tabelas por RLS
-- (admin lê e escreve só na própria conta), CHECKs, índices únicos (uma
-- rodada `running` por conta; uma mensagem gera um candidato) e as ações de
-- exclusão das chaves estrangeiras (conta: CASCADE; conversa e mensagem: SET
-- NULL nos exemplos).

DO $$
DECLARE
  v_a      UUID;
  v_u      UUID;
  v_b      UUID;
  v_msg    UUID;
  v_conv   UUID;
  v_n      BIGINT;
  v_ids    TEXT;
  v_run    UUID;
  v_res    UUID;
  v_rows   INT;
  v_fn     TEXT := 'public.match_ai_examples(uuid,text,text,integer,real)';
  v_q      TEXT;
  v_near   TEXT;
  v_far    TEXT;
  v_mid    TEXT;
  v_r      TEXT := '';
  v_fail   INT;
BEGIN
  -- ---------- Dados ----------
  SELECT p.account_id, p.user_id INTO v_a, v_u
    FROM profiles p
   WHERE p.account_role IN ('owner', 'admin') AND p.blocked_at IS NULL
   ORDER BY p.user_id LIMIT 1;
  IF v_a IS NULL THEN
    RAISE EXCEPTION 'F7_TESTE_ABORTADO precisa de uma conta com um admin/owner';
  END IF;
  SELECT a.id INTO v_b
    FROM accounts a
   WHERE a.id <> v_a
     AND NOT EXISTS (SELECT 1 FROM profiles p WHERE p.account_id = a.id AND p.user_id = v_u)
   ORDER BY a.id LIMIT 1;
  IF v_b IS NULL THEN
    RAISE EXCEPTION 'F7_TESTE_ABORTADO precisa de uma segunda conta da qual o admin nao e membro';
  END IF;
  SELECT m.id, m.conversation_id INTO v_msg, v_conv
    FROM messages m JOIN conversations c ON c.id = m.conversation_id
   WHERE c.account_id = v_a LIMIT 1;

  -- Vetores de 1536 dimensões com só as duas primeiras componentes != 0.
  -- Consulta [1,0]; perto [1,0.1] (dist ~0.005); meio [1,1] (dist ~0.29);
  -- longe [0,1] (dist 1).
  v_q    := '[1,0,' || repeat('0,', 1533) || '0]';
  v_near := '[1,0.1,' || repeat('0,', 1533) || '0]';
  v_mid  := '[1,1,' || repeat('0,', 1533) || '0]';
  v_far  := '[0,1,' || repeat('0,', 1533) || '0]';

  -- ---------- 1) privilégios ----------
  v_r := v_r || CASE WHEN NOT has_function_privilege('anon', v_fn, 'EXECUTE')
                      AND NOT has_function_privilege('public', v_fn, 'EXECUTE')
                      AND has_function_privilege('authenticated', v_fn, 'EXECUTE')
                      AND has_function_privilege('service_role', v_fn, 'EXECUTE')
                 THEN 'ok   ' ELSE 'FALHA' END
        || ' 1a. match_ai_examples: anon e PUBLIC sem EXECUTE; authenticated e service_role com' || E'\n';
  v_r := v_r || CASE WHEN EXISTS (SELECT 1 FROM pg_proc
                                   WHERE oid = v_fn::regprocedure AND prosecdef
                                     AND EXISTS (SELECT 1 FROM unnest(proconfig) c WHERE c LIKE 'search_path=%'))
                 THEN 'ok   ' ELSE 'FALHA' END
        || ' 1b. match_ai_examples: SECURITY DEFINER com search_path fixo' || E'\n';
  v_r := v_r || CASE WHEN NOT has_table_privilege('anon', 'public.ai_examples', 'SELECT')
                      AND NOT has_table_privilege('anon', 'public.ai_drafts', 'SELECT')
                      AND NOT has_table_privilege('anon', 'public.ai_eval_cases', 'SELECT')
                      AND NOT has_table_privilege('anon', 'public.ai_eval_runs', 'SELECT')
                      AND NOT has_table_privilege('anon', 'public.ai_eval_results', 'SELECT')
                      AND NOT has_table_privilege('anon', 'public.ai_examples', 'INSERT')
                 THEN 'ok   ' ELSE 'FALHA' END
        || ' 1c. anon sem acesso a nenhuma das 5 tabelas' || E'\n';
  v_r := v_r || CASE WHEN NOT has_table_privilege('authenticated', 'public.ai_drafts', 'SELECT')
                      AND NOT has_table_privilege('authenticated', 'public.ai_drafts', 'INSERT')
                      AND NOT has_table_privilege('authenticated', 'public.ai_drafts', 'DELETE')
                      AND has_table_privilege('service_role', 'public.ai_drafts', 'INSERT')
                 THEN 'ok   ' ELSE 'FALHA' END
        || ' 1d. ai_drafts: authenticated sem acesso; so service_role' || E'\n';
  v_r := v_r || CASE WHEN has_table_privilege('authenticated', 'public.ai_eval_runs', 'SELECT')
                      AND NOT has_table_privilege('authenticated', 'public.ai_eval_runs', 'INSERT')
                      AND NOT has_table_privilege('authenticated', 'public.ai_eval_runs', 'UPDATE')
                      AND NOT has_table_privilege('authenticated', 'public.ai_eval_runs', 'DELETE')
                      AND has_table_privilege('authenticated', 'public.ai_eval_results', 'SELECT')
                      AND NOT has_table_privilege('authenticated', 'public.ai_eval_results', 'INSERT')
                      AND NOT has_table_privilege('authenticated', 'public.ai_eval_results', 'DELETE')
                      AND has_column_privilege('authenticated', 'public.ai_eval_results', 'verdict', 'UPDATE')
                      AND NOT has_column_privilege('authenticated', 'public.ai_eval_results', 'response', 'UPDATE')
                      AND NOT has_column_privilege('authenticated', 'public.ai_eval_results', 'auto_pass', 'UPDATE')
                 THEN 'ok   ' ELSE 'FALHA' END
        || ' 1e. runs: so SELECT; results: SELECT e UPDATE so do veredito' || E'\n';
  v_r := v_r || CASE WHEN (SELECT count(*) FROM pg_class
                            WHERE oid IN ('public.ai_examples'::regclass, 'public.ai_drafts'::regclass,
                                          'public.ai_eval_cases'::regclass, 'public.ai_eval_runs'::regclass,
                                          'public.ai_eval_results'::regclass)
                              AND relrowsecurity) = 5
                 THEN 'ok   ' ELSE 'FALHA' END
        || ' 1f. RLS ligada nas 5 tabelas' || E'\n';

  -- ---------- 2) anon barrado ----------
  BEGIN
    SET LOCAL ROLE anon;
    PERFORM * FROM match_ai_examples(v_a, v_q, 'text-embedding-3-small', 3, 0.55::real);
    RESET ROLE;
    v_r := v_r || 'FALHA 2a. anon executou match_ai_examples' || E'\n';
  EXCEPTION WHEN insufficient_privilege THEN
    RESET ROLE;
    v_r := v_r || 'ok    2a. anon barrado na RPC (permission denied)' || E'\n';
  END;
  BEGIN
    SET LOCAL ROLE anon;
    PERFORM count(*) FROM ai_examples;
    RESET ROLE;
    v_r := v_r || 'FALHA 2b. anon leu ai_examples' || E'\n';
  EXCEPTION WHEN insufficient_privilege THEN
    RESET ROLE;
    v_r := v_r || 'ok    2b. anon barrado na tabela (permission denied)' || E'\n';
  END;

  -- ---------- 3) service_role: dados de teste e a RPC ----------
  SET LOCAL ROLE service_role;
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);

  -- A: 'near' e 'near2' aprovados; 'mid' aprovado (modelo sem prefixo);
  -- 'far' aprovado (acima do limiar); 'cand' candidato; 'rej' rejeitado;
  -- 'other-model' aprovado com outro modelo; 'no-emb' aprovado sem vetor.
  -- B: 'b-near' aprovado e perto.
  INSERT INTO ai_examples (account_id, customer_message, ideal_response, status, source, embedding, embedding_model) VALUES
    (v_a, 'zz-f7-near',  'r', 'approved',  'manual',     v_near::vector, 'openai/text-embedding-3-small'),
    (v_a, 'zz-f7-near2', 'r', 'approved',  'manual',     v_near::vector, 'openai/text-embedding-3-small'),
    (v_a, 'zz-f7-mid',   'r', 'approved',  'manual',     v_mid::vector,  'text-embedding-3-small'),
    (v_a, 'zz-f7-far',   'r', 'approved',  'manual',     v_far::vector,  'openai/text-embedding-3-small'),
    (v_a, 'zz-f7-cand',  'r', 'candidate', 'draft_edit', v_near::vector, 'openai/text-embedding-3-small'),
    (v_a, 'zz-f7-rej',   'r', 'rejected',  'draft_edit', v_near::vector, 'openai/text-embedding-3-small'),
    (v_a, 'zz-f7-othermodel', 'r', 'approved', 'manual', v_near::vector, 'some-other-model'),
    (v_a, 'zz-f7-noemb', 'r', 'approved',  'manual',     NULL,           NULL),
    (v_b, 'zz-f7-b-near','r', 'approved',  'manual',     v_near::vector, 'openai/text-embedding-3-small');

  SELECT string_agg(customer_message, ',' ORDER BY distance, id) INTO v_ids
    FROM match_ai_examples(v_a, v_q, 'openai/text-embedding-3-small', 5, 0.55::real);
  v_r := v_r || CASE WHEN v_ids = 'zz-f7-near,zz-f7-near2,zz-f7-mid'
                      OR v_ids = 'zz-f7-near2,zz-f7-near,zz-f7-mid'
                 THEN 'ok   ' ELSE 'FALHA' END
        || format(' 3a. so aprovados, mesmo modelo (com ou sem openai/), com embedding, dentro do limiar: %s', v_ids) || E'\n';

  SELECT count(*) INTO v_n FROM match_ai_examples(v_a, v_q, 'text-embedding-3-small', 5, 0.55::real);
  v_r := v_r || CASE WHEN v_n = 3 THEN 'ok   ' ELSE 'FALHA' END
        || format(' 3b. modelo pedido sem o prefixo openai/ acha os mesmos: %s', v_n) || E'\n';

  SELECT count(*) INTO v_n FROM match_ai_examples(v_a, v_q, 'openai/text-embedding-3-small', 5, 0.55::real)
   WHERE customer_message LIKE 'zz-f7-b-%';
  v_r := v_r || CASE WHEN v_n = 0 THEN 'ok   ' ELSE 'FALHA' END
        || format(' 3c. exemplo da conta B nunca aparece para a A: %s (esperado 0)', v_n) || E'\n';

  SELECT count(*) INTO v_n FROM match_ai_examples(v_a, v_q, 'openai/text-embedding-3-small', 5, 0.55::real)
   WHERE customer_message IN ('zz-f7-cand', 'zz-f7-rej', 'zz-f7-othermodel', 'zz-f7-noemb', 'zz-f7-far');
  v_r := v_r || CASE WHEN v_n = 0 THEN 'ok   ' ELSE 'FALHA' END
        || format(' 3d. candidato, rejeitado, outro modelo, sem vetor e acima do limiar ficam de fora: %s (esperado 0)', v_n) || E'\n';

  SELECT count(*) INTO v_n FROM match_ai_examples(v_a, v_q, 'openai/text-embedding-3-small', 3, 0.01::real);
  v_r := v_r || CASE WHEN v_n = 2 THEN 'ok   ' ELSE 'FALHA' END
        || format(' 3e. limiar 0,01 deixa so os dois mais perto: %s', v_n) || E'\n';

  SELECT count(*) INTO v_n FROM match_ai_examples(v_a, v_q, 'openai/text-embedding-3-small', 1, 2::real);
  v_r := v_r || CASE WHEN v_n = 1 THEN 'ok   ' ELSE 'FALHA' END
        || format(' 3f. p_match_count 1 devolve 1: %s', v_n) || E'\n';

  SELECT count(*) INTO v_n FROM match_ai_examples(v_a, v_q, 'openai/text-embedding-3-small', 99, 2::real);
  v_r := v_r || CASE WHEN v_n <= 5 THEN 'ok   ' ELSE 'FALHA' END
        || format(' 3g. p_match_count 99 e limitado a 5: %s', v_n) || E'\n';

  SELECT customer_message INTO v_ids
    FROM match_ai_examples(v_a, v_q, 'openai/text-embedding-3-small', 5, 2::real)
   ORDER BY distance DESC, id LIMIT 1;
  v_r := v_r || CASE WHEN v_ids = 'zz-f7-far' THEN 'ok   ' ELSE 'FALHA' END
        || format(' 3h. sem limiar o mais distante e o "far" (mais parecido sai primeiro): %s', v_ids) || E'\n';

  SELECT count(*) INTO v_n FROM match_ai_examples(v_a, NULL, 'openai/text-embedding-3-small', 3, 0.55::real);
  v_r := v_r || CASE WHEN v_n = 0 THEN 'ok   ' ELSE 'FALHA' END
        || ' 3i. sem vetor de consulta: nada (sem embeddings nao ha similaridade)' || E'\n';
  SELECT count(*) INTO v_n FROM match_ai_examples(v_a, v_q, '', 3, 0.55::real);
  v_r := v_r || CASE WHEN v_n = 0 THEN 'ok   ' ELSE 'FALHA' END
        || ' 3j. sem modelo: nada' || E'\n';

  -- ---------- 4) CHECKs e índices únicos ----------
  BEGIN
    INSERT INTO ai_examples (account_id, customer_message, ideal_response, status, source)
    VALUES (v_a, 'zz-f7-x', 'r', 'bogus', 'manual');
    v_r := v_r || 'FALHA 4a. status invalido aceito' || E'\n';
  EXCEPTION WHEN check_violation THEN
    v_r := v_r || 'ok    4a. status invalido recusado pelo CHECK' || E'\n';
  END;
  BEGIN
    INSERT INTO ai_examples (account_id, customer_message, ideal_response, status, source)
    VALUES (v_a, 'zz-f7-x', 'r', 'candidate', 'bogus');
    v_r := v_r || 'FALHA 4b. origem invalida aceita' || E'\n';
  EXCEPTION WHEN check_violation THEN
    v_r := v_r || 'ok    4b. origem invalida recusada pelo CHECK' || E'\n';
  END;
  BEGIN
    INSERT INTO ai_examples (account_id, customer_message, ideal_response, status, source)
    VALUES (v_a, repeat('x', 1501), 'r', 'candidate', 'manual');
    v_r := v_r || 'FALHA 4c. mensagem de 1501 caracteres aceita' || E'\n';
  EXCEPTION WHEN check_violation THEN
    v_r := v_r || 'ok    4c. mensagem acima de 1500 recusada pelo CHECK' || E'\n';
  END;
  BEGIN
    INSERT INTO ai_eval_cases (account_id, title, conversation) VALUES (v_a, 'zz-f7-c', '[]'::jsonb);
    v_r := v_r || 'FALHA 4d. caso com conversa vazia aceito' || E'\n';
  EXCEPTION WHEN check_violation THEN
    v_r := v_r || 'ok    4d. conversa vazia recusada pelo CHECK' || E'\n';
  END;
  BEGIN
    INSERT INTO ai_eval_cases (account_id, title, conversation) VALUES (v_a, 'zz-f7-c', '{"a":1}'::jsonb);
    v_r := v_r || 'FALHA 4e. conversa que nao e lista aceita' || E'\n';
  EXCEPTION WHEN check_violation THEN
    v_r := v_r || 'ok    4e. conversa que nao e lista recusada pelo CHECK' || E'\n';
  END;

  INSERT INTO ai_eval_runs (account_id, status, provider, model, prompt_hash, case_count)
  VALUES (v_a, 'running', 'openrouter', 'm', 'h', 1) RETURNING id INTO v_run;
  BEGIN
    INSERT INTO ai_eval_runs (account_id, status, provider, model, prompt_hash, case_count)
    VALUES (v_a, 'running', 'openrouter', 'm', 'h', 1);
    v_r := v_r || 'FALHA 4f. duas rodadas running na mesma conta' || E'\n';
  EXCEPTION WHEN unique_violation THEN
    v_r := v_r || 'ok    4f. so uma rodada running por conta (indice unico parcial)' || E'\n';
  END;
  BEGIN
    INSERT INTO ai_eval_runs (account_id, status, provider, model, prompt_hash, case_count)
    VALUES (v_b, 'running', 'openrouter', 'm', 'h', 1);
    UPDATE ai_eval_runs SET status = 'done' WHERE account_id = v_b AND status = 'running';
    UPDATE ai_eval_runs SET status = 'done' WHERE id = v_run;
    INSERT INTO ai_eval_runs (account_id, status, provider, model, prompt_hash, case_count)
    VALUES (v_a, 'running', 'openrouter', 'm', 'h', 1);
    v_r := v_r || 'ok    4g. depois de fechada, a conta pode abrir outra rodada' || E'\n';
  EXCEPTION WHEN unique_violation THEN
    v_r := v_r || 'FALHA 4g. rodada fechada ainda bloqueia a conta' || E'\n';
  END;

  IF v_msg IS NOT NULL THEN
    INSERT INTO ai_examples (account_id, customer_message, ideal_response, status, source, source_message_id)
    VALUES (v_a, 'zz-f7-m1', 'r', 'candidate', 'draft_edit', v_msg);
    BEGIN
      INSERT INTO ai_examples (account_id, customer_message, ideal_response, status, source, source_message_id)
      VALUES (v_a, 'zz-f7-m2', 'r', 'candidate', 'draft_edit', v_msg);
      v_r := v_r || 'FALHA 4h. a mesma mensagem gerou dois candidatos' || E'\n';
    EXCEPTION WHEN unique_violation THEN
      v_r := v_r || 'ok    4h. uma mensagem gera no maximo um candidato' || E'\n';
    END;
  ELSE
    v_r := v_r || 'ok    4h. (pulado: a conta A nao tem mensagem para ligar)' || E'\n';
  END IF;

  -- Resultado de teste para o item 6.
  INSERT INTO ai_eval_results (run_id, account_id, case_title, conversation, expect_handoff, response)
  VALUES (v_run, v_a, 'zz-f7-t', '[{"role":"user","content":"q"}]'::jsonb, false, 'resp-a')
  RETURNING id INTO v_res;
  INSERT INTO ai_eval_results (run_id, account_id, case_title, conversation, expect_handoff, response)
  SELECT r.id, v_b, 'zz-f7-tb', '[{"role":"user","content":"q"}]'::jsonb, false, 'resp-b'
    FROM ai_eval_runs r WHERE r.account_id = v_b LIMIT 1;

  -- Rascunho de teste (só service_role).
  IF v_conv IS NOT NULL THEN
    INSERT INTO ai_drafts (account_id, conversation_id, user_id, customer_message, draft_text)
    VALUES (v_a, v_conv, v_u, 'zz-f7-d', 'rascunho');
  END IF;
  RESET ROLE;

  -- ---------- 5) authenticated (admin da conta A) ----------
  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', v_u)::text, true);

  SELECT count(*) INTO v_n FROM match_ai_examples(v_a, v_q, 'openai/text-embedding-3-small', 3, 0.55::real);
  v_r := v_r || CASE WHEN v_n = 3 THEN 'ok   ' ELSE 'FALHA' END
        || format(' 5a. admin da conta chama a RPC para a propria conta: %s', v_n) || E'\n';
  BEGIN
    PERFORM * FROM match_ai_examples(v_b, v_q, 'openai/text-embedding-3-small', 3, 0.55::real);
    v_r := v_r || 'FALHA 5b. admin chamou a RPC com a conta B' || E'\n';
  EXCEPTION WHEN insufficient_privilege THEN
    v_r := v_r || 'ok    5b. conta alheia recusada na RPC (42501)' || E'\n';
  END;

  SELECT count(*) INTO v_n FROM ai_examples WHERE account_id = v_a;
  v_r := v_r || CASE WHEN v_n >= 8 THEN 'ok   ' ELSE 'FALHA' END
        || format(' 5c. admin le os exemplos da propria conta: %s', v_n) || E'\n';
  SELECT count(*) INTO v_n FROM ai_examples WHERE account_id = v_b;
  v_r := v_r || CASE WHEN v_n = 0 THEN 'ok   ' ELSE 'FALHA' END
        || format(' 5d. o mesmo admin nao le os exemplos da conta B: %s (esperado 0)', v_n) || E'\n';

  INSERT INTO ai_examples (account_id, customer_message, ideal_response, status, source)
  VALUES (v_a, 'zz-f7-own', 'r', 'candidate', 'manual');
  v_r := v_r || 'ok    5e. admin insere na propria conta' || E'\n';
  BEGIN
    INSERT INTO ai_examples (account_id, customer_message, ideal_response, status, source)
    VALUES (v_b, 'zz-f7-evil', 'r', 'approved', 'manual');
    v_r := v_r || 'FALHA 5f. admin inseriu exemplo na conta B' || E'\n';
  EXCEPTION WHEN insufficient_privilege THEN
    v_r := v_r || 'ok    5f. insercao na conta B recusada pela RLS' || E'\n';
  END;

  UPDATE ai_examples SET ideal_response = 'hacked' WHERE account_id = v_b;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  v_r := v_r || CASE WHEN v_rows = 0 THEN 'ok   ' ELSE 'FALHA' END
        || format(' 5g. UPDATE na conta B afeta %s linha(s) (esperado 0)', v_rows) || E'\n';
  DELETE FROM ai_examples WHERE account_id = v_b;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  v_r := v_r || CASE WHEN v_rows = 0 THEN 'ok   ' ELSE 'FALHA' END
        || format(' 5h. DELETE na conta B afeta %s linha(s) (esperado 0)', v_rows) || E'\n';

  BEGIN
    PERFORM count(*) FROM ai_drafts;
    v_r := v_r || 'FALHA 5i. authenticated leu ai_drafts' || E'\n';
  EXCEPTION WHEN insufficient_privilege THEN
    v_r := v_r || 'ok    5i. ai_drafts: authenticated barrado (permission denied)' || E'\n';
  END;

  BEGIN
    INSERT INTO ai_eval_runs (account_id, provider, model, prompt_hash, case_count)
    VALUES (v_a, 'openrouter', 'm', 'h', 1);
    v_r := v_r || 'FALHA 5j. authenticated inseriu rodada' || E'\n';
  EXCEPTION WHEN insufficient_privilege THEN
    v_r := v_r || 'ok    5j. rodada so e escrita pelo servidor (INSERT negado)' || E'\n';
  END;

  SELECT count(*) INTO v_n FROM ai_eval_results WHERE account_id = v_a;
  v_r := v_r || CASE WHEN v_n >= 1 THEN 'ok   ' ELSE 'FALHA' END
        || format(' 5k. admin le os resultados da propria conta: %s', v_n) || E'\n';
  SELECT count(*) INTO v_n FROM ai_eval_results WHERE account_id = v_b;
  v_r := v_r || CASE WHEN v_n = 0 THEN 'ok   ' ELSE 'FALHA' END
        || format(' 5l. e nao os da conta B: %s (esperado 0)', v_n) || E'\n';

  UPDATE ai_eval_results SET verdict = 'pass', judged_by = v_u, judged_at = now() WHERE id = v_res;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  v_r := v_r || CASE WHEN v_rows = 1 THEN 'ok   ' ELSE 'FALHA' END
        || ' 5m. admin grava o veredito do proprio resultado' || E'\n';
  BEGIN
    UPDATE ai_eval_results SET response = 'forged' WHERE id = v_res;
    v_r := v_r || 'FALHA 5n. admin alterou a resposta gravada' || E'\n';
  EXCEPTION WHEN insufficient_privilege THEN
    v_r := v_r || 'ok    5n. so o veredito e atualizavel (coluna response negada)' || E'\n';
  END;
  UPDATE ai_eval_results SET verdict = 'fail' WHERE account_id = v_b;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  v_r := v_r || CASE WHEN v_rows = 0 THEN 'ok   ' ELSE 'FALHA' END
        || format(' 5o. veredito na conta B afeta %s linha(s) (esperado 0)', v_rows) || E'\n';

  INSERT INTO ai_eval_cases (account_id, title, conversation)
  VALUES (v_a, 'zz-f7-case', '[{"role":"user","content":"oi"}]'::jsonb);
  SELECT count(*) INTO v_n FROM ai_eval_cases WHERE account_id = v_b;
  v_r := v_r || CASE WHEN v_n = 0 THEN 'ok   ' ELSE 'FALHA' END
        || ' 5p. casos: admin escreve na propria conta e nao le a B' || E'\n';
  RESET ROLE;

  -- ---------- 6) chaves estrangeiras (ações de exclusão) ----------
  v_r := v_r || CASE WHEN (SELECT count(*) FROM pg_constraint
                            WHERE contype = 'f' AND confdeltype = 'c'
                              AND confrelid = 'public.accounts'::regclass
                              AND conrelid IN ('public.ai_examples'::regclass, 'public.ai_drafts'::regclass,
                                               'public.ai_eval_cases'::regclass, 'public.ai_eval_runs'::regclass,
                                               'public.ai_eval_results'::regclass)) = 5
                 THEN 'ok   ' ELSE 'FALHA' END
        || ' 6a. as 5 tabelas apagam junto com a conta (ON DELETE CASCADE)' || E'\n';
  v_r := v_r || CASE WHEN (SELECT confdeltype FROM pg_constraint
                            WHERE contype = 'f' AND conrelid = 'public.ai_examples'::regclass
                              AND confrelid = 'public.conversations'::regclass) = 'n'
                      AND (SELECT confdeltype FROM pg_constraint
                            WHERE contype = 'f' AND conrelid = 'public.ai_examples'::regclass
                              AND confrelid = 'public.messages'::regclass) = 'n'
                 THEN 'ok   ' ELSE 'FALHA' END
        || ' 6b. exemplo: conversa e mensagem apagadas viram NULL (o exemplo ja e anonimo)' || E'\n';
  v_r := v_r || CASE WHEN (SELECT confdeltype FROM pg_constraint
                            WHERE contype = 'f' AND conrelid = 'public.ai_eval_results'::regclass
                              AND confrelid = 'public.ai_eval_runs'::regclass) = 'c'
                 THEN 'ok   ' ELSE 'FALHA' END
        || ' 6c. resultado some com a rodada' || E'\n';

  v_fail := (length(v_r) - length(replace(v_r, 'FALHA', ''))) / 5;
  RAISE EXCEPTION E'F7_TESTE_REVERTIDO\n%\nFalhas: %', v_r, v_fail;
END;
$$;
