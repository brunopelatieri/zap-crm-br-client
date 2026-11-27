-- ============================================================
-- 085_activity_log_retention.sql — SPEC 075 F8: retenção de
-- `account_activity_log`.
--
-- Duas peças:
--
--   1. `idx_activity_created_only` — a varredura apaga por
--      `created_at < corte`, SEM filtro de conta (a retenção de
--      atividade é uma regra global do .env, D-6 — "regra própria",
--      não por conta×canal como a SPEC 060). Os cinco índices da 084
--      são todos `(account_id, ...)` — nenhum serve um range scan
--      global em `created_at`. Sem este índice, cada ciclo da
--      varredura é um sequential scan da tabela inteira.
--
--   2. `purge_account_activity_log(p_older_than_days)` — o mesmo
--      molde de `purge_webhook_ingest_logs` (065, SPEC 055 D-13):
--      um DELETE simples com `GET DIAGNOSTICS` para devolver a
--      contagem, SECURITY DEFINER, só para service_role. A decisão de
--      SE rodar (o .env, ACTIVITY_LOG_RETENTION_DAYS, "nasce
--      desligada") mora em TypeScript — `src/lib/activity/retention.ts`
--      — nunca aqui; esta função é o primitivo burro que só apaga o
--      que mandarem.
-- ============================================================

CREATE INDEX IF NOT EXISTS idx_activity_created_only
  ON account_activity_log (created_at);

CREATE OR REPLACE FUNCTION public.purge_account_activity_log(
  p_older_than_days integer
) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_deleted integer;
BEGIN
  DELETE FROM account_activity_log
  WHERE created_at < now() - (p_older_than_days || ' days')::interval;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$$;

ALTER FUNCTION public.purge_account_activity_log(integer) OWNER TO postgres;

-- Mesmo aperto da 067b/084b: SECURITY DEFINER em schema public é RPC
-- exposta por padrão. Sem este revoke, authenticated apagaria o
-- próprio registro de auditoria — o log deixaria de ser append-only.
REVOKE ALL ON FUNCTION public.purge_account_activity_log(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.purge_account_activity_log(integer) FROM anon;
REVOKE ALL ON FUNCTION public.purge_account_activity_log(integer) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.purge_account_activity_log(integer) TO service_role;

COMMENT ON FUNCTION public.purge_account_activity_log IS
  'SPEC 075 F8/D-6. Sem padrão de dias aqui de propósito — quem decide o prazo (e SE roda) é ACTIVITY_LOG_RETENTION_DAYS no .env, lido por src/lib/activity/retention.ts. Não agendada por esta migração: chamada pela varredura que já existe (src/lib/retention/sweep.ts), sem cron novo.';

-- ============================================================
-- Asserções finais
-- ============================================================
DO $assert$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
     WHERE tablename = 'account_activity_log' AND indexname = 'idx_activity_created_only'
  ) THEN
    RAISE EXCEPTION '085: idx_activity_created_only nao foi criado.';
  END IF;

  IF has_function_privilege('authenticated', 'purge_account_activity_log(integer)', 'EXECUTE')
     OR has_function_privilege('anon', 'purge_account_activity_log(integer)', 'EXECUTE') THEN
    RAISE EXCEPTION '085: purge_account_activity_log executavel fora de service_role.';
  END IF;

  RAISE NOTICE '085: indice de retencao e purge_account_activity_log aplicados.';
END $assert$;
