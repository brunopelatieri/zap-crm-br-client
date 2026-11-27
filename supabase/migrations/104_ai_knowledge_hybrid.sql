-- ============================================================
-- 104_ai_knowledge_hybrid.sql — SPEC 089 F3 (recuperação híbrida)
--
-- Escrita LOCAL; aplicar no `vn` só pelo mantenedor (SQL Editor).
-- Idempotente. Depende da 103 (colunas `is_enabled`, `status`,
-- `embedding_model`) e da 102 (`ai_usage_log.cost_usd`).
--
-- 1. Extensão `unaccent` (schema `extensions`) e o wrapper IMMUTABLE
--    `ai_unaccent(text)`. `unaccent()` é STABLE (consulta o dicionário pelo
--    search_path), e coluna gerada exige expressão IMMUTABLE. O wrapper usa
--    a forma de 2 argumentos com o dicionário fixado
--    (`extensions.unaccent`), que é determinística para um dicionário
--    dado — é o padrão documentado para índice sobre `unaccent`.
-- 2. `ai_knowledge_chunks.fts_pt`: coluna gerada
--    `to_tsvector('portuguese', ai_unaccent(content))` + índice GIN, ao lado
--    da `fts` (`simple`) atual (D-11).
-- 3. `match_ai_knowledge_hybrid` (D-10): semântica + léxica, fusão RRF
--    `1/(60+posição)`, limiar de distância, só documento `is_enabled` e
--    `ready`, filtro por `embedding_model` na parte semântica (D-4).
--    SECURITY DEFINER com search_path fixo e guarda de vínculo com a conta
--    para quem não é `service_role`.
-- 4. `ai_usage_log.knowledge_document_ids` (D-14).
-- 5. Correção de segurança nas RPCs ANTIGAS (`match_ai_knowledge_fts` e
--    `_semantic`): a 103 as recriou como SECURITY DEFINER e desfez a 032
--    (GHSA-fg5p-2qc3-jmxr). No `vn` (conferido em 2026-11-27) qualquer
--    usuário autenticado lê fatias de outra conta chamando a RPC com o
--    `account_id` alheio. Voltam a SECURITY INVOKER (RLS decide), mantendo o
--    filtro `is_enabled`. Ficam até a F3 ser validada, depois somem.
-- 6. Asserções.
--
-- Depois de aplicar: `get_advisors` (security) no `vn` e
-- `scripts/verify-104-ai-knowledge-hybrid.sql`.
-- ============================================================

-- ------------------------------------------------------------
-- 1) unaccent + wrapper IMMUTABLE
-- ------------------------------------------------------------
CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS unaccent WITH SCHEMA extensions;

CREATE OR REPLACE FUNCTION public.ai_unaccent(p_text text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
STRICT
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT extensions.unaccent('extensions.unaccent'::regdictionary, p_text);
$$;

COMMENT ON FUNCTION public.ai_unaccent(text) IS
  'SPEC 089 D-11: unaccent IMMUTABLE (dicionario fixado) para a coluna gerada fts_pt. Nao use para outra coisa.';

-- Função pura, sem dado de conta. EXECUTE só a quem escreve fatias (a coluna
-- gerada é avaliada com o privilégio de quem faz o INSERT/UPDATE) e a RPC.
REVOKE ALL ON FUNCTION public.ai_unaccent(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ai_unaccent(text) FROM anon;
GRANT EXECUTE ON FUNCTION public.ai_unaccent(text) TO authenticated, service_role;

-- ------------------------------------------------------------
-- 2) fts_pt + GIN
-- ------------------------------------------------------------
ALTER TABLE public.ai_knowledge_chunks
  ADD COLUMN IF NOT EXISTS fts_pt tsvector
  GENERATED ALWAYS AS (to_tsvector('portuguese', public.ai_unaccent(content))) STORED;

CREATE INDEX IF NOT EXISTS ai_knowledge_chunks_fts_pt_idx
  ON public.ai_knowledge_chunks USING gin (fts_pt);

COMMENT ON COLUMN public.ai_knowledge_chunks.fts_pt IS
  'SPEC 089 D-11: tsvector portuguese + unaccent, ao lado de fts (simple).';

-- ------------------------------------------------------------
-- 3) match_ai_knowledge_hybrid
-- ------------------------------------------------------------
-- p_query            texto para a busca léxica, em sintaxe websearch
--                    (aspas, "or", "-"); o cliente (TS) monta "a or b or c".
-- p_query_embedding  literal pgvector '[0.1,...]' ou NULL (sem chave de
--                    embeddings: só a parte léxica).
-- p_embedding_model  identificador PEDIDO ao provedor; a comparação trata
--                    'openai/text-embedding-3-small' e 'text-embedding-3-small'
--                    como o mesmo modelo (mesmo modelo de 1536 dimensões por
--                    dois provedores), D-4.
-- p_max_distance     limiar de distância cosseno (0..2); NULL = sem limiar.
--                    Fatia semântica acima dele só entra se casar na léxica.
--
-- Retorno: uma linha por fatia, ordenada por `score` (soma RRF). `source` diz
-- de onde veio: 'semantic', 'lexical' ou 'both'.
CREATE OR REPLACE FUNCTION public.match_ai_knowledge_hybrid(
  p_account_id      uuid,
  p_query           text,
  p_query_embedding text,
  p_embedding_model text,
  p_match_count     integer,
  p_max_distance    real
)
RETURNS TABLE (
  chunk_id     uuid,
  document_id  uuid,
  title        text,
  heading      text,
  content      text,
  distance     real,
  lexical_rank real,
  score        double precision,
  source       text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_count    integer := LEAST(GREATEST(COALESCE(p_match_count, 5), 1), 20);
  v_pool     integer;
  v_query    text    := left(btrim(COALESCE(p_query, '')), 2000);
  v_max      real    := COALESCE(p_max_distance, 2);
  v_model    text    := regexp_replace(btrim(COALESCE(p_embedding_model, '')), '^openai/', '');
  v_vec      vector(1536);
  v_q_pt     tsquery := ''::tsquery;
  v_q_simple tsquery := ''::tsquery;
  v_prev_scan text;
BEGIN
  IF p_account_id IS NULL THEN
    RETURN;
  END IF;

  -- Guarda obrigatória: a função roda como o dono (RLS desligada). O motor
  -- (auto-reply) chama como service_role; a sessão do painel como
  -- authenticated, e precisa ser membro da conta pedida.
  IF COALESCE(auth.role(), '') <> 'service_role'
     AND NOT is_account_member(p_account_id) THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  v_pool := LEAST(v_count * 4, 80);

  -- Semântica só com vetor E modelo. Vetor mal formado levanta erro (o
  -- cliente TS monta o literal; quem chama direto com lixo recebe o erro).
  IF p_query_embedding IS NOT NULL AND btrim(p_query_embedding) <> '' AND v_model <> '' THEN
    v_vec := p_query_embedding::vector(1536);
    -- O índice HNSW devolve os ef_search vizinhos de TODAS as contas e só
    -- depois filtra; a varredura iterativa (pgvector 0.8) continua até
    -- achar o suficiente da conta. Melhor esforço: GUC ausente não quebra.
    BEGIN
      v_prev_scan := current_setting('hnsw.iterative_scan', true);
      PERFORM set_config('hnsw.iterative_scan', 'strict_order', true);
    EXCEPTION WHEN OTHERS THEN
      v_prev_scan := NULL;
    END;
  END IF;

  IF v_query <> '' THEN
    v_q_pt     := websearch_to_tsquery('portuguese'::regconfig, public.ai_unaccent(v_query));
    v_q_simple := websearch_to_tsquery('simple'::regconfig, v_query);
  END IF;

  RETURN QUERY
  WITH sem AS (
    SELECT c.id AS cid,
           (c.embedding <=> v_vec)::real AS dist,
           row_number() OVER (ORDER BY c.embedding <=> v_vec, c.id) AS pos
      FROM ai_knowledge_chunks c
      JOIN ai_knowledge_documents d ON d.id = c.document_id
     WHERE v_vec IS NOT NULL
       AND c.account_id = p_account_id
       AND d.account_id = p_account_id
       AND d.is_enabled
       AND d.status = 'ready'
       AND c.embedding IS NOT NULL
       AND regexp_replace(COALESCE(c.embedding_model, ''), '^openai/', '') = v_model
     ORDER BY c.embedding <=> v_vec, c.id
     LIMIT v_pool
  ),
  lex AS (
    SELECT c.id AS cid,
           GREATEST(ts_rank(c.fts_pt, v_q_pt), ts_rank(c.fts, v_q_simple))::real AS lrank,
           row_number() OVER (
             ORDER BY GREATEST(ts_rank(c.fts_pt, v_q_pt), ts_rank(c.fts, v_q_simple)) DESC, c.id
           ) AS pos
      FROM ai_knowledge_chunks c
      JOIN ai_knowledge_documents d ON d.id = c.document_id
     WHERE v_query <> ''
       AND c.account_id = p_account_id
       AND d.account_id = p_account_id
       AND d.is_enabled
       AND d.status = 'ready'
       AND (c.fts_pt @@ v_q_pt OR c.fts @@ v_q_simple)
     ORDER BY GREATEST(ts_rank(c.fts_pt, v_q_pt), ts_rank(c.fts, v_q_simple)) DESC, c.id
     LIMIT v_pool
  ),
  fused AS (
    SELECT COALESCE(s.cid, l.cid) AS cid,
           s.dist,
           l.lrank,
           (s.dist IS NOT NULL AND s.dist <= v_max) AS sem_ok,
           (l.cid IS NOT NULL) AS lex_ok,
           (CASE WHEN s.dist IS NOT NULL AND s.dist <= v_max
                 THEN 1.0 / (60 + s.pos) ELSE 0 END
            + CASE WHEN l.cid IS NOT NULL
                   THEN 1.0 / (60 + l.pos) ELSE 0 END)::double precision AS score
      FROM sem s
      FULL OUTER JOIN lex l ON l.cid = s.cid
  )
  SELECT c.id,
         c.document_id,
         d.title,
         c.heading,
         c.content,
         f.dist,
         f.lrank,
         f.score,
         CASE WHEN f.sem_ok AND f.lex_ok THEN 'both'
              WHEN f.sem_ok THEN 'semantic'
              ELSE 'lexical' END
    FROM fused f
    JOIN ai_knowledge_chunks c ON c.id = f.cid
    JOIN ai_knowledge_documents d ON d.id = c.document_id
   WHERE (f.sem_ok OR f.lex_ok)
     AND c.account_id = p_account_id
   ORDER BY f.score DESC, f.dist ASC NULLS LAST, c.id
   LIMIT v_count;

  -- set_config(..., true) vale até o fim da transação de quem chamou:
  -- devolve o valor anterior (RETURN QUERY já terminou a consulta).
  IF v_prev_scan IS NOT NULL THEN
    BEGIN
      PERFORM set_config('hnsw.iterative_scan', NULLIF(v_prev_scan, ''), true);
    EXCEPTION WHEN OTHERS THEN
      NULL;
    END;
  END IF;
END;
$$;

ALTER FUNCTION public.match_ai_knowledge_hybrid(uuid, text, text, text, integer, real) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.match_ai_knowledge_hybrid(uuid, text, text, text, integer, real) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.match_ai_knowledge_hybrid(uuid, text, text, text, integer, real) FROM anon;
GRANT EXECUTE ON FUNCTION public.match_ai_knowledge_hybrid(uuid, text, text, text, integer, real) TO authenticated, service_role;

COMMENT ON FUNCTION public.match_ai_knowledge_hybrid(uuid, text, text, text, integer, real) IS
  'SPEC 089 D-10: recuperacao hibrida (semantica + lexical pt, fusao RRF 1/(60+pos), limiar de distancia). DEFINER: guarda de vinculo com a conta no corpo.';

-- ------------------------------------------------------------
-- 4) ai_usage_log.knowledge_document_ids (D-14)
-- ------------------------------------------------------------
ALTER TABLE public.ai_usage_log
  ADD COLUMN IF NOT EXISTS knowledge_document_ids uuid[] NOT NULL DEFAULT '{}';

COMMENT ON COLUMN public.ai_usage_log.knowledge_document_ids IS
  'SPEC 089 D-14: documentos da base cujas fatias entraram no prompt desta chamada.';

-- ------------------------------------------------------------
-- 5) RPCs antigas: de volta a SECURITY INVOKER (corrige a 103)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.match_ai_knowledge_fts(
  p_account_id  uuid,
  p_query       text,
  p_match_count integer
)
RETURNS TABLE (id uuid, content text, rank real) AS $$
  SELECT c.id,
         c.content,
         ts_rank(c.fts, plainto_tsquery('simple', p_query)) AS rank
  FROM ai_knowledge_chunks c
  JOIN ai_knowledge_documents d ON d.id = c.document_id
  WHERE c.account_id = p_account_id
    AND d.account_id = p_account_id
    AND d.is_enabled
    AND c.fts @@ plainto_tsquery('simple', p_query)
  ORDER BY rank DESC
  LIMIT GREATEST(p_match_count, 0);
$$ LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public;

CREATE OR REPLACE FUNCTION public.match_ai_knowledge_semantic(
  p_account_id      uuid,
  p_query_embedding text,
  p_match_count     integer
)
RETURNS TABLE (id uuid, content text, distance real) AS $$
  SELECT c.id,
         c.content,
         (c.embedding <=> p_query_embedding::vector(1536)) AS distance
  FROM ai_knowledge_chunks c
  JOIN ai_knowledge_documents d ON d.id = c.document_id
  WHERE c.account_id = p_account_id
    AND d.account_id = p_account_id
    AND d.is_enabled
    AND c.embedding IS NOT NULL
  ORDER BY c.embedding <=> p_query_embedding::vector(1536)
  LIMIT GREATEST(p_match_count, 0);
$$ LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public;

REVOKE ALL ON FUNCTION public.match_ai_knowledge_fts(uuid, text, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.match_ai_knowledge_fts(uuid, text, integer) FROM anon;
GRANT EXECUTE ON FUNCTION public.match_ai_knowledge_fts(uuid, text, integer) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.match_ai_knowledge_semantic(uuid, text, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.match_ai_knowledge_semantic(uuid, text, integer) FROM anon;
GRANT EXECUTE ON FUNCTION public.match_ai_knowledge_semantic(uuid, text, integer) TO authenticated, service_role;

-- ------------------------------------------------------------
-- 6) Asserções — falham alto
-- ------------------------------------------------------------
DO $$
DECLARE
  v_fn TEXT;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'ai_knowledge_chunks'
                    AND column_name = 'embedding_model') THEN
    RAISE EXCEPTION '104: rode a 103 primeiro (ai_knowledge_chunks.embedding_model ausente).' USING ERRCODE = '55006';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'ai_knowledge_chunks'
                    AND column_name = 'fts_pt' AND is_generated = 'ALWAYS') THEN
    RAISE EXCEPTION '104: fts_pt ausente ou nao e coluna gerada.' USING ERRCODE = '55006';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_indexes
                  WHERE schemaname = 'public' AND indexname = 'ai_knowledge_chunks_fts_pt_idx') THEN
    RAISE EXCEPTION '104: indice GIN de fts_pt ausente.' USING ERRCODE = '55006';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'ai_usage_log'
                    AND column_name = 'knowledge_document_ids') THEN
    RAISE EXCEPTION '104: ai_usage_log.knowledge_document_ids ausente.' USING ERRCODE = '55006';
  END IF;

  -- Sanidade do wrapper: acento some, e o resultado é o esperado.
  IF public.ai_unaccent('preço ação côr') <> 'preco acao cor' THEN
    RAISE EXCEPTION '104: ai_unaccent nao removeu acentos.' USING ERRCODE = '55006';
  END IF;
  -- "preços" e "preço" casam em portuguese (radical).
  IF NOT (to_tsvector('portuguese', public.ai_unaccent('o preço do plano'))
          @@ websearch_to_tsquery('portuguese'::regconfig, public.ai_unaccent('preços'))) THEN
    RAISE EXCEPTION '104: "precos" nao casou "preco" em portuguese.' USING ERRCODE = '55006';
  END IF;

  -- A RPC híbrida: DEFINER, search_path fixo, guarda no corpo, anon e PUBLIC
  -- sem EXECUTE, authenticated e service_role com.
  v_fn := 'public.match_ai_knowledge_hybrid(uuid,text,text,text,integer,real)';
  IF has_function_privilege('anon', v_fn, 'EXECUTE')
     OR has_function_privilege('public', v_fn, 'EXECUTE')
     OR NOT has_function_privilege('authenticated', v_fn, 'EXECUTE')
     OR NOT has_function_privilege('service_role', v_fn, 'EXECUTE') THEN
    RAISE EXCEPTION '104: privilegios de % errados.', v_fn USING ERRCODE = '55006';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc
     WHERE oid = v_fn::regprocedure
       AND prosecdef
       AND EXISTS (SELECT 1 FROM unnest(proconfig) c WHERE c LIKE 'search_path=%')
       AND prosrc LIKE '%is_account_member%'
       AND prosrc LIKE '%is_enabled%'
  ) THEN
    RAISE EXCEPTION '104: % sem SECURITY DEFINER, search_path fixo, guarda de conta ou filtro is_enabled.', v_fn USING ERRCODE = '55006';
  END IF;

  v_fn := 'public.ai_unaccent(text)';
  IF has_function_privilege('anon', v_fn, 'EXECUTE')
     OR has_function_privilege('public', v_fn, 'EXECUTE') THEN
    RAISE EXCEPTION '104: % executavel por anon/PUBLIC.', v_fn USING ERRCODE = '55006';
  END IF;

  -- As antigas: INVOKER (a RLS decide), sem anon.
  FOREACH v_fn IN ARRAY ARRAY[
    'public.match_ai_knowledge_fts(uuid,text,integer)',
    'public.match_ai_knowledge_semantic(uuid,text,integer)'
  ] LOOP
    IF has_function_privilege('anon', v_fn, 'EXECUTE')
       OR has_function_privilege('public', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION '104: % executavel por anon/PUBLIC.', v_fn USING ERRCODE = '55006';
    END IF;
    IF EXISTS (SELECT 1 FROM pg_proc WHERE oid = v_fn::regprocedure AND prosecdef) THEN
      RAISE EXCEPTION '104: % ainda e SECURITY DEFINER (leitura entre contas).', v_fn USING ERRCODE = '55006';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid = v_fn::regprocedure AND prosrc LIKE '%is_enabled%') THEN
      RAISE EXCEPTION '104: % perdeu o filtro is_enabled.', v_fn USING ERRCODE = '55006';
    END IF;
  END LOOP;
END;
$$;
