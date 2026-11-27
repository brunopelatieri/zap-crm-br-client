-- ============================================================
-- 106_ai_tool_calls.sql — SPEC 089 F5 (ferramentas de escrita do agente)
--
--   1. ai_tool_calls: auditoria de TODA chamada de ferramenta de um turno
--      real do auto-reply (leitura e escrita), uma linha por chamada,
--      gravada ANTES de a ferramenta rodar (estado 'started') e fechada
--      depois ('ok' | 'error' | 'timeout'). Chamada recusada pelo banco
--      (teto de escritas por conversa, quota do plano) também vira linha,
--      com estado 'refused'. Só de inserção para o cliente: ninguém tem
--      INSERT/UPDATE/DELETE direto na tabela, nem o service_role; a
--      escrita passa pelas duas RPCs abaixo (SECURITY DEFINER).
--   2. claim_ai_tool_call(): reivindica a chamada de forma ATÔMICA — uma
--      só transação confere a conversa da conta (e a trava), a
--      idempotência (account_id, call_key), o teto de escritas por
--      conversa (SPEC 089 P-6: 10) e a quota mensal de plano
--      `ai_tool_calls_month` (D-20: ausente = ilimitado; o banco decide,
--      regra 1 de planos-quotas-admin.md), e insere a linha 'started'.
--      O contador do mês é `ai_tool_calls:YYYY-MM` em
--      account_usage_counters (America/Sao_Paulo, como form_responses).
--      EXCEÇÃO: `handoff_to_human` nunca é recusado pelo teto nem pela quota
--      (e não gasta quota): é a saída de emergência, e um agente que bateu
--      no limite ainda precisa conseguir passar a conversa a uma pessoa. A
--      chamada continua auditada (linha 'started').
--   3. finish_ai_tool_call(): fecha uma linha 'started' (uma vez).
--   4. account_activity_log.resource_type aceita 'ai' (o registro de
--      atividade da SPEC 075 ganha as ações `ai.tool_*`, ator 'system').
--
-- Privilégios (supabase-rls-mcp.md): as duas funções só dão EXECUTE a
-- service_role (REVOKE de PUBLIC, anon e authenticated); a tabela só dá
-- SELECT a authenticated, e a policy deixa admin+ ler o PRÓPRIO
-- histórico. A conta apagada leva as linhas junto (CASCADE); conversa ou
-- contato apagados viram NULL (a auditoria sobrevive).
--
-- Retenção (SPEC 089 P-5) ainda é pendência: nada apaga estas linhas.
--
-- Idempotente — pode rodar de novo. Nada de URL ou segredo do deploy aqui.
-- ============================================================

-- ------------------------------------------------------------
-- 1) Tabela de auditoria
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.ai_tool_calls (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  conversation_id uuid REFERENCES public.conversations(id) ON DELETE SET NULL,
  contact_id      uuid REFERENCES public.contacts(id) ON DELETE SET NULL,
  mode            text NOT NULL
                    CHECK (mode IN ('auto_reply', 'draft', 'playground', 'eval')),
  tool            text NOT NULL CHECK (char_length(tool) BETWEEN 1 AND 64),
  risk            text NOT NULL CHECK (risk IN ('read', 'write')),
  -- `<turno>:<id da chamada>`: o mesmo par nunca executa duas vezes.
  call_key        text NOT NULL CHECK (char_length(call_key) BETWEEN 1 AND 200),
  -- Argumentos JÁ com dado pessoal mascarado pelo código (SPEC 089 §8).
  input           jsonb NOT NULL DEFAULT '{}'::jsonb
                    CHECK (octet_length(input::text) <= 4096),
  output_summary  text CHECK (output_summary IS NULL OR char_length(output_summary) <= 500),
  status          text NOT NULL DEFAULT 'started'
                    CHECK (status IN ('started', 'ok', 'error', 'timeout', 'refused')),
  error_code      text CHECK (error_code IS NULL OR char_length(error_code) <= 64),
  duration_ms     integer CHECK (duration_ms IS NULL OR duration_ms >= 0),
  created_at      timestamptz NOT NULL DEFAULT now(),
  finished_at     timestamptz
);

COMMENT ON TABLE public.ai_tool_calls IS
  'SPEC 089 F5: auditoria append-only das chamadas de ferramenta do agente de IA (auto-reply). Escrita só pelas RPCs claim_ai_tool_call / finish_ai_tool_call.';

CREATE UNIQUE INDEX IF NOT EXISTS ai_tool_calls_account_call_key_idx
  ON public.ai_tool_calls (account_id, call_key);
CREATE INDEX IF NOT EXISTS ai_tool_calls_account_created_idx
  ON public.ai_tool_calls (account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ai_tool_calls_conversation_writes_idx
  ON public.ai_tool_calls (conversation_id)
  WHERE risk = 'write' AND status <> 'refused';

ALTER TABLE public.ai_tool_calls ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ai_tool_calls_select ON public.ai_tool_calls;
CREATE POLICY ai_tool_calls_select ON public.ai_tool_calls
  FOR SELECT TO authenticated
  USING (public.is_account_member(account_id, 'admin'));

-- Só leitura para o cliente; nenhum INSERT/UPDATE/DELETE direto, nem para
-- o service_role (a escrita é das RPCs, que rodam como o dono).
REVOKE ALL ON public.ai_tool_calls FROM PUBLIC;
REVOKE ALL ON public.ai_tool_calls FROM anon;
REVOKE ALL ON public.ai_tool_calls FROM authenticated;
REVOKE ALL ON public.ai_tool_calls FROM service_role;
GRANT SELECT ON public.ai_tool_calls TO authenticated;
GRANT SELECT ON public.ai_tool_calls TO service_role;

-- ------------------------------------------------------------
-- 2) claim_ai_tool_call — reivindicação atômica
-- ------------------------------------------------------------
-- outcome:
--   'claimed'               linha 'started' criada (call_id)
--   'duplicate'             o mesmo call_key já existe (call_id da existente)
--   'conversation_not_found' conversa inexistente ou de outra conta
--   'write_cap_reached'     teto de escritas da conversa (linha 'refused')
--   'quota_exceeded'        quota ai_tool_calls_month (linha 'refused')
-- `used`/`limit`: uso do mês e teto do plano (limit NULL = ilimitado).
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
  -- parâmetro (D-16). FOR UPDATE serializa as chamadas da mesma conversa,
  -- então o teto de escritas não estoura por corrida.
  SELECT c.contact_id
    INTO v_contact_id
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

  -- A saída de emergência não passa pelo teto nem pela quota (ver o
  -- cabeçalho); segue auditada.
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

  v_metric := 'ai_tool_calls:'
    || to_char(now() AT TIME ZONE 'America/Sao_Paulo', 'YYYY-MM');
  v_limit := public.plan_limit(p_account_id, 'ai_tool_calls_month');

  -- Teto de escritas por conversa (padrão 10, ratificado em P-6; o valor
  -- vem do código, limitado aqui a 0–100).
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

  -- Quota mensal: a linha do contador é o lock (como as demais quotas).
  -- Incremento condicional: só passa se ainda há vaga.
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
-- 3) finish_ai_tool_call — fecha uma linha 'started' (uma vez)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.finish_ai_tool_call(
  p_call_id        uuid,
  p_status         text,
  p_error_code     text,
  p_output_summary text,
  p_duration_ms    integer
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_rows integer;
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role'
     AND session_user NOT IN ('postgres', 'supabase_admin') THEN
    RAISE EXCEPTION 'finish_ai_tool_call: forbidden' USING ERRCODE = '42501';
  END IF;

  IF p_status NOT IN ('ok', 'error', 'timeout') THEN
    RAISE EXCEPTION 'finish_ai_tool_call: invalid status' USING ERRCODE = '22023';
  END IF;

  UPDATE public.ai_tool_calls
     SET status = p_status,
         error_code = LEFT(p_error_code, 64),
         output_summary = LEFT(p_output_summary, 500),
         duration_ms = GREATEST(p_duration_ms, 0),
         finished_at = now()
   WHERE id = p_call_id
     AND status = 'started';
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows = 1;
END;
$$;

ALTER FUNCTION public.finish_ai_tool_call(uuid, text, text, text, integer) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.finish_ai_tool_call(uuid, text, text, text, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.finish_ai_tool_call(uuid, text, text, text, integer) FROM anon;
REVOKE ALL ON FUNCTION public.finish_ai_tool_call(uuid, text, text, text, integer) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.finish_ai_tool_call(uuid, text, text, text, integer) TO service_role;

-- ------------------------------------------------------------
-- 4) Registro de atividade: recurso novo `ai` (SPEC 075 / 089 F5)
--    O CHECK da 084/097 é recriado por nome, como a 097 fez para `form`.
-- ------------------------------------------------------------
DO $$
DECLARE
  v_con RECORD;
BEGIN
  FOR v_con IN
    SELECT c.conname
      FROM pg_constraint c
     WHERE c.conrelid = 'public.account_activity_log'::regclass
       AND c.contype = 'c'
       AND pg_get_constraintdef(c.oid) LIKE '%resource_type%'
  LOOP
    EXECUTE format('ALTER TABLE public.account_activity_log DROP CONSTRAINT %I', v_con.conname);
  END LOOP;
END $$;

ALTER TABLE public.account_activity_log
  ADD CONSTRAINT account_activity_log_resource_type_check
  CHECK (resource_type IN (
    'message','conversation','contact','deal','broadcast',
    'automation','flow','channel','member','export',
    'plan','tag','webhook','form','ai'));

-- ------------------------------------------------------------
-- 5) Asserções (falham alto se algo ficou pela metade)
-- ------------------------------------------------------------
DO $$
BEGIN
  IF (SELECT count(*) FROM pg_constraint
       WHERE conrelid = 'public.account_activity_log'::regclass
         AND contype = 'c'
         AND pg_get_constraintdef(oid) LIKE '%resource_type%') <> 1 THEN
    RAISE EXCEPTION '106: account_activity_log deve ter exatamente UM check de resource_type.' USING ERRCODE = '55006';
  END IF;

  IF has_table_privilege('authenticated', 'public.ai_tool_calls', 'INSERT')
     OR has_table_privilege('authenticated', 'public.ai_tool_calls', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.ai_tool_calls', 'DELETE')
     OR has_table_privilege('anon', 'public.ai_tool_calls', 'SELECT')
     OR has_table_privilege('service_role', 'public.ai_tool_calls', 'INSERT')
     OR has_table_privilege('service_role', 'public.ai_tool_calls', 'UPDATE')
     OR has_table_privilege('service_role', 'public.ai_tool_calls', 'DELETE') THEN
    RAISE EXCEPTION '106: privilegios de ai_tool_calls fora do desenho (so SELECT para authenticated/service_role).' USING ERRCODE = '55006';
  END IF;

  IF has_function_privilege('anon', 'public.claim_ai_tool_call(uuid,uuid,text,text,text,text,jsonb,integer)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.claim_ai_tool_call(uuid,uuid,text,text,text,text,jsonb,integer)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.finish_ai_tool_call(uuid,text,text,text,integer)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.finish_ai_tool_call(uuid,text,text,text,integer)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.claim_ai_tool_call(uuid,uuid,text,text,text,text,jsonb,integer)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.finish_ai_tool_call(uuid,text,text,text,integer)', 'EXECUTE') THEN
    RAISE EXCEPTION '106: EXECUTE das RPCs de auditoria fora do desenho (so service_role).' USING ERRCODE = '55006';
  END IF;
END $$;
