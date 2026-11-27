-- ============================================================
-- 067_plans_and_quotas.sql — SPEC 059: motor de planos e quotas
--
-- Princípio: o banco decide, o app explica (SPEC 059 §1). O ZAP CRM BR
-- grava contato direto do navegador (contact-form.tsx, import-modal.tsx
-- via supabase-js com a chave anônima), então o único ponto de
-- enforcement que uma guarda de API não consegue contornar é uma
-- trigger. TypeScript só antecipa, traduz e esconde — nunca é a
-- última palavra.
--
-- D-1 (opt-in por deployment): platform_settings.quotas_enforced nasce
-- FALSE. Enquanto desligado, account_effective_limits() devolve '{}' e
-- toda quota é ilimitada — um fork de terceiro que dá `git pull` nesta
-- migração não sente nada. O interruptor mora no banco porque a
-- trigger não lê process.env.
--
-- D-2 (catálogo comercial fora da migração): aqui só entra o plano
-- 'unlimited' (todos os limites nulos), semente técnica. Os planos
-- comerciais com preço em BRL vivem em supabase/setup/plans-seed.sql —
-- mesma regra que já protege cron-jobs.sql.
--
-- Idempotente (IF NOT EXISTS, DROP…CREATE em policies/triggers/funções)
-- e com o bloco de asserções finais que falha alto, no padrão das
-- 041/052/059/061/062.
-- ============================================================

-- ============================================================
-- 1. platform_settings — o interruptor (D-1)
-- ============================================================
CREATE TABLE IF NOT EXISTS platform_settings (
  id                   BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
  quotas_enforced      BOOLEAN NOT NULL DEFAULT FALSE,
  default_plan_code    TEXT    NOT NULL DEFAULT 'unlimited',
  payment_instructions TEXT,
  billing_contact      TEXT,
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO platform_settings (id) VALUES (TRUE) ON CONFLICT DO NOTHING;

ALTER TABLE platform_settings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS platform_settings_select ON platform_settings;
CREATE POLICY platform_settings_select ON platform_settings
  FOR SELECT USING (auth.uid() IS NOT NULL);

DROP TRIGGER IF EXISTS set_updated_at ON platform_settings;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON platform_settings
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================================
-- 2. plans — catálogo
--
-- plans_select_own (policy que libera o plano atual da própria conta)
-- só é criada na seção 3, depois de account_plans existir — ela
-- referencia essa tabela na subquery, e criar as duas policies juntas
-- aqui quebra com "relation account_plans does not exist" (42P01).
-- ============================================================
CREATE TABLE IF NOT EXISTS plans (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code           TEXT NOT NULL UNIQUE,
  name           TEXT NOT NULL,
  description    TEXT,
  price_cents    INTEGER NOT NULL DEFAULT 0 CHECK (price_cents >= 0),
  currency       TEXT NOT NULL DEFAULT 'BRL' CHECK (currency ~ '^[A-Z]{3}$'),
  billing_period TEXT NOT NULL DEFAULT 'monthly'
                 CHECK (billing_period IN ('monthly','yearly','custom','none')),
  -- JSONB e não colunas: cada quota nova seria migração + deploy. O
  -- preço é perder o CHECK do banco sobre as chaves; o contrapeso é
  -- src/lib/plans/types.ts ser a fonte de verdade e catalog.test.ts
  -- validar o seed contra ela.
  limits         JSONB NOT NULL DEFAULT '{}'::jsonb,
  features       JSONB NOT NULL DEFAULT '{}'::jsonb,
  is_public      BOOLEAN NOT NULL DEFAULT FALSE,
  is_active      BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order     INTEGER NOT NULL DEFAULT 0,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE plans ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS plans_select_catalog ON plans;
CREATE POLICY plans_select_catalog ON plans
  FOR SELECT USING (is_active AND is_public);

-- plans_select_own (libera o plano atual da própria conta mesmo se
-- privado) é criada logo abaixo, depois de account_plans existir —
-- a policy referencia essa tabela.

DROP TRIGGER IF EXISTS set_updated_at ON plans;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON plans
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================================
-- 3. account_plans — a assinatura
-- ============================================================
CREATE TABLE IF NOT EXISTS account_plans (
  account_id         UUID PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  plan_id            UUID NOT NULL REFERENCES plans(id) ON DELETE RESTRICT,
  status             TEXT NOT NULL DEFAULT 'active'
                     CHECK (status IN ('trialing','active','past_due','suspended','canceled')),
  trial_ends_at      TIMESTAMPTZ,
  current_period_end TIMESTAMPTZ,
  -- Exceção por conta ("esse cliente negociou 15.000 contatos no
  -- Profissional") — generaliza o papel que accounts.evolution_instance_limit
  -- cumpria sozinho.
  limit_overrides    JSONB NOT NULL DEFAULT '{}'::jsonb,
  note               TEXT,
  updated_by         TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE account_plans ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS account_plans_select ON account_plans;
CREATE POLICY account_plans_select ON account_plans
  FOR SELECT USING (is_account_member(account_id));
-- Escrita: só service_role (nenhuma policy de INSERT/UPDATE/DELETE) —
-- o dono da conta não pode se auto-promover.

-- Libera o plano atual da própria conta mesmo se privado (ex.: "Sob
-- medida" negociado não aparece no catálogo, mas o dono precisa vê-lo).
-- Fica aqui, e não junto das outras policies de `plans`, porque só
-- agora account_plans existe para a subquery referenciar.
DROP POLICY IF EXISTS plans_select_own ON plans;
CREATE POLICY plans_select_own ON plans
  FOR SELECT USING (
    id IN (SELECT plan_id FROM account_plans WHERE is_account_member(account_id))
  );

DROP TRIGGER IF EXISTS set_updated_at ON account_plans;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON account_plans
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================================
-- 4. account_plan_events — histórico append-only
-- ============================================================
CREATE TABLE IF NOT EXISTS account_plan_events (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  from_plan_code  TEXT,
  to_plan_code    TEXT NOT NULL,
  from_status     TEXT,
  to_status       TEXT NOT NULL,
  overrides_after JSONB NOT NULL DEFAULT '{}'::jsonb,
  actor           TEXT NOT NULL,
  reason          TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_account_plan_events_account
  ON account_plan_events (account_id, created_at DESC);

ALTER TABLE account_plan_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS account_plan_events_select ON account_plan_events;
CREATE POLICY account_plan_events_select ON account_plan_events
  FOR SELECT USING (is_account_member(account_id));
-- Sem policy de escrita para o cliente (padrão da 062: policy de
-- escrita aqui permitiria forjar histórico de cobrança).

-- ============================================================
-- 5. plan_change_requests — a solicitação (D-8)
-- ============================================================
CREATE TABLE IF NOT EXISTS plan_change_requests (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id         UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  requested_plan_id  UUID NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  requested_by       UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  status             TEXT NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending','approved','rejected','canceled')),
  message            TEXT,
  resolved_at        TIMESTAMPTZ,
  resolved_note      TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Índice parcial: impede a conta acumular dez solicitações abertas —
-- mesma técnica de idx_channels_one_default_per_account (055).
CREATE UNIQUE INDEX IF NOT EXISTS idx_plan_requests_one_pending
  ON plan_change_requests (account_id) WHERE status = 'pending';

ALTER TABLE plan_change_requests ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS plan_change_requests_select ON plan_change_requests;
CREATE POLICY plan_change_requests_select ON plan_change_requests
  FOR SELECT USING (is_account_member(account_id, 'admin'));
DROP POLICY IF EXISTS plan_change_requests_insert ON plan_change_requests;
CREATE POLICY plan_change_requests_insert ON plan_change_requests
  FOR INSERT WITH CHECK (is_account_member(account_id, 'admin'));

-- Auto-atendimento estreito: admin+ pode CANCELAR a própria solicitação
-- pendente (retirar o pedido), mas não pode aprovar/rejeitar — isso
-- continua exclusivo do operador via /api/admin/plan-requests
-- (service_role). USING restringe a linha de origem (pending);
-- WITH CHECK restringe o valor de chegada (canceled) — as duas pontas
-- fecham a porta para qualquer outra transição pelo cliente.
DROP POLICY IF EXISTS plan_change_requests_cancel_own ON plan_change_requests;
CREATE POLICY plan_change_requests_cancel_own ON plan_change_requests
  FOR UPDATE
  USING (is_account_member(account_id, 'admin') AND status = 'pending')
  WITH CHECK (is_account_member(account_id, 'admin') AND status = 'canceled');
-- DELETE nenhum pelo cliente.

-- ============================================================
-- 6. account_usage_counters — uso O(1)
--
-- Uma trigger que fizesse SELECT count(*) FROM contacts a cada linha
-- inserida transformaria uma importação de 5.000 linhas em 5.000
-- varreduras. O contador é uma linha, lida e escrita em O(1); o
-- UPDATE … RETURNING pega lock de linha, então dois inserts
-- concorrentes na mesma conta serializam ali — é a garantia contra
-- corrida de duas abas furando o teto, não um efeito colateral.
-- ============================================================
CREATE TABLE IF NOT EXISTS account_usage_counters (
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  metric     TEXT NOT NULL,
  value      INTEGER NOT NULL DEFAULT 0 CHECK (value >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (account_id, metric)
);

ALTER TABLE account_usage_counters ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS account_usage_counters_select ON account_usage_counters;
CREATE POLICY account_usage_counters_select ON account_usage_counters
  FOR SELECT USING (is_account_member(account_id));
-- Escrita nenhuma pelo cliente — as triggers são SECURITY DEFINER
-- (owner postgres, com BYPASSRLS) e escrevem por baixo da RLS.

-- ============================================================
-- 7. contacts.created_via — a origem (D-5)
--
-- A origem tem que viajar NO PAYLOAD (não em set_config de sessão):
-- a ingestão fala com o banco via PostgREST/supabase-js, que não
-- garante que set_config e o INSERT caiam na mesma conexão do pool.
--
-- DEFAULT 'manual' (bloqueante), não 'inbound': quem esquecer de
-- declarar cai no caminho restrito. Um cliente com o DevTools aberto
-- pode mandar created_via: 'inbound'; a trigger da seção 9 reescreve
-- para 'manual' quando o chamador não é service_role.
-- ============================================================
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS created_via TEXT;

-- Backfill ANTES do DEFAULT valer para o histórico — linhas
-- existentes viram 'legacy' ("anterior à 067", não uma origem real).
UPDATE contacts SET created_via = 'legacy' WHERE created_via IS NULL;

ALTER TABLE contacts ALTER COLUMN created_via SET DEFAULT 'manual';
ALTER TABLE contacts ALTER COLUMN created_via SET NOT NULL;

ALTER TABLE contacts DROP CONSTRAINT IF EXISTS contacts_created_via_check;
ALTER TABLE contacts ADD CONSTRAINT contacts_created_via_check
  CHECK (created_via IN ('manual','import','api','audience','inbound','legacy'));

-- ============================================================
-- 8. Funções de leitura de limite
--
-- As quatro funções abaixo confiam CEGAMENTE em p_account_id — ao
-- contrário de is_account_member(), elas não checam auth.uid() contra
-- a conta pedida. GRANT só para service_role é o que impede um
-- usuário autenticado da conta A de chamar
-- /rest/v1/rpc/plan_limit?p_account_id=<conta B> e ler a configuração
-- de quota de outra conta (achado do advisor de segurança do Supabase,
-- lints 0028/0029 — anon/authenticated_security_definer_function_executable).
-- Uso interno (triggers, RPCs SECURITY DEFINER) não precisa do GRANT:
-- roda como postgres, que já tem o privilégio. Uso a partir de rota
-- Next.js server-side (que já validou o account_id do CHAMADOR antes
-- de montar o parâmetro) usa supabaseAdmin(), não o client RLS.
-- ============================================================

-- account_effective_limits: plano || overrides da conta. Devolve '{}'
-- quando o interruptor está desligado — o D-1 fica implementado num
-- lugar só, e chave ausente em '{}' já significa "ilimitada" (D-3).
CREATE OR REPLACE FUNCTION account_effective_limits(p_account_id UUID)
RETURNS JSONB
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT CASE
    WHEN NOT (SELECT quotas_enforced FROM platform_settings) THEN '{}'::jsonb
    ELSE COALESCE(
      (
        SELECT p.limits || ap.limit_overrides
        FROM account_plans ap
        JOIN plans p ON p.id = ap.plan_id
        WHERE ap.account_id = p_account_id
      ),
      '{}'::jsonb
    )
  END;
$$;
ALTER FUNCTION account_effective_limits(UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION account_effective_limits(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION account_effective_limits(UUID) TO service_role;

-- plan_limit: NULL = ilimitado. Sem linha em account_plans → NULL →
-- ilimitado — falha aberta de propósito (quota é política comercial,
-- não controle de segurança; isso é papel da RLS).
CREATE OR REPLACE FUNCTION plan_limit(p_account_id UUID, p_key TEXT)
RETURNS INTEGER
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT NULLIF(account_effective_limits(p_account_id) ->> p_key, '')::INTEGER;
$$;
ALTER FUNCTION plan_limit(UUID, TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION plan_limit(UUID, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION plan_limit(UUID, TEXT) TO service_role;

-- plan_feature: ausente é TRUE (mesma lógica permissiva de D-3), e
-- TRUE também quando o interruptor está desligado.
CREATE OR REPLACE FUNCTION plan_feature(p_account_id UUID, p_key TEXT)
RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT CASE
    WHEN NOT (SELECT quotas_enforced FROM platform_settings) THEN TRUE
    ELSE COALESCE(
      (
        SELECT (p.features || ap.limit_overrides) ->> p_key
        FROM account_plans ap
        JOIN plans p ON p.id = ap.plan_id
        WHERE ap.account_id = p_account_id
      ),
      'true'
    )::boolean
  END;
$$;
ALTER FUNCTION plan_feature(UUID, TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION plan_feature(UUID, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION plan_feature(UUID, TEXT) TO service_role;

-- count_members_role: D-6 — owner conta em members_total e também em
-- members_admin (nunca é bloqueado, mas ocupa vaga do teto de admin).
CREATE OR REPLACE FUNCTION count_members_role(p_account_id UUID, p_role TEXT)
RETURNS INTEGER
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT count(*)::INTEGER FROM profiles
  WHERE account_id = p_account_id
    AND (account_role::text = p_role OR (p_role = 'admin' AND account_role = 'owner'));
$$;
ALTER FUNCTION count_members_role(UUID, TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION count_members_role(UUID, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION count_members_role(UUID, TEXT) TO service_role;

-- recount_account_usage: recalcula do zero. Chamada pelo backfill
-- desta migração, pela rota de operador e, opcionalmente, por uma
-- linha em supabase/setup/cron-jobs.sql. Não é para o cliente.
CREATE OR REPLACE FUNCTION recount_account_usage(p_account_id UUID)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO account_usage_counters (account_id, metric, value, updated_at)
  SELECT p_account_id, 'contacts', count(*), NOW()
  FROM contacts WHERE account_id = p_account_id
  ON CONFLICT (account_id, metric)
  DO UPDATE SET value = EXCLUDED.value, updated_at = NOW();
END;
$$;
ALTER FUNCTION recount_account_usage(UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION recount_account_usage(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION recount_account_usage(UUID) TO service_role;

-- ============================================================
-- 9. Triggers de quota de contatos
--
-- Duas triggers, de propósito separado: a BEFORE normaliza NEW (só
-- ela pode reescrever a linha); a AFTER conta e decide. A exceção da
-- AFTER aborta a transação e desfaz o incremento do passo 2 junto —
-- por isso a ordem é incrementar-depois-checar: o incremento é o que
-- dá o lock que serializa a corrida (ver seção 6).
-- ============================================================

CREATE OR REPLACE FUNCTION normalize_contact_created_via()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.created_via = 'inbound' AND auth.role() <> 'service_role' THEN
    NEW.created_via := 'manual';
  END IF;
  RETURN NEW;
END;
$$;
ALTER FUNCTION normalize_contact_created_via() OWNER TO postgres;

DROP TRIGGER IF EXISTS normalize_contact_created_via_trigger ON contacts;
CREATE TRIGGER normalize_contact_created_via_trigger
  BEFORE INSERT ON contacts
  FOR EACH ROW EXECUTE FUNCTION normalize_contact_created_via();

CREATE OR REPLACE FUNCTION enforce_contact_quota()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_used  INTEGER;
  v_limit INTEGER;
BEGIN
  INSERT INTO account_usage_counters (account_id, metric, value, updated_at)
  VALUES (NEW.account_id, 'contacts', 1, NOW())
  ON CONFLICT (account_id, metric)
  DO UPDATE SET value = account_usage_counters.value + 1, updated_at = NOW()
  RETURNING value INTO v_used;

  v_limit := plan_limit(NEW.account_id, 'contacts');

  -- Inbound conta mas não bloqueia (D-5): o incremento acima sempre
  -- acontece; só a exceção sai pela condição created_via <> 'inbound'.
  IF v_limit IS NOT NULL AND v_used > v_limit AND NEW.created_via <> 'inbound' THEN
    -- ERRCODE P0001 é o que o PostgREST devolve como HTTP 400 com a
    -- mensagem preservada. Formato QUOTA_EXCEEDED:<metric>:<used>:<limit>
    -- é contrato com src/lib/plans/errors.ts — mudou de um lado, muda dos dois.
    RAISE EXCEPTION 'QUOTA_EXCEEDED:contacts:%:%', v_used, v_limit
      USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$$;
ALTER FUNCTION enforce_contact_quota() OWNER TO postgres;

DROP TRIGGER IF EXISTS enforce_contact_quota_trigger ON contacts;
CREATE TRIGGER enforce_contact_quota_trigger
  AFTER INSERT ON contacts
  FOR EACH ROW EXECUTE FUNCTION enforce_contact_quota();

CREATE OR REPLACE FUNCTION decrement_contact_usage()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE account_usage_counters
  SET value = GREATEST(value - 1, 0), updated_at = NOW()
  WHERE account_id = OLD.account_id AND metric = 'contacts';
  RETURN OLD;
END;
$$;
ALTER FUNCTION decrement_contact_usage() OWNER TO postgres;

DROP TRIGGER IF EXISTS decrement_contact_usage_trigger ON contacts;
CREATE TRIGGER decrement_contact_usage_trigger
  AFTER DELETE ON contacts
  FOR EACH ROW EXECUTE FUNCTION decrement_contact_usage();

-- ============================================================
-- 10. Plano padrão e atribuição (D-2)
-- ============================================================
INSERT INTO plans (code, name, description, price_cents, billing_period,
                   limits, features, is_public, sort_order)
VALUES ('unlimited', 'Ilimitado',
        'Plano padrão do deployment. Sem limites — é o comportamento do ZAP CRM BR antes da 067.',
        0, 'none', '{}'::jsonb, '{}'::jsonb, FALSE, 1000)
ON CONFLICT (code) DO NOTHING;

INSERT INTO account_plans (account_id, plan_id, status)
SELECT a.id, (SELECT id FROM plans WHERE code = 'unlimited'), 'active'
FROM accounts a
WHERE NOT EXISTS (SELECT 1 FROM account_plans ap WHERE ap.account_id = a.id);

-- ============================================================
-- 10.5. Backfill de accounts.evolution_instance_limit (SPEC 059 F6)
--
-- A coluna (056) vira override de plano — mesma exceção por conta,
-- lugar novo. A coluna permanece (não quebrar quem já a lê), marcada
-- obsoleta; o app para de lê-la ao fim da F6.
-- ============================================================
UPDATE account_plans ap
SET limit_overrides = ap.limit_overrides
  || jsonb_build_object('channels_whatsapp_qr', a.evolution_instance_limit)
FROM accounts a
WHERE a.id = ap.account_id
  AND a.evolution_instance_limit IS NOT NULL;

COMMENT ON COLUMN accounts.evolution_instance_limit IS
  'Obsoleta desde a 067 (SPEC 059) — o override vive em account_plans.limit_overrides->>''channels_whatsapp_qr''. Mantida só para não quebrar leitores antigos.';

-- ============================================================
-- 11. handle_new_user — atribui o plano padrão no cadastro
--
-- Base: a definição vigente em 017_account_sharing.sql:691 (não a da
-- 001). Falha ao atribuir plano não pode impedir cadastro — mesmo
-- EXCEPTION WHEN OTHERS que a função já tinha.
-- ============================================================
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_full_name TEXT;
  v_account_id UUID;
  v_default_plan_code TEXT;
  v_plan_id UUID;
BEGIN
  v_full_name := COALESCE(NEW.raw_user_meta_data->>'full_name', '');

  INSERT INTO public.accounts (name, owner_user_id)
  VALUES (COALESCE(NULLIF(v_full_name, ''), NEW.email, 'My account'), NEW.id)
  RETURNING id INTO v_account_id;

  INSERT INTO public.profiles (user_id, full_name, email, account_id, account_role)
  VALUES (NEW.id, v_full_name, NEW.email, v_account_id, 'owner');

  SELECT default_plan_code INTO v_default_plan_code FROM public.platform_settings;
  SELECT id INTO v_plan_id FROM public.plans WHERE code = v_default_plan_code;
  IF v_plan_id IS NOT NULL THEN
    INSERT INTO public.account_plans (account_id, plan_id, status)
    VALUES (v_account_id, v_plan_id, 'active')
    ON CONFLICT (account_id) DO NOTHING;
  END IF;

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'Failed to bootstrap account/profile for user %: %', NEW.id, SQLERRM;
  RETURN NEW;
END;
$$;

ALTER FUNCTION public.handle_new_user() OWNER TO postgres;

-- ============================================================
-- 12. Quota de membros dentro dos RPCs existentes (§3.5 SPEC 059)
--
-- Não há trigger nova para membros — os dois caminhos que criam/promovem
-- membro já são SECURITY DEFINER; a checagem entra dentro deles.
-- ============================================================

-- redeem_invitation: checagem final de members_total e members_<papel>,
-- depois das validações de convite e antes de mover o perfil. Base:
-- definição vigente em 019_invitation_rpcs.sql:125.
CREATE OR REPLACE FUNCTION public.redeem_invitation(
  p_token_hash TEXT
) RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_id UUID := auth.uid();
  v_inv account_invitations%ROWTYPE;
  v_old_account_id UUID;
  v_old_account_owner UUID;
  v_has_data BOOLEAN;
  v_members_total INTEGER;
  v_members_role INTEGER;
  v_limit_total INTEGER;
  v_limit_role INTEGER;
BEGIN
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_inv
  FROM account_invitations
  WHERE token_hash = p_token_hash
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invitation not found' USING ERRCODE = '22023';
  END IF;
  IF v_inv.accepted_at IS NOT NULL THEN
    RAISE EXCEPTION 'Invitation has already been redeemed'
      USING ERRCODE = '22023';
  END IF;
  IF v_inv.expires_at <= NOW() THEN
    RAISE EXCEPTION 'Invitation has expired' USING ERRCODE = '22023';
  END IF;

  SELECT p.account_id, a.owner_user_id
  INTO v_old_account_id, v_old_account_owner
  FROM profiles p
  JOIN accounts a ON a.id = p.account_id
  WHERE p.user_id = v_caller_id;

  IF v_old_account_id IS NULL THEN
    RAISE EXCEPTION 'Caller has no profile' USING ERRCODE = '42501';
  END IF;

  IF v_old_account_id = v_inv.account_id THEN
    RAISE EXCEPTION 'You are already a member of this account'
      USING ERRCODE = '23505';
  END IF;

  IF v_old_account_owner <> v_caller_id THEN
    RAISE EXCEPTION 'You are already in a shared account; sign up with a different email to join this one'
      USING ERRCODE = '23505';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM contacts WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM conversations WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM broadcasts WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM automations WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM flows WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM pipelines WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM message_templates WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM tags WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM custom_fields WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM contact_notes WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM whatsapp_config WHERE account_id = v_old_account_id
    LIMIT 1
  ) INTO v_has_data;

  IF v_has_data THEN
    RAISE EXCEPTION 'Your account already contains data; sign up with a different email to join this one'
      USING ERRCODE = '23505';
  END IF;

  -- SPEC 059 §3.5: quota de membros do plano da conta que está
  -- recebendo o convidado (v_inv.account_id), checagem final.
  --
  -- Lock na linha de accounts (achado de code review): sem isto, dois
  -- resgates concorrentes para a MESMA conta (dois convites distintos,
  -- aceitos quase ao mesmo tempo) leem o mesmo v_members_total antes de
  -- qualquer UPDATE profiles committar, e os dois passam — mesmo tipo
  -- de corrida que o UPDATE...RETURNING de account_usage_counters
  -- (§6) existe para evitar do lado de contatos. `accounts` já é
  -- travada topo-a-baixo por esta função via v_old_account_owner mais
  -- acima só para leitura; este FOR UPDATE é o que de fato serializa.
  PERFORM 1 FROM accounts WHERE id = v_inv.account_id FOR UPDATE;

  SELECT count(*) INTO v_members_total FROM profiles WHERE account_id = v_inv.account_id;
  v_members_role := count_members_role(v_inv.account_id, v_inv.role::text);
  v_limit_total := plan_limit(v_inv.account_id, 'members_total');
  v_limit_role := plan_limit(v_inv.account_id, 'members_' || v_inv.role::text);

  IF v_limit_total IS NOT NULL AND v_members_total + 1 > v_limit_total THEN
    RAISE EXCEPTION 'QUOTA_EXCEEDED:members_total:%:%', v_members_total + 1, v_limit_total
      USING ERRCODE = '22023';
  END IF;
  IF v_limit_role IS NOT NULL AND v_members_role + 1 > v_limit_role THEN
    RAISE EXCEPTION 'QUOTA_EXCEEDED:members_%:%:%', v_inv.role, v_members_role + 1, v_limit_role
      USING ERRCODE = '22023';
  END IF;

  UPDATE profiles
  SET account_id = v_inv.account_id,
      account_role = v_inv.role
  WHERE user_id = v_caller_id;

  UPDATE account_invitations
  SET accepted_at = NOW(),
      accepted_by_user_id = v_caller_id
  WHERE id = v_inv.id;

  DELETE FROM accounts WHERE id = v_old_account_id;

  RETURN v_inv.account_id;
END;
$$;

ALTER FUNCTION public.redeem_invitation(TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.redeem_invitation(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.redeem_invitation(TEXT) TO authenticated;

-- set_member_role: promover para um papel cujo teto está cheio falha;
-- rebaixar nunca falha. Base: definição vigente em
-- 018_account_member_rpcs.sql:37.
CREATE OR REPLACE FUNCTION public.set_member_role(
  p_user_id UUID,
  p_new_role account_role_enum
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_account_id UUID;
  v_caller_role account_role_enum;
  v_target_account_id UUID;
  v_target_role account_role_enum;
  v_rank_old INTEGER;
  v_rank_new INTEGER;
  v_role_count INTEGER;
  v_role_limit INTEGER;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  SELECT account_id, account_role
  INTO v_caller_account_id, v_caller_role
  FROM profiles
  WHERE user_id = auth.uid();

  IF v_caller_account_id IS NULL THEN
    RAISE EXCEPTION 'Caller has no account' USING ERRCODE = '42501';
  END IF;

  IF v_caller_role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'This action requires the admin role or higher'
      USING ERRCODE = '42501';
  END IF;

  IF p_user_id = auth.uid() THEN
    RAISE EXCEPTION 'Cannot change your own role'
      USING ERRCODE = '22023';
  END IF;

  SELECT account_id, account_role
  INTO v_target_account_id, v_target_role
  FROM profiles
  WHERE user_id = p_user_id;

  IF v_target_account_id IS NULL THEN
    RAISE EXCEPTION 'Target user not found' USING ERRCODE = '22023';
  END IF;

  IF v_target_account_id <> v_caller_account_id THEN
    RAISE EXCEPTION 'Target user is not a member of your account'
      USING ERRCODE = '42501';
  END IF;

  IF v_target_role = 'owner' THEN
    RAISE EXCEPTION 'Use transfer_account_ownership to demote an owner'
      USING ERRCODE = '22023';
  END IF;
  IF p_new_role = 'owner' THEN
    RAISE EXCEPTION 'Use transfer_account_ownership to promote to owner'
      USING ERRCODE = '22023';
  END IF;

  -- SPEC 059 §3.5: só promoção (rank sobe) pode ser bloqueada.
  v_rank_old := CASE v_target_role WHEN 'admin' THEN 3 WHEN 'agent' THEN 2 WHEN 'viewer' THEN 1 END;
  v_rank_new := CASE p_new_role   WHEN 'admin' THEN 3 WHEN 'agent' THEN 2 WHEN 'viewer' THEN 1 END;

  IF v_rank_new > v_rank_old THEN
    v_role_count := count_members_role(v_caller_account_id, p_new_role::text);
    v_role_limit := plan_limit(v_caller_account_id, 'members_' || p_new_role::text);
    IF v_role_limit IS NOT NULL AND v_role_count + 1 > v_role_limit THEN
      RAISE EXCEPTION 'QUOTA_EXCEEDED:members_%:%:%', p_new_role, v_role_count + 1, v_role_limit
        USING ERRCODE = '22023';
    END IF;
  END IF;

  UPDATE profiles
  SET account_role = p_new_role
  WHERE user_id = p_user_id;
END;
$$;

ALTER FUNCTION public.set_member_role(UUID, account_role_enum) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.set_member_role(UUID, account_role_enum) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_member_role(UUID, account_role_enum) TO authenticated;

-- ============================================================
-- 13. Backfill de account_usage_counters
-- ============================================================
INSERT INTO account_usage_counters (account_id, metric, value, updated_at)
SELECT account_id, 'contacts', count(*), NOW()
FROM contacts
GROUP BY account_id
ON CONFLICT (account_id, metric) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW();

-- ============================================================
-- 14. Asserções finais — falham alto de propósito
-- ============================================================
DO $$
DECLARE
  v_orphans INTEGER;
  v_mismatches INTEGER;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM plans WHERE code = 'unlimited') THEN
    RAISE EXCEPTION '067: plano unlimited nao foi semeado.';
  END IF;

  SELECT count(*) INTO v_orphans
  FROM accounts a
  WHERE NOT EXISTS (SELECT 1 FROM account_plans ap WHERE ap.account_id = a.id);
  IF v_orphans > 0 THEN
    RAISE EXCEPTION '067: % conta(s) sem account_plans apos backfill.', v_orphans;
  END IF;

  IF (SELECT quotas_enforced FROM platform_settings) IS DISTINCT FROM FALSE THEN
    RAISE EXCEPTION '067: quotas_enforced deve nascer FALSE (D-1) — migracao nunca liga quota.';
  END IF;

  SELECT count(*) INTO v_mismatches
  FROM (
    SELECT a.id AS account_id,
           COALESCE(auc.value, 0) AS counted,
           (SELECT count(*)::int FROM contacts c WHERE c.account_id = a.id) AS actual
    FROM accounts a
    LEFT JOIN account_usage_counters auc
      ON auc.account_id = a.id AND auc.metric = 'contacts'
  ) x
  WHERE x.counted <> x.actual;
  IF v_mismatches > 0 THEN
    RAISE EXCEPTION '067: % conta(s) com account_usage_counters divergente de count(*) apos backfill.', v_mismatches;
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename IN ('account_plans', 'account_plan_events', 'account_usage_counters')
      AND cmd <> 'SELECT'
  ) THEN
    RAISE EXCEPTION '067: policy de escrita pelo cliente encontrada em tabela que deveria ser somente-leitura.';
  END IF;

  RAISE NOTICE '067: plans_and_quotas aplicada — quotas_enforced=FALSE, % contas no plano unlimited.',
    (SELECT count(*) FROM account_plans);
END $$;
