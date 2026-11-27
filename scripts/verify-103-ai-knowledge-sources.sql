-- verify-103-ai-knowledge-sources.sql — conferência da F2 da SPEC 089. NÃO é migração.
--
-- Para o SQL Editor (ou MCP) do projeto confirmado: o `vn`. Rode DEPOIS de
-- aplicar `supabase/migrations/103_ai_knowledge_sources.sql`. Uma consulta só.
-- Roda os testes DENTRO de um bloco que sempre termina em RAISE EXCEPTION: o
-- Postgres desfaz tudo (documentos e fatias de teste, override de plano,
-- interruptor de quotas, contadores). O relatório vem na mensagem do erro, que
-- começa com `F2_TESTE_REVERTIDO`. Nunca deve sobrar dado: depois de rodar,
-- confira que `select count(*) from ai_knowledge_documents where title like 'zz-f2-%'` é 0.
--
-- Usa a primeira conta que tem plano. Overrides e `quotas_enforced` só valem
-- dentro da transação.

DO $$
DECLARE
  v_acc   UUID;
  v_d1    UUID;
  v_d2    UUID;
  v_val   BIGINT;
  v_cnt   BIGINT;
  v_r     TEXT := '';
  v_fn    TEXT;
  v_base  BIGINT;
BEGIN
  SELECT account_id INTO v_acc FROM account_plans ORDER BY created_at LIMIT 1;
  IF v_acc IS NULL THEN
    RAISE EXCEPTION 'F2_TESTE_ABORTADO nenhuma conta com plano';
  END IF;

  -- Estado de partida: nada de linha antiga fora do esperado.
  SELECT count(*) INTO v_cnt FROM ai_knowledge_documents
   WHERE content_hash IS NULL OR status NOT IN ('pending','indexing','ready','error');
  v_r := v_r || format('0a. documentos sem hash ou com estado invalido = %s (esperado 0)%s', v_cnt, E'\n');

  SELECT count(*) INTO v_cnt FROM ai_knowledge_documents d
   WHERE d.status = 'ready'
     AND d.chunk_count <> (SELECT count(*) FROM ai_knowledge_chunks c WHERE c.document_id = d.id);
  v_r := v_r || format('0b. documentos ready com chunk_count diferente das fatias = %s (esperado 0)%s', v_cnt, E'\n');

  -- Quota ligada e limite 1 só nesta transação.
  UPDATE platform_settings SET quotas_enforced = TRUE;
  -- Limite = documentos que a conta já tem + 1: cabe exatamente mais um.
  SELECT count(*) INTO v_base FROM ai_knowledge_documents WHERE account_id = v_acc;
  UPDATE account_plans
     SET limit_overrides = limit_overrides || jsonb_build_object('knowledge_documents', v_base + 1)
   WHERE account_id = v_acc;

  -- 1) o documento que completa o limite cabe
  INSERT INTO ai_knowledge_documents (account_id, title, content, status)
  VALUES (v_acc, 'zz-f2-a', 'zzxyzzy palavra rara de teste', 'pending') RETURNING id INTO v_d1;
  SELECT value INTO v_val FROM account_usage_counters
   WHERE account_id = v_acc AND metric = 'knowledge_documents';
  v_r := v_r || format('1. contador apos o insert = %s (esperado %s)%s', v_val, v_base + 1, E'\n');

  -- 2) o seguinte estoura
  BEGIN
    INSERT INTO ai_knowledge_documents (account_id, title, content, status)
    VALUES (v_acc, 'zz-f2-b', 'segundo', 'pending');
    v_r := v_r || E'2. FALHA: o insert acima do limite passou\n';
  EXCEPTION WHEN OTHERS THEN
    v_r := v_r || format('2. insert acima do limite: %s | %s (esperado P0001 | QUOTA_EXCEEDED:knowledge_documents:%s:%s)%s', SQLSTATE, SQLERRM, v_base + 2, v_base + 1, E'\n');
  END;

  -- 3) excluir libera a vaga
  DELETE FROM ai_knowledge_documents WHERE id = v_d1;
  SELECT value INTO v_cnt FROM account_usage_counters
   WHERE account_id = v_acc AND metric = 'knowledge_documents';
  v_r := v_r || format('3. contador depois de excluir = %s (esperado %s)%s', v_cnt, GREATEST(v_val - 1, 0), E'\n');

  -- Sem o limite, o documento de teste da etapa 4 cabe.
  UPDATE account_plans
     SET limit_overrides = limit_overrides - 'knowledge_documents'
   WHERE account_id = v_acc;

  -- 4) is_enabled nas RPCs antigas (a 104b as apaga: sem elas, este item nao se aplica)
  INSERT INTO ai_knowledge_documents (account_id, title, content, status, is_enabled)
  VALUES (v_acc, 'zz-f2-c', 'zzxyzzy palavra rara de teste', 'ready', TRUE) RETURNING id INTO v_d2;
  INSERT INTO ai_knowledge_chunks (document_id, account_id, chunk_index, content, heading)
  VALUES (v_d2, v_acc, 0, 'zz-f2-c' || E'\n\n' || 'zzxyzzy palavra rara de teste', 'zz-f2-c');

  IF to_regprocedure('public.match_ai_knowledge_fts(uuid,text,integer)') IS NULL THEN
    v_r := v_r || E'4. RPCs antigas removidas (104b): item nao se aplica\n';
  ELSE
    SELECT count(*) INTO v_cnt FROM match_ai_knowledge_fts(v_acc, 'zzxyzzy', 5);
    v_r := v_r || format('4a. busca lexica com o documento ligado = %s (esperado 1)%s', v_cnt, E'\n');

    UPDATE ai_knowledge_documents SET is_enabled = FALSE WHERE id = v_d2;
    SELECT count(*) INTO v_cnt FROM match_ai_knowledge_fts(v_acc, 'zzxyzzy', 5);
    v_r := v_r || format('4b. busca lexica com o documento desligado = %s (esperado 0)%s', v_cnt, E'\n');
  END IF;

  -- 5) privilegios
  FOREACH v_fn IN ARRAY ARRAY[
    'public.enforce_knowledge_document_quota()',
    'public.match_ai_knowledge_fts(uuid,text,integer)',
    'public.match_ai_knowledge_semantic(uuid,text,integer)'
  ] LOOP
    -- As duas RPCs antigas somem com a 104b.
    CONTINUE WHEN to_regprocedure(v_fn) IS NULL;
    v_r := v_r || format('5. anon/PUBLIC executam %s = %s (esperado false)%s',
      v_fn,
      has_function_privilege('anon', v_fn, 'EXECUTE') OR has_function_privilege('public', v_fn, 'EXECUTE'),
      E'\n');
  END LOOP;
  v_r := v_r || format('5b. authenticated executa a funcao interna da quota = %s (esperado false)%s',
    has_function_privilege('authenticated', 'public.enforce_knowledge_document_quota()', 'EXECUTE'), E'\n');

  -- 6) fts_pt e da 104 (F3): informativo, false antes dela e true depois
  v_r := v_r || format('6. coluna fts_pt existe = %s (informativo: e da 104; false antes, true depois)%s',
    EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema = 'public' AND table_name = 'ai_knowledge_chunks' AND column_name = 'fts_pt'),
    E'\n');

  RAISE EXCEPTION E'F2_TESTE_REVERTIDO\n%', v_r;
END;
$$;
