-- ============================================================
-- 083_message_deletion.sql — SPEC 074: apagar a mensagem enviada
--
-- Três peças, na ordem do §3 da SPEC:
--
--   1. Seis colunas em `messages` — o INTERRUPTOR (`deleted_at`) e o
--      CONTEXTO (`deletion_scope`/`deletion_actor`/`deletion_error`/
--      `resent_from_message_id`). Nenhum índice novo: nenhuma consulta
--      filtra por `deleted_at` (§3.1).
--   2. `message_deletion_log` — registro append-only que SOBREVIVE à
--      exclusão de uma mensagem (D-14). Sem FK em `message_id` de
--      propósito: `ON DELETE CASCADE` mataria o log junto com a
--      exclusão que ele existe para registrar; `ON DELETE SET NULL`
--      quebraria o costurar entre as linhas `mark`/`purge` da mesma
--      mensagem (§3.2).
--   3. Aperto de `messages_delete` (039) — hoje qualquer agent+ pode
--      apagar a linha direto do navegador; a partir desta migração só
--      admin+, o mesmo papel que o diálogo do produto exige (§3.3).
--
-- Idempotente e com bloco de asserções finais, no padrão da 068/080/082.
-- ============================================================

-- ============================================================
-- 1. messages — o interruptor e o contexto (§3.1)
-- ============================================================
ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS deleted_at      TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS deleted_by      UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS deletion_scope  TEXT CHECK (deletion_scope IN ('revoked','not_supported','revoke_failed')),
  ADD COLUMN IF NOT EXISTS deletion_actor  TEXT CHECK (deletion_actor IN ('agent','contact')),
  ADD COLUMN IF NOT EXISTS deletion_error  TEXT,
  ADD COLUMN IF NOT EXISTS resent_from_message_id UUID REFERENCES messages(id) ON DELETE SET NULL;

-- ============================================================
-- 2. message_deletion_log — o registro que sobrevive à exclusão (§3.2)
-- ============================================================
CREATE TABLE IF NOT EXISTS message_deletion_log (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id          UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,

  -- SEM FK — ver o cabeçalho acima. A mensagem/conversa/canal apontados
  -- podem deixar de existir; o apontamento vale mais que a integridade
  -- referencial, mesmo raciocínio da 078 para `channel_type`.
  conversation_id     UUID,
  message_id          UUID,
  provider_message_id TEXT,
  channel_id          UUID,
  channel_type        TEXT,

  action              TEXT NOT NULL CHECK (action IN ('mark','purge','revoke_retry')),
  provider_outcome    TEXT NOT NULL CHECK (provider_outcome IN ('revoked','not_supported','revoke_failed','not_attempted')),
  provider_error      TEXT,

  actor               TEXT NOT NULL CHECK (actor IN ('agent','contact')),
  actor_user_id       UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  actor_role          TEXT,

  content_type        TEXT,
  content_preview     TEXT,   -- 120 caracteres, truncado (D-15)
  had_media           BOOLEAN NOT NULL DEFAULT FALSE,
  media_path          TEXT,
  media_removed       BOOLEAN,

  message_created_at  TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_msg_deletion_log_account
  ON message_deletion_log (account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_msg_deletion_log_message
  ON message_deletion_log (message_id);

-- Append-only: SELECT para admin+ da própria conta; NENHUMA policy de
-- INSERT/UPDATE/DELETE — quem grava é a rota, com service_role. Log que
-- o auditado pode editar não é log.
ALTER TABLE message_deletion_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS message_deletion_log_select ON message_deletion_log;
CREATE POLICY message_deletion_log_select ON message_deletion_log FOR SELECT
  USING (is_account_member(account_id, 'admin'));

-- ============================================================
-- 3. Aperto de messages_delete (039) — o buraco que a exclusão abre (§3.3)
--
-- Verificado antes de escrever: nenhum código do app faz
-- `.from('messages').delete()` — a única remoção em massa é
-- `purge_channel_messages` (068), que roda por service_role e não passa
-- por RLS, e a exclusão de conta (073), que desce por CASCADE. O aperto
-- não quebra caminho existente.
-- ============================================================
DROP POLICY IF EXISTS messages_delete ON messages;
CREATE POLICY messages_delete ON messages FOR DELETE
  USING (is_account_member(
    (SELECT c.account_id FROM conversations c WHERE c.id = messages.conversation_id),
    'admin'
  ));

-- ============================================================
-- 4. Asserções finais — falham alto de propósito (padrão da casa)
-- ============================================================
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'messages' AND column_name = 'deleted_at'
  ) THEN
    RAISE EXCEPTION '083: messages.deleted_at nao foi criada.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables WHERE table_name = 'message_deletion_log'
  ) THEN
    RAISE EXCEPTION '083: message_deletion_log nao foi criada.';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'message_deletion_log' AND cmd <> 'SELECT'
  ) THEN
    RAISE EXCEPTION '083: policy de escrita pelo cliente encontrada em message_deletion_log — o log deixaria de ser append-only.';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'message_deletion_log'
      AND cmd = 'SELECT'
      AND qual NOT LIKE '%admin%'
  ) THEN
    RAISE EXCEPTION '083: policy de leitura de message_deletion_log sem restricao a admin encontrada.';
  END IF;

  -- messages_delete precisa ter deixado de valer para agent — a
  -- checagem heurística confere que a nova qual referencia 'admin'.
  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'messages' AND policyname = 'messages_delete'
      AND qual NOT LIKE '%admin%'
  ) THEN
    RAISE EXCEPTION '083: messages_delete nao foi apertada para admin+.';
  END IF;

  RAISE NOTICE '083: colunas de apagamento, message_deletion_log e aperto de messages_delete aplicados.';
END $$;
