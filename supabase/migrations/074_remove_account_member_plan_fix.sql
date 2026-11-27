-- ============================================================
-- 074_remove_account_member_plan_fix.sql
--
-- Corrige `remove_account_member()` (039_conversation_assignment.sql:801):
-- o RPC cria uma conta pessoal nova para quem é removido de uma conta
-- compartilhada (comportamento correto — espelha handle_new_user), mas a
-- 067 (SPEC 059, motor de quotas) exigiu que TODA conta tenha uma linha
-- em account_plans e só atualizou handle_new_user() para atender isso.
-- remove_account_member() ficou para trás — não é silent failure, é
-- código que simplesmente nunca ganhou o INSERT.
--
-- Efeito em produção (vn, 2026-08-31): um membro removido da conta
-- compartilhada ficou com conta pessoal sem account_plans — invisível
-- em getAccountPlan() (500 "has no account_plans row") e fora de
-- qualquer filtro do /admin/accounts que dependa do join com
-- account_plans. Conta e usuário já foram apagados manualmente
-- (incidente investigado e resolvido fora desta migração); esta
-- migração fecha a lacuna para o próximo membro removido.
--
-- Sem trigger nova: a razão da 067 não ter posto isso em trigger (BEFORE
-- INSERT ON accounts) continua válida aqui — o INSERT em account_plans
-- depende de platform_settings.default_plan_code, que é decisão de
-- aplicação, não invariante de schema. Mantém o padrão dos outros dois
-- pontos de criação de conta (handle_new_user, aqui) resolvendo isso
-- em código, não em trigger.
-- ============================================================

CREATE OR REPLACE FUNCTION public.remove_account_member(
  p_user_id UUID
) RETURNS UUID  -- id da nova conta pessoal
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_account_id UUID;
  v_caller_role       account_role_enum;
  v_target_account_id UUID;
  v_target_role       account_role_enum;
  v_target_name       TEXT;
  v_target_email      TEXT;
  v_new_account_id    UUID;
  v_default_plan_code TEXT;
  v_plan_id           UUID;
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

  SELECT account_id, account_role, full_name, email
    INTO v_target_account_id, v_target_role, v_target_name, v_target_email
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
    RAISE EXCEPTION 'Cannot remove the account owner; transfer ownership first'
      USING ERRCODE = '22023';
  END IF;

  -- Devolve à fila tudo o que estava atribuído ao removido (039).
  UPDATE conversations
     SET assigned_agent_id = NULL,
         updated_at = NOW()
   WHERE account_id = v_target_account_id
     AND assigned_agent_id = p_user_id;

  -- Cria uma conta pessoal nova para o removido. Espelho do
  -- handle_new_user — ele continua inteiro, só realocado.
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

  -- NOVO na 074: atribui o plano padrão à conta nova, igual
  -- handle_new_user() já faz desde a 067. Falha ao atribuir plano não
  -- pode impedir a remoção do membro — mesma postura defensiva da 067
  -- (EXCEPTION WHEN OTHERS só nesta etapa, não na função inteira).
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

ALTER FUNCTION public.remove_account_member(UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.remove_account_member(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.remove_account_member(UUID) TO authenticated;

-- ============================================================
-- Backfill defensivo: repara qualquer conta órfã (sem account_plans)
-- que já exista hoje, criada por este mesmo bug antes da correção
-- acima. Mesma lógica de "10. Plano padrão e atribuição" da 067.
-- ============================================================
INSERT INTO account_plans (account_id, plan_id, status)
SELECT a.id, (SELECT id FROM plans WHERE code = (SELECT default_plan_code FROM platform_settings)), 'active'
FROM accounts a
WHERE NOT EXISTS (SELECT 1 FROM account_plans ap WHERE ap.account_id = a.id)
  AND EXISTS (SELECT 1 FROM plans WHERE code = (SELECT default_plan_code FROM platform_settings));

-- ============================================================
-- Asserção final — falha alto de propósito (padrão 041/052/059/061/062/067)
-- ============================================================
DO $$
DECLARE
  v_orphans INTEGER;
BEGIN
  SELECT count(*) INTO v_orphans
  FROM accounts a
  WHERE NOT EXISTS (SELECT 1 FROM account_plans ap WHERE ap.account_id = a.id);
  IF v_orphans > 0 THEN
    RAISE EXCEPTION '074: % conta(s) sem account_plans apos backfill (verificar default_plan_code em platform_settings).', v_orphans;
  END IF;

  RAISE NOTICE '074: remove_account_member() corrigido — novas contas de membro removido ganham account_plans. Backfill aplicado a contas orfas pre-existentes.';
END $$;
