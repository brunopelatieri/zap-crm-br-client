-- ============================================================
-- 081_extract_shared_member_detach_core.sql
--
-- Achado de code review: `platform_remove_account_member()` (079) era
-- cópia quase integral de `remove_account_member()` (018/074) — mesmo
-- efeito (reatribui conversas, cria conta pessoal, atribui plano
-- padrão), só a checagem de QUEM CHAMA diferia. A cronologia já provou
-- o risco: a 079 teve que replicar manualmente, na hora de escrever,
-- o bloco de plano padrão que a 074 tinha acabado de corrigir.
--
-- Esta migração extrai o corpo comum para um helper interno,
-- `_account_member_detach_core`, e as duas RPCs públicas passam a ser
-- só a casca de autorização + delegação. A ÚNICA coisa que difere
-- entre os dois textos de erro "não pode remover o dono" é preservada
-- via parâmetro (`p_owner_error_message`), palavra por palavra, contra
-- a definição live de cada função (conferido com pg_get_functiondef
-- antes de escrever este arquivo).
--
-- Superfície pública NÃO muda: mesmos nomes, mesmos parâmetros, mesmo
-- retorno, mesmas mensagens de erro e SQLSTATEs, mesmos GRANTs. Só a
-- implementação interna passa a ser compartilhada.
--
-- O helper não tem GRANT nenhum — nem para service_role. Só é
-- chamável de dentro de outra função SECURITY DEFINER de propriedade
-- de `postgres` (que tem privilégio implícito como dono); nenhuma
-- rota do app chama `_account_member_detach_core` diretamente.
-- ============================================================

CREATE OR REPLACE FUNCTION public._account_member_detach_core(
  p_user_id UUID,
  p_owner_error_message TEXT
) RETURNS UUID -- id da nova conta pessoal
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_target_account_id UUID;
  v_target_role       account_role_enum;
  v_target_name       TEXT;
  v_target_email      TEXT;
  v_new_account_id    UUID;
  v_default_plan_code TEXT;
  v_plan_id           UUID;
BEGIN
  SELECT account_id, account_role, full_name, email
    INTO v_target_account_id, v_target_role, v_target_name, v_target_email
    FROM profiles
   WHERE user_id = p_user_id;

  IF v_target_account_id IS NULL THEN
    RAISE EXCEPTION 'Target user not found' USING ERRCODE = '22023';
  END IF;

  IF v_target_role = 'owner' THEN
    RAISE EXCEPTION USING MESSAGE = p_owner_error_message, ERRCODE = '22023';
  END IF;

  -- Devolve à fila tudo o que estava atribuído ao removido (039).
  UPDATE conversations
     SET assigned_agent_id = NULL,
         updated_at = NOW()
   WHERE account_id = v_target_account_id
     AND assigned_agent_id = p_user_id;

  -- Cria uma conta pessoal nova para o removido — espelho de
  -- `handle_new_user()`.
  INSERT INTO accounts (name, owner_user_id)
  VALUES (
    COALESCE(NULLIF(v_target_name, ''), v_target_email, 'My account'),
    p_user_id
  )
  RETURNING id INTO v_new_account_id;

  UPDATE profiles
     SET account_id   = v_new_account_id,
         account_role = 'owner'
   WHERE user_id = p_user_id;

  -- Plano padrão à conta nova (074) — falha aqui não pode impedir o
  -- desligamento do membro.
  BEGIN
    SELECT default_plan_code INTO v_default_plan_code FROM public.platform_settings;
    SELECT id INTO v_plan_id FROM public.plans WHERE code = v_default_plan_code;
    IF v_plan_id IS NOT NULL THEN
      INSERT INTO public.account_plans (account_id, plan_id, status)
      VALUES (v_new_account_id, v_plan_id, 'active')
      ON CONFLICT (account_id) DO NOTHING;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'Failed to assign default plan to account % (removed member %): %',
      v_new_account_id, p_user_id, SQLERRM;
  END;

  RETURN v_new_account_id;
END;
$$;

ALTER FUNCTION public._account_member_detach_core(UUID, TEXT) OWNER TO postgres;
-- Este projeto tem GRANT default automático de EXECUTE para
-- anon/authenticated/service_role em função nova (foi exatamente isso
-- que vazou `platform_remove_account_member` na 079, corrigido na
-- 080) — os quatro REVOKE abaixo fecham os três de propósito. Nenhum
-- GRANT depois: só as duas RPCs abaixo (de propriedade de postgres)
-- chamam este helper, com privilégio implícito de dono.
REVOKE ALL ON FUNCTION public._account_member_detach_core(UUID, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public._account_member_detach_core(UUID, TEXT) FROM anon;
REVOKE ALL ON FUNCTION public._account_member_detach_core(UUID, TEXT) FROM authenticated;
REVOKE ALL ON FUNCTION public._account_member_detach_core(UUID, TEXT) FROM service_role;

-- ============================================================
-- `remove_account_member` — casca de autorização (§018/074) + delegação.
-- Texto de erro do "é o dono" preservado byte a byte da versão live.
-- ============================================================

CREATE OR REPLACE FUNCTION public.remove_account_member(
  p_user_id UUID
) RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_account_id UUID;
  v_caller_role       account_role_enum;
  v_target_account_id UUID;
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
    RAISE EXCEPTION 'Cannot remove yourself; transfer ownership or leave the account instead'
      USING ERRCODE = '22023';
  END IF;

  SELECT account_id INTO v_target_account_id FROM profiles WHERE user_id = p_user_id;

  IF v_target_account_id IS NULL THEN
    RAISE EXCEPTION 'Target user not found' USING ERRCODE = '22023';
  END IF;

  IF v_target_account_id <> v_caller_account_id THEN
    RAISE EXCEPTION 'Target user is not a member of your account'
      USING ERRCODE = '42501';
  END IF;

  RETURN public._account_member_detach_core(
    p_user_id,
    'Cannot remove the account owner; transfer ownership first'
  );
END;
$$;

ALTER FUNCTION public.remove_account_member(UUID) OWNER TO postgres;

-- ============================================================
-- `platform_remove_account_member` — casca de autorização é o GRANT
-- (só service_role) + `requirePlatformOwner()` no app; sem checagem de
-- chamador em SQL (§079). Texto de erro do "é o dono" preservado byte
-- a byte da versão live.
-- ============================================================

CREATE OR REPLACE FUNCTION public.platform_remove_account_member(
  p_user_id UUID
) RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN public._account_member_detach_core(
    p_user_id,
    'Cannot remove the account owner; delete the account instead'
  );
END;
$$;

ALTER FUNCTION public.platform_remove_account_member(UUID) OWNER TO postgres;

-- ============================================================
-- Asserção final — falha alto de propósito (padrão 041/052/059/061/
-- 062/067/074/079/080). Confere que a superfície pública NÃO mudou
-- (nomes, GRANTs) e que o helper novo está fechado.
-- ============================================================
DO $$
BEGIN
  IF to_regprocedure('public._account_member_detach_core(uuid, text)') IS NULL THEN
    RAISE EXCEPTION '081: _account_member_detach_core() não foi criada.';
  END IF;

  IF has_function_privilege('anon', '_account_member_detach_core(uuid, text)', 'EXECUTE')
     OR has_function_privilege('authenticated', '_account_member_detach_core(uuid, text)', 'EXECUTE')
     OR has_function_privilege('service_role', '_account_member_detach_core(uuid, text)', 'EXECUTE')
  THEN
    RAISE EXCEPTION '081: _account_member_detach_core() não pode ser executável por anon/authenticated/service_role — só chamável internamente por postgres.';
  END IF;

  IF NOT has_function_privilege('authenticated', 'public.remove_account_member(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION '081: remove_account_member() perdeu o GRANT para authenticated — a aba Equipe quebraria.';
  END IF;

  IF NOT has_function_privilege('service_role', 'public.platform_remove_account_member(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION '081: platform_remove_account_member() perdeu o GRANT para service_role — a exclusão administrativa quebraria.';
  END IF;

  IF has_function_privilege('anon', 'public.platform_remove_account_member(uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.platform_remove_account_member(uuid)', 'EXECUTE')
  THEN
    RAISE EXCEPTION '081: platform_remove_account_member() ficou executável por anon/authenticated depois do CREATE OR REPLACE.';
  END IF;

  RAISE NOTICE '081: núcleo comum extraído para _account_member_detach_core(); as duas RPCs públicas preservam superfície e GRANTs.';
END $$;
