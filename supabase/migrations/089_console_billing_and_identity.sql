-- ============================================================
-- 089_console_billing_and_identity.sql — SPEC 078 F1
--
-- Base de banco para três operações do console do proprietário
-- (`/admin`) que hoje exigem SQL direto ou são impossíveis:
--
--   1. Alterar a data de vencimento do plano (`set_plan_period_end`).
--   2. Registrar pagamento manual (`apply_plan_renewal` v2) e desfazê-lo
--      (`reverse_plan_payment`).
--   3. Editar nome/e-mail de usuários — que depende de `profiles.email`
--      acompanhar `auth.users.email`, coisa que NUNCA aconteceu:
--      `profile-form.tsx` afirmava que "o Supabase empurra a mudança",
--      mas `auth.users` só tinha os triggers `on_auth_user_created`
--      (INSERT) e `on_auth_user_deleted_reassign` (DELETE). Toda troca
--      de e-mail pelo perfil deixava a cópia divergente em silêncio.
--
-- Nenhuma linha de RLS é afrouxada: as três funções de cobrança são
-- SECURITY DEFINER só para escrever em duas tabelas numa transação;
-- quem chama é `service_role` (rotas `/api/platform/**` atrás de
-- `requirePlatformOwner()`, e `/api/admin/**` com segredo de máquina).
--
-- Idempotente (IF NOT EXISTS, CREATE OR REPLACE, DROP … IF EXISTS) e
-- com bloco de asserções finais que falha alto, no padrão das 069/071.
-- ============================================================

-- ============================================================
-- 1. Sincronização auth.users.email → profiles.email (SPEC 078 §6.1)
--
-- O GoTrue só grava `auth.users.email` DEPOIS da confirmação (no
-- autosserviço) ou na hora (no `auth.admin.updateUserById` do console,
-- D-10) — então `profiles.email` muda exatamente quando o login muda.
--
-- `NEW.email IS NOT NULL` na cláusula WHEN: `profiles.email` é NOT
-- NULL e o trigger roda DENTRO da transação do GoTrue. Um usuário só
-- de telefone (e-mail nulo) faria o UPDATE falhar e, com ele, a
-- escrita do próprio Auth — um trigger de cópia não pode derrubar o
-- login.
--
-- `current_user` aqui é `postgres` (SECURITY DEFINER), então o
-- `enforce_profile_privilege_columns` (034/069) não barra — e de
-- qualquer forma ele só olha `account_role`/`account_id`/bloqueio.
-- ============================================================
CREATE OR REPLACE FUNCTION public.sync_profile_email()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.profiles
     SET email = NEW.email
   WHERE user_id = NEW.id
     AND email IS DISTINCT FROM NEW.email;
  RETURN NEW;
END;
$$;

ALTER FUNCTION public.sync_profile_email() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.sync_profile_email() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS on_auth_user_email_updated ON auth.users;
CREATE TRIGGER on_auth_user_email_updated
  AFTER UPDATE OF email ON auth.users
  FOR EACH ROW
  WHEN (NEW.email IS DISTINCT FROM OLD.email AND NEW.email IS NOT NULL)
  EXECUTE FUNCTION public.sync_profile_email();

-- Backfill: conserta qualquer divergência que já exista (vn e rs
-- tinham 0 em 2026-10-08, mas a migração não pode depender disso).
UPDATE public.profiles p
   SET email = u.email
  FROM auth.users u
 WHERE u.id = p.user_id
   AND u.email IS NOT NULL
   AND p.email IS DISTINCT FROM u.email;

-- ============================================================
-- 2. account_plan_payments — colunas novas (§6.2)
--
-- Tudo NULL-ável: linhas antigas continuam válidas, e
-- `previous_status IS NULL` é justamente o que marca "não estornável"
-- (§4.5 item 5) — sem ele não há como saber para que status voltar.
-- RLS segue ligada com ZERO policies (071).
-- ============================================================
ALTER TABLE account_plan_payments
  ADD COLUMN IF NOT EXISTS method TEXT
    CHECK (method IS NULL OR method IN ('pix','boleto','card','transfer','cash','other')),
  ADD COLUMN IF NOT EXISTS amount_cents INTEGER
    CHECK (amount_cents IS NULL OR amount_cents >= 0),
  ADD COLUMN IF NOT EXISTS recorded_by TEXT,
  ADD COLUMN IF NOT EXISTS previous_status TEXT
    CHECK (previous_status IS NULL
           OR previous_status IN ('trialing','active','past_due','suspended','canceled')),
  ADD COLUMN IF NOT EXISTS previous_grace_until TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reversed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reversed_by TEXT,
  ADD COLUMN IF NOT EXISTS reversal_reason TEXT;

-- Antes da 089 a única porta de escrita era a rota de máquina.
UPDATE account_plan_payments SET recorded_by = 'api:billing-renew' WHERE recorded_by IS NULL;

-- ============================================================
-- 3. apply_plan_renewal v2 (§6.3, D-6/D-7/D-8)
--
-- Assinatura nova = função nova para o Postgres. A antiga (6
-- parâmetros) é dropada ANTES do CREATE: se as duas coexistirem como
-- sobrecarga, a chamada por parâmetros nomeados do `supabase-js` com
-- os 6 nomes antigos fica ambígua e `/billing/renew` passa a responder
-- 500. Dentro da transação da migração não há janela sem função.
--
-- Corpo idêntico ao da 071, com:
--   * `p_actor`/`p_method`/`p_amount_cents` (todos DEFAULT NULL — a
--     rota `/api/admin/.../billing/renew` continua chamando com os 6
--     nomes antigos e recebe o mesmo resultado);
--   * `previous_status`/`previous_grace_until` gravados no log — é o
--     que torna o pagamento estornável (§4.5);
--   * `trialing` também reativa para `active` (D-8), além de `past_due`;
--   * `created_at = clock_timestamp()` no log, lido DEPOIS do
--     `FOR UPDATE`: o estorno decide "último pagamento" por essa
--     coluna, e o `NOW()` padrão é o instante de INÍCIO da transação —
--     uma renovação que começou antes mas esperou o lock de outra
--     ficaria com `created_at` menor apesar de ter sido aplicada
--     depois, e o estorno escolheria o pagamento errado.
-- ============================================================
DROP FUNCTION IF EXISTS public.apply_plan_renewal(UUID, TEXT, TIMESTAMPTZ, INTEGER, TEXT, TEXT);

CREATE OR REPLACE FUNCTION public.apply_plan_renewal(
  p_account_id UUID,
  p_payment_ref TEXT,
  p_paid_at TIMESTAMPTZ,
  p_periods INTEGER,
  p_external_ref TEXT DEFAULT NULL,
  p_note TEXT DEFAULT NULL,
  p_actor TEXT DEFAULT NULL,
  p_method TEXT DEFAULT NULL,
  p_amount_cents INTEGER DEFAULT NULL
) RETURNS TABLE (
  applied BOOLEAN,
  current_period_end TIMESTAMPTZ,
  status TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_account account_plans%ROWTYPE;
  v_billing_period TEXT;
  v_base TIMESTAMPTZ;
  v_new_period_end TIMESTAMPTZ;
  v_reactivate BOOLEAN;
  v_paid_at TIMESTAMPTZ := COALESCE(p_paid_at, NOW());
  v_actor TEXT := COALESCE(NULLIF(btrim(p_actor), ''), 'api:billing-renew');
BEGIN
  IF p_payment_ref IS NULL OR btrim(p_payment_ref) = '' THEN
    RAISE EXCEPTION 'payment_ref is required' USING ERRCODE = '22023';
  END IF;
  IF p_periods IS NULL OR p_periods < 1 THEN
    RAISE EXCEPTION 'periods must be a positive integer' USING ERRCODE = '22023';
  END IF;
  -- Os CHECKs da tabela também barram, mas com `check_violation` sem
  -- nome legível; aqui a mensagem diz qual parâmetro está errado.
  IF p_method IS NOT NULL
     AND p_method NOT IN ('pix','boleto','card','transfer','cash','other') THEN
    RAISE EXCEPTION 'invalid payment method' USING ERRCODE = '22023';
  END IF;
  IF p_amount_cents IS NOT NULL AND p_amount_cents < 0 THEN
    RAISE EXCEPTION 'amount_cents must be >= 0' USING ERRCODE = '22023';
  END IF;

  -- Duas consultas, não uma: PL/pgSQL não mistura `%ROWTYPE` com coluna
  -- extra no mesmo `INTO`. O `FOR UPDATE` trava a linha que importa.
  SELECT * INTO v_account
    FROM account_plans
   WHERE account_id = p_account_id
     FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'ACCOUNT_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;

  SELECT billing_period INTO v_billing_period
    FROM plans
   WHERE id = v_account.plan_id;

  IF v_billing_period IS NULL OR v_billing_period NOT IN ('monthly', 'yearly') THEN
    RAISE EXCEPTION 'NO_BILLING_CYCLE' USING ERRCODE = 'P0001';
  END IF;

  -- A partir do VENCIMENTO ATUAL, nunca de "agora" (SPEC 062 §6.2
  -- passo 2): renovar atrasado não pode encurtar o período do cliente.
  v_base := COALESCE(v_account.current_period_end, NOW());
  v_new_period_end := v_base + CASE v_account.billing_cycle
    WHEN 'yearly' THEN make_interval(years => p_periods)
    ELSE make_interval(months => p_periods)
  END;
  -- D-8: quem pagou deixa de aparecer "em teste". `suspended` e
  -- `canceled` continuam decisões manuais — pagamento não as desfaz,
  -- assim como não desbloqueia a conta (PRD 061 D-7).
  v_reactivate := v_account.status IN ('past_due', 'trialing');

  BEGIN
    INSERT INTO account_plan_payments (
      account_id, payment_ref, periods, previous_period_end,
      new_period_end, paid_at, external_ref, note,
      method, amount_cents, recorded_by,
      previous_status, previous_grace_until, created_at
    ) VALUES (
      p_account_id, p_payment_ref, p_periods, v_account.current_period_end,
      v_new_period_end, v_paid_at, p_external_ref, p_note,
      p_method, p_amount_cents, v_actor,
      v_account.status, v_account.grace_until, clock_timestamp()
    );
  EXCEPTION WHEN unique_violation THEN
    -- `payment_ref` já aplicado (retentativa, clique duplo, ou o mesmo
    -- ID Pix chegando pelo console E pelo sistema externo — §4.2).
    -- Não aplicar de novo; devolver o estado atual.
    RETURN QUERY SELECT FALSE, v_account.current_period_end, v_account.status;
    RETURN;
  END;

  -- Alias `ap`: as colunas de saída (`current_period_end`, `status`)
  -- colidem com as da tabela.
  UPDATE account_plans AS ap
     SET current_period_end = v_new_period_end,
         last_payment_ref   = p_payment_ref,
         last_payment_at    = v_paid_at,
         status       = CASE WHEN v_reactivate THEN 'active' ELSE ap.status END,
         grace_until  = CASE WHEN v_reactivate THEN NULL ELSE ap.grace_until END,
         updated_by   = v_actor,
         updated_at   = NOW()
   WHERE ap.account_id = p_account_id;

  RETURN QUERY SELECT
    TRUE,
    v_new_period_end,
    (CASE WHEN v_reactivate THEN 'active' ELSE v_account.status END);
END;
$$;

ALTER FUNCTION public.apply_plan_renewal(UUID, TEXT, TIMESTAMPTZ, INTEGER, TEXT, TEXT, TEXT, TEXT, INTEGER)
  OWNER TO postgres;
REVOKE ALL ON FUNCTION public.apply_plan_renewal(UUID, TEXT, TIMESTAMPTZ, INTEGER, TEXT, TEXT, TEXT, TEXT, INTEGER)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_plan_renewal(UUID, TEXT, TIMESTAMPTZ, INTEGER, TEXT, TEXT, TEXT, TEXT, INTEGER)
  TO service_role;

-- ============================================================
-- 4. set_plan_period_end — alterar o vencimento (§3, §6.4)
--
-- Função no banco, não `select` + `update` pelo supabase-js: uma
-- renovação chegando entre os dois passos (ela trava a linha com
-- `FOR UPDATE`) teria o avanço sobrescrito, e a auditoria gravaria um
-- "valor anterior" que já não era o anterior (§3.2).
--
-- A data é DIA, não instante (D-2): vira 23:59:59 de São Paulo
-- daquele dia, convertido AQUI — no TypeScript dependeria do fuso do
-- servidor (a VPS pode estar em UTC). `date + time` dá `timestamp`
-- sem fuso; `AT TIME ZONE` sobre ele interpreta como hora local de SP
-- e devolve `timestamptz`.
--
-- NÃO grava `account_plan_payments`: mudar a data não é pagamento.
-- `started_at` (adesão) e `cancel_at_period_end` ficam intocados — o
-- cancelamento agendado acompanha a nova data (a UI avisa).
-- ============================================================
CREATE OR REPLACE FUNCTION public.set_plan_period_end(
  p_account_id UUID,
  p_date DATE,
  p_billing_cycle TEXT DEFAULT NULL,
  p_actor TEXT DEFAULT NULL
) RETURNS TABLE (
  previous_period_end TIMESTAMPTZ,
  new_period_end TIMESTAMPTZ,
  previous_status TEXT,
  new_status TEXT,
  billing_cycle TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_account account_plans%ROWTYPE;
  v_billing_period TEXT;
  v_price_cents INTEGER;
  v_today DATE;
  v_new_period_end TIMESTAMPTZ;
  v_new_cycle TEXT;
  v_leaves_past_due BOOLEAN;
BEGIN
  IF p_billing_cycle IS NOT NULL AND p_billing_cycle NOT IN ('monthly', 'yearly') THEN
    RAISE EXCEPTION 'INVALID_BILLING_CYCLE' USING ERRCODE = 'P0001';
  END IF;
  IF p_date IS NULL THEN
    RAISE EXCEPTION 'PERIOD_END_OUT_OF_RANGE' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_account
    FROM account_plans
   WHERE account_id = p_account_id
     FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'ACCOUNT_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;

  SELECT pl.billing_period, pl.price_cents INTO v_billing_period, v_price_cents
    FROM plans pl
   WHERE pl.id = v_account.plan_id;

  -- D-1: mesma regra de `computePeriodEnd` (billing.ts). Vencimento
  -- num plano sem ciclo faria o cron marcar `past_due` num plano que
  -- não vence, e a renovação depois recusaria com NO_BILLING_CYCLE —
  -- um estado sem saída pela tela.
  IF v_billing_period IS NULL
     OR v_billing_period NOT IN ('monthly', 'yearly')
     OR COALESCE(v_price_cents, 0) <= 0 THEN
    RAISE EXCEPTION 'NO_BILLING_CYCLE' USING ERRCODE = 'P0001';
  END IF;

  -- D-3: de hoje até hoje + 3 anos, no calendário de São Paulo. Data
  -- passada dispararia `past_due` + carência já vencida no próximo cron.
  v_today := (NOW() AT TIME ZONE 'America/Sao_Paulo')::DATE;
  IF p_date < v_today OR p_date > (v_today + INTERVAL '3 years')::DATE THEN
    RAISE EXCEPTION 'PERIOD_END_OUT_OF_RANGE' USING ERRCODE = 'P0001';
  END IF;

  v_new_period_end := (p_date + TIME '23:59:59') AT TIME ZONE 'America/Sao_Paulo';
  v_new_cycle := COALESCE(p_billing_cycle, v_account.billing_cycle);
  -- D-5: vencimento futuro tira a conta do atraso (mesmo efeito da
  -- renovação). Qualquer outro status fica como está.
  v_leaves_past_due := v_account.status = 'past_due';

  -- Alias `ap`: `billing_cycle` é ao mesmo tempo coluna e saída.
  UPDATE account_plans AS ap
     SET current_period_end = v_new_period_end,
         billing_cycle = v_new_cycle,
         status        = CASE WHEN v_leaves_past_due THEN 'active' ELSE ap.status END,
         grace_until   = CASE WHEN v_leaves_past_due THEN NULL ELSE ap.grace_until END,
         updated_by    = COALESCE(NULLIF(btrim(p_actor), ''), 'console'),
         updated_at    = NOW()
   WHERE ap.account_id = p_account_id;

  RETURN QUERY SELECT
    v_account.current_period_end,
    v_new_period_end,
    v_account.status,
    (CASE WHEN v_leaves_past_due THEN 'active' ELSE v_account.status END),
    v_new_cycle;
END;
$$;

ALTER FUNCTION public.set_plan_period_end(UUID, DATE, TEXT, TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.set_plan_period_end(UUID, DATE, TEXT, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_plan_period_end(UUID, DATE, TEXT, TEXT)
  TO service_role;

-- ============================================================
-- 5. reverse_plan_payment — desfazer pagamento manual (§4.5, D-9)
--
-- Ordem dos locks: primeiro a linha de `account_plans` (a mesma que
-- `apply_plan_renewal` e `set_plan_period_end` travam — então estorno,
-- renovação e troca de vencimento da mesma conta serializam), DEPOIS
-- relê o pagamento. Dois estornos simultâneos do mesmo pagamento: o
-- segundo espera o lock, relê e vê `reversed_at` preenchido.
--
-- Status e carência só voltam se a conta ainda está no status que o
-- pagamento deixou. Se, depois do pagamento, alguém suspendeu/cancelou
-- a conta (ou o cron a marcou em atraso), "voltar ao anterior"
-- desfaria também essa outra mudança sem ninguém ver — mesmo
-- raciocínio da regra PERIOD_CHANGED_SINCE_PAYMENT, aplicado ao status.
-- O vencimento volta sempre (a regra 2 já garantiu que é o do
-- pagamento).
--
-- A linha é MARCADA, nunca apagada: o `payment_ref` continua ocupado
-- de propósito, para o sistema externo não reaplicar aquele pagamento.
-- ============================================================
CREATE OR REPLACE FUNCTION public.reverse_plan_payment(
  p_payment_id UUID,
  p_actor TEXT,
  p_reason TEXT DEFAULT NULL
) RETURNS TABLE (
  restored_period_end TIMESTAMPTZ,
  restored_status TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_account_id UUID;
  v_payment account_plan_payments%ROWTYPE;
  v_account account_plans%ROWTYPE;
  v_status_after_payment TEXT;
  v_restore_status BOOLEAN;
  v_restored_status TEXT;
  v_prev_ref TEXT;
  v_prev_paid_at TIMESTAMPTZ;
BEGIN
  IF p_actor IS NULL OR btrim(p_actor) = '' THEN
    RAISE EXCEPTION 'actor is required' USING ERRCODE = '22023';
  END IF;

  SELECT pay.account_id INTO v_account_id
    FROM account_plan_payments pay
   WHERE pay.id = p_payment_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'PAYMENT_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_account
    FROM account_plans
   WHERE account_id = v_account_id
     FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'ACCOUNT_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;

  -- Releitura sob o lock (READ COMMITTED: cada comando vê o último
  -- commit) — é ela que pega o estorno concorrente.
  SELECT * INTO v_payment
    FROM account_plan_payments
   WHERE id = p_payment_id
     FOR UPDATE;

  IF v_payment.reversed_at IS NOT NULL THEN
    RAISE EXCEPTION 'PAYMENT_ALREADY_REVERSED' USING ERRCODE = 'P0001';
  END IF;

  -- Gravado antes da 089: não há como saber para que status voltar.
  IF v_payment.previous_status IS NULL THEN
    RAISE EXCEPTION 'PAYMENT_NOT_REVERSIBLE' USING ERRCODE = 'P0001';
  END IF;

  -- Regra 1: só o último não estornado. Estornar um do meio exigiria
  -- recalcular a cadeia posterior inteira.
  IF EXISTS (
    SELECT 1 FROM account_plan_payments other
     WHERE other.account_id = v_payment.account_id
       AND other.id <> v_payment.id
       AND other.reversed_at IS NULL
       AND (other.created_at, other.id) > (v_payment.created_at, v_payment.id)
  ) THEN
    RAISE EXCEPTION 'PAYMENT_NOT_LATEST' USING ERRCODE = 'P0001';
  END IF;

  -- Regra 2: o vencimento ainda é o que o pagamento gravou.
  IF v_account.current_period_end IS DISTINCT FROM v_payment.new_period_end THEN
    RAISE EXCEPTION 'PERIOD_CHANGED_SINCE_PAYMENT' USING ERRCODE = 'P0001';
  END IF;

  -- O status que `apply_plan_renewal` v2 deixou (D-8).
  v_status_after_payment := CASE
    WHEN v_payment.previous_status IN ('past_due', 'trialing') THEN 'active'
    ELSE v_payment.previous_status
  END;
  v_restore_status := v_account.status = v_status_after_payment;
  v_restored_status := CASE WHEN v_restore_status
    THEN v_payment.previous_status ELSE v_account.status END;

  -- `last_payment_ref`/`last_payment_at` passam a apontar para o
  -- pagamento vigente anterior (ou nada) — não para um estornado.
  SELECT other.payment_ref, other.paid_at INTO v_prev_ref, v_prev_paid_at
    FROM account_plan_payments other
   WHERE other.account_id = v_payment.account_id
     AND other.id <> v_payment.id
     AND other.reversed_at IS NULL
   ORDER BY other.created_at DESC, other.id DESC
   LIMIT 1;

  UPDATE account_plans AS ap
     SET current_period_end = v_payment.previous_period_end,
         status       = v_restored_status,
         grace_until  = CASE WHEN v_restore_status
                          THEN v_payment.previous_grace_until ELSE ap.grace_until END,
         last_payment_ref = v_prev_ref,
         last_payment_at  = v_prev_paid_at,
         updated_by   = p_actor,
         updated_at   = NOW()
   WHERE ap.account_id = v_payment.account_id;

  UPDATE account_plan_payments AS pay
     SET reversed_at     = NOW(),
         reversed_by     = p_actor,
         reversal_reason = NULLIF(btrim(p_reason), '')
   WHERE pay.id = v_payment.id;

  RETURN QUERY SELECT v_payment.previous_period_end, v_restored_status;
END;
$$;

ALTER FUNCTION public.reverse_plan_payment(UUID, TEXT, TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.reverse_plan_payment(UUID, TEXT, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reverse_plan_payment(UUID, TEXT, TEXT)
  TO service_role;

-- ============================================================
-- 6. Asserções finais (§6.6)
-- ============================================================
DO $$
DECLARE
  v_count    INTEGER;
  v_fn       TEXT;
  v_proc     pg_proc%ROWTYPE;
BEGIN
  -- 6.1. Trigger de sincronização existe em auth.users; a função é
  -- SECURITY DEFINER e pertence a postgres.
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgrelid = 'auth.users'::regclass
       AND tgname = 'on_auth_user_email_updated'
       AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION '089: trigger on_auth_user_email_updated ausente em auth.users.';
  END IF;
  SELECT p.* INTO v_proc
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'sync_profile_email';
  IF v_proc.oid IS NULL OR NOT v_proc.prosecdef
     OR (SELECT rolname FROM pg_roles WHERE oid = v_proc.proowner) IS DISTINCT FROM 'postgres' THEN
    RAISE EXCEPTION '089: sync_profile_email ausente, sem SECURITY DEFINER ou fora de postgres.';
  END IF;

  -- 6.2. Zero perfis divergentes depois do backfill.
  SELECT count(*) INTO v_count
    FROM public.profiles p
    JOIN auth.users u ON u.id = p.user_id
   WHERE u.email IS NOT NULL AND p.email IS DISTINCT FROM u.email;
  IF v_count > 0 THEN
    RAISE EXCEPTION '089: % perfil(is) com e-mail divergente de auth.users apos o backfill.', v_count;
  END IF;

  -- 6.3. Exatamente uma apply_plan_renewal (a de 9 parâmetros).
  SELECT count(*) INTO v_count
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'apply_plan_renewal';
  IF v_count <> 1 THEN
    RAISE EXCEPTION '089: existem % apply_plan_renewal — sobrecarga sobrou (deveria ser 1).', v_count;
  END IF;
  IF (SELECT p.pronargs FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'apply_plan_renewal') <> 9 THEN
    RAISE EXCEPTION '089: apply_plan_renewal nao tem os 9 parametros esperados.';
  END IF;

  -- 6.4. As três funções de cobrança: SECURITY DEFINER, dono postgres,
  -- sem EXECUTE para anon/authenticated (has_function_privilege enxerga
  -- também o que vem por PUBLIC), com EXECUTE para service_role.
  FOREACH v_fn IN ARRAY ARRAY['apply_plan_renewal', 'set_plan_period_end', 'reverse_plan_payment'] LOOP
    SELECT p.* INTO v_proc
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = v_fn;
    IF v_proc.oid IS NULL THEN
      RAISE EXCEPTION '089: % nao existe apos a migracao.', v_fn;
    END IF;
    IF NOT v_proc.prosecdef THEN
      RAISE EXCEPTION '089: % sem SECURITY DEFINER.', v_fn;
    END IF;
    IF (SELECT rolname FROM pg_roles WHERE oid = v_proc.proowner) IS DISTINCT FROM 'postgres' THEN
      RAISE EXCEPTION '089: % nao pertence a postgres.', v_fn;
    END IF;
    IF has_function_privilege('anon', v_proc.oid, 'EXECUTE')
       OR has_function_privilege('authenticated', v_proc.oid, 'EXECUTE') THEN
      RAISE EXCEPTION '089: % concede EXECUTE a anon/authenticated.', v_fn;
    END IF;
    IF NOT has_function_privilege('service_role', v_proc.oid, 'EXECUTE') THEN
      RAISE EXCEPTION '089: % sem EXECUTE para service_role.', v_fn;
    END IF;
  END LOOP;

  -- 6.5. account_plan_payments: RLS ligada, zero policies, UNIQUE intacta.
  IF NOT (SELECT c.relrowsecurity FROM pg_class c
           JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public' AND c.relname = 'account_plan_payments') THEN
    RAISE EXCEPTION '089: account_plan_payments sem RLS ligada.';
  END IF;
  SELECT count(*) INTO v_count
    FROM pg_policies WHERE schemaname = 'public' AND tablename = 'account_plan_payments';
  IF v_count > 0 THEN
    RAISE EXCEPTION '089: account_plan_payments tem % policy(ies) — deveria ser so service_role.', v_count;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.account_plan_payments'::regclass
       AND conname = 'account_plan_payments_ref_unique'
       AND contype = 'u'
  ) THEN
    RAISE EXCEPTION '089: UNIQUE account_plan_payments_ref_unique sumiu.';
  END IF;

  -- 6.6. Nenhuma linha antiga sem recorded_by.
  SELECT count(*) INTO v_count FROM account_plan_payments WHERE recorded_by IS NULL;
  IF v_count > 0 THEN
    RAISE EXCEPTION '089: % pagamento(s) sem recorded_by apos o backfill.', v_count;
  END IF;

  RAISE NOTICE '089: console_billing_and_identity aplicada — sync de e-mail, renovacao v2, vencimento manual e estorno prontos.';
END $$;
