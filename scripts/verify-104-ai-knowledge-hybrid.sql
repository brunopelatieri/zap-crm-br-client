-- verify-104-ai-knowledge-hybrid.sql — conferência da F3 da SPEC 089. NÃO é migração.
--
-- Para o SQL Editor (ou MCP) do projeto confirmado: o `vn`. Rode DEPOIS de
-- aplicar `supabase/migrations/104_ai_knowledge_hybrid.sql`. Uma consulta só.
-- Roda os testes DENTRO de um bloco que sempre termina em RAISE EXCEPTION: o
-- Postgres desfaz tudo (documentos, fatias e a troca de papel). O relatório
-- vem na mensagem do erro, que começa com `F3_TESTE_REVERTIDO`; cada linha
-- começa com `ok` ou `FALHA`, e a última diz quantas falharam. Depois de
-- rodar, confira que
--   select count(*) from ai_knowledge_documents where title like 'zz-f3-%'
-- é 0.
--
-- Usa um membro qualquer (conta A) e uma conta da qual ele NÃO é membro
-- (conta B). Vetores de teste: e1, e2, e3 são vetores unitários ortogonais
-- (distância cosseno e1–e1 = 0; e1–e2 = e1–e3 = 1).
--
-- Cobre: privilégios (anon/PUBLIC sem EXECUTE, authenticated com), recusa de
-- conta alheia (42501), isolamento entre contas na RPC nova E nas antigas
-- (regressão da 103), `fts_pt` ("preços" acha "preço", com e sem acento),
-- limiar de distância, filtro por modelo de embedding (com a normalização
-- `openai/`), `is_enabled`, status `ready`, soma RRF e a coluna de uso.

DO $$
DECLARE
  v_u     UUID;
  v_a     UUID;
  v_b     UUID;
  v_da    UUID;
  v_dx    UUID;   -- documento desligado
  v_dp    UUID;   -- documento pending
  v_db    UUID;
  v_e1    TEXT;
  v_e2    TEXT;
  v_e3    TEXT;
  v_n     BIGINT;
  v_src   TEXT;
  v_score DOUBLE PRECISION;
  v_dist  REAL;
  v_fn    TEXT;
  v_msg   TEXT;
  v_r     TEXT := '';
  v_fail  INT;
BEGIN
  -- ---------- Dados ----------
  SELECT p.user_id, p.account_id INTO v_u, v_a
    FROM profiles p
   WHERE p.blocked_at IS NULL
   ORDER BY p.user_id LIMIT 1;
  SELECT a.id INTO v_b
    FROM accounts a
   WHERE a.id <> v_a
     AND NOT EXISTS (SELECT 1 FROM profiles p WHERE p.account_id = a.id AND p.user_id = v_u)
   ORDER BY a.id LIMIT 1;
  IF v_u IS NULL OR v_b IS NULL THEN
    RAISE EXCEPTION 'F3_TESTE_ABORTADO precisa de um membro e de uma segunda conta da qual ele nao e membro';
  END IF;

  -- A trigger de quota do 103 não deve atrapalhar a inserção de teste.
  UPDATE platform_settings SET quotas_enforced = FALSE;

  v_e1 := '[' || array_to_string(ARRAY(SELECT CASE WHEN g = 1 THEN 1 ELSE 0 END FROM generate_series(1, 1536) g), ',') || ']';
  v_e2 := '[' || array_to_string(ARRAY(SELECT CASE WHEN g = 2 THEN 1 ELSE 0 END FROM generate_series(1, 1536) g), ',') || ']';
  v_e3 := '[' || array_to_string(ARRAY(SELECT CASE WHEN g = 3 THEN 1 ELSE 0 END FROM generate_series(1, 1536) g), ',') || ']';

  INSERT INTO ai_knowledge_documents (account_id, title, content, status, is_enabled)
  VALUES (v_a, 'zz-f3-a', 'x', 'ready', TRUE) RETURNING id INTO v_da;
  INSERT INTO ai_knowledge_documents (account_id, title, content, status, is_enabled)
  VALUES (v_a, 'zz-f3-desligado', 'x', 'ready', FALSE) RETURNING id INTO v_dx;
  INSERT INTO ai_knowledge_documents (account_id, title, content, status, is_enabled)
  VALUES (v_a, 'zz-f3-pending', 'x', 'pending', TRUE) RETURNING id INTO v_dp;
  INSERT INTO ai_knowledge_documents (account_id, title, content, status, is_enabled)
  VALUES (v_b, 'zz-f3-b', 'x', 'ready', TRUE) RETURNING id INTO v_db;

  -- Conta A, documento ligado e pronto:
  --   c0 "preço" (e1, modelo sem prefixo)  c1 "troca" (e2, modelo COM prefixo openai/)
  --   c2 "atendimento" (e3, outro modelo)  c3 "entrega" sem vetor
  INSERT INTO ai_knowledge_chunks (document_id, account_id, chunk_index, content, heading, embedding, embedding_model) VALUES
    (v_da, v_a, 0, 'O preço do plano básico é R$ 99 por mês.',            'zz-f3-a', v_e1::vector, 'text-embedding-3-small'),
    (v_da, v_a, 1, 'A troca de produto é aceita em até sete dias.',        'zz-f3-a', v_e2::vector, 'openai/text-embedding-3-small'),
    (v_da, v_a, 2, 'Horário de atendimento: segunda a sexta, das 9h às 18h.', 'zz-f3-a', v_e3::vector, 'outro-modelo'),
    (v_da, v_a, 3, 'A entrega é feita pelos Correios em cinco dias úteis.', 'zz-f3-a', NULL, NULL);
  -- Documento desligado e documento pending: nunca aparecem.
  INSERT INTO ai_knowledge_chunks (document_id, account_id, chunk_index, content, heading, embedding, embedding_model) VALUES
    (v_dx, v_a, 0, 'preço secreto do documento desligado', 'zz-f3-desligado', v_e1::vector, 'text-embedding-3-small'),
    (v_dp, v_a, 0, 'preço do documento ainda pending',      'zz-f3-pending',   v_e1::vector, 'text-embedding-3-small');
  -- Conta B: mesma palavra e mesmo vetor.
  INSERT INTO ai_knowledge_chunks (document_id, account_id, chunk_index, content, heading, embedding, embedding_model) VALUES
    (v_db, v_b, 0, 'O preço do plano de OUTRA conta é R$ 1.', 'zz-f3-b', v_e1::vector, 'text-embedding-3-small');

  -- ---------- 1) estrutura e privilégios ----------
  v_fn := 'public.match_ai_knowledge_hybrid(uuid,text,text,text,integer,real)';
  v_r := v_r || CASE WHEN NOT has_function_privilege('anon', v_fn, 'EXECUTE')
                      AND NOT has_function_privilege('public', v_fn, 'EXECUTE')
                      AND has_function_privilege('authenticated', v_fn, 'EXECUTE')
                      AND has_function_privilege('service_role', v_fn, 'EXECUTE')
                 THEN 'ok   ' ELSE 'FALHA' END
        || ' 1a. RPC hibrida: anon/PUBLIC sem EXECUTE; authenticated e service_role com' || E'\n';
  v_r := v_r || CASE WHEN NOT has_function_privilege('anon', 'public.ai_unaccent(text)', 'EXECUTE')
                      AND NOT has_function_privilege('public', 'public.ai_unaccent(text)', 'EXECUTE')
                 THEN 'ok   ' ELSE 'FALHA' END || ' 1b. ai_unaccent: anon/PUBLIC sem EXECUTE' || E'\n';
  v_r := v_r || CASE WHEN EXISTS (SELECT 1 FROM pg_proc WHERE oid = v_fn::regprocedure AND prosecdef
                                    AND EXISTS (SELECT 1 FROM unnest(proconfig) c WHERE c LIKE 'search_path=%'))
                 THEN 'ok   ' ELSE 'FALHA' END || ' 1c. RPC hibrida: SECURITY DEFINER com search_path fixo' || E'\n';
  -- Por nome: a 104b apaga as duas (nenhuma linha = ok tambem).
  v_r := v_r || CASE WHEN NOT EXISTS (SELECT 1 FROM pg_proc
                                       WHERE pronamespace = 'public'::regnamespace
                                         AND proname IN ('match_ai_knowledge_fts', 'match_ai_knowledge_semantic')
                                         AND prosecdef)
                 THEN 'ok   ' ELSE 'FALHA' END || ' 1d. RPCs antigas, se existirem, sao SECURITY INVOKER (regressao da 103)' || E'\n';

  -- ---------- 2) anon não executa ----------
  BEGIN
    SET LOCAL ROLE anon;
    PERFORM * FROM match_ai_knowledge_hybrid(v_a, 'preço', NULL, NULL, 5, 0.5);
    RESET ROLE;
    v_r := v_r || 'FALHA 2. anon executou a RPC hibrida' || E'\n';
  EXCEPTION WHEN insufficient_privilege THEN
    RESET ROLE;
    v_r := v_r || 'ok    2. anon barrado na RPC hibrida (permission denied)' || E'\n';
  END;

  -- ---------- 3) service_role: lexical, fts_pt, vetor ----------
  SET LOCAL ROLE service_role;
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);

  -- "preços" (plural, com cedilha) acha "preço" via fts_pt; só da conta A.
  SELECT count(*), max(source) INTO v_n, v_src
    FROM match_ai_knowledge_hybrid(v_a, 'preços', NULL, NULL, 5, 0.5);
  v_r := v_r || CASE WHEN v_n = 1 AND v_src = 'lexical' THEN 'ok   ' ELSE 'FALHA' END
        || format(' 3a. "precos" acha "preco" so na conta A: %s fatia(s), origem %s (esperado 1, lexical)', v_n, v_src) || E'\n';

  -- Sem acento na pergunta, com acento no texto.
  SELECT count(*) INTO v_n FROM match_ai_knowledge_hybrid(v_a, 'preco', NULL, NULL, 5, 0.5);
  v_r := v_r || CASE WHEN v_n = 1 THEN 'ok   ' ELSE 'FALHA' END
        || format(' 3b. "preco" (sem acento) acha "preço": %s (esperado 1)', v_n) || E'\n';

  -- Documento desligado e pending nunca entram.
  SELECT count(*) INTO v_n FROM match_ai_knowledge_hybrid(v_a, 'secreto pending', NULL, NULL, 5, 0.5);
  v_r := v_r || CASE WHEN v_n = 0 THEN 'ok   ' ELSE 'FALHA' END
        || format(' 3c. documento desligado/pending fora da busca: %s (esperado 0)', v_n) || E'\n';

  -- Operador do websearch: "or" amplia, o resultado traz o título do documento.
  SELECT count(*) INTO v_n FROM match_ai_knowledge_hybrid(v_a, 'preço or entrega', NULL, NULL, 5, 0.5)
   WHERE title = 'zz-f3-a';
  v_r := v_r || CASE WHEN v_n = 2 THEN 'ok   ' ELSE 'FALHA' END
        || format(' 3d. "preco or entrega" acha 2 fatias com o titulo do documento: %s (esperado 2)', v_n) || E'\n';

  -- Pergunta vazia e sem vetor = nada.
  SELECT count(*) INTO v_n FROM match_ai_knowledge_hybrid(v_a, '   ', NULL, NULL, 5, 0.5);
  v_r := v_r || CASE WHEN v_n = 0 THEN 'ok   ' ELSE 'FALHA' END
        || format(' 3e. pergunta vazia sem vetor: %s (esperado 0)', v_n) || E'\n';

  -- ---------- 4) semântica, limiar, modelo, RRF ----------
  -- e1, limiar 0,5: só c0 (distância 0). c1 (distância 1) fica acima e não casa na léxica.
  SELECT count(*), max(source), min(distance) INTO v_n, v_src, v_dist
    FROM match_ai_knowledge_hybrid(v_a, 'zzsemcasamento', v_e1, 'text-embedding-3-small', 5, 0.5);
  v_r := v_r || CASE WHEN v_n = 1 AND v_src = 'semantic' AND v_dist = 0 THEN 'ok   ' ELSE 'FALHA' END
        || format(' 4a. limiar 0.5: %s fatia(s), origem %s, distancia %s (esperado 1, semantic, 0)', v_n, v_src, v_dist) || E'\n';

  -- Sem limiar útil (2): c1 (modelo com prefixo openai/) também entra; c2 (outro modelo) nunca.
  SELECT count(*) INTO v_n
    FROM match_ai_knowledge_hybrid(v_a, 'zzsemcasamento', v_e1, 'text-embedding-3-small', 5, 2);
  v_r := v_r || CASE WHEN v_n = 2 THEN 'ok   ' ELSE 'FALHA' END
        || format(' 4b. limiar 2: %s fatias (esperado 2: c0 e c1; "outro-modelo" filtrado, openai/ normalizado)', v_n) || E'\n';

  -- O modelo pedido com prefixo acha as mesmas fatias.
  SELECT count(*) INTO v_n
    FROM match_ai_knowledge_hybrid(v_a, 'zzsemcasamento', v_e1, 'openai/text-embedding-3-small', 5, 2);
  v_r := v_r || CASE WHEN v_n = 2 THEN 'ok   ' ELSE 'FALHA' END
        || format(' 4c. modelo pedido com prefixo openai/: %s fatias (esperado 2)', v_n) || E'\n';

  -- Outro modelo pedido: nenhuma fatia semântica.
  SELECT count(*) INTO v_n
    FROM match_ai_knowledge_hybrid(v_a, 'zzsemcasamento', v_e1, 'modelo-inexistente', 5, 2);
  v_r := v_r || CASE WHEN v_n = 0 THEN 'ok   ' ELSE 'FALHA' END
        || format(' 4d. modelo pedido sem fatias: %s (esperado 0)', v_n) || E'\n';

  -- Fatia acima do limiar MAS com casamento léxico entra, como 'lexical'.
  -- Pergunta e2 + palavra "preço": c0 (e1, distancia 1 > 0.5) casa na léxica; c1 e2 dist 0 é semântica.
  SELECT count(*) FILTER (WHERE source = 'lexical'), count(*) FILTER (WHERE source = 'semantic')
    INTO v_n, v_dist
    FROM match_ai_knowledge_hybrid(v_a, 'preço', v_e2, 'text-embedding-3-small', 5, 0.5);
  v_r := v_r || CASE WHEN v_n = 1 AND v_dist = 1 THEN 'ok   ' ELSE 'FALHA' END
        || format(' 4e. acima do limiar mas com palavra: %s lexical, %s semantic (esperado 1 e 1)', v_n, v_dist::bigint) || E'\n';

  -- RRF: c0 é 1º na semântica (e1) e 1º na léxica ("preço"): 1/61 + 1/61.
  SELECT score, source INTO v_score, v_src
    FROM match_ai_knowledge_hybrid(v_a, 'preço', v_e1, 'text-embedding-3-small', 5, 0.5)
   ORDER BY score DESC LIMIT 1;
  v_r := v_r || CASE WHEN v_src = 'both' AND abs(v_score - 2.0 / 61) < 1e-9 THEN 'ok   ' ELSE 'FALHA' END
        || format(' 4f. RRF: origem %s, score %s (esperado both, %s)', v_src, round(v_score::numeric, 6), round((2.0 / 61)::numeric, 6)) || E'\n';

  -- Conta B nunca aparece em chamada com o id da A (mesmo vetor, mesma palavra).
  SELECT count(*) INTO v_n
    FROM match_ai_knowledge_hybrid(v_a, 'preço', v_e1, 'text-embedding-3-small', 20, 2) r
    JOIN ai_knowledge_chunks c ON c.id = r.chunk_id
   WHERE c.account_id <> v_a;
  v_r := v_r || CASE WHEN v_n = 0 THEN 'ok   ' ELSE 'FALHA' END
        || format(' 4g. fatias de outra conta numa chamada da A: %s (esperado 0)', v_n) || E'\n';

  RESET ROLE;

  -- ---------- 5) authenticated: membro da A, estranho à B ----------
  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', v_u)::text, true);

  SELECT count(*) INTO v_n FROM match_ai_knowledge_hybrid(v_a, 'preço', NULL, NULL, 5, 0.5);
  v_r := v_r || CASE WHEN v_n = 1 THEN 'ok   ' ELSE 'FALHA' END
        || format(' 5a. membro le a propria conta: %s fatia(s) (esperado 1)', v_n) || E'\n';

  BEGIN
    PERFORM * FROM match_ai_knowledge_hybrid(v_b, 'preço', v_e1, 'text-embedding-3-small', 5, 2);
    v_r := v_r || 'FALHA 5b. membro leu a conta de OUTRO tenant pela RPC hibrida' || E'\n';
  EXCEPTION WHEN insufficient_privilege THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    v_r := v_r || 'ok    5b. conta alheia recusada na RPC hibrida (' || v_msg || ')' || E'\n';
  END;

  -- Regressão da 103: as RPCs antigas, chamadas por um membro com o id de
  -- outra conta, não devolvem nada (INVOKER + RLS). A 104b as apaga; sem
  -- elas este bloco não se aplica.
  IF to_regprocedure('public.match_ai_knowledge_fts(uuid,text,integer)') IS NULL THEN
    v_r := v_r || 'ok    5c-5e. RPCs antigas removidas (104b): nada a conferir' || E'\n';
  ELSE
    SELECT count(*) INTO v_n FROM match_ai_knowledge_fts(v_b, 'preço', 5);
    v_r := v_r || CASE WHEN v_n = 0 THEN 'ok   ' ELSE 'FALHA' END
          || format(' 5c. match_ai_knowledge_fts com conta alheia: %s (esperado 0)', v_n) || E'\n';
    SELECT count(*) INTO v_n FROM match_ai_knowledge_semantic(v_b, v_e1, 5);
    v_r := v_r || CASE WHEN v_n = 0 THEN 'ok   ' ELSE 'FALHA' END
          || format(' 5d. match_ai_knowledge_semantic com conta alheia: %s (esperado 0)', v_n) || E'\n';
    SELECT count(*) INTO v_n FROM match_ai_knowledge_fts(v_a, 'preço', 5);
    v_r := v_r || CASE WHEN v_n >= 1 THEN 'ok   ' ELSE 'FALHA' END
          || format(' 5e. match_ai_knowledge_fts na propria conta segue funcionando: %s (esperado >= 1)', v_n) || E'\n';
  END IF;

  RESET ROLE;

  -- ---------- 6) sem sessão (nem service_role, nem membro) ----------
  PERFORM set_config('request.jwt.claims', '', true);
  BEGIN
    SET LOCAL ROLE authenticated;
    PERFORM * FROM match_ai_knowledge_hybrid(v_a, 'preço', NULL, NULL, 5, 0.5);
    RESET ROLE;
    v_r := v_r || 'FALHA 6. chamada sem claims foi aceita' || E'\n';
  EXCEPTION WHEN insufficient_privilege THEN
    RESET ROLE;
    v_r := v_r || 'ok    6. authenticated sem claims recusado' || E'\n';
  END;

  -- ---------- 7) coluna de uso ----------
  v_r := v_r || CASE WHEN EXISTS (SELECT 1 FROM information_schema.columns
                                   WHERE table_schema = 'public' AND table_name = 'ai_usage_log'
                                     AND column_name = 'knowledge_document_ids')
                 THEN 'ok   ' ELSE 'FALHA' END || ' 7. ai_usage_log.knowledge_document_ids existe' || E'\n';

  v_fail := (length(v_r) - length(replace(v_r, 'FALHA', ''))) / 5;
  RAISE EXCEPTION E'F3_TESTE_REVERTIDO\n%\nFalhas: %', v_r, v_fail;
END;
$$;
