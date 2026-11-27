-- ============================================================
-- 100_form_phone_proofs.sql — SPEC 085 F7 (prova de posse do telefone)
--
-- Só do ZAP. Fecha M-2 e M-3 do Status da SPEC 085 no modo "com
-- confirmação" (`forms.settings.require_phone_proof = true`): o visitante
-- informa o telefone, recebe um CÓDIGO na tela e o ENVIA, do próprio
-- WhatsApp, ao número da conta. A mensagem que chega (autenticada pelo
-- provedor: o remetente não se forja) confirma a prova. Só depois o
-- contato é criado/vinculado e a resposta passa a agir sobre ele. Nenhuma
-- mensagem SAI para número desconhecido: não há custo de template, teto de
-- envio frio nem vetor de spam contra terceiros.
--
-- Uma tabela, sem função: a regra mora em `src/lib/forms/phone-proof.ts`
-- (testada); as transições são `UPDATE … WHERE status = '…'` (atômicas),
-- escritas só pelo service_role (rota pública e ingestão do webhook).
--
--   pending   → código gerado, aguardando a mensagem do telefone
--   confirmed → a mensagem chegou DO telefone informado; vale ~15 min
--   consumed  → usada por um `start` (uso único)
--   expired   → vencida ou substituída por um código mais novo
--
-- Privilégios: RLS ligada e NENHUMA policy; REVOKE de PUBLIC, anon e
-- authenticated (o privilégio padrão de tabela do dono dá `arwdDxtm` a
-- `authenticated` em `public`, lição da F5 da SPEC 085). Só service_role.
--
-- Idempotente. Não é para fork de terceiros: nada de URL ou segredo aqui.
-- ============================================================

CREATE TABLE IF NOT EXISTS form_phone_proofs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  form_id       UUID NOT NULL REFERENCES forms(id) ON DELETE CASCADE,
  -- Telefone informado, canônico (SPEC 050). Não é PII nova: é o que o
  -- visitante digitou e o `start` gravaria no contato.
  phone         TEXT NOT NULL CHECK (length(phone) BETWEEN 8 AND 20),
  -- 8 caracteres de [2-9A-HJKMNP-Z] (≈ 39,6 bits), SEM hífen. Aparece na tela
  -- e no `wa.me` do visitante, então não é segredo: quem a conhece ainda
  -- precisa mandá-la DO telefone informado.
  code          TEXT NOT NULL CHECK (code ~ '^[2-9A-HJKMNP-Z]{8}$'),
  -- sha256 (hex) do segredo que só o navegador do visitante conhece: liga
  -- o `start` ao mesmo navegador que pediu o código.
  secret_hash   TEXT NOT NULL CHECK (secret_hash ~ '^[0-9a-f]{64}$'),
  status        TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'confirmed', 'consumed', 'expired')),
  ip_hash       TEXT,
  expires_at    TIMESTAMPTZ NOT NULL,
  confirmed_at  TIMESTAMPTZ,
  consumed_at   TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Um código pendente por conta: a mensagem chega sem formulário, só com o
-- código, e a busca é (conta, código). Colisão na geração → a rota sorteia
-- outro (23505).
CREATE UNIQUE INDEX IF NOT EXISTS idx_form_phone_proofs_pending_code
  ON form_phone_proofs (account_id, code) WHERE status = 'pending';

-- Limites por telefone (conta + telefone, janela de 1 h) e leitura da prova
-- pelo `start`.
CREATE INDEX IF NOT EXISTS idx_form_phone_proofs_phone
  ON form_phone_proofs (account_id, phone, created_at DESC);

-- Limites por formulário e por conta (contagem na janela de 1 h).
CREATE INDEX IF NOT EXISTS idx_form_phone_proofs_form
  ON form_phone_proofs (form_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_form_phone_proofs_account
  ON form_phone_proofs (account_id, created_at DESC);

-- Varredura (cron): apaga o que venceu há mais de um dia.
CREATE INDEX IF NOT EXISTS idx_form_phone_proofs_expires
  ON form_phone_proofs (expires_at);

ALTER TABLE form_phone_proofs ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE form_phone_proofs FROM PUBLIC;
REVOKE ALL ON TABLE form_phone_proofs FROM anon;
REVOKE ALL ON TABLE form_phone_proofs FROM authenticated;
GRANT ALL ON TABLE form_phone_proofs TO service_role;

DO $$
BEGIN
  IF has_table_privilege('anon', 'public.form_phone_proofs', 'SELECT')
     OR has_table_privilege('authenticated', 'public.form_phone_proofs', 'SELECT')
     OR has_table_privilege('authenticated', 'public.form_phone_proofs', 'INSERT')
     OR has_table_privilege('authenticated', 'public.form_phone_proofs', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.form_phone_proofs', 'DELETE') THEN
    RAISE EXCEPTION 'form_phone_proofs: anon/authenticated com privilegio indevido';
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class
          WHERE oid = 'public.form_phone_proofs'::regclass) THEN
    RAISE EXCEPTION 'form_phone_proofs: RLS desligada';
  END IF;
END $$;
