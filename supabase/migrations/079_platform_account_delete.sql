-- ============================================================
-- 079_platform_account_delete.sql
--
-- Extensão da SPEC 073: exclusão de conta pelo CONSOLE do proprietário
-- da plataforma (/admin/accounts), complementando a exclusão
-- self-service já existente (nenhuma migração precisou disso — a
-- prova de cascade da F1 fechou o D-8 "sem migração").
--
-- Por que uma RPC nova em vez de reusar `remove_account_member()`
-- (018/074): essa RPC checa, em SQL, que quem chama (`auth.uid()`) é
-- admin+ DA MESMA CONTA do alvo — desenho correto para a Aba
-- "Equipe" (mutação feita pela SESSÃO de um colega do próprio time),
-- mas incompatível com uma chamada administrativa entre contas:
--   - via `supabaseAdmin()` (service_role), `auth.uid()` é NULL —
--     cai direto no primeiro `IF auth.uid() IS NULL THEN RAISE`.
--   - mesmo com uma sessão real, o proprietário da plataforma quase
--     nunca é membro da conta-alvo (é identidade de .env, não de
--     linha em `profiles` — ver `src/lib/platform/owner.ts`).
--
-- Esta variante remove a checagem "quem chama pertence à mesma
-- conta" e move a autorização inteira para fora do SQL: só
-- `service_role` pode executá-la (REVOKE de `authenticated`/`anon`),
-- ou seja, só uma rota server-side já barrada por
-- `requirePlatformOwner()` consegue chamar. O resto do corpo é IDÊNTICO
-- a `remove_account_member()` — mesmo efeito (conta pessoal nova +
-- plano padrão), só a guarda de entrada muda.
-- ============================================================

CREATE OR REPLACE FUNCTION public.platform_remove_account_member(
  p_user_id UUID
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
    RAISE EXCEPTION 'Cannot remove the account owner; delete the account instead'
      USING ERRCODE = '22023';
  END IF;

  -- Devolve à fila tudo o que estava atribuído ao removido (039).
  UPDATE conversations
     SET assigned_agent_id = NULL,
         updated_at = NOW()
   WHERE account_id = v_target_account_id
     AND assigned_agent_id = p_user_id;

  -- Cria uma conta pessoal nova para o removido — espelho de
  -- `remove_account_member()`/`handle_new_user()`.
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

ALTER FUNCTION public.platform_remove_account_member(UUID) OWNER TO postgres;
-- PUBLIC primeiro: `anon` e `authenticated` herdam dele, mas cada um
-- pode ter um GRANT direto próprio também (é o caso deste projeto —
-- achado de code review na 080: revogar só de PUBLIC/authenticated
-- deixou `anon` com EXECUTE, herdado de um default privilege) — por
-- isso os três REVOKE explícitos, mesmo padrão da 042.
REVOKE ALL ON FUNCTION public.platform_remove_account_member(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.platform_remove_account_member(UUID) FROM anon;
REVOKE ALL ON FUNCTION public.platform_remove_account_member(UUID) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.platform_remove_account_member(UUID) TO service_role;

-- ============================================================
-- Asserção final — falha alto de propósito (padrão 041/052/059/061/062/067/074)
-- ============================================================
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc
    WHERE proname = 'platform_remove_account_member'
      AND pronamespace = 'public'::regnamespace
  ) THEN
    RAISE EXCEPTION '079: platform_remove_account_member() não foi criada.';
  END IF;

  IF has_function_privilege('anon', 'public.platform_remove_account_member(uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.platform_remove_account_member(uuid)', 'EXECUTE')
  THEN
    RAISE EXCEPTION '079: platform_remove_account_member() não pode ser executável por anon/authenticated — só service_role.';
  END IF;

  RAISE NOTICE '079: platform_remove_account_member() criada, restrita a service_role.';
END $$;
