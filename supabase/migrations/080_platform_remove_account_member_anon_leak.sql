-- ============================================================
-- 080_platform_remove_account_member_anon_leak.sql
--
-- Corrige um achado de code review na 079: `platform_remove_account_member()`
-- foi criada com `REVOKE ALL ... FROM PUBLIC` e `FROM authenticated`, mas
-- SEM `FROM anon` — a mesma armadilha que a 042 documenta explicitamente
-- ("revogar só de PUBLIC e authenticated deixaria o buraco aberto para
-- anon, que herda um GRANT default deste projeto na criação da função").
--
-- Confirmado contra o banco real (vn e rs) logo após aplicar a 079:
--   information_schema.routine_privileges mostrava anon com EXECUTE.
--
-- Impacto se explorado: a função é SECURITY DEFINER, sem NENHUMA
-- checagem de `auth.uid()` no corpo (a autorização foi movida de
-- propósito para fora do SQL — só `requirePlatformOwner()` no app +
-- GRANT restrito no banco). Um `anon` com EXECUTE conseguiria chamar
-- `platform_remove_account_member(p_user_id)` direto via PostgREST
-- (`/rest/v1/rpc/platform_remove_account_member`) com a anon key
-- pública, para QUALQUER `p_user_id` — desligaria qualquer membro
-- não-dono de qualquer conta, sem autenticação nenhuma.
-- ============================================================

REVOKE ALL ON FUNCTION public.platform_remove_account_member(uuid) FROM anon;

-- ============================================================
-- Asserção final — mesmo padrão da 042: falha alto se anon OU
-- authenticated ainda tiverem EXECUTE.
-- ============================================================
DO $$
BEGIN
  IF has_function_privilege('anon', 'public.platform_remove_account_member(uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.platform_remove_account_member(uuid)', 'EXECUTE')
  THEN
    RAISE EXCEPTION '080: platform_remove_account_member() continua executavel por anon/authenticated apos o REVOKE.'
      USING ERRCODE = '55006';
  END IF;

  RAISE NOTICE '080: platform_remove_account_member() fechada para anon/authenticated — só service_role.';
END $$;
