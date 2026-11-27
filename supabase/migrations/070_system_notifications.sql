-- ============================================================
-- 070_system_notifications.sql — SPEC 063: outbox de notificações do
-- sistema (e-mail SMTP + webhook)
--
-- Princípio (SPEC 063 §1): o aviso nunca pode derrubar a ação que o
-- originou. Três regras derivam daí:
--
--   1. Gravar primeiro, entregar depois — a ação grava aqui, dentro da
--      mesma transação lógica; a entrega acontece fora do caminho da
--      resposta (src/lib/notifications/dispatch.ts).
--   2. Toda entrega é idempotente por `dedupe_key` (UNIQUE parcial).
--   3. Canal ausente é no-op silencioso — SMTP/webhook não configurados
--      não travam nada; o status vira 'skipped', não 'failed'.
--
-- Idempotente (IF NOT EXISTS) e com bloco de asserções finais que falha
-- alto, no padrão das 041/052/061/067/068/069.
-- ============================================================

-- ============================================================
-- 1. system_notifications — a outbox (§2.1)
-- ============================================================
CREATE TABLE IF NOT EXISTS system_notifications (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type         TEXT NOT NULL,
  account_id   UUID REFERENCES accounts(id) ON DELETE SET NULL,
  payload      JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- Idempotência. NULL = sempre entrega (evento pontual); preenchido =
  -- no máximo uma vez com aquela chave.
  dedupe_key   TEXT,

  email_status TEXT NOT NULL DEFAULT 'pending'
               CHECK (email_status IN ('pending','sent','failed','skipped')),
  hook_status  TEXT NOT NULL DEFAULT 'pending'
               CHECK (hook_status  IN ('pending','sent','failed','skipped')),
  attempts     INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error   TEXT,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  delivered_at TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Parcial: senão duas linhas de dedupe_key IS NULL colidiriam — um
-- evento pontual (troca manual de plano, bloqueio) não tem chave e
-- precisa poder se repetir livremente.
CREATE UNIQUE INDEX IF NOT EXISTS idx_system_notifications_dedupe
  ON system_notifications (dedupe_key) WHERE dedupe_key IS NOT NULL;

-- A varredura de reentrega só olha o que ainda tem trabalho.
CREATE INDEX IF NOT EXISTS idx_system_notifications_pending
  ON system_notifications (next_attempt_at)
  WHERE email_status = 'pending' OR hook_status = 'pending';

CREATE INDEX IF NOT EXISTS idx_system_notifications_created
  ON system_notifications (created_at DESC);

-- RLS ligada, zero policies — só service_role, mesma decisão de
-- platform_audit_log (SPEC 062 §3.5). O console lê por rota de servidor.
ALTER TABLE system_notifications ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- 2. purge_system_notifications — retenção da própria outbox (§2.2)
--
-- Só apaga linhas JÁ RESOLVIDAS (nenhum canal em 'pending') e mais
-- velhas que p_keep_days. Uma pendente de 6 meses é sintoma para
-- investigar, não lixo para varrer.
-- ============================================================
CREATE OR REPLACE FUNCTION purge_system_notifications(p_keep_days INTEGER DEFAULT 90)
RETURNS INTEGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_deleted INTEGER;
BEGIN
  DELETE FROM system_notifications
   WHERE email_status <> 'pending'
     AND hook_status <> 'pending'
     AND created_at < NOW() - (GREATEST(p_keep_days, 1) || ' days')::INTERVAL;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$$;

ALTER FUNCTION purge_system_notifications(INTEGER) OWNER TO postgres;

-- Mesmo cuidado de purge_channel_messages (068): nenhum cliente pode
-- disparar a própria purga da outbox.
REVOKE ALL ON FUNCTION purge_system_notifications(INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION purge_system_notifications(INTEGER) TO service_role;

-- ============================================================
-- 3. Asserções finais (§2.3)
-- ============================================================
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_tables
     WHERE tablename = 'system_notifications' AND rowsecurity = TRUE
  ) THEN
    RAISE EXCEPTION '070: system_notifications sem RLS ligada.';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'system_notifications'
  ) THEN
    RAISE EXCEPTION '070: system_notifications tem policy — deveria ter zero (só service_role).';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
     WHERE tablename = 'system_notifications'
       AND indexname = 'idx_system_notifications_dedupe'
       AND indexdef LIKE '%WHERE (dedupe_key IS NOT NULL)%'
  ) THEN
    RAISE EXCEPTION '070: idx_system_notifications_dedupe nao e parcial (WHERE dedupe_key IS NOT NULL).';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM information_schema.routine_privileges
     WHERE routine_name = 'purge_system_notifications'
       AND grantee IN ('anon', 'authenticated', 'PUBLIC')
  ) THEN
    RAISE EXCEPTION '070: purge_system_notifications ainda concede EXECUTE a anon/authenticated/PUBLIC.';
  END IF;
END $$;
