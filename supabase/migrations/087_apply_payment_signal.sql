-- ============================================================
-- 087_apply_payment_signal.sql — SPEC 076 F3: o sinal de pagamento
-- (131042) aplicado num passo ATÔMICO.
--
-- Por que existe (desvio declarado do §8 da SPEC, que não previa função)
--
--   O §6.3 pede, num mesmo movimento: `COALESCE` em
--   `payment_blocked_since`, `GREATEST` em `last_payment_error_at`,
--   "episódio novo" só quando `payment_blocked_since` ERA nulo e
--   "reabre só se ts > payment_cleared_at". Nada disso cabe num
--   `.upsert()` do supabase-js (o PostgREST não aceita expressão no SET
--   nem devolve o valor ANTERIOR da linha), e ler-e-depois-escrever
--   pelo TypeScript abre corrida justamente no cenário que motivou a F3:
--   um disparo em massa falhando com 131042 gera uma RAJADA de status
--   `failed` do mesmo WABA, processados em paralelo. Duas leituras vendo
--   `payment_blocked_since IS NULL` antes de qualquer commit = dois
--   "episódios novos" = notificação em dobro.
--
--   Aqui a decisão roda sob o lock da linha (`ON CONFLICT DO NOTHING`
--   espera o INSERT concorrente; `SELECT … FOR UPDATE` serializa o
--   resto). Exatamente UMA chamada devolve TRUE por episódio.
--
-- Contrato
--
--   apply_payment_signal(account, waba, kind, ts, phone_number_id) → boolean
--
--   kind = 'payment_error' → TRUE se ABRIU um episódio (quem chama
--          notifica; com o flag desligado o estado é gravado do mesmo
--          jeito, D-10).
--   kind = 'billable_ok'   → TRUE se LIMPOU o episódio pendente.
--
--   Só mexe nas colunas de pagamento. O retrato de health/consumo (F4) e
--   as colunas `health_error_*`/`spend_error_*` ficam intactos.
--
-- Um segundo desvio, de propósito: na limpeza AUTOMÁTICA,
-- `payment_cleared_at` = carimbo da mensagem cobrável (`ts`), não
-- `now()`. Com `now()`, um 131042 real ocorrido ENTRE a entrega cobrável
-- e o processamento dela (a Meta agrupa e atrasa webhooks) chegaria com
-- `ts < payment_cleared_at` e seria ignorado — o episódio verdadeiro
-- sumiria. A limpeza MANUAL (F4, "Já regularizei") continua com `now()`:
-- ali a intenção é justamente descartar erros antigos.
-- ============================================================

DO $pre$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'whatsapp_billing_status'
       AND column_name = 'payment_blocked_since'
  ) THEN
    RAISE EXCEPTION '087: requer a migracao 086 (whatsapp_billing_status ausente).';
  END IF;
END $pre$;

CREATE OR REPLACE FUNCTION public.apply_payment_signal(
  p_account_id      UUID,
  p_waba_id         TEXT,
  p_kind            TEXT,
  p_ts              TIMESTAMPTZ,
  p_phone_number_id TEXT DEFAULT NULL
) RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_since      TIMESTAMPTZ;
  v_last       TIMESTAMPTZ;
  v_cleared_at TIMESTAMPTZ;
BEGIN
  IF p_kind IS NULL OR p_kind NOT IN ('payment_error', 'billable_ok') THEN
    RAISE EXCEPTION 'apply_payment_signal: kind invalido: %', p_kind
      USING ERRCODE = '22023';
  END IF;

  IF p_account_id IS NULL OR p_waba_id IS NULL OR p_waba_id = ''
     OR p_ts IS NULL THEN
    RETURN FALSE;
  END IF;

  -- Tenancy (RNF-02). SECURITY DEFINER ignora RLS, então a garantia de
  -- que este WABA é DESTA conta é nossa — mesmo cuidado da
  -- `notify_channel_payment_blocked` (086). O chamador já resolve o WABA
  -- pela `whatsapp_config`; isto fecha a porta para um chamador futuro
  -- que não resolva.
  IF NOT EXISTS (
    SELECT 1 FROM whatsapp_config
     WHERE account_id = p_account_id
       AND waba_id = p_waba_id
  ) THEN
    RETURN FALSE;
  END IF;

  -- ----------------------------------------------------------
  -- Limpeza automática (§6.3): uma mensagem COBRÁVEL saiu depois do
  -- último 131042. Um UPDATE condicional só: o lock da linha reavalia o
  -- WHERE, então um 131042 mais novo gravado em paralelo impede a
  -- limpeza. No caso comum (nada pendente) não afeta linha nenhuma.
  -- ----------------------------------------------------------
  IF p_kind = 'billable_ok' THEN
    UPDATE whatsapp_billing_status
       SET payment_blocked_since = NULL,
           payment_cleared_at    = p_ts,
           payment_cleared_by    = NULL,
           payment_clear_reason  = 'billable_delivered'
     WHERE account_id = p_account_id
       AND waba_id = p_waba_id
       AND payment_blocked_since IS NOT NULL
       AND last_payment_error_at < p_ts;
    RETURN FOUND;
  END IF;

  -- ----------------------------------------------------------
  -- 131042 (§6.3 "Liga").
  -- ----------------------------------------------------------

  -- Primeira vez que este WABA aparece: a linha nasce já pendente. Com
  -- um INSERT concorrente, o ON CONFLICT ESPERA o outro commit e não faz
  -- nada — só um dos dois vê FOUND.
  INSERT INTO whatsapp_billing_status (
    account_id, waba_id,
    payment_blocked_since, last_payment_error_at,
    last_payment_error_phone_number_id
  ) VALUES (
    p_account_id, p_waba_id, p_ts, p_ts, p_phone_number_id
  )
  ON CONFLICT (account_id, waba_id) DO NOTHING;

  IF FOUND THEN
    RETURN TRUE;
  END IF;

  SELECT payment_blocked_since, last_payment_error_at, payment_cleared_at
    INTO v_since, v_last, v_cleared_at
    FROM whatsapp_billing_status
   WHERE account_id = p_account_id
     AND waba_id = p_waba_id
     FOR UPDATE;

  IF NOT FOUND THEN
    -- Apagada entre o INSERT e o SELECT (conta excluída em cascata).
    RETURN FALSE;
  END IF;

  IF v_since IS NOT NULL THEN
    -- Já pendente: só o GREATEST. Webhook repetido (mesmo ts) não muda
    -- nada e não abre episódio — a notificação não duplica (§10.4).
    IF v_last IS NULL OR p_ts > v_last THEN
      UPDATE whatsapp_billing_status
         SET last_payment_error_at = p_ts,
             last_payment_error_phone_number_id =
               COALESCE(p_phone_number_id, last_payment_error_phone_number_id)
       WHERE account_id = p_account_id
         AND waba_id = p_waba_id;
    END IF;
    RETURN FALSE;
  END IF;

  -- Não pendente. Um 131042 ANTERIOR à última limpeza (fora de ordem, ou
  -- reprocessado depois de "Já regularizei") é ignorado (§10.4).
  IF v_cleared_at IS NOT NULL AND p_ts <= v_cleared_at THEN
    RETURN FALSE;
  END IF;

  -- Episódio novo. `payment_cleared_*` ficam como memória da limpeza
  -- anterior; o que diz "pendente" é `payment_blocked_since`.
  UPDATE whatsapp_billing_status
     SET payment_blocked_since = p_ts,
         last_payment_error_at = GREATEST(last_payment_error_at, p_ts),
         last_payment_error_phone_number_id = CASE
           WHEN last_payment_error_at IS NULL OR p_ts >= last_payment_error_at
             THEN COALESCE(p_phone_number_id, last_payment_error_phone_number_id)
           ELSE last_payment_error_phone_number_id
         END
   WHERE account_id = p_account_id
     AND waba_id = p_waba_id;

  RETURN TRUE;
END;
$$;

ALTER FUNCTION public.apply_payment_signal(UUID, TEXT, TEXT, TIMESTAMPTZ, TEXT) OWNER TO postgres;

-- Mesmo aperto da 067b/084b/085/086: SECURITY DEFINER em `public` vira
-- RPC exposta por padrão. Sem o REVOKE, qualquer usuário logado ligaria
-- ou limparia o alerta de pagamento de outra conta.
REVOKE ALL ON FUNCTION public.apply_payment_signal(UUID, TEXT, TEXT, TIMESTAMPTZ, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.apply_payment_signal(UUID, TEXT, TEXT, TIMESTAMPTZ, TEXT) FROM anon;
REVOKE ALL ON FUNCTION public.apply_payment_signal(UUID, TEXT, TEXT, TIMESTAMPTZ, TEXT) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.apply_payment_signal(UUID, TEXT, TEXT, TIMESTAMPTZ, TEXT) TO service_role;

COMMENT ON FUNCTION public.apply_payment_signal IS
  'SPEC 076 §6.3/§10.3. Aplica o sinal de pagamento por (conta, WABA) de forma atomica: payment_error devolve TRUE so ao ABRIR um episodio; billable_ok devolve TRUE ao limpar. So service_role; chamada por billing-signal.ts.';

-- ============================================================
-- Asserções finais
-- ============================================================
DO $assert$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.proname = 'apply_payment_signal'
       AND p.pronamespace = 'public'::regnamespace
       AND p.prosecdef
       AND p.proconfig @> ARRAY['search_path=public']
  ) THEN
    RAISE EXCEPTION '087: apply_payment_signal ausente, sem SECURITY DEFINER ou com search_path mutavel.';
  END IF;

  IF has_function_privilege('authenticated', 'apply_payment_signal(uuid, text, text, timestamptz, text)', 'EXECUTE')
     OR has_function_privilege('anon', 'apply_payment_signal(uuid, text, text, timestamptz, text)', 'EXECUTE') THEN
    RAISE EXCEPTION '087: apply_payment_signal executavel fora de service_role.';
  END IF;

  IF NOT has_function_privilege('service_role', 'apply_payment_signal(uuid, text, text, timestamptz, text)', 'EXECUTE') THEN
    RAISE EXCEPTION '087: service_role sem EXECUTE em apply_payment_signal.';
  END IF;

  RAISE NOTICE '087: apply_payment_signal criada (sinal de pagamento atomico).';
END $assert$;
