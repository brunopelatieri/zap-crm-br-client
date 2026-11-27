-- ============================================================
-- 084b_tighten_activity_function_grants.sql — SPEC 075 F1, aperto
--
-- O advisor de segurança do Supabase, rodado logo depois da 084,
-- apontou duas coisas nas funções que ela criou. Nenhuma delas é
-- explorável hoje, e é exatamente por isso que viram migração agora,
-- antes de virarem hábito — mesmo movimento da 067b sobre a 067.
--
--   1. `mask_phone_for_log` ficou com search_path mutável
--      (lint 0011). Ela é IMMUTABLE e não toca em tabela nenhuma, então
--      o risco prático é nulo; mas as outras funções da casa fixam o
--      search_path e não há motivo para esta ser a exceção.
--
--   2. `trg_log_contact_activity` e `trg_log_deal_activity` são
--      SECURITY DEFINER no schema `public`, o que as expõe como RPC do
--      PostgREST a anon e authenticated (lints 0028/0029). Chamá-las
--      por ali falha sozinho — uma função de gatilho exige TG_OP e um
--      registro OLD/NEW que a chamada REST não tem — mas "falha
--      sozinho" é um argumento sobre a implementação de hoje, não uma
--      tranca. Estas duas escrevem no log de auditoria: a tranca vale
--      mais que o argumento.
--
-- Revogar EXECUTE não afeta o disparo como trigger: uma trigger executa
-- com os privilégios do dono da tabela, não pelo grant da função.
--
-- Vale registrar o que este aperto NÃO faz: as funções de gatilho
-- antigas (`enforce_contact_quota`, `normalize_contact_created_via`,
-- `handle_new_user` e companhia) continuam expostas do mesmo jeito.
-- Elas são anteriores e não são desta SPEC; varrê-las é trabalho
-- próprio, com teste próprio, e entra numa migração que só faça isso.
-- ============================================================

ALTER FUNCTION mask_phone_for_log(TEXT) SET search_path = public;

REVOKE ALL ON FUNCTION trg_log_contact_activity() FROM PUBLIC;
REVOKE ALL ON FUNCTION trg_log_contact_activity() FROM anon;
REVOKE ALL ON FUNCTION trg_log_contact_activity() FROM authenticated;

REVOKE ALL ON FUNCTION trg_log_deal_activity() FROM PUBLIC;
REVOKE ALL ON FUNCTION trg_log_deal_activity() FROM anon;
REVOKE ALL ON FUNCTION trg_log_deal_activity() FROM authenticated;

-- ============================================================
-- Asserções finais
-- ============================================================
DO $assert$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.proname = 'mask_phone_for_log'
       AND p.proconfig @> ARRAY['search_path=public']
  ) THEN
    RAISE EXCEPTION '084b: mask_phone_for_log continua com search_path mutavel.';
  END IF;

  IF has_function_privilege('authenticated', 'trg_log_contact_activity()', 'EXECUTE')
     OR has_function_privilege('anon', 'trg_log_contact_activity()', 'EXECUTE') THEN
    RAISE EXCEPTION '084b: trg_log_contact_activity continua executavel via RPC.';
  END IF;

  IF has_function_privilege('authenticated', 'trg_log_deal_activity()', 'EXECUTE')
     OR has_function_privilege('anon', 'trg_log_deal_activity()', 'EXECUTE') THEN
    RAISE EXCEPTION '084b: trg_log_deal_activity continua executavel via RPC.';
  END IF;

  RAISE NOTICE '084b: search_path fixado e RPC das funcoes de gatilho revogada.';
END $assert$;
