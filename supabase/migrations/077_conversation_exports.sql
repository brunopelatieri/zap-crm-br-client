-- ============================================================
-- 077_conversation_exports — trilha de auditoria da exportação de
-- conversa (SPEC 067 §9.1)
--
-- Por que esta tabela existe
--
--   Exportar uma conversa tira do produto o histórico inteiro de um
--   titular — texto, anexos, telefone — num arquivo que sai do nosso
--   controle no instante do download. A LGPD (art. 18, II e V) pede
--   que exista resposta para "quem levou os dados deste titular,
--   quando, e quanto". A rota POST /api/inbox/conversations/[id]/export
--   grava uma linha aqui a cada exportação concluída.
--
-- `id` NÃO tem DEFAULT gen_random_uuid()
--
--   Quem gera o UUID é a rota, porque o valor precisa estar impresso no
--   RODAPÉ DO PDF antes deste INSERT acontecer — é o que permite pegar
--   um documento em papel e encontrar a linha que o originou. Um
--   default aqui esconderia essa dependência e deixaria alguém
--   "simplificar" a rota removendo o crypto.randomUUID().
--
-- `conversation_id` / `contact_id` são ON DELETE SET NULL
--
--   Apagar a conversa (retenção da SPEC 060, ou pedido de exclusão do
--   titular) não pode apagar o registro de que ela foi exportada: a
--   pergunta "quem levou esses dados embora" precisa sobreviver ao
--   dado. Só CASCADE em `account_id` — sumindo a conta, some o tenant
--   inteiro e não há mais a quem prestar contas.
--
-- Sem policy de INSERT/UPDATE/DELETE
--
--   Só a rota escreve, com `supabaseAdmin()` (service role, que ignora
--   RLS) e depois de já ter checado `requireRole('agent')`. Ninguém
--   edita um registro depois de criado — é isso que o torna trilha, e
--   não um log qualquer.
--
-- SELECT só para admin+
--
--   O agente exporta (D-1), mas quem audita é a administração.
--   `is_account_member(x, 'admin')` já cobre `owner`.
-- ============================================================

CREATE TABLE IF NOT EXISTS conversation_exports (
  id               UUID PRIMARY KEY,            -- gerado na rota (rodapé do PDF)
  account_id       UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  conversation_id  UUID REFERENCES conversations(id) ON DELETE SET NULL,
  contact_id       UUID REFERENCES contacts(id) ON DELETE SET NULL,
  user_id          UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  format           TEXT NOT NULL CHECK (format IN ('pdf','zip')),
  message_count    INT  NOT NULL,
  media_count      INT  NOT NULL DEFAULT 0,
  media_missing    INT  NOT NULL DEFAULT 0,
  total_bytes      BIGINT NOT NULL DEFAULT 0,
  period_from      TIMESTAMPTZ,
  period_to        TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_conversation_exports_account
  ON conversation_exports(account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_conversation_exports_conversation
  ON conversation_exports(conversation_id);

ALTER TABLE conversation_exports ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS conversation_exports_select ON conversation_exports;
CREATE POLICY conversation_exports_select ON conversation_exports
  FOR SELECT USING (is_account_member(account_id, 'admin'));

COMMENT ON TABLE conversation_exports IS
  'Trilha de auditoria de exportacoes de conversa (SPEC 067). So escrita pela rota POST /api/inbox/conversations/[id]/export via service role, depois de checar requireRole(agent). O id e gerado na rota porque vai impresso no rodape do PDF. Sem policy de INSERT/UPDATE/DELETE de proposito.';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_name = 'conversation_exports'
  ) THEN
    RAISE EXCEPTION '077: tabela conversation_exports nao foi criada.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'conversation_exports'
      AND policyname = 'conversation_exports_select'
  ) THEN
    RAISE EXCEPTION '077: policy conversation_exports_select ausente.';
  END IF;

  -- O id sem DEFAULT é parte do contrato com o rodapé do PDF: se
  -- alguém acrescentar gen_random_uuid() depois, a rota passa a poder
  -- omitir o id e o vínculo documento <-> trilha se perde em silêncio.
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'conversation_exports'
      AND column_name = 'id'
      AND column_default IS NOT NULL
  ) THEN
    RAISE EXCEPTION '077: conversation_exports.id nao pode ter DEFAULT.';
  END IF;
END $$;
