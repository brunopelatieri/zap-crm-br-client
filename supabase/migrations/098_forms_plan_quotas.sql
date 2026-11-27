-- ============================================================
-- 098_forms_plan_quotas.sql — SPEC 085 §5.2 (PRD 084 D-10), F1
--
-- Plano e quotas dos formulários. Depende da 097 (tabelas) e da 096
-- (`plan_feature_strict`). Escrita LOCAL nesta fase; aplicar no `vn` só
-- na F5, com confirmação do mantenedor. Idempotente.
--
-- 1. `account_usage_counters.value` passa a BIGINT. A quota de upload é
--    contada em BYTES (E-7) e o plano Empresarial do PRD §7 dá 5.120 MB
--    = 5.368.709.120 bytes, acima do teto de INTEGER (2^31−1). Achado
--    da F1; registrado no Status da SPEC. Nada que lê o contador muda:
--    `plan_limit` continua INTEGER (MB), e o TS lê `number`.
-- 2. `enforce_form_quota()` — métrica `forms` = formulários NÃO
--    arquivados. AFTER INSERT / UPDATE OF status / DELETE, no padrão de
--    `enforce_contact_quota` (067 §9): incrementa-depois-checa, porque o
--    UPDATE do contador é o lock que serializa a corrida.
--    Estouro → `QUOTA_EXCEEDED:forms:<used>:<limit>` (P0001, contrato de
--    `src/lib/plans/errors.ts`).
-- 3. `count_form_responses_month()` — métrica `form_responses:YYYY-MM`
--    em `America/Sao_Paulo`, incrementada quando a resposta vira
--    `completed`. NÃO levanta exceção: a recusa é na pré-checagem (E-8)
--    e na rota; um estouro por corrida fica acima do teto, aceito.
-- 4. `form_month_quota_state(account)` e `form_upload_quota_state(account)`
--    — leitura O(1) para a rota (só `service_role`).
-- 5. `recount_account_usage` estendida: `contacts` (como na 067) +
--    `forms` + `form_responses:<mês corrente>` + `form_upload_bytes`.
-- 6. `form_public_availability` reescrita: + `plan_feature_strict(…,
--    'forms_enabled')` + `form_responses_month` com vaga + `contacts` com
--    vaga (só para o link genérico).
-- 7. `notifications_type_check` aceita `form_response_received`; a tabela
--    ganha `form_id` e `form_response_id` (link profundo da notificação,
--    F4 — `ON DELETE SET NULL`: apagar a resposta não apaga o aviso).
-- 7a. `form_responses.deal_id` (F4): o negócio que a faixa criou, para o
--    painel de detalhe da resposta (`ON DELETE SET NULL`).
-- 7b. `contact_exports.source` (`contacts` | `form_responses`, F4): a
--    exportação de respostas é auditada na MESMA tabela da de contatos
--    (SPEC 085 §4.4). Linhas antigas ficam `contacts` pelo DEFAULT.
-- 8. Asserções.
--
-- Nomes de métrica (contrato com `src/lib/forms/quota.ts`):
--   forms · form_responses:YYYY-MM · form_upload_bytes
-- ============================================================

-- ------------------------------------------------------------
-- 1) Contador em BIGINT
-- ------------------------------------------------------------
ALTER TABLE account_usage_counters
  ALTER COLUMN value TYPE BIGINT;

-- ------------------------------------------------------------
-- 2) Quota `forms` — trigger em `forms`
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.enforce_form_quota()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_used  BIGINT;
  v_limit INTEGER;
  v_delta INTEGER := 0;
  v_account UUID;
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_account := NEW.account_id;
    IF NEW.status <> 'archived' THEN v_delta := 1; END IF;
  ELSIF TG_OP = 'UPDATE' THEN
    v_account := NEW.account_id;
    IF OLD.status <> 'archived' AND NEW.status = 'archived' THEN
      v_delta := -1;
    ELSIF OLD.status = 'archived' AND NEW.status <> 'archived' THEN
      v_delta := 1;
    END IF;
  ELSE -- DELETE
    v_account := OLD.account_id;
    IF OLD.status <> 'archived' THEN v_delta := -1; END IF;
  END IF;

  IF v_delta = 0 THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  IF v_delta < 0 THEN
    UPDATE account_usage_counters
       SET value = GREATEST(value - 1, 0), updated_at = NOW()
     WHERE account_id = v_account AND metric = 'forms';
    RETURN COALESCE(NEW, OLD);
  END IF;

  INSERT INTO account_usage_counters (account_id, metric, value, updated_at)
  VALUES (v_account, 'forms', 1, NOW())
  ON CONFLICT (account_id, metric)
  DO UPDATE SET value = account_usage_counters.value + 1, updated_at = NOW()
  RETURNING value INTO v_used;

  v_limit := plan_limit(v_account, 'forms');

  IF v_limit IS NOT NULL AND v_used > v_limit THEN
    -- Contrato com src/lib/plans/errors.ts — mudou de um lado, muda dos dois.
    RAISE EXCEPTION 'QUOTA_EXCEEDED:forms:%:%', v_used, v_limit
      USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$$;

ALTER FUNCTION public.enforce_form_quota() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.enforce_form_quota() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.enforce_form_quota() FROM anon;
REVOKE ALL ON FUNCTION public.enforce_form_quota() FROM authenticated;

DROP TRIGGER IF EXISTS enforce_form_quota_trigger ON forms;
CREATE TRIGGER enforce_form_quota_trigger
  AFTER INSERT OR UPDATE OF status OR DELETE ON forms
  FOR EACH ROW EXECUTE FUNCTION public.enforce_form_quota();

-- ------------------------------------------------------------
-- 3) Contador mensal de respostas concluídas
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.form_month_metric(p_at TIMESTAMPTZ DEFAULT NOW())
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  -- Mesmo fuso de `src/lib/forms/quota.ts` (monthMetricKey). Mudou de um
  -- lado, muda dos dois (SPEC 085 §14).
  SELECT 'form_responses:' || to_char(p_at AT TIME ZONE 'America/Sao_Paulo', 'YYYY-MM');
$$;

ALTER FUNCTION public.form_month_metric(TIMESTAMPTZ) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.form_month_metric(TIMESTAMPTZ) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.form_month_metric(TIMESTAMPTZ) FROM anon;
REVOKE ALL ON FUNCTION public.form_month_metric(TIMESTAMPTZ) FROM authenticated;

-- A trigger dispara em INSERT já `completed` (o fluxo normal é partial →
-- completed, mas a API da SPEC 086 pode gravar direto) e em todo UPDATE
-- OF status que termine em completed; para não contar duas vezes um
-- UPDATE completed → completed, a função só soma quando o status MUDOU.
CREATE OR REPLACE FUNCTION public.count_form_responses_month()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.status = 'completed' THEN
    RETURN NEW;
  END IF;
  INSERT INTO account_usage_counters (account_id, metric, value, updated_at)
  VALUES (NEW.account_id, form_month_metric(COALESCE(NEW.completed_at, NOW())), 1, NOW())
  ON CONFLICT (account_id, metric)
  DO UPDATE SET value = account_usage_counters.value + 1, updated_at = NOW();
  RETURN NEW;
END;
$$;

ALTER FUNCTION public.count_form_responses_month() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.count_form_responses_month() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.count_form_responses_month() FROM anon;
REVOKE ALL ON FUNCTION public.count_form_responses_month() FROM authenticated;

DROP TRIGGER IF EXISTS count_form_responses_month_trigger ON form_responses;
CREATE TRIGGER count_form_responses_month_trigger
  AFTER INSERT OR UPDATE OF status ON form_responses
  FOR EACH ROW
  WHEN (NEW.status = 'completed')
  EXECUTE FUNCTION public.count_form_responses_month();

-- ------------------------------------------------------------
-- 4) Estado das duas quotas para a rota (só service_role)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.form_month_quota_state(p_account_id UUID)
RETURNS TABLE (used INTEGER, "limit" INTEGER)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE((SELECT c.value::INTEGER
                     FROM account_usage_counters c
                    WHERE c.account_id = p_account_id
                      AND c.metric = form_month_metric(NOW())), 0),
         plan_limit(p_account_id, 'form_responses_month');
$$;

ALTER FUNCTION public.form_month_quota_state(UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.form_month_quota_state(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.form_month_quota_state(UUID) FROM anon;
REVOKE ALL ON FUNCTION public.form_month_quota_state(UUID) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.form_month_quota_state(UUID) TO service_role;

-- `plan_limit` é em MB (chave `form_upload_mb`); o contador é em bytes.
-- `limit_bytes` NULL = ilimitado.
CREATE OR REPLACE FUNCTION public.form_upload_quota_state(p_account_id UUID)
RETURNS TABLE (used_bytes BIGINT, limit_bytes BIGINT)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE((SELECT c.value
                     FROM account_usage_counters c
                    WHERE c.account_id = p_account_id
                      AND c.metric = 'form_upload_bytes'), 0)::BIGINT,
         (plan_limit(p_account_id, 'form_upload_mb')::BIGINT * 1048576);
$$;

ALTER FUNCTION public.form_upload_quota_state(UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.form_upload_quota_state(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.form_upload_quota_state(UUID) FROM anon;
REVOKE ALL ON FUNCTION public.form_upload_quota_state(UUID) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.form_upload_quota_state(UUID) TO service_role;

-- A rota de envio soma os bytes reais (E-7: "no envio concluído, pelo
-- tamanho real do objeto") e a de apagar respostas subtrai. Uma função
-- só, para o delta nunca deixar o contador negativo nem exigir que a
-- rota faça read-modify-write.
CREATE OR REPLACE FUNCTION public.form_upload_bytes_add(p_account_id UUID, p_delta BIGINT)
RETURNS BIGINT
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_value BIGINT;
BEGIN
  INSERT INTO account_usage_counters (account_id, metric, value, updated_at)
  VALUES (p_account_id, 'form_upload_bytes', GREATEST(p_delta, 0), NOW())
  ON CONFLICT (account_id, metric)
  DO UPDATE SET value = GREATEST(account_usage_counters.value + p_delta, 0),
                updated_at = NOW()
  RETURNING value INTO v_value;
  RETURN v_value;
END;
$$;

ALTER FUNCTION public.form_upload_bytes_add(UUID, BIGINT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.form_upload_bytes_add(UUID, BIGINT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.form_upload_bytes_add(UUID, BIGINT) FROM anon;
REVOKE ALL ON FUNCTION public.form_upload_bytes_add(UUID, BIGINT) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.form_upload_bytes_add(UUID, BIGINT) TO service_role;

-- ------------------------------------------------------------
-- 5) recount_account_usage — estendida (corpo da 067 + formulários)
-- ------------------------------------------------------------
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
END;
$$;

ALTER FUNCTION public.recount_account_usage(UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.recount_account_usage(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.recount_account_usage(UUID) FROM anon;
REVOKE ALL ON FUNCTION public.recount_account_usage(UUID) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.recount_account_usage(UUID) TO service_role;

-- ------------------------------------------------------------
-- 6) form_public_availability — completa (E-8)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.form_public_availability(
  p_slug         TEXT,
  p_generic_link BOOLEAN DEFAULT TRUE
)
RETURNS TABLE (status TEXT, reason TEXT, form_id UUID, account_id UUID)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_form    RECORD;
  v_blocked TIMESTAMPTZ;
  v_used    BIGINT;
  v_limit   INTEGER;
BEGIN
  SELECT f.id, f.account_id, f.status
    INTO v_form
    FROM forms f
   WHERE f.slug = p_slug;

  IF v_form.id IS NULL THEN
    RETURN QUERY SELECT 'unavailable'::TEXT, 'not_found'::TEXT, NULL::UUID, NULL::UUID;
    RETURN;
  END IF;

  IF v_form.status <> 'published' THEN
    RETURN QUERY SELECT 'unavailable'::TEXT, 'not_published'::TEXT, v_form.id, v_form.account_id;
    RETURN;
  END IF;

  SELECT a.blocked_at INTO v_blocked FROM accounts a WHERE a.id = v_form.account_id;
  IF v_blocked IS NOT NULL THEN
    RETURN QUERY SELECT 'unavailable'::TEXT, 'account_blocked'::TEXT, v_form.id, v_form.account_id;
    RETURN;
  END IF;

  -- PRD 084 D-10/D-11: fail-closed, independe de quotas_enforced.
  IF NOT plan_feature_strict(v_form.account_id, 'forms_enabled') THEN
    RETURN QUERY SELECT 'unavailable'::TEXT, 'feature_not_in_plan'::TEXT, v_form.id, v_form.account_id;
    RETURN;
  END IF;

  -- Respostas do mês: NULL = ilimitado, 0 = bloqueado (PRD 058 D-3).
  SELECT s.used, s."limit" INTO v_used, v_limit
    FROM form_month_quota_state(v_form.account_id) s;
  IF v_limit IS NOT NULL AND v_used >= v_limit THEN
    RETURN QUERY SELECT 'unavailable'::TEXT, 'responses_quota'::TEXT, v_form.id, v_form.account_id;
    RETURN;
  END IF;

  -- Contatos cheios: só o link genérico cria contato (D-10). Com token o
  -- contato já existe e responde normalmente.
  IF p_generic_link THEN
    v_limit := plan_limit(v_form.account_id, 'contacts');
    IF v_limit IS NOT NULL THEN
      SELECT COALESCE(c.value, 0) INTO v_used
        FROM account_usage_counters c
       WHERE c.account_id = v_form.account_id AND c.metric = 'contacts';
      IF COALESCE(v_used, 0) >= v_limit THEN
        RETURN QUERY SELECT 'unavailable'::TEXT, 'contacts_quota'::TEXT, v_form.id, v_form.account_id;
        RETURN;
      END IF;
    END IF;
  END IF;

  RETURN QUERY SELECT 'available'::TEXT, 'ok'::TEXT, v_form.id, v_form.account_id;
END;
$$;

ALTER FUNCTION public.form_public_availability(TEXT, BOOLEAN) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.form_public_availability(TEXT, BOOLEAN) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.form_public_availability(TEXT, BOOLEAN) FROM anon;
REVOKE ALL ON FUNCTION public.form_public_availability(TEXT, BOOLEAN) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.form_public_availability(TEXT, BOOLEAN) TO service_role;
COMMENT ON FUNCTION public.form_public_availability(TEXT, BOOLEAN) IS
  'SPEC 085 E-8 (098): publicado + conta nao bloqueada + plan_feature_strict(forms_enabled) + form_responses_month com vaga + contacts com vaga (so link generico). So service_role. Todo motivo vira a mesma pagina neutra (PRD 084 D-11).';

-- ------------------------------------------------------------
-- 7) notifications.type += form_response_received (SPEC 085 §9)
-- ------------------------------------------------------------
ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_type_check;
ALTER TABLE notifications
  ADD CONSTRAINT notifications_type_check
  CHECK (type IN ('conversation_assigned', 'channel_payment_blocked', 'form_response_received'));

ALTER TABLE notifications
  ADD COLUMN IF NOT EXISTS form_id UUID REFERENCES forms(id) ON DELETE SET NULL;
ALTER TABLE notifications
  ADD COLUMN IF NOT EXISTS form_response_id UUID REFERENCES form_responses(id) ON DELETE SET NULL;

ALTER TABLE form_responses
  ADD COLUMN IF NOT EXISTS deal_id UUID REFERENCES deals(id) ON DELETE SET NULL;

-- ------------------------------------------------------------
-- 7b) contact_exports.source (F4)
-- ------------------------------------------------------------
ALTER TABLE contact_exports
  ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'contacts';
ALTER TABLE contact_exports DROP CONSTRAINT IF EXISTS contact_exports_source_check;
ALTER TABLE contact_exports
  ADD CONSTRAINT contact_exports_source_check
  CHECK (source IN ('contacts', 'form_responses'));
COMMENT ON COLUMN contact_exports.source IS
  'Origem da exportacao: contacts (SPEC 051) ou form_responses (SPEC 085 F4; filter.form_id aponta o formulario).';

-- ------------------------------------------------------------
-- 8) Asserções — falham alto
-- ------------------------------------------------------------
DO $$
DECLARE
  v_fn   TEXT;
  v_src  TEXT;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'plan_feature_strict') THEN
    RAISE EXCEPTION '098: plan_feature_strict() ausente — rode a 096 primeiro.' USING ERRCODE = '55006';
  END IF;
  IF to_regclass('public.forms') IS NULL THEN
    RAISE EXCEPTION '098: forms ausente — rode a 097 primeiro.' USING ERRCODE = '55006';
  END IF;

  -- Contador em BIGINT.
  IF (SELECT data_type FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'account_usage_counters'
         AND column_name = 'value') <> 'bigint' THEN
    RAISE EXCEPTION '098: account_usage_counters.value nao e BIGINT.' USING ERRCODE = '55006';
  END IF;

  -- Funções internas: ninguém além do dono.
  FOREACH v_fn IN ARRAY ARRAY[
    'public.enforce_form_quota()',
    'public.count_form_responses_month()',
    'public.form_month_metric(timestamptz)'
  ] LOOP
    IF has_function_privilege('anon', v_fn, 'EXECUTE')
       OR has_function_privilege('authenticated', v_fn, 'EXECUTE')
       OR has_function_privilege('public', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION '098: % executavel por anon/authenticated/PUBLIC.', v_fn USING ERRCODE = '55006';
    END IF;
  END LOOP;

  -- Funções do servidor: só service_role.
  FOREACH v_fn IN ARRAY ARRAY[
    'public.form_month_quota_state(uuid)',
    'public.form_upload_quota_state(uuid)',
    'public.form_upload_bytes_add(uuid,bigint)',
    'public.form_public_availability(text,boolean)',
    'public.recount_account_usage(uuid)'
  ] LOOP
    IF has_function_privilege('anon', v_fn, 'EXECUTE')
       OR has_function_privilege('authenticated', v_fn, 'EXECUTE')
       OR has_function_privilege('public', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION '098: % executavel por anon/authenticated/PUBLIC.', v_fn USING ERRCODE = '55006';
    END IF;
    IF NOT has_function_privilege('service_role', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION '098: % sem EXECUTE para service_role.', v_fn USING ERRCODE = '55006';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_proc
       WHERE oid = v_fn::regprocedure
         AND prosecdef
         AND EXISTS (SELECT 1 FROM unnest(proconfig) c WHERE c = 'search_path=public')
    ) THEN
      RAISE EXCEPTION '098: % sem SECURITY DEFINER ou sem search_path fixo.', v_fn USING ERRCODE = '55006';
    END IF;
  END LOOP;

  -- `anon` continua sem SELECT nas três tabelas (097 + 091).
  IF has_table_privilege('anon', 'public.forms', 'SELECT')
     OR has_table_privilege('anon', 'public.form_fields', 'SELECT')
     OR has_table_privilege('anon', 'public.form_responses', 'SELECT') THEN
    RAISE EXCEPTION '098: anon tem SELECT em tabela de formulario.' USING ERRCODE = '55006';
  END IF;

  -- Triggers presentes.
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'enforce_form_quota_trigger' AND NOT tgisinternal) THEN
    RAISE EXCEPTION '098: enforce_form_quota_trigger ausente.' USING ERRCODE = '55006';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'count_form_responses_month_trigger' AND NOT tgisinternal) THEN
    RAISE EXCEPTION '098: count_form_responses_month_trigger ausente.' USING ERRCODE = '55006';
  END IF;

  -- A disponibilidade usa a chave estrita, nunca `plan_feature(`.
  SELECT prosrc INTO v_src FROM pg_proc WHERE oid = 'public.form_public_availability(text,boolean)'::regprocedure;
  IF v_src NOT LIKE '%plan_feature_strict(%' OR v_src ~ 'plan_feature\(' THEN
    RAISE EXCEPTION '098: form_public_availability nao usa plan_feature_strict.' USING ERRCODE = '55006';
  END IF;
  IF v_src NOT LIKE '%forms_enabled%' THEN
    RAISE EXCEPTION '098: form_public_availability nao checa forms_enabled.' USING ERRCODE = '55006';
  END IF;

  -- Fuso do mês: o mesmo literal do TS.
  IF (SELECT prosrc FROM pg_proc WHERE oid = 'public.form_month_metric(timestamptz)'::regprocedure)
       NOT LIKE '%America/Sao_Paulo%' THEN
    RAISE EXCEPTION '098: form_month_metric sem America/Sao_Paulo.' USING ERRCODE = '55006';
  END IF;
  IF form_month_metric('2026-12-01 02:59:59+00'::timestamptz) <> 'form_responses:2026-11'
     OR form_month_metric('2026-12-01 03:00:00+00'::timestamptz) <> 'form_responses:2026-12' THEN
    RAISE EXCEPTION '098: virada de mes de form_month_metric errada.' USING ERRCODE = '55006';
  END IF;

  -- Chave fail-closed: conta inexistente nunca tem formulários.
  IF plan_feature_strict(gen_random_uuid(), 'forms_enabled') IS NOT FALSE THEN
    RAISE EXCEPTION '098: plan_feature_strict(forms_enabled) de conta inexistente nao e FALSE.' USING ERRCODE = '55006';
  END IF;

  -- Slug inexistente: indisponível, sem revelar nada.
  IF (SELECT s.status FROM form_public_availability('__098_nao_existe__') s) <> 'unavailable' THEN
    RAISE EXCEPTION '098: form_public_availability de slug inexistente nao e unavailable.' USING ERRCODE = '55006';
  END IF;

  -- notifications aceita o tipo novo.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.notifications'::regclass
                    AND conname = 'notifications_type_check'
                    AND pg_get_constraintdef(oid) LIKE '%form_response_received%') THEN
    RAISE EXCEPTION '098: notifications.type nao aceita form_response_received.' USING ERRCODE = '55006';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'notifications'
                    AND column_name = 'form_response_id')
     OR NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'notifications'
                    AND column_name = 'form_id') THEN
    RAISE EXCEPTION '098: notifications.form_id/form_response_id ausentes.' USING ERRCODE = '55006';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'form_responses'
                    AND column_name = 'deal_id') THEN
    RAISE EXCEPTION '098: form_responses.deal_id ausente.' USING ERRCODE = '55006';
  END IF;

  -- contact_exports.source aceita form_responses e o DEFAULT cobre as linhas antigas.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.contact_exports'::regclass
                    AND conname = 'contact_exports_source_check'
                    AND pg_get_constraintdef(oid) LIKE '%form_responses%') THEN
    RAISE EXCEPTION '098: contact_exports.source nao aceita form_responses.' USING ERRCODE = '55006';
  END IF;
END;
$$;
