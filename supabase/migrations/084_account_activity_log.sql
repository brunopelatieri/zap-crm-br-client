-- ============================================================
-- 084_account_activity_log.sql — SPEC 075 F1: registro de atividade
-- da conta ("quem fez o quê", dentro da conta).
--
-- Quatro peças, na ordem do §3 da SPEC:
--
--   1. `account_activity_log` — a tabela append-only. Nenhuma FK para o
--      recurso registrado, de propósito e pelo mesmo motivo da 078/083:
--      registrar que algo foi APAGADO é o caso de uso, e um CASCADE
--      mataria o registro junto com o que ele existe para registrar.
--   2. Cinco índices, um por filtro da página, com `created_at DESC`
--      fechando todos — o período é o filtro que está sempre ligado.
--   3. RLS de leitura: admin+ vê a conta inteira; o agente vê só o que
--      ELE fez. Nenhuma policy de escrita — quem grava é a trigger
--      (SECURITY DEFINER, dona postgres) ou o helper com service_role.
--   4. `log_account_activity()` + as triggers do §3.4, para o que o
--      navegador escreve DIRETO no PostgREST, sem passar por rota
--      nenhuma (contato e negócio). É o mesmo muro em que a SPEC 059
--      bateu com a quota, e a mesma solução.
--
-- Idempotente e com bloco de asserções finais, no padrão da 068/080/083.
--
-- ------------------------------------------------------------
-- TRÊS CORREÇÕES À SPEC, conferidas contra o schema em produção
-- (`vn`), não presumidas:
--
--   (a) `account_members` NÃO EXISTE neste banco. A SPEC §3.4 lê o papel
--       do ator de lá; a membership real mora em `profiles`
--       (`account_id`, `account_role account_role_enum`), que é de onde
--       `is_account_member` (017) também lê. A função abaixo usa
--       `profiles`. Escrita como está na SPEC, ela falharia na criação.
--
--   (b) A guarda de `created_via` da SPEC §3.4 é uma LISTA NEGRA
--       ('import','audience','api','inbound') — e o CHECK real da coluna
--       já tem SETE valores: a 078 acrescentou 'harvest' (captação em
--       lote da SPEC 069), que a lista negra deixaria inundar o feed.
--       Aqui a guarda é uma LISTA BRANCA: registra-se 'manual' e nada
--       mais. Origem nova acrescentada amanhã fica de fora sozinha, em
--       vez de precisar lembrar de editar esta migração.
--
--   (c) O braço "agente vê o que ele fez" da RLS (§3.3) não checava a
--       conta. Quem trocou de conta continuaria enxergando o próprio
--       rastro na conta anterior. Aqui o braço exige, além disso,
--       membership na conta da linha.
--
-- ------------------------------------------------------------
-- E UMA DECISÃO DE SEGURANÇA DE PRODUÇÃO, que a SPEC não tomou:
--
--   A D-12 diz "falha ao gravar o evento NUNCA derruba a ação do
--   usuário" — mas escreve essa postura só no helper TypeScript
--   (§5, regra 5). Uma trigger AFTER roda DENTRO da transação de quem
--   escreveu: se `log_account_activity()` lançar, o INSERT do contato
--   faz rollback e a criação de contato quebra em produção. Isto é o
--   oposto exato da D-12.
--
--   Por isso a função abaixo tem bloco EXCEPTION: qualquer falha vira
--   `RAISE WARNING` e a ação do usuário segue. O preço é o buraco no
--   log que a própria D-12 assume e manda escrever na tela.
--
--   Mesma razão para a guarda `accounts` da seção 4: durante a exclusão
--   de uma conta (079 em produção hoje, 073 a caminho), os contatos e
--   negócios descem por CASCADE e disparariam estas triggers, cada uma
--   tentando inserir uma linha apontando para a conta que está sendo
--   apagada na mesma transação. Sem a guarda, isso é violação de FK — e
--   o botão de excluir conta, que JÁ EXISTE em produção, quebra.
-- ============================================================

-- ============================================================
-- 1. account_activity_log (§3.1)
-- ============================================================
CREATE TABLE IF NOT EXISTS account_activity_log (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,

  -- ---------- QUEM ----------
  actor_kind      TEXT NOT NULL
                    CHECK (actor_kind IN ('user','system','contact','api')),
  -- SET NULL, não CASCADE: o colega sai da equipe, o rastro fica.
  actor_user_id   UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  -- Congelado no instante do evento — é o que sobra quando o login some,
  -- e é metade do que a busca livre procura (D-9).
  actor_name      TEXT,
  actor_role      TEXT CHECK (actor_role IN ('owner','admin','agent','viewer')),

  -- ---------- O QUÊ ----------
  resource_type   TEXT NOT NULL CHECK (resource_type IN (
                    'message','conversation','contact','deal','broadcast',
                    'automation','flow','channel','member','export',
                    'plan','tag','webhook')),
  action          TEXT NOT NULL,           -- catálogo fechado no §4 da SPEC
  -- SEM FK, de propósito — ver o cabeçalho.
  resource_id     UUID,
  resource_label  TEXT,                    -- desnormalizado, 160 chars (D-8)

  -- ---------- ONDE ----------
  channel_id      UUID,                    -- sem FK: instância QR morre, registro fica
  channel_type    TEXT CHECK (channel_type IN ('whatsapp_cloud','whatsapp_qr')),
  conversation_id UUID,
  contact_id      UUID,

  -- ---------- CONTEXTO ----------
  -- Ponteiro para a tabela especializada que tem o detalhe (D-2).
  source_table    TEXT,
  source_id       UUID,
  -- de→para, motivo, contadores. JSONB para não migrar a cada campo
  -- novo, no mesmo espírito de broadcast_audit_log.details.
  metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,

  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- 2. Índices — um por filtro, `created_at DESC` sempre por último (§3.2)
-- ============================================================

-- feed sem filtro + filtro só de período (o caminho mais quente)
CREATE INDEX IF NOT EXISTS idx_activity_account_created
  ON account_activity_log (account_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_activity_account_type_created
  ON account_activity_log (account_id, resource_type, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_activity_account_actor_created
  ON account_activity_log (account_id, actor_user_id, created_at DESC)
  WHERE actor_user_id IS NOT NULL;

-- Parcial: a maioria dos eventos NÃO tem canal (contato, negócio, plano).
-- O índice fica do tamanho do subconjunto que o filtro de canal alcança.
CREATE INDEX IF NOT EXISTS idx_activity_account_channel_created
  ON account_activity_log (account_id, channel_id, created_at DESC)
  WHERE channel_id IS NOT NULL;

-- Deep-link "atividade deste contato/desta conversa"
CREATE INDEX IF NOT EXISTS idx_activity_account_resource
  ON account_activity_log (account_id, resource_type, resource_id)
  WHERE resource_id IS NOT NULL;

-- ============================================================
-- 3. RLS — o corte de quem vê (§3.3 + §9)
-- ============================================================
ALTER TABLE account_activity_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS account_activity_log_select ON account_activity_log;
CREATE POLICY account_activity_log_select ON account_activity_log FOR SELECT
  USING (
    is_account_member(account_id, 'admin')          -- admin/owner: tudo
    OR (                                            -- agente: só o que ELE fez (D-5)
      actor_user_id = auth.uid()
      AND is_account_member(account_id)             -- ...e só na conta de que participa
    )
  );

-- Nenhuma policy de INSERT/UPDATE/DELETE: quem grava é a trigger
-- SECURITY DEFINER (dona postgres, não barrada pela RLS) ou o helper com
-- service_role. Log que o auditado edita não é log.
--
-- Defesa em profundidade, no espírito da 080/082: além da RLS, retirar o
-- grant de escrita que o Supabase concede por padrão em tabela nova.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON account_activity_log FROM anon, authenticated;

-- ============================================================
-- 4. A função de escrita e as triggers (§3.4)
-- ============================================================

-- Máscara de telefone para log — porte SQL de `maskPhoneForLog`
-- (src/lib/phone/mask-for-log.ts, SPEC 055 D-13): mantém os 4 primeiros
-- dígitos (DDI+DDD) e os 2 últimos, preservando a pontuação. A trigger
-- precisa dela porque o rótulo de um contato sem nome é o telefone, e o
-- de→para do item 2 do teste manual (§13) é de telefone.
CREATE OR REPLACE FUNCTION mask_phone_for_log(p_raw TEXT)
RETURNS TEXT
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  v_chars TEXT[];
  v_total INT;
  v_pos   INT := 0;
  i       INT;
BEGIN
  IF p_raw IS NULL OR p_raw = '' THEN
    RETURN '—';
  END IF;

  v_total := length(regexp_replace(p_raw, '[^0-9]', '', 'g'));

  IF v_total <= 6 THEN
    RETURN regexp_replace(p_raw, '[0-9]', '*', 'g');
  END IF;

  v_chars := regexp_split_to_array(p_raw, '');
  FOR i IN 1 .. array_length(v_chars, 1) LOOP
    IF v_chars[i] ~ '[0-9]' THEN
      IF v_pos >= 4 AND v_pos < v_total - 2 THEN
        v_chars[i] := '*';
      END IF;
      v_pos := v_pos + 1;
    END IF;
  END LOOP;

  RETURN array_to_string(v_chars, '');
END;
$$;

ALTER FUNCTION mask_phone_for_log(TEXT) OWNER TO postgres;

-- A escrita central usada pelas triggers.
--
-- `p_contact_id` não está na assinatura da SPEC: foi acrescentado para
-- que a linha de um evento de contato já sirva ao deep-link "atividade
-- deste contato" (o índice idx_activity_account_resource). É opcional,
-- então não muda nenhuma chamada escrita contra a assinatura da SPEC.
CREATE OR REPLACE FUNCTION log_account_activity(
  p_account_id     UUID,
  p_resource_type  TEXT,
  p_action         TEXT,
  p_resource_id    UUID,
  p_resource_label TEXT,
  p_metadata       JSONB,
  p_contact_id     UUID DEFAULT NULL
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid  UUID := auth.uid();
  v_name TEXT;
  v_role TEXT;
BEGIN
  IF p_account_id IS NULL THEN
    RETURN;
  END IF;

  -- A conta está sendo apagada nesta mesma transação (079/073): os
  -- filhos descem por CASCADE e chegam aqui. Sem esta guarda, o INSERT
  -- aponta para uma conta que já não existe e a exclusão inteira falha
  -- por violação de FK. Ver o cabeçalho.
  IF NOT EXISTS (SELECT 1 FROM accounts WHERE id = p_account_id) THEN
    RETURN;
  END IF;

  -- A membership mora em `profiles`, não em `account_members` — ver a
  -- correção (a) no cabeçalho.
  SELECT pr.full_name, pr.account_role::TEXT
    INTO v_name, v_role
    FROM profiles pr
   WHERE pr.user_id = v_uid
     AND pr.account_id = p_account_id;

  INSERT INTO account_activity_log (
    account_id, actor_kind, actor_user_id, actor_name, actor_role,
    resource_type, action, resource_id, resource_label, contact_id, metadata
  ) VALUES (
    p_account_id,
    -- service_role e cron não têm auth.uid(): viram 'system'.
    CASE WHEN v_uid IS NULL THEN 'system' ELSE 'user' END,
    v_uid,
    v_name,
    v_role,
    p_resource_type, p_action, p_resource_id,
    LEFT(COALESCE(p_resource_label, ''), 160),
    p_contact_id,
    COALESCE(p_metadata, '{}'::jsonb)
  );

EXCEPTION WHEN OTHERS THEN
  -- D-12 aplicada do lado do banco: a ação do usuário NUNCA cai por
  -- causa do rastro. Ver o cabeçalho.
  RAISE WARNING 'log_account_activity falhou (%): %', SQLSTATE, SQLERRM;
END;
$$;

ALTER FUNCTION log_account_activity(UUID, TEXT, TEXT, UUID, TEXT, JSONB, UUID) OWNER TO postgres;

-- SECURITY DEFINER + schema public = exposta como RPC do PostgREST. Sem
-- este revoke, qualquer usuário autenticado forja linha no log de
-- qualquer conta — o log deixaria de valer como auditoria. Mesmo aperto
-- da 067b.
REVOKE ALL ON FUNCTION log_account_activity(UUID, TEXT, TEXT, UUID, TEXT, JSONB, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION log_account_activity(UUID, TEXT, TEXT, UUID, TEXT, JSONB, UUID) FROM anon;
REVOKE ALL ON FUNCTION log_account_activity(UUID, TEXT, TEXT, UUID, TEXT, JSONB, UUID) FROM authenticated;

-- ------------------------------------------------------------
-- 4.1 contacts — criado / editado / excluído
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION trg_log_contact_activity()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_meta JSONB := '{}'::jsonb;
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- LISTA BRANCA: só o contato criado À MÃO, um a um, na tela. Uma
    -- importação de 10 000 contatos é UM evento humano, gravado pela
    -- rota de importação (F4), não 10 000 linhas de feed. Ver a
    -- correção (b) no cabeçalho.
    IF NEW.created_via <> 'manual' THEN
      RETURN NULL;
    END IF;

    PERFORM log_account_activity(
      NEW.account_id, 'contact', 'contact.created', NEW.id,
      COALESCE(NULLIF(NEW.name, ''), mask_phone_for_log(NEW.phone)),
      jsonb_build_object('created_via', NEW.created_via),
      NEW.id
    );
    RETURN NULL;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    -- Só os quatro campos que o §3.4 nomeia. `updated_at`, opt-in,
    -- avatar e status de WhatsApp mudam sozinhos o tempo todo (checagem
    -- da 069, webhook, cron) e virariam ruído.
    IF NEW.name    IS NOT DISTINCT FROM OLD.name
   AND NEW.phone   IS NOT DISTINCT FROM OLD.phone
   AND NEW.email   IS NOT DISTINCT FROM OLD.email
   AND NEW.company IS NOT DISTINCT FROM OLD.company THEN
      RETURN NULL;
    END IF;

    IF NEW.name IS DISTINCT FROM OLD.name THEN
      v_meta := v_meta || jsonb_build_object(
        'name', jsonb_build_object('from', OLD.name, 'to', NEW.name));
    END IF;
    -- Telefone entra MASCARADO nos dois lados (§13, item 2).
    IF NEW.phone IS DISTINCT FROM OLD.phone THEN
      v_meta := v_meta || jsonb_build_object(
        'phone', jsonb_build_object(
          'from', mask_phone_for_log(OLD.phone),
          'to',   mask_phone_for_log(NEW.phone)));
    END IF;
    IF NEW.email IS DISTINCT FROM OLD.email THEN
      v_meta := v_meta || jsonb_build_object(
        'email', jsonb_build_object('from', OLD.email, 'to', NEW.email));
    END IF;
    IF NEW.company IS DISTINCT FROM OLD.company THEN
      v_meta := v_meta || jsonb_build_object(
        'company', jsonb_build_object('from', OLD.company, 'to', NEW.company));
    END IF;

    PERFORM log_account_activity(
      NEW.account_id, 'contact', 'contact.updated', NEW.id,
      COALESCE(NULLIF(NEW.name, ''), mask_phone_for_log(NEW.phone)),
      v_meta,
      NEW.id
    );
    RETURN NULL;
  END IF;

  -- DELETE: o `resource_label` é a única cópia que sobra do nome.
  PERFORM log_account_activity(
    OLD.account_id, 'contact', 'contact.deleted', OLD.id,
    COALESCE(NULLIF(OLD.name, ''), mask_phone_for_log(OLD.phone)),
    jsonb_build_object('phone', mask_phone_for_log(OLD.phone)),
    OLD.id
  );
  RETURN NULL;
END;
$$;

ALTER FUNCTION trg_log_contact_activity() OWNER TO postgres;

DROP TRIGGER IF EXISTS log_contact_activity_trigger ON contacts;
CREATE TRIGGER log_contact_activity_trigger
  AFTER INSERT OR UPDATE OR DELETE ON contacts
  FOR EACH ROW EXECUTE FUNCTION trg_log_contact_activity();

-- ------------------------------------------------------------
-- 4.2 deals — criado / movido de estágio / excluído
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION trg_log_deal_activity()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_from TEXT;
  v_to   TEXT;
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM log_account_activity(
      NEW.account_id, 'deal', 'deal.created', NEW.id, NEW.title,
      jsonb_build_object('value', NEW.value, 'currency', NEW.currency),
      NEW.contact_id
    );
    RETURN NULL;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF NEW.stage_id IS NOT DISTINCT FROM OLD.stage_id THEN
      RETURN NULL;
    END IF;

    -- Os NOMES dos estágios, não os UUIDs (§13, item 4).
    SELECT name INTO v_from FROM pipeline_stages WHERE id = OLD.stage_id;
    SELECT name INTO v_to   FROM pipeline_stages WHERE id = NEW.stage_id;

    PERFORM log_account_activity(
      NEW.account_id, 'deal', 'deal.stage_changed', NEW.id, NEW.title,
      jsonb_build_object('from', v_from, 'to', v_to),
      NEW.contact_id
    );
    RETURN NULL;
  END IF;

  PERFORM log_account_activity(
    OLD.account_id, 'deal', 'deal.deleted', OLD.id, OLD.title,
    jsonb_build_object('value', OLD.value, 'currency', OLD.currency),
    OLD.contact_id
  );
  RETURN NULL;
END;
$$;

ALTER FUNCTION trg_log_deal_activity() OWNER TO postgres;

DROP TRIGGER IF EXISTS log_deal_activity_trigger ON deals;
CREATE TRIGGER log_deal_activity_trigger
  AFTER INSERT OR UPDATE OR DELETE ON deals
  FOR EACH ROW EXECUTE FUNCTION trg_log_deal_activity();

-- ------------------------------------------------------------
-- 4.3 contact_tags — NÃO entra nesta migração.
--
-- A SPEC §3.4 marca `contact.tagged/untagged` como "ver D-7: entra na v1
-- ou fica para a fase seguinte", e a D-7 continua sem ratificação. Fica
-- de fora até o mantenedor decidir: o modal de contato grava etiqueta
-- por DELETE-e-INSERT do conjunto inteiro, então salvar um contato com
-- cinco etiquetas produziria até dez linhas de feed para uma edição só —
-- exatamente o ruído que a guarda de `created_via` existe para evitar.
-- Ligar depois é uma trigger a mais, sem tocar em nada desta migração.
-- ------------------------------------------------------------

-- ============================================================
-- 5. Asserções finais — falham alto de propósito (padrão da casa)
-- ============================================================
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables WHERE table_name = 'account_activity_log'
  ) THEN
    RAISE EXCEPTION '084: account_activity_log nao foi criada.';
  END IF;

  IF (
    SELECT count(*) FROM pg_indexes
     WHERE tablename = 'account_activity_log'
       AND indexname LIKE 'idx_activity_%'
  ) < 5 THEN
    RAISE EXCEPTION '084: os cinco indices de account_activity_log nao foram criados.';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_policies
     WHERE tablename = 'account_activity_log' AND cmd <> 'SELECT'
  ) THEN
    RAISE EXCEPTION '084: policy de escrita pelo cliente encontrada em account_activity_log — o log deixaria de ser append-only.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE tablename = 'account_activity_log' AND policyname = 'account_activity_log_select'
  ) THEN
    RAISE EXCEPTION '084: policy de leitura de account_activity_log ausente.';
  END IF;

  -- O revoke da seção 4 é o que impede forjar linha de auditoria via RPC.
  IF has_function_privilege(
       'authenticated',
       'log_account_activity(uuid,text,text,uuid,text,jsonb,uuid)',
       'EXECUTE'
     ) THEN
    RAISE EXCEPTION '084: log_account_activity ainda executavel por authenticated — qualquer usuario forjaria linha no log.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'log_contact_activity_trigger'
  ) THEN
    RAISE EXCEPTION '084: trigger de contacts nao foi criada.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'log_deal_activity_trigger'
  ) THEN
    RAISE EXCEPTION '084: trigger de deals nao foi criada.';
  END IF;

  RAISE NOTICE '084: account_activity_log, indices, RLS, log_account_activity() e as triggers de contacts/deals aplicados.';
END $$;
