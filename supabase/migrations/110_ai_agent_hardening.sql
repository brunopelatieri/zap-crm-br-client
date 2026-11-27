-- ============================================================
-- 110 — Endurecimento do agente de IA (SPEC 089 F8, revisão de segurança)
-- ============================================================
-- Idempotente. Aplicar no SQL Editor do `vn` pelo mantenedor; depois rodar
-- scripts/verify-110-ai-agent-hardening.sql e `get_advisors` (security).
-- A 109 é da SPEC 090: esta migração não depende dela.
--
-- O que muda, e por quê (achados da revisão adversarial da F8):
--   1) claim_ai_reply_slot só concede vaga em conversa sem humano: com a IA
--      pausada (`ai_autoreply_disabled`) ou com agente atribuído, a vaga é
--      recusada. Antes, uma rajada de mensagens ou um "Assumir" no meio de
--      um turno de até 60 s deixava o turno em curso escrever e responder
--      numa conversa que já era de um humano.
--   2) claim_ai_tool_call recusa (`conversation_paused`) ferramenta do
--      auto-reply em conversa pausada ou atribuída, exceto o
--      `handoff_to_human` (saída de emergência). Rascunho e demais modos não
--      mudam: neles o humano é quem opera.
--   3) match_ai_examples passa a exigir admin para a sessão (a tabela
--      `ai_examples` já é só de admin). O rascunho pedido por um agente
--      chama a RPC com o service role (código, mesma entrega).
--   4) deals.ai_dedupe_key + índice único parcial: o `create_deal` do agente
--      não cria dois negócios abertos iguais por corrida (duas mensagens em
--      rajada). Só o agente preenche a coluna; negócio criado por humano fica
--      NULL e não é afetado. Ao sair de `open`, a chave é limpa (trigger), então
--      reabrir um negócio nunca colide.
--   5) purge_ai_tool_calls: expurgo por idade da auditoria (retenção decidida
--      pelo mantenedor: 90 dias), com teto por chamada. A tabela não dá DELETE
--      a ninguém (106); a função é o único caminho e só o service_role a chama
--      (fase 9 do /api/automations/cron).
--   6) search_path com pg_temp nas duas funções SECURITY DEFINER da 103.
--   7) ai_custom_tools não aceita nome de ferramenta nativa (a isenção de
--      teto e quota do `handoff_to_human` no claim depende só do nome).
--   8) ai_eval_results: o veredito só pode ser assinado pelo próprio usuário
--      (`judged_by` = auth.uid() ou NULL).
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- 1) claim_ai_reply_slot
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.claim_ai_reply_slot(
  conversation_id uuid,
  max_replies     integer
)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH claimed AS (
    UPDATE public.conversations c
       SET ai_reply_count = c.ai_reply_count + 1
     WHERE c.id = claim_ai_reply_slot.conversation_id
       AND c.ai_reply_count < claim_ai_reply_slot.max_replies
       AND NOT COALESCE(c.ai_autoreply_disabled, false)
       AND c.assigned_agent_id IS NULL
    RETURNING 1
  )
  SELECT EXISTS (SELECT 1 FROM claimed);
$$;

ALTER FUNCTION public.claim_ai_reply_slot(uuid, integer) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.claim_ai_reply_slot(uuid, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.claim_ai_reply_slot(uuid, integer) FROM anon;
REVOKE ALL ON FUNCTION public.claim_ai_reply_slot(uuid, integer) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.claim_ai_reply_slot(uuid, integer) TO service_role;

-- ------------------------------------------------------------
-- 2) claim_ai_tool_call (corpo da 106 + recusa em conversa pausada)
-- ------------------------------------------------------------
-- outcome:
--   'claimed'               linha 'started' criada (call_id)
--   'duplicate'             o mesmo call_key já existe (call_id da existente)
--   'conversation_not_found' conversa inexistente ou de outra conta
--   'conversation_paused'   (110) auto-reply em conversa pausada ou atribuída
--   'write_cap_reached'     teto de escritas da conversa (linha 'refused')
--   'quota_exceeded'        quota ai_tool_calls_month (linha 'refused')
CREATE OR REPLACE FUNCTION public.claim_ai_tool_call(
  p_account_id      uuid,
  p_conversation_id uuid,
  p_mode            text,
  p_tool            text,
  p_risk            text,
  p_call_key        text,
  p_input           jsonb,
  p_max_writes      integer
)
RETURNS TABLE (outcome text, call_id uuid, used integer, "limit" integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_contact_id uuid;
  v_paused     boolean;
  v_assigned   uuid;
  v_existing   uuid;
  v_writes     integer;
  v_metric     text;
  v_limit      integer;
  v_used       integer;
  v_id         uuid;
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role'
     AND session_user NOT IN ('postgres', 'supabase_admin') THEN
    RAISE EXCEPTION 'claim_ai_tool_call: forbidden' USING ERRCODE = '42501';
  END IF;

  IF p_risk NOT IN ('read', 'write') THEN
    RAISE EXCEPTION 'claim_ai_tool_call: invalid risk' USING ERRCODE = '22023';
  END IF;

  -- A conversa tem de ser DESTA conta. O contato é o da linha, nunca um
  -- parâmetro (D-16). FOR UPDATE serializa as chamadas da mesma conversa.
  SELECT c.contact_id, COALESCE(c.ai_autoreply_disabled, false), c.assigned_agent_id
    INTO v_contact_id, v_paused, v_assigned
    FROM public.conversations c
   WHERE c.id = p_conversation_id
     AND c.account_id = p_account_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'conversation_not_found'::text, NULL::uuid, 0, NULL::integer;
    RETURN;
  END IF;

  SELECT t.id INTO v_existing
    FROM public.ai_tool_calls t
   WHERE t.account_id = p_account_id AND t.call_key = p_call_key;
  IF FOUND THEN
    RETURN QUERY SELECT 'duplicate'::text, v_existing, 0, NULL::integer;
    RETURN;
  END IF;

  -- A saída de emergência não passa pelo teto, pela quota nem pela pausa;
  -- segue auditada.
  IF p_tool = 'handoff_to_human' THEN
    INSERT INTO public.ai_tool_calls
      (account_id, conversation_id, contact_id, mode, tool, risk, call_key, input)
    VALUES
      (p_account_id, p_conversation_id, v_contact_id, p_mode, p_tool, p_risk,
       p_call_key, COALESCE(p_input, '{}'::jsonb))
    RETURNING id INTO v_id;
    RETURN QUERY SELECT 'claimed'::text, v_id, 0, NULL::integer;
    RETURN;
  END IF;

  -- (110) Um humano assumiu (ou a IA já entregou) enquanto o turno rodava:
  -- o auto-reply não age mais nesta conversa.
  IF p_mode = 'auto_reply' AND (v_paused OR v_assigned IS NOT NULL) THEN
    INSERT INTO public.ai_tool_calls
      (account_id, conversation_id, contact_id, mode, tool, risk, call_key,
       input, status, error_code, finished_at)
    VALUES
      (p_account_id, p_conversation_id, v_contact_id, p_mode, p_tool, p_risk,
       p_call_key, COALESCE(p_input, '{}'::jsonb), 'refused',
       'conversation_paused', now())
    RETURNING id INTO v_id;
    RETURN QUERY SELECT 'conversation_paused'::text, v_id, 0, NULL::integer;
    RETURN;
  END IF;

  v_metric := 'ai_tool_calls:'
    || to_char(now() AT TIME ZONE 'America/Sao_Paulo', 'YYYY-MM');
  v_limit := public.plan_limit(p_account_id, 'ai_tool_calls_month');

  IF p_risk = 'write' THEN
    SELECT count(*)::integer INTO v_writes
      FROM public.ai_tool_calls t
     WHERE t.conversation_id = p_conversation_id
       AND t.risk = 'write'
       AND t.status <> 'refused';
    IF v_writes >= GREATEST(0, LEAST(COALESCE(p_max_writes, 10), 100)) THEN
      INSERT INTO public.ai_tool_calls
        (account_id, conversation_id, contact_id, mode, tool, risk, call_key,
         input, status, error_code, finished_at)
      VALUES
        (p_account_id, p_conversation_id, v_contact_id, p_mode, p_tool, p_risk,
         p_call_key, COALESCE(p_input, '{}'::jsonb), 'refused',
         'write_cap_reached', now())
      RETURNING id INTO v_id;
      RETURN QUERY SELECT 'write_cap_reached'::text, v_id, v_writes, NULL::integer;
      RETURN;
    END IF;
  END IF;

  INSERT INTO public.account_usage_counters (account_id, metric, value, updated_at)
  VALUES (p_account_id, v_metric, 0, now())
  ON CONFLICT (account_id, metric) DO NOTHING;

  UPDATE public.account_usage_counters
     SET value = value + 1, updated_at = now()
   WHERE account_id = p_account_id
     AND metric = v_metric
     AND (v_limit IS NULL OR value < v_limit)
  RETURNING value INTO v_used;

  IF NOT FOUND THEN
    SELECT value INTO v_used
      FROM public.account_usage_counters
     WHERE account_id = p_account_id AND metric = v_metric;
    INSERT INTO public.ai_tool_calls
      (account_id, conversation_id, contact_id, mode, tool, risk, call_key,
       input, status, error_code, finished_at)
    VALUES
      (p_account_id, p_conversation_id, v_contact_id, p_mode, p_tool, p_risk,
       p_call_key, COALESCE(p_input, '{}'::jsonb), 'refused',
       'quota_exceeded', now())
    RETURNING id INTO v_id;
    RETURN QUERY SELECT 'quota_exceeded'::text, v_id, COALESCE(v_used, 0), v_limit;
    RETURN;
  END IF;

  INSERT INTO public.ai_tool_calls
    (account_id, conversation_id, contact_id, mode, tool, risk, call_key, input)
  VALUES
    (p_account_id, p_conversation_id, v_contact_id, p_mode, p_tool, p_risk,
     p_call_key, COALESCE(p_input, '{}'::jsonb))
  RETURNING id INTO v_id;

  RETURN QUERY SELECT 'claimed'::text, v_id, v_used, v_limit;
END;
$$;

ALTER FUNCTION public.claim_ai_tool_call(uuid, uuid, text, text, text, text, jsonb, integer)
  OWNER TO postgres;
REVOKE ALL ON FUNCTION public.claim_ai_tool_call(uuid, uuid, text, text, text, text, jsonb, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.claim_ai_tool_call(uuid, uuid, text, text, text, text, jsonb, integer) FROM anon;
REVOKE ALL ON FUNCTION public.claim_ai_tool_call(uuid, uuid, text, text, text, text, jsonb, integer) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.claim_ai_tool_call(uuid, uuid, text, text, text, text, jsonb, integer) TO service_role;

-- ------------------------------------------------------------
-- 3) match_ai_examples: sessão precisa ser admin
-- ------------------------------------------------------------
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

  -- (110) Mesma régua da tabela `ai_examples` (admin). O motor (auto-reply,
  -- rascunho, playground, avaliação) chama como service_role.
  IF COALESCE(auth.role(), '') <> 'service_role'
     AND NOT public.is_account_member(p_account_id, 'admin'::public.account_role_enum) THEN
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
    FROM public.ai_examples e
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

-- ------------------------------------------------------------
-- 4) deals.ai_dedupe_key + índice único parcial + limpeza ao sair de open
-- ------------------------------------------------------------
ALTER TABLE public.deals
  ADD COLUMN IF NOT EXISTS ai_dedupe_key text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.deals'::regclass
       AND conname = 'deals_ai_dedupe_key_len'
  ) THEN
    ALTER TABLE public.deals
      ADD CONSTRAINT deals_ai_dedupe_key_len
      CHECK (ai_dedupe_key IS NULL OR char_length(ai_dedupe_key) BETWEEN 1 AND 200);
  END IF;
END $$;

COMMENT ON COLUMN public.deals.ai_dedupe_key IS
  'SPEC 089 F8: chave do create_deal do agente de IA (contato, funil e título normalizado). NULL para negócio criado por humano. Limpa quando o negócio sai de open.';

-- Poucas linhas têm a chave: o índice é pequeno. Sem CONCURRENTLY porque a
-- migração roda numa transação (a tabela `deals` é pequena no `vn`).
CREATE UNIQUE INDEX IF NOT EXISTS deals_ai_dedupe_open_uidx
  ON public.deals (account_id, ai_dedupe_key)
  WHERE ai_dedupe_key IS NOT NULL AND status = 'open';

CREATE OR REPLACE FUNCTION public.clear_deal_ai_dedupe_key()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM 'open' THEN
    NEW.ai_dedupe_key := NULL;
  END IF;
  RETURN NEW;
END;
$$;

ALTER FUNCTION public.clear_deal_ai_dedupe_key() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.clear_deal_ai_dedupe_key() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.clear_deal_ai_dedupe_key() FROM anon;
REVOKE ALL ON FUNCTION public.clear_deal_ai_dedupe_key() FROM authenticated;

DROP TRIGGER IF EXISTS clear_deal_ai_dedupe_key_trigger ON public.deals;
CREATE TRIGGER clear_deal_ai_dedupe_key_trigger
  BEFORE INSERT OR UPDATE OF status, ai_dedupe_key ON public.deals
  FOR EACH ROW
  WHEN (NEW.ai_dedupe_key IS NOT NULL)
  EXECUTE FUNCTION public.clear_deal_ai_dedupe_key();

-- ------------------------------------------------------------
-- 5) purge_ai_tool_calls — retenção da auditoria (90 dias)
-- ------------------------------------------------------------
-- p_older_than_days  idade mínima (limitada a 30..3650; padrão 90)
-- p_limit            linhas por chamada (limitado a 1..5000; padrão 1000)
-- Devolve quantas linhas apagou. Mais antigas primeiro.
CREATE OR REPLACE FUNCTION public.purge_ai_tool_calls(
  p_older_than_days integer DEFAULT 90,
  p_limit           integer DEFAULT 1000
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_days  integer := LEAST(GREATEST(COALESCE(p_older_than_days, 90), 30), 3650);
  v_limit integer := LEAST(GREATEST(COALESCE(p_limit, 1000), 1), 5000);
  v_count integer;
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role'
     AND session_user NOT IN ('postgres', 'supabase_admin') THEN
    RAISE EXCEPTION 'purge_ai_tool_calls: forbidden' USING ERRCODE = '42501';
  END IF;

  WITH victims AS (
    SELECT t.id
      FROM public.ai_tool_calls t
     WHERE t.created_at < now() - make_interval(days => v_days)
     ORDER BY t.created_at
     LIMIT v_limit
  )
  DELETE FROM public.ai_tool_calls t
   USING victims v
   WHERE t.id = v.id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

ALTER FUNCTION public.purge_ai_tool_calls(integer, integer) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.purge_ai_tool_calls(integer, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.purge_ai_tool_calls(integer, integer) FROM anon;
REVOKE ALL ON FUNCTION public.purge_ai_tool_calls(integer, integer) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.purge_ai_tool_calls(integer, integer) TO service_role;

CREATE INDEX IF NOT EXISTS ai_tool_calls_created_idx
  ON public.ai_tool_calls (created_at);

-- ------------------------------------------------------------
-- 6) search_path com pg_temp (funções DEFINER da 103)
-- ------------------------------------------------------------
ALTER FUNCTION public.enforce_knowledge_document_quota() SET search_path = public, pg_temp;
ALTER FUNCTION public.recount_account_usage(uuid) SET search_path = public, pg_temp;

-- ------------------------------------------------------------
-- 7) ai_custom_tools: nome de ferramenta nativa é reservado
-- ------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.ai_custom_tools'::regclass
       AND conname = 'ai_custom_tools_name_not_native'
  ) THEN
    ALTER TABLE public.ai_custom_tools
      ADD CONSTRAINT ai_custom_tools_name_not_native
      CHECK (name NOT IN (
        'search_knowledge', 'get_contact_profile', 'list_contact_deals',
        'update_contact_fields', 'add_contact_tags', 'remove_contact_tags',
        'create_deal', 'move_deal_stage', 'add_internal_note',
        'handoff_to_human', 'send_form_link'
      ));
  END IF;
END $$;

-- ------------------------------------------------------------
-- 8) ai_eval_results: veredito assinado pelo próprio usuário
-- ------------------------------------------------------------
DROP POLICY IF EXISTS ai_eval_results_update ON public.ai_eval_results;
CREATE POLICY ai_eval_results_update ON public.ai_eval_results
  FOR UPDATE TO authenticated
  USING (public.is_account_member(account_id, 'admin'))
  WITH CHECK (
    public.is_account_member(account_id, 'admin')
    AND (judged_by IS NULL OR judged_by = (SELECT auth.uid()))
  );

-- ------------------------------------------------------------
-- Asserções (falham a migração inteira se algo não ficou como deveria)
-- ------------------------------------------------------------
DO $$
DECLARE
  v_fn text;
BEGIN
  FOREACH v_fn IN ARRAY ARRAY[
    'public.claim_ai_reply_slot(uuid, integer)',
    'public.claim_ai_tool_call(uuid, uuid, text, text, text, text, jsonb, integer)',
    'public.purge_ai_tool_calls(integer, integer)',
    'public.clear_deal_ai_dedupe_key()'
  ] LOOP
    IF has_function_privilege('anon', v_fn::regprocedure, 'EXECUTE')
       OR has_function_privilege('authenticated', v_fn::regprocedure, 'EXECUTE') THEN
      RAISE EXCEPTION '110: % executavel por anon ou authenticated.', v_fn USING ERRCODE = '55006';
    END IF;
  END LOOP;

  IF has_function_privilege('anon', 'public.match_ai_examples(uuid, text, text, integer, real)'::regprocedure, 'EXECUTE') THEN
    RAISE EXCEPTION '110: match_ai_examples executavel por anon.' USING ERRCODE = '55006';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc
     WHERE oid = 'public.match_ai_examples(uuid, text, text, integer, real)'::regprocedure
       AND prosrc LIKE '%''admin''::public.account_role_enum%'
  ) THEN
    RAISE EXCEPTION '110: match_ai_examples sem a guarda de admin.' USING ERRCODE = '55006';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_proc
     WHERE oid IN ('public.enforce_knowledge_document_quota()'::regprocedure,
                   'public.recount_account_usage(uuid)'::regprocedure)
       AND NOT ('search_path=public, pg_temp' = ANY (proconfig))
  ) THEN
    RAISE EXCEPTION '110: funcao da 103 sem search_path com pg_temp.' USING ERRCODE = '55006';
  END IF;
END $$;

COMMIT;
