-- ============================================================
-- 108_ai_tuning.sql — SPEC 089 F7 (ajuste do agente)
--
-- Escrita LOCAL; aplicar no `vn` só pelo mantenedor (SQL Editor).
-- Idempotente. Depende da 102 (conta, `ai_prompt_versions`) e usa
-- `is_account_member`. Não depende da 107.
--
--   1. ai_examples: exemplos de "como este negócio responde" (mensagem do
--      cliente + resposta ideal), com estado candidate | approved |
--      rejected, origem, etiquetas e embedding 1536 com `embedding_model`
--      (D-4, como as fatias da base). SÓ `approved` entra no prompt. O
--      texto é gravado JÁ MASCARADO pelo código (SPEC 089 §8).
--   2. ai_drafts: o elo "rascunho da IA → mensagem enviada". O rascunho do
--      inbox (/api/ai/draft) grava aqui o texto (mascarado) e devolve o id;
--      o envio (/api/whatsapp/send) consome a linha, compara com o que o
--      atendente mandou e, se editou, cria um candidato. Só service_role.
--   3. ai_eval_cases / ai_eval_runs / ai_eval_results: conjunto de avaliação
--      (conversa de referência e o que se espera), rodadas contra a
--      configuração atual e o resultado por caso, com o veredito humano.
--   4. match_ai_examples(): os exemplos APROVADOS mais parecidos com a
--      consulta. SECURITY DEFINER, search_path fixo, guarda de vínculo com a
--      conta para quem não é service_role, limiar de distância. Sem índice
--      HNSW de propósito: são poucas centenas de linhas por conta, a busca
--      exata filtrada por conta é rápida e não sofre o problema de recall do
--      HNSW com filtro (o motivo do `iterative_scan` na RPC da base).
--
-- Privilégios (supabase-rls-mcp.md, lição da 097): tudo REVOKE de PUBLIC,
-- anon e authenticated, depois só o necessário.
--   ai_examples, ai_eval_cases: admin+ lê e escreve (RLS); service_role tudo.
--   ai_eval_runs: admin+ lê; escrita só service_role (a rodada é do servidor).
--   ai_eval_results: admin+ lê e SÓ pode alterar as colunas do veredito
--     (grant por coluna + policy); o resto é do service_role.
--   ai_drafts: nenhum acesso para authenticated (só service_role).
--
-- Exclusão em cascata com a conta (ON DELETE CASCADE). Conversa, mensagem e
-- usuário apagados viram NULL (o exemplo já é anônimo). Retenção (P-5):
-- varredura no cron (src/lib/ai/tuning/retention.ts), ver SPEC 089 §5.5.
--
-- Nada de URL ou segredo do deploy aqui.
-- ============================================================

-- ------------------------------------------------------------
-- 1) ai_examples
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.ai_examples (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id        uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  -- Mensagem(ns) do cliente que abriram a troca, JÁ mascaradas.
  customer_message  text NOT NULL
                      CHECK (char_length(customer_message) BETWEEN 1 AND 1500),
  -- A resposta que o negócio quer dar, JÁ mascarada.
  ideal_response    text NOT NULL
                      CHECK (char_length(ideal_response) BETWEEN 1 AND 3500),
  -- O que a IA tinha sugerido (origem draft_edit), mascarado: serve à
  -- revisão ("o que mudou"). Nunca entra no prompt.
  ai_draft          text
                      CHECK (ai_draft IS NULL OR char_length(ai_draft) <= 3500),
  tags              text[] NOT NULL DEFAULT '{}'
                      CHECK (cardinality(tags) <= 10),
  status            text NOT NULL DEFAULT 'candidate'
                      CHECK (status IN ('candidate', 'approved', 'rejected')),
  source            text NOT NULL
                      CHECK (source IN ('manual', 'draft_edit', 'handoff_reply')),
  conversation_id   uuid REFERENCES public.conversations(id) ON DELETE SET NULL,
  source_message_id uuid REFERENCES public.messages(id) ON DELETE SET NULL,
  embedding         vector(1536),
  -- Identificador PEDIDO ao provedor (D-4); a RPC trata
  -- 'openai/text-embedding-3-small' e 'text-embedding-3-small' como um só.
  embedding_model   text,
  created_by        uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  reviewed_by       uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  reviewed_at       timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.ai_examples IS
  'SPEC 089 F7: exemplos dinamicos (few-shot recuperado por similaridade). So status=approved entra no prompt. Texto ja mascarado.';

-- Uma mensagem enviada gera no máximo um candidato (idempotência da captura).
CREATE UNIQUE INDEX IF NOT EXISTS ai_examples_account_source_message_idx
  ON public.ai_examples (account_id, source_message_id)
  WHERE source_message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ai_examples_account_status_idx
  ON public.ai_examples (account_id, status, created_at DESC);

ALTER TABLE public.ai_examples ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ai_examples_select ON public.ai_examples;
CREATE POLICY ai_examples_select ON public.ai_examples
  FOR SELECT TO authenticated
  USING (public.is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS ai_examples_insert ON public.ai_examples;
CREATE POLICY ai_examples_insert ON public.ai_examples
  FOR INSERT TO authenticated
  WITH CHECK (public.is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS ai_examples_update ON public.ai_examples;
CREATE POLICY ai_examples_update ON public.ai_examples
  FOR UPDATE TO authenticated
  USING (public.is_account_member(account_id, 'admin'))
  WITH CHECK (public.is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS ai_examples_delete ON public.ai_examples;
CREATE POLICY ai_examples_delete ON public.ai_examples
  FOR DELETE TO authenticated
  USING (public.is_account_member(account_id, 'admin'));

REVOKE ALL ON TABLE public.ai_examples FROM PUBLIC;
REVOKE ALL ON TABLE public.ai_examples FROM anon;
REVOKE ALL ON TABLE public.ai_examples FROM authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.ai_examples TO authenticated;
GRANT ALL ON TABLE public.ai_examples TO service_role;

-- ------------------------------------------------------------
-- 2) ai_drafts — elo rascunho → envio (só service_role)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.ai_drafts (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id       uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  conversation_id  uuid NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  user_id          uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  -- Ambos JÁ mascarados.
  customer_message text NOT NULL CHECK (char_length(customer_message) <= 1500),
  draft_text       text NOT NULL CHECK (char_length(draft_text) <= 3500),
  created_at       timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.ai_drafts IS
  'SPEC 089 F7: rascunho da IA servido ao atendente (mascarado), consumido no envio para detectar edicao. Vida curta (varredura apaga em 2 dias).';

CREATE INDEX IF NOT EXISTS ai_drafts_created_idx
  ON public.ai_drafts (created_at);
CREATE INDEX IF NOT EXISTS ai_drafts_account_conv_idx
  ON public.ai_drafts (account_id, conversation_id);

-- RLS ligada e SEM policy para authenticated: só o service_role (que ignora
-- a RLS) lê e escreve. O aviso "RLS sem policy" do advisor é o desenho.
ALTER TABLE public.ai_drafts ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.ai_drafts FROM PUBLIC;
REVOKE ALL ON TABLE public.ai_drafts FROM anon;
REVOKE ALL ON TABLE public.ai_drafts FROM authenticated;
GRANT ALL ON TABLE public.ai_drafts TO service_role;

-- ------------------------------------------------------------
-- 3) Avaliação: casos, rodadas, resultados
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.ai_eval_cases (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id     uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  title          text NOT NULL CHECK (char_length(btrim(title)) BETWEEN 1 AND 120),
  -- [{ "role": "user" | "assistant", "content": "…" }, …] — mascarado pelo
  -- código; precisa terminar numa fala do cliente (o código confere).
  conversation   jsonb NOT NULL
                   CHECK (jsonb_typeof(conversation) = 'array'
                          AND jsonb_array_length(conversation) BETWEEN 1 AND 20
                          AND octet_length(conversation::text) <= 12000),
  -- Esperado: entregar a um humano (true) ou responder (false).
  expect_handoff boolean NOT NULL DEFAULT false,
  expected_notes text CHECK (expected_notes IS NULL OR char_length(expected_notes) <= 1000),
  created_by     uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ai_eval_cases_account_idx
  ON public.ai_eval_cases (account_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.ai_eval_runs (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id        uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  created_by        uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  status            text NOT NULL DEFAULT 'running'
                      CHECK (status IN ('running', 'done', 'error')),
  -- Configuração avaliada (foto do momento; sem chave).
  provider          text NOT NULL,
  model             text NOT NULL,
  prompt_hash       text NOT NULL,
  prompt_chars      integer NOT NULL DEFAULT 0 CHECK (prompt_chars >= 0),
  case_count        integer NOT NULL CHECK (case_count BETWEEN 1 AND 50),
  completed_count   integer NOT NULL DEFAULT 0 CHECK (completed_count >= 0),
  prompt_tokens     bigint NOT NULL DEFAULT 0 CHECK (prompt_tokens >= 0),
  completion_tokens bigint NOT NULL DEFAULT 0 CHECK (completion_tokens >= 0),
  total_tokens      bigint NOT NULL DEFAULT 0 CHECK (total_tokens >= 0),
  -- Soma do que o provedor informou (OpenRouter); NULL = nenhum informou.
  cost_usd          numeric(12, 6),
  error_code        text CHECK (error_code IS NULL OR char_length(error_code) <= 64),
  created_at        timestamptz NOT NULL DEFAULT now(),
  finished_at       timestamptz
);

CREATE INDEX IF NOT EXISTS ai_eval_runs_account_idx
  ON public.ai_eval_runs (account_id, created_at DESC);
-- No máximo uma rodada "running" por conta (o teto de custo não vira N em
-- paralelo por corrida entre duas requisições).
CREATE UNIQUE INDEX IF NOT EXISTS ai_eval_runs_one_running_idx
  ON public.ai_eval_runs (account_id)
  WHERE status = 'running';

CREATE TABLE IF NOT EXISTS public.ai_eval_results (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id            uuid NOT NULL REFERENCES public.ai_eval_runs(id) ON DELETE CASCADE,
  account_id        uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  case_id           uuid REFERENCES public.ai_eval_cases(id) ON DELETE SET NULL,
  -- Foto do caso no momento da rodada (o caso pode ser editado ou apagado).
  case_title        text NOT NULL,
  conversation      jsonb NOT NULL,
  expect_handoff    boolean NOT NULL,
  expected_notes    text,
  -- Saída.
  response          text,
  handoff           boolean NOT NULL DEFAULT false,
  -- Conferência automática (handoff esperado × obtido); NULL = erro.
  auto_pass         boolean,
  error_code        text CHECK (error_code IS NULL OR char_length(error_code) <= 64),
  tool_calls        integer NOT NULL DEFAULT 0 CHECK (tool_calls >= 0),
  prompt_tokens     integer NOT NULL DEFAULT 0 CHECK (prompt_tokens >= 0),
  completion_tokens integer NOT NULL DEFAULT 0 CHECK (completion_tokens >= 0),
  cost_usd          numeric(12, 6),
  -- Julgamento humano (P-3: juiz por LLM fica fora).
  verdict           text CHECK (verdict IS NULL OR verdict IN ('pass', 'fail')),
  judged_by         uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  judged_at         timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ai_eval_results_run_idx
  ON public.ai_eval_results (run_id);
CREATE INDEX IF NOT EXISTS ai_eval_results_account_idx
  ON public.ai_eval_results (account_id);

ALTER TABLE public.ai_eval_cases ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_eval_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_eval_results ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ai_eval_cases_select ON public.ai_eval_cases;
CREATE POLICY ai_eval_cases_select ON public.ai_eval_cases
  FOR SELECT TO authenticated
  USING (public.is_account_member(account_id, 'admin'));
DROP POLICY IF EXISTS ai_eval_cases_insert ON public.ai_eval_cases;
CREATE POLICY ai_eval_cases_insert ON public.ai_eval_cases
  FOR INSERT TO authenticated
  WITH CHECK (public.is_account_member(account_id, 'admin'));
DROP POLICY IF EXISTS ai_eval_cases_update ON public.ai_eval_cases;
CREATE POLICY ai_eval_cases_update ON public.ai_eval_cases
  FOR UPDATE TO authenticated
  USING (public.is_account_member(account_id, 'admin'))
  WITH CHECK (public.is_account_member(account_id, 'admin'));
DROP POLICY IF EXISTS ai_eval_cases_delete ON public.ai_eval_cases;
CREATE POLICY ai_eval_cases_delete ON public.ai_eval_cases
  FOR DELETE TO authenticated
  USING (public.is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS ai_eval_runs_select ON public.ai_eval_runs;
CREATE POLICY ai_eval_runs_select ON public.ai_eval_runs
  FOR SELECT TO authenticated
  USING (public.is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS ai_eval_results_select ON public.ai_eval_results;
CREATE POLICY ai_eval_results_select ON public.ai_eval_results
  FOR SELECT TO authenticated
  USING (public.is_account_member(account_id, 'admin'));
DROP POLICY IF EXISTS ai_eval_results_update ON public.ai_eval_results;
CREATE POLICY ai_eval_results_update ON public.ai_eval_results
  FOR UPDATE TO authenticated
  USING (public.is_account_member(account_id, 'admin'))
  WITH CHECK (public.is_account_member(account_id, 'admin'));

REVOKE ALL ON TABLE public.ai_eval_cases FROM PUBLIC;
REVOKE ALL ON TABLE public.ai_eval_cases FROM anon;
REVOKE ALL ON TABLE public.ai_eval_cases FROM authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.ai_eval_cases TO authenticated;
GRANT ALL ON TABLE public.ai_eval_cases TO service_role;

REVOKE ALL ON TABLE public.ai_eval_runs FROM PUBLIC;
REVOKE ALL ON TABLE public.ai_eval_runs FROM anon;
REVOKE ALL ON TABLE public.ai_eval_runs FROM authenticated;
GRANT SELECT ON TABLE public.ai_eval_runs TO authenticated;
GRANT ALL ON TABLE public.ai_eval_runs TO service_role;

REVOKE ALL ON TABLE public.ai_eval_results FROM PUBLIC;
REVOKE ALL ON TABLE public.ai_eval_results FROM anon;
REVOKE ALL ON TABLE public.ai_eval_results FROM authenticated;
GRANT SELECT ON TABLE public.ai_eval_results TO authenticated;
-- Só o veredito é do painel; o resto do resultado é do servidor.
GRANT UPDATE (verdict, judged_by, judged_at) ON TABLE public.ai_eval_results TO authenticated;
GRANT ALL ON TABLE public.ai_eval_results TO service_role;

-- ------------------------------------------------------------
-- 4) match_ai_examples
-- ------------------------------------------------------------
-- p_query_embedding  literal pgvector '[0.1,...]'; NULL ou '' = nada a buscar
--                    (devolve vazio: sem embeddings não há similaridade).
-- p_embedding_model  identificador PEDIDO ao provedor; 'openai/' é ignorado
--                    na comparação (mesmo modelo de 1536 dimensões).
-- p_match_count      1..5 (padrão 3).
-- p_max_distance     limiar de distância cosseno (0..2); NULL = sem limiar.
-- Só `approved`, com embedding do mesmo modelo. Ordem: mais parecido primeiro.
CREATE OR REPLACE FUNCTION public.match_ai_examples(
  p_account_id      uuid,
  p_query_embedding text,
  p_embedding_model text,
  p_match_count     integer,
  p_max_distance    real
)
RETURNS TABLE (
  id               uuid,
  customer_message text,
  ideal_response   text,
  distance         real
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_count integer := LEAST(GREATEST(COALESCE(p_match_count, 3), 1), 5);
  v_max   real    := COALESCE(p_max_distance, 2);
  v_model text    := regexp_replace(btrim(COALESCE(p_embedding_model, '')), '^openai/', '');
  v_vec   vector(1536);
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

  IF p_query_embedding IS NULL OR btrim(p_query_embedding) = '' OR v_model = '' THEN
    RETURN;
  END IF;
  v_vec := p_query_embedding::vector(1536);

  RETURN QUERY
  SELECT e.id,
         e.customer_message,
         e.ideal_response,
         (e.embedding <=> v_vec)::real AS dist
    FROM ai_examples e
   WHERE e.account_id = p_account_id
     AND e.status = 'approved'
     AND e.embedding IS NOT NULL
     AND regexp_replace(COALESCE(e.embedding_model, ''), '^openai/', '') = v_model
     AND (e.embedding <=> v_vec) <= v_max
   ORDER BY e.embedding <=> v_vec, e.id
   LIMIT v_count;
END;
$$;

ALTER FUNCTION public.match_ai_examples(uuid, text, text, integer, real) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.match_ai_examples(uuid, text, text, integer, real) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.match_ai_examples(uuid, text, text, integer, real) FROM anon;
GRANT EXECUTE ON FUNCTION public.match_ai_examples(uuid, text, text, integer, real) TO authenticated, service_role;

COMMENT ON FUNCTION public.match_ai_examples(uuid, text, text, integer, real) IS
  'SPEC 089 F7: exemplos aprovados mais parecidos (distancia cosseno, limiar). DEFINER: guarda de vinculo com a conta no corpo.';

-- ------------------------------------------------------------
-- 5) Asserções (falham alto se algo ficou pela metade)
-- ------------------------------------------------------------
DO $$
BEGIN
  IF has_table_privilege('anon', 'public.ai_examples', 'SELECT')
     OR has_table_privilege('anon', 'public.ai_drafts', 'SELECT')
     OR has_table_privilege('anon', 'public.ai_eval_cases', 'SELECT')
     OR has_table_privilege('anon', 'public.ai_eval_runs', 'SELECT')
     OR has_table_privilege('anon', 'public.ai_eval_results', 'SELECT') THEN
    RAISE EXCEPTION '108: anon nao pode ter acesso as tabelas de ajuste.' USING ERRCODE = '55006';
  END IF;

  IF has_table_privilege('authenticated', 'public.ai_drafts', 'SELECT')
     OR has_table_privilege('authenticated', 'public.ai_drafts', 'INSERT') THEN
    RAISE EXCEPTION '108: ai_drafts e so do service_role.' USING ERRCODE = '55006';
  END IF;

  IF has_table_privilege('authenticated', 'public.ai_eval_runs', 'INSERT')
     OR has_table_privilege('authenticated', 'public.ai_eval_runs', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.ai_eval_runs', 'DELETE')
     OR has_table_privilege('authenticated', 'public.ai_eval_results', 'INSERT')
     OR has_table_privilege('authenticated', 'public.ai_eval_results', 'DELETE')
     OR has_column_privilege('authenticated', 'public.ai_eval_results', 'response', 'UPDATE')
     OR NOT has_column_privilege('authenticated', 'public.ai_eval_results', 'verdict', 'UPDATE') THEN
    RAISE EXCEPTION '108: privilegios de ai_eval_runs/ai_eval_results fora do desenho.' USING ERRCODE = '55006';
  END IF;

  IF has_function_privilege('anon', 'public.match_ai_examples(uuid,text,text,integer,real)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.match_ai_examples(uuid,text,text,integer,real)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.match_ai_examples(uuid,text,text,integer,real)', 'EXECUTE') THEN
    RAISE EXCEPTION '108: EXECUTE de match_ai_examples fora do desenho.' USING ERRCODE = '55006';
  END IF;
END $$;
