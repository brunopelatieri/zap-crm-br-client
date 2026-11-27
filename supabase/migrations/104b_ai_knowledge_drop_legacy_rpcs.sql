-- ============================================================
-- 104b_ai_knowledge_drop_legacy_rpcs.sql — SPEC 089 F3 (limpeza)
--
-- Apaga as duas RPCs de recuperação anteriores à F3,
-- `match_ai_knowledge_fts` e `match_ai_knowledge_semantic` (030, 032, 103,
-- 104). A `match_ai_knowledge_hybrid` (104) as substitui, e o código deixou
-- de chamá-las (a reserva `retrieveLegacy` foi removida).
--
-- ⚠️ ORDEM DE APLICAÇÃO: só aplique DEPOIS de o código da F3 estar em
-- produção. O código da F2 (o que roda hoje em `zap.local.ia.br`) ainda chama
-- essas duas funções; apagá-las antes faz a recuperação da base falhar em
-- silêncio (melhor esforço: o agente passa a responder sem a base).
--
-- ⚠️ Reaplicar a 103 ou a 104 depois desta recria as duas funções (como INVOKER,
-- inofensivas, mas sem uso): apague-as de novo com esta migração.
--
-- Escrita LOCAL; aplicar no `vn` só pelo mantenedor. Idempotente.
-- ============================================================

DROP FUNCTION IF EXISTS public.match_ai_knowledge_fts(uuid, text, integer);
DROP FUNCTION IF EXISTS public.match_ai_knowledge_semantic(uuid, text, integer);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
              WHERE n.nspname = 'public'
                AND p.proname IN ('match_ai_knowledge_fts', 'match_ai_knowledge_semantic')) THEN
    RAISE EXCEPTION '104b: RPC antiga ainda existe (outra sobrecarga?).' USING ERRCODE = '55006';
  END IF;
  IF to_regprocedure('public.match_ai_knowledge_hybrid(uuid,text,text,text,integer,real)') IS NULL THEN
    RAISE EXCEPTION '104b: match_ai_knowledge_hybrid ausente — rode a 104 primeiro.' USING ERRCODE = '55006';
  END IF;
END;
$$;
