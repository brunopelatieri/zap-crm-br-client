-- ============================================================
-- 069_platform_console.sql — SPEC 062 (F1): console do proprietário,
--                            bloqueio e ciclo de plano
--
-- Esta migração NÃO liga nada. Ao final dela o app se comporta
-- exatamente como antes: nenhuma conta e nenhum perfil bloqueado,
-- nenhum vencimento inventado, nenhuma linha de política de retenção
-- perdida. O que ela faz é preparar o terreno em cinco frentes:
--
--   1. Bloqueio de conta e de usuário (§3.1) — colunas + índices
--      parciais, escrita só por `service_role`.
--   2. `is_account_member()` passa a conhecer bloqueio (§3.2) — é o
--      coração do enforcement: a função está dentro de praticamente
--      toda policy RLS do repositório, então bloquear passa a valer
--      em todas as tabelas de uma vez, inclusive no INSERT direto
--      que o navegador faz (SPEC 059 §1).
--   3. Ciclo de vida e cobrança externa em `account_plans`
--      (§3.3, §3.7) — inclusive o índice único parcial que dá
--      idempotência à futura rota de renovação.
--   4. Desconto anual e as chaves novas de `platform_settings`
--      (§3.4) + `retention_defaults` (§3.8).
--   5. `platform_audit_log` (§3.5) e a virada de dono da retenção
--      (§3.8) — as policies do cliente somem, os DADOS ficam.
--
-- Idempotente (IF NOT EXISTS, DROP…CREATE em policies/funções/
-- triggers) e com bloco de asserções finais que falha alto, no
-- padrão das 041/052/067/068.
-- ============================================================

-- ============================================================
-- 0. Estado ANTERIOR — o que as asserções do fim precisam comparar
--
-- Duas perguntas só podem ser respondidas antes das alterações:
--
--   * quantas linhas `channel_retention_policies` tinha (a virada de
--     dono da §3.8 não pode apagar política de ninguém — e "zero
--     antes, zero depois" não prova nada sozinho);
--   * `account_plans.started_at` já existia? Se sim, esta migração já
--     rodou e o backfill da §3.3 NÃO pode rodar de novo por cima de
--     datas de adesão reais.
--
-- TEMP: vive só nesta sessão e é derrubada no fim. Se a migração
-- falhar no meio, o rollback leva tudo junto.
-- ============================================================
DROP TABLE IF EXISTS mig069_before;
CREATE TEMP TABLE mig069_before AS
SELECT
  (SELECT count(*) FROM channel_retention_policies)      AS retention_rows,
  EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name   = 'account_plans'
       AND column_name  = 'started_at'
  )                                                      AS started_at_existed;

-- ============================================================
-- 1. Bloqueio de conta e de usuário (§3.1)
--
-- Timestamp, não booleano: `blocked_at` responde "desde quando",
-- que é a pergunta do suporte. `blocked_by` é TEXTO
-- ('console:<email>') e não FK para auth.users — o proprietário da
-- plataforma pode não ter usuário neste banco no futuro, e a trilha
-- não pode depender disso.
--
-- Escrita: só `service_role`. NENHUMA policy nova — nem para o dono
-- da conta. Um dono que pudesse limpar o próprio `blocked_at`
-- tornaria o bloqueio decorativo (ver seção 3 sobre a policy
-- `profiles_update`, que já existe desde a 017).
-- ============================================================
ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS blocked_at     TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS blocked_reason TEXT,
  ADD COLUMN IF NOT EXISTS blocked_by     TEXT;

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS blocked_at     TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS blocked_reason TEXT,
  ADD COLUMN IF NOT EXISTS blocked_by     TEXT;

-- Parciais: bloqueado é a exceção. O índice tem o tamanho do conjunto
-- de bloqueados, e é ele que faz a lista "contas bloqueadas" do
-- console sair barata sem varrer a tabela inteira.
CREATE INDEX IF NOT EXISTS idx_accounts_blocked ON accounts (blocked_at) WHERE blocked_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_profiles_blocked ON profiles (blocked_at) WHERE blocked_at IS NOT NULL;

-- ============================================================
-- 2. `is_account_member()` passa a conhecer bloqueio (§3.2)
--
-- Duas condições novas, e o bloqueio passa a valer em TODAS as
-- policies que já chamam esta função — contatos, conversas,
-- mensagens, disparos, automações, chaves de API, retenção. Nenhuma
-- policy precisa ser reescrita.
--
-- Três coisas que não podem ser erradas aqui:
--
--   * continua `STABLE` — perder isso degrada consulta em toda a
--     aplicação, porque o planejador deixa de reaproveitar o
--     resultado dentro do mesmo comando;
--   * o `ALTER FUNCTION … OWNER TO postgres` é REPETIDO depois do
--     CREATE OR REPLACE — sem ele a função `SECURITY DEFINER` passa
--     a rodar com o dono errado e falha com "permission denied";
--   * o `JOIN accounts` nunca derruba linha por conta ausente:
--     `profiles.account_id` é FK para `accounts(id)` desde a 017.
--
-- `service_role` não passa por RLS, então o console, os motores e as
-- rotas de cron continuam enxergando conta bloqueada. Quem precisa
-- parar de agir sobre ela é código explícito (§4.3, fase F5).
-- ============================================================
CREATE OR REPLACE FUNCTION is_account_member(
  target_account_id UUID,
  min_role account_role_enum DEFAULT 'viewer'
) RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM profiles p
    JOIN accounts a ON a.id = p.account_id
    WHERE p.user_id = auth.uid()
      AND p.account_id = target_account_id
      AND p.blocked_at IS NULL          -- usuário bloqueado
      AND a.blocked_at IS NULL          -- conta bloqueada
      AND CASE p.account_role
            WHEN 'owner'  THEN 4
            WHEN 'admin'  THEN 3
            WHEN 'agent'  THEN 2
            WHEN 'viewer' THEN 1
          END
        >=
          CASE min_role
            WHEN 'owner'  THEN 4
            WHEN 'admin'  THEN 3
            WHEN 'agent'  THEN 2
            WHEN 'viewer' THEN 1
          END
  );
$$;

ALTER FUNCTION is_account_member(UUID, account_role_enum) OWNER TO postgres;
GRANT EXECUTE ON FUNCTION is_account_member(UUID, account_role_enum) TO authenticated, service_role;

-- ============================================================
-- 3. O bloqueio de USUÁRIO precisa de guarda de coluna (§3.1)
--
-- ACRÉSCIMO AO TEXTO LITERAL DA SPEC — e o motivo está no schema.
--
-- A §3.1 diz "escrita só service_role, nenhuma policy nova". Isso
-- basta para `accounts.blocked_at`: a única policy de UPDATE em
-- `accounts` é `accounts_update`, que passa por
-- `is_account_member(id,'admin')` — e conta bloqueada reprova ali
-- agora, então ninguém de dentro limpa o próprio bloqueio.
--
-- Para `profiles.blocked_at` NÃO basta: a policy `profiles_update`
-- da 017 é `USING (auth.uid() = user_id)` e não passa por
-- `is_account_member`. Sem guarda, o usuário bloqueado faria
--
--     UPDATE profiles SET blocked_at = NULL WHERE user_id = auth.uid();
--
-- pelo `supabase-js`, e o bloqueio de usuário seria exatamente o
-- "decorativo" que a §3.1 existe para impedir. RLS restringe QUAIS
-- LINHAS podem ser atualizadas, não QUAIS COLUNAS.
--
-- A casa já resolveu esse problema idêntico na 034
-- (GHSA-fg5p-2qc3-jmxr) para `account_role`/`account_id`: um
-- BEFORE UPDATE que rejeita a mudança quando `current_user` é
-- `authenticated`. Aqui a função daquela migração é ESTENDIDA — não
-- duplicada — para cobrir as três colunas de bloqueio. Os
-- escritores legítimos seguem intactos: as RPCs 018/019 são
-- SECURITY DEFINER (current_user = postgres) e o backend roda como
-- `service_role`.
-- ============================================================
CREATE OR REPLACE FUNCTION public.enforce_profile_privilege_columns()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF (NEW.account_role IS DISTINCT FROM OLD.account_role
      OR NEW.account_id IS DISTINCT FROM OLD.account_id)
     AND current_user = 'authenticated'
  THEN
    RAISE EXCEPTION
      'account_role and account_id cannot be changed directly; use the account member/invitation RPCs'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- SPEC 062 §3.1: bloqueio é escrita de `service_role`. O navegador
  -- não desfaz o próprio bloqueio.
  IF (NEW.blocked_at IS DISTINCT FROM OLD.blocked_at
      OR NEW.blocked_reason IS DISTINCT FROM OLD.blocked_reason
      OR NEW.blocked_by IS DISTINCT FROM OLD.blocked_by)
     AND current_user = 'authenticated'
  THEN
    RAISE EXCEPTION
      'blocked_at, blocked_reason and blocked_by are managed by the platform console'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN NEW;
END;
$$;

ALTER FUNCTION public.enforce_profile_privilege_columns() OWNER TO postgres;

DROP TRIGGER IF EXISTS enforce_profile_privilege_columns ON public.profiles;
CREATE TRIGGER enforce_profile_privilege_columns
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.enforce_profile_privilege_columns();

-- ============================================================
-- 4. Ciclo de vida em `account_plans` (§3.3)
--
-- `current_period_end` já existe desde a 067 e passa a ser DERIVADO
-- (`started_at` + 1 mês/ano), calculado em TypeScript (§5.1, fase
-- F2) e gravado. Não é coluna computada porque a regra de fim de mês
-- (adesão em 31/01) é decisão de produto e precisa de teste unitário.
-- ============================================================
ALTER TABLE account_plans
  ADD COLUMN IF NOT EXISTS billing_cycle TEXT NOT NULL DEFAULT 'monthly'
    CHECK (billing_cycle IN ('monthly','yearly')),
  ADD COLUMN IF NOT EXISTS started_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS cancel_at_period_end BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS canceled_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS grace_until   TIMESTAMPTZ;

-- O cron de vencimento (§8) varre por data. Sem este índice ele vira
-- varredura da tabela inteira a cada 6 horas.
CREATE INDEX IF NOT EXISTS idx_account_plans_period_end
  ON account_plans (current_period_end)
  WHERE current_period_end IS NOT NULL;

-- Backfill: a adesão é a data em que a linha nasceu, não o instante
-- do deploy. `current_period_end` permanece NULL para todo mundo —
-- toda conta existente está no plano `unlimited`
-- (`billing_period='none'`), que por definição não vence.
-- UMA MIGRAÇÃO NUNCA INVENTA VENCIMENTO PARA QUEM JÁ É CLIENTE.
--
-- Só roda quando a coluna acabou de nascer (seção 0): numa segunda
-- aplicação, `started_at` já carrega datas de adesão reais e
-- reescrevê-las com `created_at` seria perder informação.
--
-- Nota: o trigger `set_updated_at` da 067 bumpa
-- `account_plans.updated_at` neste UPDATE. É cosmético e deliberado
-- — a coluna não é lida em lugar nenhum do app, e desabilitar
-- trigger para preservá-la custaria mais risco do que vale.
DO $$
BEGIN
  IF NOT (SELECT started_at_existed FROM mig069_before) THEN
    UPDATE account_plans
       SET started_at = COALESCE(created_at, NOW())
     WHERE started_at IS DISTINCT FROM COALESCE(created_at, NOW());
  END IF;
END $$;

-- ============================================================
-- 5. Cobrança externa (§3.7)
--
-- A cobrança é emitida por outro sistema. O CRM não cobra, mas
-- precisa saber a QUAL cobrança cada conta corresponde e ter por
-- onde ser avisado de que o período foi pago.
--
-- `billing_source` já prevê 'gateway' SEM nada implementado — é uma
-- linha de CHECK hoje e a diferença entre uma migração e nenhuma no
-- dia em que o gateway entrar.
-- ============================================================
ALTER TABLE account_plans
  ADD COLUMN IF NOT EXISTS billing_source TEXT NOT NULL DEFAULT 'manual'
    CHECK (billing_source IN ('manual','external','gateway')),
  ADD COLUMN IF NOT EXISTS external_billing_ref TEXT,
  ADD COLUMN IF NOT EXISTS last_payment_ref TEXT,
  ADD COLUMN IF NOT EXISTS last_payment_at TIMESTAMPTZ;

-- Idempotência da renovação (§6.2): o mesmo pagamento chegando duas
-- vezes (retentativa do sistema externo, clique duplo) não avança o
-- vencimento duas vezes. Um `SELECT … WHERE ref = ?` na rota NÃO
-- resolve — duas chamadas simultâneas não encontrariam nada e as
-- duas avançariam. O índice é o único ponto que serializa isso de
-- verdade, mesma lógica de `idx_plan_requests_one_pending` (067) e
-- `idx_channels_one_default_per_account` (055). Parcial porque a
-- esmagadora maioria das contas é NULL aqui.
--
-- Não é usado nesta fase — só precisa existir.
CREATE UNIQUE INDEX IF NOT EXISTS idx_account_plans_last_payment
  ON account_plans (last_payment_ref) WHERE last_payment_ref IS NOT NULL;

-- ============================================================
-- 6. Desconto anual e as chaves novas da plataforma (§3.4)
--
-- NULL no plano = usa o padrão da plataforma (D-5). O CHECK de 0–100
-- existe porque um desconto de 150% viraria preço negativo, e o
-- lugar de barrar isso é o banco — a validação de rota é a segunda
-- camada, não a única.
--
-- O catálogo comercial NÃO muda aqui: `supabase/setup/plans-seed.sql`
-- já traz os quatro planos, e o anual é derivado (todos herdam os
-- 17% da plataforma enquanto `yearly_discount_percent` for NULL).
-- ============================================================
ALTER TABLE plans
  ADD COLUMN IF NOT EXISTS yearly_discount_percent INTEGER
    CHECK (yearly_discount_percent IS NULL
           OR (yearly_discount_percent >= 0 AND yearly_discount_percent <= 100));

-- `self_service_enabled` é o interruptor da §7.1: permite voltar ao
-- fluxo de aprovação sem redeploy se a troca imediata se mostrar um
-- problema comercial. `support_email` aparece na tela de bloqueio
-- (§4.4) — sem ele, o bloqueado não tem para quem escrever.
ALTER TABLE platform_settings
  ADD COLUMN IF NOT EXISTS default_yearly_discount_percent INTEGER NOT NULL DEFAULT 17
    CHECK (default_yearly_discount_percent >= 0 AND default_yearly_discount_percent <= 100),
  ADD COLUMN IF NOT EXISTS support_email TEXT,
  ADD COLUMN IF NOT EXISTS grace_days INTEGER NOT NULL DEFAULT 7 CHECK (grace_days >= 0),
  ADD COLUMN IF NOT EXISTS self_service_enabled BOOLEAN NOT NULL DEFAULT TRUE;

-- ============================================================
-- 7. `platform_audit_log` — o que o console fez (§3.5)
--
-- `ON DELETE SET NULL` no `account_id`: a auditoria precisa
-- SOBREVIVER à conta apagada — é justamente o registro de que ela
-- existiu (mesma razão de `account_plan_events` guardar `code` e não
-- `plan_id`).
--
-- RLS ligada SEM NENHUMA POLICY: ninguém lê pelo `supabase-js`, nem
-- o dono da conta, nem o proprietário. O console lê por
-- `service_role`. Uma tabela com RLS ligada e zero policies é a
-- forma mais curta de dizer "só service_role" — e a asserção final
-- confere que ela continua assim.
-- ============================================================
CREATE TABLE IF NOT EXISTS platform_audit_log (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor          TEXT NOT NULL,                    -- 'console:bruno@...' | 'api:<actor>'
  action         TEXT NOT NULL,                    -- 'account.block' | 'plan.change' | ...
  account_id     UUID REFERENCES accounts(id) ON DELETE SET NULL,
  target_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  payload        JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_platform_audit_created ON platform_audit_log (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_platform_audit_account ON platform_audit_log (account_id, created_at DESC);

ALTER TABLE platform_audit_log ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- 8. Retenção passa ao proprietário da plataforma (§3.8)
--
-- A SPEC 060 entregou a política de retenção como configuração do
-- DONO DA CONTA. Ela passa a ser do proprietário da plataforma.
--
-- 8.1. As policies do cliente somem. As duas tabelas ficam com RLS
--      ligada e ZERO policies — mesmo padrão da `platform_audit_log`.
--
-- NENHUMA LINHA DE DADO É APAGADA. Uma conta que já configurou
-- política continua com ela valendo exatamente igual — só deixa de
-- conseguir vê-la e mudá-la pela sessão do cliente. A varredura roda
-- com `service_role` e não é afetada em nada. Se alguém abrir
-- chamado dizendo que "a política sumiu", confira por `service_role`
-- e não pela sessão do cliente (§11).
--
-- O que NÃO muda e esta migração não encosta: `messages.is_favorite`
-- e a policy `messages_update` da 017 (favoritar continua agent+),
-- `purge_channel_messages` e o REVOKE dela, o piso de idade e as
-- três fases da varredura.
-- ============================================================
DROP POLICY IF EXISTS channel_retention_select ON channel_retention_policies;
DROP POLICY IF EXISTS channel_retention_insert ON channel_retention_policies;
DROP POLICY IF EXISTS channel_retention_update ON channel_retention_policies;
DROP POLICY IF EXISTS channel_retention_delete ON channel_retention_policies;
DROP POLICY IF EXISTS message_retention_state_select ON message_retention_state;

-- RLS continua ligada nas duas (a 068 já ligou; repetido aqui porque
-- tabela com RLS DESLIGADA e zero policies é o oposto exato do que
-- se pretende — seria leitura livre).
ALTER TABLE channel_retention_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE message_retention_state    ENABLE ROW LEVEL SECURITY;

-- 8.2. O padrão global ganha uma fonte editável (D-13), acima do
--      `.env`. A cadeia de precedência da SPEC 060 §3.4 ganha um elo:
--
--        linha da política da conta -> padrão global do console
--          -> padrão do `.env` -> sem limite
--
--      Chave ausente em qualquer nível cai para o próximo; `0`
--      continua significando "sem limite" e NUNCA "apagar tudo".
--
--      Nasce '{}' de propósito: uma migração nunca semeia limite de
--      retenção. Quem lê isso é o `sweep.ts` a partir da F7 — nesta
--      fase a coluna só existe.
--
-- 8.3. O interruptor NÃO vai para a tela: `MESSAGE_RETENTION_ENABLED`
--      continua só no `.env` (D-13). Ligar limpeza de histórico por
--      clique é o tipo de acidente sem desfazer que a SPEC 060 §1
--      existe para impedir.
ALTER TABLE platform_settings
  ADD COLUMN IF NOT EXISTS retention_defaults JSONB NOT NULL DEFAULT '{}'::jsonb;

-- ============================================================
-- 9. Asserções finais — falham alto de propósito (§3.9)
-- ============================================================
DO $$
DECLARE
  v_blocked_accounts INTEGER;
  v_blocked_profiles INTEGER;
  v_orphans          INTEGER;
  v_period_ends      INTEGER;
  v_policies         INTEGER;
  v_retention_now    BIGINT;
  v_retention_before BIGINT;
  v_proc             pg_proc%ROWTYPE;
BEGIN
  -- 9.1. is_account_member: existe, SECURITY DEFINER, STABLE, dona
  -- postgres, e o corpo conhece bloqueio. Se o corpo nao citar
  -- `blocked_at`, a 069 rodou depois de algo que a reescreveu.
  SELECT p.* INTO v_proc
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'is_account_member';

  IF v_proc.oid IS NULL THEN
    RAISE EXCEPTION '069: is_account_member nao existe apos a migracao.';
  END IF;
  IF NOT v_proc.prosecdef THEN
    RAISE EXCEPTION '069: is_account_member perdeu o SECURITY DEFINER.';
  END IF;
  IF v_proc.provolatile <> 's' THEN
    RAISE EXCEPTION '069: is_account_member perdeu o STABLE (volatilidade: %) — degrada consulta em toda a aplicacao.', v_proc.provolatile;
  END IF;
  -- Comparacao pelo nome do papel (e nao oid <> regrole) para nao
  -- depender de resolucao implicita de operador dentro da assercao.
  IF (SELECT rolname FROM pg_roles WHERE oid = v_proc.proowner) IS DISTINCT FROM 'postgres' THEN
    RAISE EXCEPTION '069: is_account_member nao pertence a postgres (dona: %) — faltou repetir o ALTER FUNCTION ... OWNER TO postgres.',
      COALESCE((SELECT rolname FROM pg_roles WHERE oid = v_proc.proowner), '<desconhecida>');
  END IF;
  IF v_proc.prosrc NOT LIKE '%blocked_at%' THEN
    RAISE EXCEPTION '069: is_account_member nao conhece bloqueio — o corpo nao cita blocked_at.';
  END IF;

  -- 9.2. Invariante da 067: toda conta continua com linha em account_plans.
  SELECT count(*) INTO v_orphans
    FROM accounts a
   WHERE NOT EXISTS (SELECT 1 FROM account_plans ap WHERE ap.account_id = a.id);
  IF v_orphans > 0 THEN
    RAISE EXCEPTION '069: % conta(s) sem linha em account_plans.', v_orphans;
  END IF;

  -- 9.3. Nenhuma conta e nenhum perfil sai bloqueado desta migracao.
  SELECT count(*) INTO v_blocked_accounts FROM accounts WHERE blocked_at IS NOT NULL;
  SELECT count(*) INTO v_blocked_profiles FROM profiles WHERE blocked_at IS NOT NULL;
  IF v_blocked_accounts > 0 OR v_blocked_profiles > 0 THEN
    RAISE EXCEPTION '069: migracao deixou % conta(s) e % perfil(is) bloqueados — ela nunca bloqueia ninguem.',
      v_blocked_accounts, v_blocked_profiles;
  END IF;

  -- 9.4. Nenhuma conta sai com vencimento (§3.3).
  SELECT count(*) INTO v_period_ends FROM account_plans WHERE current_period_end IS NOT NULL;
  IF v_period_ends > 0 THEN
    RAISE EXCEPTION '069: % conta(s) com current_period_end preenchido — migracao nao inventa vencimento.', v_period_ends;
  END IF;

  -- 9.5. platform_audit_log: RLS ligada e ZERO policies.
  IF NOT (SELECT c.relrowsecurity FROM pg_class c
           JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public' AND c.relname = 'platform_audit_log') THEN
    RAISE EXCEPTION '069: platform_audit_log sem RLS ligada.';
  END IF;
  SELECT count(*) INTO v_policies
    FROM pg_policies WHERE schemaname = 'public' AND tablename = 'platform_audit_log';
  IF v_policies > 0 THEN
    RAISE EXCEPTION '069: platform_audit_log tem % policy(ies) — deveria ser so service_role.', v_policies;
  END IF;

  -- 9.6. Retencao: RLS ligada, zero policies, e NENHUMA LINHA PERDIDA.
  -- `count = 2` junto com o `bool_and`: sem ele, uma tabela ausente
  -- daria conjunto vazio, bool_and NULL, e a assercao passaria calada.
  IF (SELECT count(*) FILTER (WHERE c.relrowsecurity) FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public'
         AND c.relname IN ('channel_retention_policies', 'message_retention_state')) <> 2 THEN
    RAISE EXCEPTION '069: tabela de retencao ausente ou com RLS desligada — seria leitura livre.';
  END IF;

  SELECT count(*) INTO v_policies
    FROM pg_policies
   WHERE schemaname = 'public'
     AND tablename IN ('channel_retention_policies', 'message_retention_state');
  IF v_policies > 0 THEN
    RAISE EXCEPTION '069: % policy(ies) sobrando nas tabelas de retencao — a virada de dono (§3.8) nao completou.', v_policies;
  END IF;

  SELECT retention_rows INTO v_retention_before FROM mig069_before;
  SELECT count(*) INTO v_retention_now FROM channel_retention_policies;
  IF v_retention_now <> v_retention_before THEN
    RAISE EXCEPTION '069: channel_retention_policies tinha % linha(s) e ficou com % — a virada de dono nao pode apagar politica de ninguem.',
      v_retention_before, v_retention_now;
  END IF;

  -- 9.7. purge_channel_messages continua sem EXECUTE para o cliente
  -- (a 069 nao pode ter afrouxado o REVOKE da 068).
  IF EXISTS (
    SELECT 1 FROM information_schema.routine_privileges
     WHERE routine_name = 'purge_channel_messages'
       AND grantee IN ('anon', 'authenticated', 'PUBLIC')
  ) THEN
    RAISE EXCEPTION '069: purge_channel_messages voltou a conceder EXECUTE a anon/authenticated/PUBLIC.';
  END IF;

  -- 9.8. Nenhuma escrita pelo cliente sobre bloqueio.
  -- As unicas policies de UPDATE em accounts/profiles continuam sendo
  -- as da 017 — esta migracao nao criou nenhuma. E `profiles_update`,
  -- que nao passa por is_account_member, esta coberta pela guarda de
  -- coluna da secao 3 (sem ela o bloqueio de usuario seria decorativo).
  SELECT count(*) INTO v_policies
    FROM pg_policies
   WHERE schemaname = 'public'
     AND tablename IN ('accounts', 'profiles')
     AND cmd = 'UPDATE'
     AND policyname NOT IN ('accounts_update', 'profiles_update');
  IF v_policies > 0 THEN
    RAISE EXCEPTION '069: % policy(ies) de UPDATE inesperada(s) em accounts/profiles.', v_policies;
  END IF;

  IF pg_get_functiondef('public.enforce_profile_privilege_columns()'::regprocedure)
       NOT LIKE '%blocked_at%' THEN
    RAISE EXCEPTION '069: a guarda de coluna de profiles nao protege blocked_at — usuario bloqueado limparia o proprio bloqueio pelo supabase-js.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgrelid = 'public.profiles'::regclass
       AND tgname  = 'enforce_profile_privilege_columns'
       AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION '069: trigger enforce_profile_privilege_columns ausente em profiles.';
  END IF;

  -- 9.9. platform_settings nasce com os padroes certos — e sem
  -- limite de retencao nenhum (§3.8: migracao nunca semeia limite).
  IF (SELECT self_service_enabled FROM platform_settings) IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION '069: platform_settings.self_service_enabled deveria nascer TRUE.';
  END IF;
  IF (SELECT default_yearly_discount_percent FROM platform_settings) NOT BETWEEN 0 AND 100 THEN
    RAISE EXCEPTION '069: default_yearly_discount_percent fora de 0-100.';
  END IF;
  IF (SELECT retention_defaults FROM platform_settings) IS DISTINCT FROM '{}'::jsonb THEN
    RAISE EXCEPTION '069: retention_defaults deveria nascer vazio — migracao nunca semeia limite de retencao.';
  END IF;

  RAISE NOTICE '069: platform_console aplicada — 0 contas bloqueadas, 0 vencimentos, % politica(s) de retencao preservada(s).',
    v_retention_now;
END $$;

DROP TABLE IF EXISTS mig069_before;
