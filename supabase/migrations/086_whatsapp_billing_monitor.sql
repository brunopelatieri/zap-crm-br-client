-- ============================================================
-- 086_whatsapp_billing_monitor.sql — SPEC 076 F1: monitor de status
-- de envio e consumo do WhatsApp Cloud API.
--
-- Cinco peças, todas aditivas (nada existente muda de comportamento
-- enquanto `whatsapp_billing_monitor_enabled` estiver FALSE):
--
--   1. `whatsapp_billing_status` — o retrato atual POR WABA (D-1), com
--      prazo de validade por campo (D-2) e o estado de pagamento
--      pendente (§6.3). NÃO guarda segredo nenhum: é por isso que mora
--      numa tabela própria e não em `whatsapp_config`, legível por
--      qualquer membro (§8.1).
--   2. `messages.pricing_billable` / `pricing_category` — o `pricing`
--      do webhook de status, hoje descartado (D-7, §8.2).
--   3. `notifications` — tipo novo `channel_payment_blocked`, coluna
--      `channel_id` e a função `notify_channel_payment_blocked` (§8.3).
--   4. `platform_settings.whatsapp_billing_monitor_enabled` — o
--      interruptor, padrão FALSE (D-10, §8.4), no molde de
--      `quotas_enforced` (067).
--
-- Escrita em `whatsapp_billing_status`: só service_role (sem policy de
-- INSERT/UPDATE/DELETE). Agente e viewer recebem o status pela rota
-- (D-8); a tabela só é legível por admin+.
-- ============================================================

-- ============================================================
-- 1. whatsapp_billing_status
-- ============================================================
CREATE TABLE IF NOT EXISTS whatsapp_billing_status (
  account_id   UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  waba_id      TEXT NOT NULL,

  -- Moeda do WABA (ISO-4217). Pode mudar num WABA existente (F-5).
  currency     TEXT,

  -- health_status (F-6). Valor fora do vocabulário da Meta é gravado
  -- como NULL pelo código (e logado) → a UI mostra `unknown`.
  health_overall     TEXT
    CHECK (health_overall IN ('AVAILABLE', 'LIMITED', 'BLOCKED')),
  -- [{ entity_type, id, can_send_message, errors[], additional_info[] }]
  -- Sem token.
  health_entities    JSONB,
  -- Id da entidade BUSINESS, só para montar o link do Billing Hub (D-11).
  business_id        TEXT,
  health_checked_at  TIMESTAMPTZ,

  -- Consumo do mês (§7.4). NULL em spend_total = indisponível, ≠ 0.
  spend_period_start       DATE,
  spend_tz_offset_seconds  INTEGER,
  spend_total              NUMERIC(14, 6),
  -- { "MARKETING": { "volume": 113, "cost": 7.0625 }, ... } — `cost`
  -- pode faltar (F-11).
  spend_by_category        JSONB,
  -- Moeda da leitura de consumo; se ≠ `currency`, a UI avisa (F-5).
  spend_currency           TEXT,
  spend_checked_at         TIMESTAMPTZ,

  -- Falha da última LEITURA da Graph, uma por campo — `health_status` e
  -- `pricing_analytics` falham e se recuperam de forma independente
  -- (§7.6), então cada um tem o seu erro, o seu contador e o seu recuo.
  -- Com um único conjunto de colunas, uma falha só do consumo seria lida
  -- como falha do status de envio (e derrubaria o estado do canal).
  -- Mensagens saneadas (§12) e limitadas a 500 caracteres.
  health_error_kind      TEXT
    CHECK (health_error_kind IN ('auth', 'permission', 'rate_limit', 'transient', 'unknown')),
  health_error_code      INTEGER,
  health_error_message   TEXT CHECK (char_length(health_error_message) <= 500),
  health_error_at        TIMESTAMPTZ,
  health_consecutive_failures INTEGER NOT NULL DEFAULT 0,
  health_next_retry_at   TIMESTAMPTZ,

  spend_error_kind       TEXT
    CHECK (spend_error_kind IN ('auth', 'permission', 'rate_limit', 'transient', 'unknown')),
  spend_error_code       INTEGER,
  spend_error_message    TEXT CHECK (char_length(spend_error_message) <= 500),
  spend_error_at         TIMESTAMPTZ,
  spend_consecutive_failures  INTEGER NOT NULL DEFAULT 0,
  spend_next_retry_at    TIMESTAMPTZ,

  -- Pagamento (§6.3). `payment_blocked_since IS NOT NULL` = pendente.
  payment_blocked_since              TIMESTAMPTZ,
  last_payment_error_at              TIMESTAMPTZ,
  last_payment_error_phone_number_id TEXT,
  payment_cleared_at                 TIMESTAMPTZ,
  payment_cleared_by                 UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  payment_clear_reason               TEXT
    CHECK (payment_clear_reason IN ('billable_delivered', 'manual')),

  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  PRIMARY KEY (account_id, waba_id)
);

DROP TRIGGER IF EXISTS set_updated_at ON whatsapp_billing_status;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON whatsapp_billing_status
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE whatsapp_billing_status ENABLE ROW LEVEL SECURITY;

-- SELECT só admin+: o consumo é informação financeira (D-8). Agente e
-- viewer veem o STATUS pela rota, que filtra por papel.
DROP POLICY IF EXISTS whatsapp_billing_status_select ON whatsapp_billing_status;
CREATE POLICY whatsapp_billing_status_select ON whatsapp_billing_status
  FOR SELECT USING (is_account_member(account_id, 'admin'));

-- Sem policy de escrita: só service_role (que ignora RLS). O REVOKE
-- fecha também o grant padrão do Supabase, no mesmo molde da 084.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE
  ON whatsapp_billing_status FROM anon, authenticated;

COMMENT ON TABLE whatsapp_billing_status IS
  'SPEC 076 §8.1. Retrato atual por (conta, WABA) do status de envio e do consumo estimado da Cloud API, mais o estado de pagamento pendente (131042). Sem segredos. Escrita só service_role.';

-- ============================================================
-- 2. messages — pricing do webhook de status (D-7)
--
-- Duas colunas nulas, preenchidas no mesmo UPDATE que o webhook já faz.
-- Sem índice na v1 (§8.2). `ADD COLUMN` nulo, sem DEFAULT, é só
-- metadado no Postgres: não reescreve a tabela.
-- ============================================================
ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS pricing_billable BOOLEAN,
  ADD COLUMN IF NOT EXISTS pricing_category TEXT;

COMMENT ON COLUMN messages.pricing_billable IS
  'SPEC 076 D-7. statuses[].pricing.billable do webhook da Meta. NULL = a Meta não informou (não sobrescrito por status sem pricing).';
COMMENT ON COLUMN messages.pricing_category IS
  'SPEC 076 D-7. statuses[].pricing.category em MAIÚSCULAS (MARKETING, UTILITY, SERVICE...). Valor cru: a categoria pode não ter tradução.';

-- ============================================================
-- 3. notifications — tipo novo + channel_id + função (D-6, §8.3)
-- ============================================================

-- O CHECK de `type` nasceu inline na 027 (nome gerado). Em vez de
-- supor o nome, derruba qualquer CHECK de `notifications` que cite o
-- tipo antigo e recria com o conjunto novo — idempotente.
DO $$
DECLARE
  v_con RECORD;
BEGIN
  FOR v_con IN
    SELECT c.conname
      FROM pg_constraint c
     WHERE c.conrelid = 'public.notifications'::regclass
       AND c.contype = 'c'
       AND pg_get_constraintdef(c.oid) LIKE '%conversation_assigned%'
  LOOP
    EXECUTE format('ALTER TABLE notifications DROP CONSTRAINT %I', v_con.conname);
  END LOOP;
END $$;

ALTER TABLE notifications
  ADD CONSTRAINT notifications_type_check
  CHECK (type IN ('conversation_assigned', 'channel_payment_blocked'));

-- Para o link e o dedupe. CASCADE: apagar o canal leva o alerta junto.
ALTER TABLE notifications
  ADD COLUMN IF NOT EXISTS channel_id UUID REFERENCES channels(id) ON DELETE CASCADE;

-- Garante, no banco, "no máximo UMA notificação não lida por usuário e
-- canal" (§10.4). Um NOT EXISTS na função não bastava: duas chamadas
-- concorrentes (rajada de webhooks, retry após timeout) passariam
-- ambas pela checagem antes de qualquer commit e duplicariam o alerta.
-- Serve também de índice para a consulta de não lidas por canal.
CREATE UNIQUE INDEX IF NOT EXISTS uq_notifications_payment_blocked_unread
  ON notifications (user_id, channel_id)
  WHERE type = 'channel_payment_blocked' AND read_at IS NULL;

-- Uma linha por owner/admin da conta, PULANDO (ON CONFLICT) quem já tem
-- notificação NÃO lida do mesmo tipo e canal (idempotência do §10.4). Agente e
-- viewer não recebem: eles não resolvem cobrança (D-6).
--
-- Quem decide SE e QUANDO chamar (episódio novo + flag ligado) é o
-- servidor (`billing-signal.ts`, F3); esta função só insere. Texto já em
-- pt-BR no INSERT — mesmo padrão da 057. Devolve quantas linhas criou.
CREATE OR REPLACE FUNCTION public.notify_channel_payment_blocked(
  p_account_id UUID,
  p_channel_id UUID,
  p_waba_id    TEXT
) RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_channel_name TEXT;
  v_inserted     INTEGER;
BEGIN
  -- O canal precisa ser DESTA conta. SECURITY DEFINER ignora RLS, então
  -- a checagem de tenancy é nossa (mesmo cuidado de cloud-channels.ts).
  SELECT name INTO v_channel_name
    FROM channels
   WHERE id = p_channel_id
     AND account_id = p_account_id;

  IF NOT FOUND THEN
    RETURN 0;
  END IF;

  INSERT INTO notifications (
    account_id, user_id, type, channel_id, title, body
  )
  SELECT
    p_account_id,
    p.user_id,
    'channel_payment_blocked',
    p_channel_id,
    'Envio bloqueado por pagamento no WhatsApp',
    'O número "' || v_channel_name || '" recebeu o erro 131042 da Meta '
      || '(problema na forma de pagamento'
      || CASE
           WHEN p_waba_id IS NULL OR length(p_waba_id) < 4 THEN ''
           ELSE ', WABA final ' || right(p_waba_id, 4)
         END
      || '). Regularize em Cobrança e pagamentos no Meta Business Suite.'
    FROM profiles p
   WHERE p.account_id = p_account_id
     AND p.account_role IN ('owner', 'admin')
     AND p.blocked_at IS NULL
  -- Quem já tem uma não lida deste canal é pulado pelo índice único.
  ON CONFLICT (user_id, channel_id)
    WHERE type = 'channel_payment_blocked' AND read_at IS NULL
    DO NOTHING;

  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  RETURN v_inserted;
END;
$$;

ALTER FUNCTION public.notify_channel_payment_blocked(UUID, UUID, TEXT) OWNER TO postgres;

-- Mesmo aperto da 067b/084b/085: SECURITY DEFINER em `public` é RPC
-- exposta por padrão. Sem o REVOKE, qualquer usuário logado forjaria
-- alertas de cobrança na conta de outro.
REVOKE ALL ON FUNCTION public.notify_channel_payment_blocked(UUID, UUID, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.notify_channel_payment_blocked(UUID, UUID, TEXT) FROM anon;
REVOKE ALL ON FUNCTION public.notify_channel_payment_blocked(UUID, UUID, TEXT) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.notify_channel_payment_blocked(UUID, UUID, TEXT) TO service_role;

COMMENT ON FUNCTION public.notify_channel_payment_blocked IS
  'SPEC 076 D-6/§8.3. Cria uma notificação por owner/admin da conta (pulando, via índice único, quem já tem não lida do mesmo canal). Só service_role; a decisão de chamar (episódio novo + flag ligado) é de billing-signal.ts.';

-- ============================================================
-- 4. platform_settings — o interruptor (D-10)
--
-- Padrão FALSE: com ele desligado a rota responde 404 e a UI não
-- renderiza nada. O webhook continua gravando `pricing` e o estado de
-- pagamento (D-7), para que, ao ligar, já exista histórico.
-- ============================================================
ALTER TABLE platform_settings
  ADD COLUMN IF NOT EXISTS whatsapp_billing_monitor_enabled BOOLEAN NOT NULL DEFAULT FALSE;

-- ============================================================
-- Asserções finais
-- ============================================================
DO $assert$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'whatsapp_billing_status'
       AND column_name = 'payment_blocked_since'
  ) THEN
    RAISE EXCEPTION '086: whatsapp_billing_status nao foi criada.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_tables
     WHERE schemaname = 'public' AND tablename = 'whatsapp_billing_status'
       AND rowsecurity
  ) THEN
    RAISE EXCEPTION '086: RLS desligada em whatsapp_billing_status.';
  END IF;

  IF has_table_privilege('authenticated', 'whatsapp_billing_status', 'INSERT')
     OR has_table_privilege('authenticated', 'whatsapp_billing_status', 'UPDATE')
     OR has_table_privilege('authenticated', 'whatsapp_billing_status', 'DELETE') THEN
    RAISE EXCEPTION '086: whatsapp_billing_status gravavel por authenticated.';
  END IF;

  IF (SELECT count(*) FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'messages'
         AND column_name IN ('pricing_billable', 'pricing_category')) <> 2 THEN
    RAISE EXCEPTION '086: colunas de pricing ausentes em messages.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.notifications'::regclass
       AND conname = 'notifications_type_check'
       AND pg_get_constraintdef(oid) LIKE '%channel_payment_blocked%'
  ) THEN
    RAISE EXCEPTION '086: CHECK de notifications.type nao aceita channel_payment_blocked.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'notifications'
       AND column_name = 'channel_id'
  ) THEN
    RAISE EXCEPTION '086: notifications.channel_id ausente.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
     WHERE schemaname = 'public' AND tablename = 'notifications'
       AND indexname = 'uq_notifications_payment_blocked_unread'
  ) THEN
    RAISE EXCEPTION '086: indice unico de dedupe de notificacoes ausente.';
  END IF;

  IF has_function_privilege('authenticated', 'notify_channel_payment_blocked(uuid, uuid, text)', 'EXECUTE')
     OR has_function_privilege('anon', 'notify_channel_payment_blocked(uuid, uuid, text)', 'EXECUTE') THEN
    RAISE EXCEPTION '086: notify_channel_payment_blocked executavel fora de service_role.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'platform_settings'
       AND column_name = 'whatsapp_billing_monitor_enabled'
  ) THEN
    RAISE EXCEPTION '086: flag whatsapp_billing_monitor_enabled ausente.';
  END IF;

  IF (SELECT whatsapp_billing_monitor_enabled FROM platform_settings LIMIT 1) IS DISTINCT FROM FALSE THEN
    RAISE EXCEPTION '086: o flag deve nascer FALSE.';
  END IF;

  RAISE NOTICE '086: monitor de cobranca do WhatsApp (tabela, pricing, notificacao, flag) aplicado.';
END $assert$;
