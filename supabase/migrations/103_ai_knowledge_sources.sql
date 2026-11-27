-- ============================================================
-- 103_ai_knowledge_sources.sql — SPEC 089 F2 (base de conhecimento)
--
-- Novas fontes (arquivo, URL, perguntas e respostas), estado de
-- indexação, interruptor e etiquetas por documento, modelo de embedding
-- por fatia e a quota de plano `knowledge_documents` (D-7, D-9, D-12,
-- D-4, D-20). Escrita LOCAL; aplicar no `vn` só com confirmação do
-- mantenedor. Idempotente.
--
-- NÃO cria `fts_pt`, `match_ai_knowledge_hybrid` nem limiar de distância:
-- isso é a F3. As duas RPCs antigas (030) continuam, com UM ajuste: agora
-- ignoram documento com `is_enabled = false` (o interruptor tem de valer
-- já na F2, antes de a RPC híbrida existir).
--
-- 1. ai_knowledge_documents: source_type, source_name, source_url,
--    mime_type, status (pending | indexing | ready | error), index_error,
--    index_attempts, index_started_at, chunk_count, char_count,
--    content_hash, is_enabled, tags, indexed_at. Linhas existentes viram
--    `text` + `ready`, com contagens e hash preenchidos.
-- 2. ai_knowledge_chunks: heading (título da seção prefixado à fatia,
--    D-12) e embedding_model (D-4).
-- 3. Quota `knowledge_documents`: trigger AFTER INSERT/DELETE no padrão
--    de `enforce_form_quota` (098); ausente = ilimitado. Contador em
--    `account_usage_counters`, recalculado por `recount_account_usage`.
-- 4. match_ai_knowledge_fts / _semantic: filtram `is_enabled`.
-- 5. Asserções.
--
-- Contrato com o TypeScript (`src/lib/ai/ingest/`, `src/lib/plans/`):
--   métrica `knowledge_documents` · erro `QUOTA_EXCEEDED:knowledge_documents:<usado>:<limite>`
--   status e source_type com os mesmos literais dos CHECKs abaixo.
-- ============================================================

-- ------------------------------------------------------------
-- 1) ai_knowledge_documents
-- ------------------------------------------------------------
ALTER TABLE ai_knowledge_documents
  ADD COLUMN IF NOT EXISTS source_type      TEXT        NOT NULL DEFAULT 'text',
  ADD COLUMN IF NOT EXISTS source_name      TEXT,
  ADD COLUMN IF NOT EXISTS source_url       TEXT,
  ADD COLUMN IF NOT EXISTS mime_type        TEXT,
  ADD COLUMN IF NOT EXISTS status           TEXT        NOT NULL DEFAULT 'ready',
  ADD COLUMN IF NOT EXISTS index_error      TEXT,
  ADD COLUMN IF NOT EXISTS index_attempts   INTEGER     NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS index_started_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS chunk_count      INTEGER     NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS char_count       INTEGER     NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS content_hash     TEXT,
  ADD COLUMN IF NOT EXISTS is_enabled       BOOLEAN     NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS tags             TEXT[]      NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS indexed_at       TIMESTAMPTZ;

ALTER TABLE ai_knowledge_documents
  DROP CONSTRAINT IF EXISTS ai_knowledge_documents_source_type_check;
ALTER TABLE ai_knowledge_documents
  ADD CONSTRAINT ai_knowledge_documents_source_type_check
  CHECK (source_type IN ('text', 'file', 'url', 'faq'));

ALTER TABLE ai_knowledge_documents
  DROP CONSTRAINT IF EXISTS ai_knowledge_documents_status_check;
ALTER TABLE ai_knowledge_documents
  ADD CONSTRAINT ai_knowledge_documents_status_check
  CHECK (status IN ('pending', 'indexing', 'ready', 'error'));

ALTER TABLE ai_knowledge_documents
  DROP CONSTRAINT IF EXISTS ai_knowledge_documents_tags_check;
ALTER TABLE ai_knowledge_documents
  ADD CONSTRAINT ai_knowledge_documents_tags_check
  CHECK (cardinality(tags) <= 20);

-- Linhas anteriores à 103: texto colado, já indexado (ou lexical-only).
-- O trigger de `updated_at` fica desligado só durante o backfill, senão
-- todo documento antigo ganharia "atualizado agora" e a lista perderia
-- a ordem real.
ALTER TABLE ai_knowledge_documents
  DISABLE TRIGGER ai_knowledge_documents_updated_at;

UPDATE ai_knowledge_documents d
   SET char_count   = char_length(d.content),
       content_hash = encode(sha256(convert_to(d.content, 'UTF8')), 'hex'),
       chunk_count  = (SELECT count(*) FROM ai_knowledge_chunks c WHERE c.document_id = d.id),
       indexed_at   = d.updated_at
 WHERE d.content_hash IS NULL;

ALTER TABLE ai_knowledge_documents
  ENABLE TRIGGER ai_knowledge_documents_updated_at;

-- Varredura de reserva (D-9): só enxerga o que está em andamento.
CREATE INDEX IF NOT EXISTS ai_knowledge_documents_indexing_idx
  ON ai_knowledge_documents (created_at)
  WHERE status IN ('pending', 'indexing');

-- Idempotência por conteúdo (não único: contas antigas podem ter texto
-- repetido, e um UNIQUE derrubaria a migração).
CREATE INDEX IF NOT EXISTS ai_knowledge_documents_account_hash_idx
  ON ai_knowledge_documents (account_id, content_hash)
  WHERE content_hash IS NOT NULL;

COMMENT ON COLUMN ai_knowledge_documents.status IS
  'SPEC 089 D-9: pending (aguardando indexacao) | indexing | ready | error. Quem muda e o servidor (after() da rota e a fase de varredura do cron); o cliente nunca precisa escrever aqui.';
COMMENT ON COLUMN ai_knowledge_documents.content_hash IS
  'SHA-256 (hex) do texto de `content`. Mesmo hash na conta = mesmo documento (idempotencia, SPEC 089 §5.2).';
COMMENT ON COLUMN ai_knowledge_documents.is_enabled IS
  'FALSE tira o documento da recuperacao sem apagar (SPEC 089 §5.2).';

-- ------------------------------------------------------------
-- 2) ai_knowledge_chunks
-- ------------------------------------------------------------
ALTER TABLE ai_knowledge_chunks
  ADD COLUMN IF NOT EXISTS heading         TEXT,
  ADD COLUMN IF NOT EXISTS embedding_model TEXT;

-- Fatias antigas com vetor vieram todas do `text-embedding-3-small` da
-- OpenAI (único modelo até a F1). Sem isto, a F3 trataria como "outro
-- modelo" tudo que já existe.
UPDATE ai_knowledge_chunks
   SET embedding_model = 'text-embedding-3-small'
 WHERE embedding IS NOT NULL AND embedding_model IS NULL;

COMMENT ON COLUMN ai_knowledge_chunks.heading IS
  'SPEC 089 D-12: titulo da secao (cabecalho Markdown ou titulo do documento) que foi prefixado a `content`.';
COMMENT ON COLUMN ai_knowledge_chunks.embedding_model IS
  'SPEC 089 D-4: identificador PEDIDO ao provedor de embeddings (ex.: text-embedding-3-small; openai/text-embedding-3-small no OpenRouter). NULL = sem vetor.';

-- ------------------------------------------------------------
-- 3) Quota `knowledge_documents`
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.enforce_knowledge_document_quota()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_used  BIGINT;
  v_limit INTEGER;
BEGIN
  IF TG_OP = 'DELETE' THEN
    UPDATE account_usage_counters
       SET value = GREATEST(value - 1, 0), updated_at = NOW()
     WHERE account_id = OLD.account_id AND metric = 'knowledge_documents';
    RETURN OLD;
  END IF;

  -- INSERT: incrementa-depois-checa, porque o UPDATE do contador é o lock
  -- que serializa a corrida (mesmo padrão de enforce_form_quota, 098).
  INSERT INTO account_usage_counters (account_id, metric, value, updated_at)
  VALUES (NEW.account_id, 'knowledge_documents', 1, NOW())
  ON CONFLICT (account_id, metric)
  DO UPDATE SET value = account_usage_counters.value + 1, updated_at = NOW()
  RETURNING value INTO v_used;

  v_limit := plan_limit(NEW.account_id, 'knowledge_documents');

  IF v_limit IS NOT NULL AND v_used > v_limit THEN
    -- Contrato com src/lib/plans/errors.ts — mudou de um lado, muda dos dois.
    RAISE EXCEPTION 'QUOTA_EXCEEDED:knowledge_documents:%:%', v_used, v_limit
      USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$$;

ALTER FUNCTION public.enforce_knowledge_document_quota() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.enforce_knowledge_document_quota() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.enforce_knowledge_document_quota() FROM anon;
REVOKE ALL ON FUNCTION public.enforce_knowledge_document_quota() FROM authenticated;

DROP TRIGGER IF EXISTS enforce_knowledge_document_quota_trigger ON ai_knowledge_documents;
CREATE TRIGGER enforce_knowledge_document_quota_trigger
  AFTER INSERT OR DELETE ON ai_knowledge_documents
  FOR EACH ROW EXECUTE FUNCTION public.enforce_knowledge_document_quota();

-- Contador das contas que já têm documentos.
INSERT INTO account_usage_counters (account_id, metric, value, updated_at)
SELECT account_id, 'knowledge_documents', count(*), NOW()
  FROM ai_knowledge_documents
 GROUP BY account_id
ON CONFLICT (account_id, metric)
DO UPDATE SET value = EXCLUDED.value, updated_at = NOW();

-- recount_account_usage — corpo da 098 + documentos da base.
CREATE OR REPLACE FUNCTION public.recount_account_usage(p_account_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO account_usage_counters (account_id, metric, value, updated_at)
  SELECT p_account_id, 'contacts', count(*), NOW()
  FROM contacts WHERE account_id = p_account_id
  ON CONFLICT (account_id, metric)
  DO UPDATE SET value = EXCLUDED.value, updated_at = NOW();

  INSERT INTO account_usage_counters (account_id, metric, value, updated_at)
  SELECT p_account_id, 'forms', count(*), NOW()
  FROM forms WHERE account_id = p_account_id AND status <> 'archived'
  ON CONFLICT (account_id, metric)
  DO UPDATE SET value = EXCLUDED.value, updated_at = NOW();

  -- Mês corrente em America/Sao_Paulo. Respostas apagadas não voltam ao
  -- contador por trigger; aqui o recálculo segue as linhas que existem.
  INSERT INTO account_usage_counters (account_id, metric, value, updated_at)
  SELECT p_account_id, form_month_metric(NOW()), count(*), NOW()
  FROM form_responses
  WHERE account_id = p_account_id
    AND status = 'completed'
    AND form_month_metric(completed_at) = form_month_metric(NOW())
  ON CONFLICT (account_id, metric)
  DO UPDATE SET value = EXCLUDED.value, updated_at = NOW();

  INSERT INTO account_usage_counters (account_id, metric, value, updated_at)
  SELECT p_account_id, 'form_upload_bytes', COALESCE(sum(upload_bytes), 0), NOW()
  FROM form_responses
  WHERE account_id = p_account_id AND status = 'completed'
  ON CONFLICT (account_id, metric)
  DO UPDATE SET value = EXCLUDED.value, updated_at = NOW();

  INSERT INTO account_usage_counters (account_id, metric, value, updated_at)
  SELECT p_account_id, 'knowledge_documents', count(*), NOW()
  FROM ai_knowledge_documents WHERE account_id = p_account_id
  ON CONFLICT (account_id, metric)
  DO UPDATE SET value = EXCLUDED.value, updated_at = NOW();
END;
$$;

ALTER FUNCTION public.recount_account_usage(UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.recount_account_usage(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.recount_account_usage(UUID) FROM anon;
REVOKE ALL ON FUNCTION public.recount_account_usage(UUID) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.recount_account_usage(UUID) TO service_role;

-- ------------------------------------------------------------
-- 4) RPCs antigas de recuperação: respeitam `is_enabled`
-- ------------------------------------------------------------
-- Mesma assinatura e mesmas colunas de retorno da 030. A RPC híbrida
-- (F3) nasce já com o filtro.
-- SECURITY INVOKER (como a 032): a RLS de ai_knowledge_chunks decide quem
-- lê. A versão original desta migração as recriou como DEFINER, o que
-- desfazia a 032 (leitura entre contas); corrigido na 104.
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
-- 5) Asserções — falham alto
-- ------------------------------------------------------------
DO $$
DECLARE
  v_fn TEXT;
BEGIN
  IF to_regclass('public.ai_knowledge_documents') IS NULL THEN
    RAISE EXCEPTION '103: ai_knowledge_documents ausente — rode a 030 primeiro.' USING ERRCODE = '55006';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'plan_limit') THEN
    RAISE EXCEPTION '103: plan_limit() ausente — rode a 067 primeiro.' USING ERRCODE = '55006';
  END IF;

  -- Colunas novas.
  IF (SELECT count(*) FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'ai_knowledge_documents'
         AND column_name IN ('source_type','source_name','source_url','mime_type','status',
                             'index_error','index_attempts','index_started_at','chunk_count',
                             'char_count','content_hash','is_enabled','tags','indexed_at')) <> 14 THEN
    RAISE EXCEPTION '103: colunas de ai_knowledge_documents incompletas.' USING ERRCODE = '55006';
  END IF;
  IF (SELECT count(*) FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'ai_knowledge_chunks'
         AND column_name IN ('heading','embedding_model')) <> 2 THEN
    RAISE EXCEPTION '103: colunas de ai_knowledge_chunks incompletas.' USING ERRCODE = '55006';
  END IF;

  -- F3 não entrou aqui.
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'ai_knowledge_chunks'
                AND column_name = 'fts_pt') THEN
    RAISE EXCEPTION '103: fts_pt e da F3, nao da F2.' USING ERRCODE = '55006';
  END IF;

  -- Nenhuma linha antiga ficou sem hash nem em estado fora do esperado.
  IF EXISTS (SELECT 1 FROM ai_knowledge_documents WHERE content_hash IS NULL) THEN
    RAISE EXCEPTION '103: documento sem content_hash apos o backfill.' USING ERRCODE = '55006';
  END IF;

  -- Função interna da quota: ninguém além do dono.
  v_fn := 'public.enforce_knowledge_document_quota()';
  IF has_function_privilege('anon', v_fn, 'EXECUTE')
     OR has_function_privilege('authenticated', v_fn, 'EXECUTE')
     OR has_function_privilege('public', v_fn, 'EXECUTE') THEN
    RAISE EXCEPTION '103: % executavel por anon/authenticated/PUBLIC.', v_fn USING ERRCODE = '55006';
  END IF;

  -- recount_account_usage continua só do service_role.
  v_fn := 'public.recount_account_usage(uuid)';
  IF has_function_privilege('anon', v_fn, 'EXECUTE')
     OR has_function_privilege('authenticated', v_fn, 'EXECUTE')
     OR has_function_privilege('public', v_fn, 'EXECUTE')
     OR NOT has_function_privilege('service_role', v_fn, 'EXECUTE') THEN
    RAISE EXCEPTION '103: privilegios de % errados.', v_fn USING ERRCODE = '55006';
  END IF;

  -- As duas RPCs de recuperação: anon sem EXECUTE, SECURITY DEFINER com
  -- search_path fixo, e o filtro de is_enabled presente.
  FOREACH v_fn IN ARRAY ARRAY[
    'public.match_ai_knowledge_fts(uuid,text,integer)',
    'public.match_ai_knowledge_semantic(uuid,text,integer)'
  ] LOOP
    IF has_function_privilege('anon', v_fn, 'EXECUTE')
       OR has_function_privilege('public', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION '103: % executavel por anon/PUBLIC.', v_fn USING ERRCODE = '55006';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_proc
       WHERE oid = v_fn::regprocedure
         AND NOT prosecdef
         AND EXISTS (SELECT 1 FROM unnest(proconfig) c WHERE c = 'search_path=public')
         AND prosrc LIKE '%is_enabled%'
    ) THEN
      RAISE EXCEPTION '103: % e SECURITY DEFINER, ou sem search_path fixo ou filtro is_enabled.', v_fn USING ERRCODE = '55006';
    END IF;
  END LOOP;

  IF NOT EXISTS (SELECT 1 FROM pg_trigger
                  WHERE tgname = 'enforce_knowledge_document_quota_trigger' AND NOT tgisinternal) THEN
    RAISE EXCEPTION '103: enforce_knowledge_document_quota_trigger ausente.' USING ERRCODE = '55006';
  END IF;
END;
$$;
