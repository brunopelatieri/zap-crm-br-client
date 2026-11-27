-- ============================================================
-- 078_qr_enrichment_and_limits.sql — SPEC 069
--
-- 1) contacts: proveniência da checagem + avatar da instância
-- 2) evolution_instances: switches do R1, teto de captação, overrides
-- 3) channel_cold_sends: discriminador `kind` (D-1)
-- 4) contact_check_queue: a fila do R3/R6
-- 5) evolution_harvested_contacts: a triagem do R5 (D-3)
-- 6) broadcasts: status `awaiting_check` (D-4) + campos do R6
-- 7) bucket privado `contact-avatars` (D-12)
-- 8) asserções
--
-- Idempotente — seguro reexecutar. NADA aqui muda comportamento
-- sozinho: os dois switches nascem FALSE e a fila nasce vazia.
-- ============================================================

-- ------------------------------------------------------------
-- 1) contacts
-- ------------------------------------------------------------
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS avatar_path TEXT;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS avatar_source TEXT;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS avatar_fetched_at TIMESTAMPTZ;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS whatsapp_checked_at TIMESTAMPTZ;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS whatsapp_checked_channel_id UUID
  REFERENCES channels(id) ON DELETE SET NULL;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS whatsapp_check_note TEXT;

ALTER TABLE contacts DROP CONSTRAINT IF EXISTS contacts_avatar_source_check;
ALTER TABLE contacts ADD CONSTRAINT contacts_avatar_source_check
  CHECK (avatar_source IS NULL OR avatar_source IN ('whatsapp_qr'));

COMMENT ON COLUMN contacts.avatar_path IS
  'Caminho no bucket privado contact-avatars (SPEC 069 D-12). Diferente de avatar_url, que é URL pronta: este precisa ser assinado antes de virar src.';
COMMENT ON COLUMN contacts.whatsapp_check_note IS
  'Discordância entre fontes de whatsapp_status (SPEC 069 D-2, regra 3). Sinal para o operador, nunca decisão automática.';

-- `harvest` é a origem do contato promovido da triagem (D-3). O CHECK
-- da 067 é nomeado, então basta recriar.
ALTER TABLE contacts DROP CONSTRAINT IF EXISTS contacts_created_via_check;
ALTER TABLE contacts ADD CONSTRAINT contacts_created_via_check
  CHECK (created_via IN ('manual','import','api','audience','inbound','legacy','harvest'));

-- CORREÇÃO da §5.1 da SPEC (achado da F1): a Evolution passa a ser a
-- TERCEIRA fonte de `whatsapp_status` (D-2, regra 1), e o motivo que
-- ela grava é `qr_check`. O CHECK herdado da 044 só conhecia as duas
-- fontes anteriores — sem esta linha, o primeiro UPDATE da F5 morreria
-- em violação de constraint. `qr_check_conflict` NÃO entra aqui: pela
-- regra 3 do D-2 a discordância vai para `whatsapp_check_note` e nunca
-- vira status.
ALTER TABLE contacts DROP CONSTRAINT IF EXISTS contacts_whatsapp_status_reason_check;
ALTER TABLE contacts ADD CONSTRAINT contacts_whatsapp_status_reason_check
  CHECK (
    whatsapp_status_reason IS NULL
    OR whatsapp_status_reason IN
       ('consecutive_failures','meta_error','manual','qr_check')
  );

-- Só os contatos que ainda não foram checados interessam à fila.
CREATE INDEX IF NOT EXISTS idx_contacts_unchecked
  ON contacts (account_id) WHERE whatsapp_checked_at IS NULL;

-- ------------------------------------------------------------
-- 2) evolution_instances — R1 (a), (b), (c) e o nível 1b da cascata
--
-- Os dois switches nascem FALSE: ninguém é inscrito em risco de
-- banimento por atualização de versão (PRD 068 §6.2).
-- ------------------------------------------------------------
ALTER TABLE evolution_instances
  ADD COLUMN IF NOT EXISTS check_enabled BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE evolution_instances
  ADD COLUMN IF NOT EXISTS harvest_enabled BOOLEAN NOT NULL DEFAULT FALSE;
-- NULL = herda o teto resolvido pela cascata; valor = teto próprio
-- desta instância, clampado na escrita e na leitura (D-7). O CHECK é
-- nomeado à parte (e não inline no ADD COLUMN) para que reexecutar a
-- migração o recrie em vez de deixar uma constraint anônima órfã.
ALTER TABLE evolution_instances
  ADD COLUMN IF NOT EXISTS harvest_max_contacts INTEGER;
ALTER TABLE evolution_instances
  DROP CONSTRAINT IF EXISTS evolution_instances_harvest_max_contacts_check;
ALTER TABLE evolution_instances
  ADD CONSTRAINT evolution_instances_harvest_max_contacts_check
  CHECK (harvest_max_contacts IS NULL OR harvest_max_contacts >= 0);
ALTER TABLE evolution_instances
  ADD COLUMN IF NOT EXISTS harvested_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE evolution_instances
  ADD COLUMN IF NOT EXISTS harvest_cursor TEXT;
ALTER TABLE evolution_instances
  ADD COLUMN IF NOT EXISTS harvest_last_run_at TIMESTAMPTZ;
-- Nível 1b da cascata (D-8). Chaves validadas em src/lib/limits/registry.ts,
-- não por CHECK — mesma escolha da 067 §2.2 para plans.limits.
ALTER TABLE evolution_instances
  ADD COLUMN IF NOT EXISTS limit_overrides JSONB NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN evolution_instances.limit_overrides IS
  'Nível 1b da cascata de limites (SPEC 069 §3.4): instância > conta > .env > código. Chave ausente = herda; 0 = bloqueia aquele eixo.';

-- ------------------------------------------------------------
-- 3) channel_cold_sends.kind — cota de checagem separada (D-1)
--
-- DEFAULT 'send' é o que preserva a contagem existente: toda linha
-- gravada até aqui é envio, e loadColdSendUsage passa a filtrar
-- kind='send'. Nada muda para quem já usa.
-- ------------------------------------------------------------
ALTER TABLE channel_cold_sends
  ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'send';
ALTER TABLE channel_cold_sends DROP CONSTRAINT IF EXISTS channel_cold_sends_kind_check;
ALTER TABLE channel_cold_sends ADD CONSTRAINT channel_cold_sends_kind_check
  CHECK (kind IN ('send','check'));

-- O índice da 062 é (channel_id, sent_at DESC); com o filtro por kind
-- ele deixa de cobrir sozinho as três consultas do teto.
CREATE INDEX IF NOT EXISTS idx_cold_sends_channel_kind_time
  ON channel_cold_sends (channel_id, kind, sent_at DESC);

COMMENT ON COLUMN channel_cold_sends.kind IS
  'send = mensagem fria (SPEC 049). check = consulta /user/check (SPEC 069 D-1) — cota separada, mesmo livro-caixa.';

-- ------------------------------------------------------------
-- 4) contact_check_queue — a fila do R2/R3/R6
--
-- SEM policy de escrita pelo cliente, como channel_cold_sends: a fila
-- é enchida por rota server-side que já validou a conta, e consumida
-- pelo cron. Uma policy de UPDATE aqui deixaria o próprio freio
-- zerável (mesmo argumento da 062).
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS contact_check_queue (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id     UUID NOT NULL REFERENCES accounts(id)  ON DELETE CASCADE,
  contact_id     UUID NOT NULL REFERENCES contacts(id)  ON DELETE CASCADE,
  -- Congelado no enfileiramento: se o contato for editado depois, o
  -- que foi checado continua rastreável.
  phone_normalized TEXT NOT NULL,

  source         TEXT NOT NULL DEFAULT 'contacts_import'
                 CHECK (source IN ('contacts_import','broadcast')),
  broadcast_id   UUID REFERENCES broadcasts(id) ON DELETE CASCADE,
  -- Instância validadora escolhida no enfileiramento (D-10). NULL
  -- resolve na hora do consumo — instância pode ser trocada no meio.
  check_channel_id UUID REFERENCES channels(id) ON DELETE SET NULL,

  status         TEXT NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending','in_progress','done','failed','expired','skipped')),
  attempts       INTEGER NOT NULL DEFAULT 0,
  last_error     TEXT,

  requested_by   UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  checked_at     TIMESTAMPTZ
);

-- Um contato não fica duas vezes na fila PELO MESMO motivo. Parcial
-- em (pending, in_progress) porque reenfileirar um contato já checado
-- meses depois é legítimo.
CREATE UNIQUE INDEX IF NOT EXISTS idx_check_queue_dedupe
  ON contact_check_queue (
    account_id,
    contact_id,
    COALESCE(broadcast_id, '00000000-0000-0000-0000-000000000000'::uuid)
  )
  WHERE status IN ('pending','in_progress');

-- A consulta do cron: pendentes de uma conta, mais antigos primeiro.
CREATE INDEX IF NOT EXISTS idx_check_queue_pending
  ON contact_check_queue (account_id, created_at)
  WHERE status = 'pending';

-- A consulta do R6: quanto falta desta campanha.
CREATE INDEX IF NOT EXISTS idx_check_queue_broadcast
  ON contact_check_queue (broadcast_id, status)
  WHERE broadcast_id IS NOT NULL;

DROP TRIGGER IF EXISTS set_updated_at ON contact_check_queue;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON contact_check_queue
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE contact_check_queue ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS contact_check_queue_select ON contact_check_queue;
CREATE POLICY contact_check_queue_select ON contact_check_queue
  FOR SELECT USING (is_account_member(account_id));

COMMENT ON TABLE contact_check_queue IS
  'Fila de checagem de número via instância QRCode (SPEC 069 R2/R3/R6). Sem policy de escrita: enchida por rota server-side, consumida por cron.';

-- ------------------------------------------------------------
-- 5) evolution_harvested_contacts — a triagem (D-3)
--
-- NÃO é contacts. Uma pessoa da agenda do dono do número não é lead
-- até alguém dizer que é — e a quota de contatos (trigger da 067) só
-- deve ser consumida quando há alguém na tela para ver o erro.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS evolution_harvested_contacts (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  channel_id    UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,

  jid           TEXT NOT NULL,
  phone_normalized TEXT,
  push_name     TEXT,
  full_name     TEXT,
  business_name TEXT,
  avatar_path   TEXT,

  -- Resposta crua da Evolution, para diagnóstico enquanto D-14 estiver
  -- aberta. Purgada junto com a linha.
  raw           JSONB NOT NULL DEFAULT '{}'::jsonb,

  status        TEXT NOT NULL DEFAULT 'new'
                CHECK (status IN ('new','promoted','ignored','duplicate')),
  promoted_contact_id UUID REFERENCES contacts(id) ON DELETE SET NULL,
  promoted_by   UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  promoted_at   TIMESTAMPTZ,

  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (account_id, channel_id, jid)
);

CREATE INDEX IF NOT EXISTS idx_harvested_triage
  ON evolution_harvested_contacts (account_id, status, created_at DESC);

DROP TRIGGER IF EXISTS set_updated_at ON evolution_harvested_contacts;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON evolution_harvested_contacts
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE evolution_harvested_contacts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS harvested_select ON evolution_harvested_contacts;
CREATE POLICY harvested_select ON evolution_harvested_contacts
  FOR SELECT USING (is_account_member(account_id));
-- Escrita (promover/ignorar) passa por rota que valida papel admin+ e
-- executa a promoção numa transação junto do INSERT em contacts —
-- por isso, service_role apenas.

COMMENT ON TABLE evolution_harvested_contacts IS
  'Triagem de contatos captados da agenda da instância QRCode (SPEC 069 D-3 / PRD 068 §3). Promoção para contacts é ato explícito de uma pessoa — base legal LGPD.';

-- ------------------------------------------------------------
-- 6) broadcasts — o estado "Em espera — disparo parcial" (D-4)
--
-- Mesmo padrão idempotente da 065 §1.2, com uma diferença: existem
-- DUAS formas anteriores possíveis do CHECK (a anônima por posição da
-- 001 e a nomeada `broadcasts_status_streaming_check` da 065). Por
-- isso o bloco localiza a constraint por CONTEÚDO, não por nome.
--
-- CORREÇÃO da §5.6 da SPEC (achado da F1): LOOP no lugar do LIMIT 1.
-- Um deployment que tenha ficado com as duas formas ao mesmo tempo
-- teria só uma derrubada, e a sobrevivente continuaria recusando
-- `awaiting_check` — em silêncio, porque o CHECK novo estaria lá,
-- válido, ao lado do antigo. Um CHECK que sobra não substitui: soma.
-- ------------------------------------------------------------
DO $$
DECLARE
  v_conname TEXT;
BEGIN
  FOR v_conname IN
    SELECT conname
    FROM pg_constraint c
    WHERE c.conrelid = 'public.broadcasts'::regclass
      AND c.contype = 'c'
      AND pg_get_constraintdef(c.oid) ILIKE '%status%draft%scheduled%sending%sent%failed%'
      AND pg_get_constraintdef(c.oid) NOT ILIKE '%awaiting_check%'
  LOOP
    EXECUTE 'ALTER TABLE public.broadcasts DROP CONSTRAINT ' || quote_ident(v_conname);
  END LOOP;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'broadcasts_status_awaiting_check_check'
      AND conrelid = 'public.broadcasts'::regclass
  ) THEN
    ALTER TABLE broadcasts
      ADD CONSTRAINT broadcasts_status_awaiting_check_check
      CHECK (status IN ('draft','scheduled','sending','sent','failed','streaming','awaiting_check'));
  END IF;
END $$;

COMMENT ON COLUMN broadcasts.status IS
  'draft/scheduled/sending/sent/failed = ciclo de uma campanha. streaming (065) = exclusivo de source=webhook. awaiting_check (078, SPEC 069 R6) = disparo parcial esperando o próximo ciclo de cota de checagem.';

ALTER TABLE broadcasts
  ADD COLUMN IF NOT EXISTS check_before_send BOOLEAN NOT NULL DEFAULT FALSE;
-- D-10: a instância que CHECA é independente do canal que DISPARA.
ALTER TABLE broadcasts
  ADD COLUMN IF NOT EXISTS check_channel_id UUID REFERENCES channels(id) ON DELETE SET NULL;
ALTER TABLE broadcasts
  ADD COLUMN IF NOT EXISTS checked_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE broadcasts
  ADD COLUMN IF NOT EXISTS check_resumed_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_broadcasts_awaiting_check
  ON broadcasts (account_id, check_resumed_at)
  WHERE status = 'awaiting_check';

-- ------------------------------------------------------------
-- 7) Bucket privado `contact-avatars` (D-12)
--
-- Privado desde o nascimento, ao contrário de `avatars` (008, público)
-- — a foto de perfil de um terceiro que nunca falou com o CRM não é
-- material para leitura anônima. Mesmo regime que a 040 impôs a
-- chat-media/flow-media: URL assinada sob demanda.
-- ------------------------------------------------------------
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('contact-avatars','contact-avatars', FALSE, 2097152,
        ARRAY['image/png','image/jpeg'])
ON CONFLICT (id) DO UPDATE
SET public = EXCLUDED.public,
    file_size_limit = EXCLUDED.file_size_limit,
    allowed_mime_types = EXCLUDED.allowed_mime_types;

-- Leitura por membro da conta dona do primeiro segmento do caminho
-- (`account-<uuid>`) — mesma convenção de chat-media.
--
-- CORREÇÃO da §5.7 da SPEC (achado da F1, medido no `vn`): o
-- `NULLIF(replace(...,'account-',''),'')::uuid` que a SPEC trazia
-- LANÇA (`22P02 invalid input syntax for type uuid`) diante de um
-- caminho fora da convenção — e um erro dentro de uma policy derruba o
-- SELECT INTEIRO em vez de negar aquela linha. Um único objeto com
-- nome torto cegaria o bucket para todo mundo.
--
-- O CASE guardado por regexp devolve NULL nesse caso, e
-- `is_account_member(NULL)` é falso. CASE, e não `AND`, porque o
-- Postgres só garante ordem de avaliação dentro de um CASE: um `AND`
-- pode avaliar o cast antes da guarda, e aí a guarda não guarda nada.
DROP POLICY IF EXISTS "Members read own account contact avatars" ON storage.objects;
CREATE POLICY "Members read own account contact avatars"
  ON storage.objects FOR SELECT
  USING (
    bucket_id = 'contact-avatars'
    AND is_account_member(
      CASE
        WHEN (storage.foldername(name))[1] ~*
             '^account-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        THEN substring((storage.foldername(name))[1] FROM 9)::uuid
      END
    )
  );
-- Escrita: nenhuma policy. Só o cron (service_role) sobe avatar — não
-- existe upload manual de avatar de contato (R4 / PRD 068 §5).

-- ------------------------------------------------------------
-- 8) Asserções — falham alto (padrão 041/052/059/061/062)
-- ------------------------------------------------------------
DO $$
DECLARE
  v_status_def TEXT;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_tables WHERE tablename = 'evolution_instances') THEN
    RAISE EXCEPTION '078: evolution_instances ausente — rode a 056 primeiro.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_tables WHERE tablename = 'channel_cold_sends') THEN
    RAISE EXCEPTION '078: channel_cold_sends ausente — rode a 062 primeiro.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'plan_limit') THEN
    RAISE EXCEPTION '078: plan_limit() ausente — rode a 067 primeiro.';
  END IF;

  -- O freio não pode ser zerável pelo cliente.
  IF EXISTS (SELECT 1 FROM pg_policies
             WHERE tablename IN ('contact_check_queue','evolution_harvested_contacts')
               AND cmd <> 'SELECT') THEN
    RAISE EXCEPTION '078: fila e triagem nao podem ter policy de escrita pelo cliente.';
  END IF;

  -- Os switches TEM que nascer desligados (PRD 068 §6.2).
  IF EXISTS (SELECT 1 FROM evolution_instances WHERE check_enabled OR harvest_enabled) THEN
    RAISE EXCEPTION '078: nenhuma instancia pode nascer com checagem/captacao ligada.';
  END IF;

  -- UM unico CHECK de valores em broadcasts.status (§11.4). Duas
  -- formas anteriores eram possiveis; sobrar qualquer uma delas
  -- recusaria awaiting_check em silencio.
  IF (SELECT count(*) FROM pg_constraint
      WHERE conrelid = 'public.broadcasts'::regclass
        AND contype = 'c'
        AND pg_get_constraintdef(oid) ILIKE '%status%draft%scheduled%') <> 1 THEN
    RAISE EXCEPTION '078: broadcasts.status deve ter exatamente UM check de valores.';
  END IF;

  SELECT pg_get_constraintdef(oid) INTO v_status_def
  FROM pg_constraint
  WHERE conname = 'broadcasts_status_awaiting_check_check'
    AND conrelid = 'public.broadcasts'::regclass;

  IF v_status_def IS NULL
     OR v_status_def NOT ILIKE '%awaiting_check%'
     OR v_status_def NOT ILIKE '%streaming%' THEN
    RAISE EXCEPTION '078: check de broadcasts.status sem os sete valores esperados.';
  END IF;
END $$;
