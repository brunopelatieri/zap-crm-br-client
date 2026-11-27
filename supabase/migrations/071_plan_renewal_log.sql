-- ============================================================
-- 071_plan_renewal_log.sql — idempotência real de POST
-- /api/admin/accounts/{id}/billing/renew (SPEC 062 §6.2, PRD §5.2, D-14)
--
-- Achado de code review sobre o código anterior: `renewAccountPlan`
-- comparava o `paymentRef` recebido contra o ÚNICO valor guardado em
-- `account_plans.last_payment_ref`. Isso reconhece a retentativa MAIS
-- RECENTE, mas não uma retentativa de um pagamento MAIS ANTIGO depois
-- que outro já sobrescreveu a coluna:
--
--   fatura-01 chega, aplica, last_payment_ref = 'fatura-01'
--   fatura-02 chega (mês seguinte), aplica, last_payment_ref = 'fatura-02'
--   uma retentativa perdida de fatura-01 chega agora — não bate com
--   'fatura-02', o índice único de account_plans não pega (não há
--   segunda linha em conflito, é a MESMA linha sendo reescrita) — o
--   período avança pela SEGUNDA vez para o mesmo pagamento.
--
-- Não é um cenário de laboratório: este endpoint é literalmente o
-- sistema de cobrança inteiro do produto — não existe gateway (D-14
-- continua valendo: "billing_source já prevê 'gateway' SEM nada
-- implementado"), então cada renovação passa por aqui, à mão ou por
-- automação simples do lado de fora, e retentativas fora de ordem são
-- exatamente o tipo de coisa que esse tipo de integração produz.
--
-- A correção: um LOG de pagamentos aplicados, não um único campo. A
-- UNIQUE constraint em `payment_ref` é a fonte de verdade da
-- idempotência — não "o último valor lido bate com o que chegou".
--
-- Idempotente (IF NOT EXISTS, CREATE OR REPLACE) e com bloco de
-- asserções finais que falha alto, no padrão das 041/052/061/067/068/
-- 069/070.
-- ============================================================

-- ============================================================
-- 1. account_plan_payments — o log (substitui a comparação de
--    igualdade contra `last_payment_ref` como mecanismo de idempotência)
-- ============================================================
CREATE TABLE IF NOT EXISTS account_plan_payments (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id           UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  -- UNIQUE, não indexado-e-comparado-por-igualdade num campo só: é
  -- isto que fecha a lacuna descrita acima. Uma tentativa de aplicar o
  -- MESMO paymentRef duas vezes — para a mesma conta ou, por erro do
  -- operador, para outra — bate na constraint, nunca numa segunda
  -- linha.
  payment_ref          TEXT NOT NULL,
  periods              INTEGER NOT NULL CHECK (periods > 0),
  previous_period_end  TIMESTAMPTZ,
  new_period_end       TIMESTAMPTZ NOT NULL,
  paid_at              TIMESTAMPTZ NOT NULL,
  -- Referência do sistema externo (nota fiscal, id de conciliação) e
  -- nota livre do operador — a rota já os aceitava no corpo, mas até
  -- esta migração eles só chegavam até `platform_audit_log` (histórico
  -- de AÇÃO do console, não de PAGAMENTO da conta). Aqui viram parte
  -- do registro que sobrevive independente de quem chamou.
  external_ref         TEXT,
  note                 TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT account_plan_payments_ref_unique UNIQUE (payment_ref)
);

CREATE INDEX IF NOT EXISTS idx_account_plan_payments_account
  ON account_plan_payments (account_id, created_at DESC);

-- Mesmo padrão de platform_audit_log/system_notifications: RLS ligada,
-- zero policies — só service_role. É histórico de cobrança, não dado
-- que o dono da conta configura ou o RLS de is_account_member protege
-- (a conta não tem por que ENXERGAR isto pela sessão dela — quem
-- decide o que mostrar ao cliente é uma tela de servidor, se um dia
-- existir).
ALTER TABLE account_plan_payments ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- 2. apply_plan_renewal() — a aplicação em si, atômica
--
-- `service_role` continua sendo quem CHAMA (a rota usa
-- `supabaseAdmin()`); `SECURITY DEFINER` aqui é sobre a função poder
-- escrever em duas tabelas dentro de uma única transação, não sobre
-- abrir a porta para o cliente — não há GRANT para `authenticated`.
--
-- Duas garantias de concorrência, cada uma cobrindo uma corrida
-- diferente:
--
--   1. `SELECT ... FOR UPDATE` trava a linha de `account_plans` da
--      conta pela duração da transação — duas renovações concorrentes
--      da MESMA conta (com paymentRefs DIFERENTES, ambas legítimas)
--      serializam aqui, então a segunda enxerga o `current_period_end`
--      que a primeira acabou de gravar como base, em vez de calcular
--      as duas a partir do mesmo valor antigo e uma sobrescrever a
--      avanço da outra.
--   2. A UNIQUE constraint de `payment_ref` (capturada pelo bloco
--      EXCEPTION) é quem decide "já apliquei este pagamento" — não
--      uma comparação de igualdade lida ANTES da escrita (que teria a
--      mesma janela de corrida que este arquivo existe para fechar).
-- ============================================================
CREATE OR REPLACE FUNCTION public.apply_plan_renewal(
  p_account_id UUID,
  p_payment_ref TEXT,
  p_paid_at TIMESTAMPTZ,
  p_periods INTEGER,
  p_external_ref TEXT DEFAULT NULL,
  p_note TEXT DEFAULT NULL
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
  v_was_past_due BOOLEAN;
  v_paid_at TIMESTAMPTZ := COALESCE(p_paid_at, NOW());
BEGIN
  IF p_payment_ref IS NULL OR btrim(p_payment_ref) = '' THEN
    RAISE EXCEPTION 'payment_ref is required' USING ERRCODE = '22023';
  END IF;
  IF p_periods IS NULL OR p_periods < 1 THEN
    RAISE EXCEPTION 'periods must be a positive integer' USING ERRCODE = '22023';
  END IF;

  -- PL/pgSQL não deixa misturar uma variável `%ROWTYPE` com uma coluna
  -- extra na mesma lista `INTO` — por isso são duas consultas, não um
  -- `SELECT ap.*, pl.billing_period INTO ...` só. O `FOR UPDATE` trava
  -- exatamente a linha que importa (`account_plans`); a de `plans` é
  -- só leitura de catálogo, que não muda com concorrência aqui.
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

  -- Plano sem ciclo de cobrança (Grátis, "sob medida", `unlimited` de
  -- backfill) não tem vencimento para avançar — renová-lo não
  -- significa nada (mesma checagem que o código anterior já fazia).
  IF v_billing_period IS NULL OR v_billing_period NOT IN ('monthly', 'yearly') THEN
    RAISE EXCEPTION 'NO_BILLING_CYCLE' USING ERRCODE = 'P0001';
  END IF;

  -- A partir do VENCIMENTO ATUAL, nunca de "agora" (§6.2 passo 2): se
  -- a conta nunca teve vencimento (troca manual anterior deixou nulo),
  -- a base é agora.
  v_base := COALESCE(v_account.current_period_end, NOW());
  -- `make_interval`, não concatenação de string em `::INTERVAL` — mesmo
  -- idioma já usado em toda a base (044/045/048/050) para intervalo
  -- parametrizado por variável.
  v_new_period_end := v_base + CASE v_account.billing_cycle
    WHEN 'yearly' THEN make_interval(years => p_periods)
    ELSE make_interval(months => p_periods)
  END;
  v_was_past_due := v_account.status = 'past_due';

  BEGIN
    INSERT INTO account_plan_payments (
      account_id, payment_ref, periods, previous_period_end,
      new_period_end, paid_at, external_ref, note
    ) VALUES (
      p_account_id, p_payment_ref, p_periods, v_account.current_period_end,
      v_new_period_end, v_paid_at, p_external_ref, p_note
    );
  EXCEPTION WHEN unique_violation THEN
    -- Este `payment_ref` já foi aplicado — pela mesma conta (a
    -- retentativa que este arquivo existe para reconhecer
    -- corretamente, não importa a ordem de chegada) ou, no caso
    -- patológico, por outra (reuso indevido do mesmo identificador).
    -- Nos dois casos: não aplicar de novo, devolver o estado atual.
    RETURN QUERY SELECT FALSE, v_account.current_period_end, v_account.status;
    RETURN;
  END;

  -- Alias `ap` no alvo do UPDATE: os nomes de saída da função
  -- (`current_period_end`, `status`) colidem com os nomes de coluna —
  -- sem qualificar, PL/pgSQL não sabe se `status` do lado direito é a
  -- variável de saída ou a coluna da linha sendo atualizada.
  UPDATE account_plans AS ap
     SET current_period_end = v_new_period_end,
         last_payment_ref   = p_payment_ref,
         last_payment_at    = v_paid_at,
         status       = CASE WHEN v_was_past_due THEN 'active' ELSE ap.status END,
         grace_until  = CASE WHEN v_was_past_due THEN NULL ELSE ap.grace_until END,
         updated_by   = 'api:billing-renew',
         updated_at   = NOW()
   WHERE ap.account_id = p_account_id;

  RETURN QUERY SELECT
    TRUE,
    v_new_period_end,
    (CASE WHEN v_was_past_due THEN 'active' ELSE v_account.status END);
END;
$$;

ALTER FUNCTION public.apply_plan_renewal(UUID, TEXT, TIMESTAMPTZ, INTEGER, TEXT, TEXT)
  OWNER TO postgres;
-- Só service_role chama (a rota usa PLATFORM_ADMIN_SECRET, não sessão
-- de usuário) — sem GRANT para authenticated/anon, mesma postura de
-- toda função que mexe em account_plans desde a 067.
REVOKE ALL ON FUNCTION public.apply_plan_renewal(UUID, TEXT, TIMESTAMPTZ, INTEGER, TEXT, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_plan_renewal(UUID, TEXT, TIMESTAMPTZ, INTEGER, TEXT, TEXT)
  TO service_role;

-- ============================================================
-- 3. Asserções finais
-- ============================================================
DO $$
DECLARE
  v_policies INTEGER;
  v_proc     pg_proc%ROWTYPE;
BEGIN
  -- 3.1. account_plan_payments: RLS ligada, zero policies.
  IF NOT (SELECT c.relrowsecurity FROM pg_class c
           JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public' AND c.relname = 'account_plan_payments') THEN
    RAISE EXCEPTION '071: account_plan_payments sem RLS ligada.';
  END IF;
  SELECT count(*) INTO v_policies
    FROM pg_policies WHERE schemaname = 'public' AND tablename = 'account_plan_payments';
  IF v_policies > 0 THEN
    RAISE EXCEPTION '071: account_plan_payments tem % policy(ies) — deveria ser só service_role.', v_policies;
  END IF;

  -- 3.2. A UNIQUE constraint existe (é ela que carrega toda a
  -- garantia de idempotência desta migração).
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.account_plan_payments'::regclass
       AND conname = 'account_plan_payments_ref_unique'
       AND contype = 'u'
  ) THEN
    RAISE EXCEPTION '071: falta a UNIQUE constraint em payment_ref.';
  END IF;

  -- 3.3. apply_plan_renewal: existe, SECURITY DEFINER, dona postgres,
  -- sem EXECUTE para anon/authenticated.
  SELECT p.* INTO v_proc
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'apply_plan_renewal';
  IF v_proc.oid IS NULL THEN
    RAISE EXCEPTION '071: apply_plan_renewal nao existe apos a migracao.';
  END IF;
  IF NOT v_proc.prosecdef THEN
    RAISE EXCEPTION '071: apply_plan_renewal perdeu o SECURITY DEFINER.';
  END IF;
  IF (SELECT rolname FROM pg_roles WHERE oid = v_proc.proowner) IS DISTINCT FROM 'postgres' THEN
    RAISE EXCEPTION '071: apply_plan_renewal nao pertence a postgres.';
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.routine_privileges
     WHERE routine_name = 'apply_plan_renewal'
       AND grantee IN ('anon', 'authenticated', 'PUBLIC')
  ) THEN
    RAISE EXCEPTION '071: apply_plan_renewal concede EXECUTE a anon/authenticated/PUBLIC.';
  END IF;

  RAISE NOTICE '071: plan_renewal_log aplicada — log de pagamentos e função atômica prontos.';
END $$;
