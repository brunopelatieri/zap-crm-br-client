-- ============================================================
-- 082_remove_account_member_anon_leak.sql
--
-- Item separado, fora do escopo da revisão de código do console do
-- proprietário: `remove_account_member()` (018/074) — RPC pré-existente,
-- usada pela aba "Equipe" desde a SPEC 017 — também tem `anon` com
-- EXECUTE, mesma classe de vazamento que a 080 fechou em
-- `platform_remove_account_member()`. Confirmado ao vivo em vn e rs
-- (information_schema.routine_privileges) antes de escrever esta
-- migração.
--
-- Por que é inofensivo hoje, e por que fechar mesmo assim
--
--   O corpo da função checa `auth.uid() IS NULL` como primeira linha —
--   um `anon` (sem JWT) sempre bate em "Unauthorized" (42501) antes de
--   tocar em qualquer dado. Não é o mesmo nível de risco de
--   `platform_remove_account_member` (que não tinha NENHUMA checagem
--   de identidade — por isso essa foi corrigida na hora, na 080).
--
--   Mesmo inofensivo, é exatamente o padrão que a 042 existe para
--   prevenir ("toda função em public com EXECUTE para anon é chamável
--   por qualquer pessoa com a anon key pública") — depender de uma
--   checagem interna correta para sempre ser a única linha de defesa é
--   frágil; o ACL é a defesa que não depende de ninguém lembrar de
--   colocar o `IF auth.uid() IS NULL` certo da próxima vez que a
--   função for editada.
-- ============================================================

REVOKE ALL ON FUNCTION public.remove_account_member(uuid) FROM anon;

-- ============================================================
-- Asserção final — mesmo padrão da 042/080.
-- ============================================================
DO $$
BEGIN
  IF has_function_privilege('anon', 'public.remove_account_member(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION '082: remove_account_member() continua executavel por anon apos o REVOKE.'
      USING ERRCODE = '55006';
  END IF;

  IF NOT has_function_privilege('authenticated', 'public.remove_account_member(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION '082: remove_account_member() perdeu o GRANT para authenticated — a aba Equipe quebraria.';
  END IF;

  RAISE NOTICE '082: remove_account_member() fechada para anon — authenticated preservado.';
END $$;
