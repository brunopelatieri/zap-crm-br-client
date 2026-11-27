-- ============================================================
-- 068_message_retention.sql — SPEC 060: retenção e limpeza de mensagens
--
-- Princípio (SPEC 060 §1): apagar é a única operação deste sistema que
-- não tem desfazer. Três regras derivam daí:
--
--   1. Nasce desligado — `MESSAGE_RETENTION_ENABLED` mora no `.env`, não
--      aqui. Esta migração NUNCA apaga uma linha de `messages`.
--   2. Existe piso de idade (`p_min_age_hours`, padrão 72h, travado num
--      mínimo absoluto de 24h DENTRO da função — achado de code
--      review) — protege a idempotência de reentrega, o fluxo
--      esperando resposta, a atribuição de resposta a campanha e o
--      contexto de IA (§4.3). Vale nas três fases, inclusive o
--      rebaixamento de favoritas (fase 3) — revisão de §4.3.
--   3. Existe prévia (`p_dry_run`) — nunca some sem que alguém tenha
--      visto o número antes.
--
-- O banco executa o conjunto (DELETE é sentença SQL sobre um conjunto,
-- não laço em Node); o TypeScript decide os números (src/lib/retention/,
-- SPEC 060 §5) — a função abaixo RECEBE os limites já resolvidos, nunca
-- lê `channel_retention_policies` nem conhece o `.env` (§4.1 ponto 1).
--
-- Idempotente (IF NOT EXISTS, DROP…CREATE em policies/triggers/funções)
-- e com o bloco de asserções finais que falha alto, no padrão das
-- 041/052/061/062/067.
-- ============================================================

-- ============================================================
-- 1. messages.is_favorite — a mensagem que a limpeza não leva (§3.1)
--
-- Coluna, não tabela: favorita entra no WHERE de toda sentença de
-- limpeza; como tabela seria mais um LEFT JOIN … IS NULL em cada uma
-- delas, e o índice parcial abaixo deixaria de existir.
-- `favorited_by` é auditoria (quem marcou), não dono — favorita é DA
-- CONTA (D-6): o mesmo ícone aparece marcado para o colega ao lado.
-- ============================================================
ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS is_favorite  BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS favorited_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS favorited_by UUID REFERENCES auth.users(id) ON DELETE SET NULL;

-- Parcial: o tamanho do índice é o do conjunto de favoritas, não o da
-- tabela — é ele que faz o `NOT is_favorite` do predicado de limpeza e
-- a contagem do teto (fase 3) saírem baratos.
CREATE INDEX IF NOT EXISTS idx_messages_favorite
  ON messages (conversation_id, created_at)
  WHERE is_favorite;

-- ============================================================
-- 2. channel_retention_policies — o ajuste por conta e canal (§3.2)
--
-- `channel_type` é TEXTO com CHECK, e não FK para `channels.id`, de
-- propósito: a política vale para o TIPO de canal na conta, não para
-- uma instância. Ligar em `channels.id` faria a política morrer junto
-- com a instância pareada a cada QR expirado.
-- ============================================================
CREATE TABLE IF NOT EXISTS channel_retention_policies (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id     UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  channel_type   TEXT NOT NULL CHECK (channel_type IN ('whatsapp_cloud','whatsapp_qr')),

  -- NULL e 0 querem dizer coisas DIFERENTES (§3.4): NULL herda o padrão
  -- global daquela dimensão; 0 é "sem limite", explícito, nunca ausência.
  max_messages   INTEGER CHECK (max_messages   IS NULL OR max_messages   >= 0),
  retention_days INTEGER CHECK (retention_days IS NULL OR retention_days >= 0),
  max_favorites  INTEGER CHECK (max_favorites  IS NULL OR max_favorites  >= 0),

  updated_by     UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (account_id, channel_type)
);

CREATE INDEX IF NOT EXISTS idx_channel_retention_account
  ON channel_retention_policies (account_id);

DROP TRIGGER IF EXISTS set_updated_at ON channel_retention_policies;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON channel_retention_policies
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- RLS — só Proprietário, e só da própria conta. `is_account_member(id,
-- 'owner')` cobre as duas exigências numa expressão só: admin/agente da
-- própria conta não leem (papel abaixo de owner) e ninguém de outra
-- conta lê (a função já é escopada por account_id). A guarda de servidor
-- em /api/account/retention repete a checagem com requireRole('owner')
-- — RLS é o chão, não o único andar.
ALTER TABLE channel_retention_policies ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS channel_retention_select ON channel_retention_policies;
CREATE POLICY channel_retention_select ON channel_retention_policies FOR SELECT
  USING (is_account_member(account_id, 'owner'));
DROP POLICY IF EXISTS channel_retention_insert ON channel_retention_policies;
CREATE POLICY channel_retention_insert ON channel_retention_policies FOR INSERT
  WITH CHECK (is_account_member(account_id, 'owner'));
DROP POLICY IF EXISTS channel_retention_update ON channel_retention_policies;
CREATE POLICY channel_retention_update ON channel_retention_policies FOR UPDATE
  USING (is_account_member(account_id, 'owner'));
DROP POLICY IF EXISTS channel_retention_delete ON channel_retention_policies;
CREATE POLICY channel_retention_delete ON channel_retention_policies FOR DELETE
  USING (is_account_member(account_id, 'owner'));

-- ============================================================
-- 3. message_retention_state — o relógio da varredura, não um log (§3.3)
--
-- Linha única (mesmo truque de `platform_settings`, 067): PRIMARY KEY +
-- CHECK(id) garantem que só existe uma. `running_since` é o claim (NULL
-- = livre); `last_result` guarda o agregado do último ciclo.
-- ============================================================
CREATE TABLE IF NOT EXISTS message_retention_state (
  id            BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
  last_run_at   TIMESTAMPTZ,
  running_since TIMESTAMPTZ,
  last_result   JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO message_retention_state (id) VALUES (TRUE) ON CONFLICT DO NOTHING;

ALTER TABLE message_retention_state ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS message_retention_state_select ON message_retention_state;
-- Restrito a owner (achado de code review, SPEC 060 — revisão da §3.3
-- original, que liberava "qualquer membro autenticado"). A tabela não
-- tem account_id — é um singleton do deployment inteiro —, então
-- "owner" aqui não é escopado a uma conta específica: é qualquer
-- usuário cujo PRÓPRIO papel seja owner em alguma conta, o mesmo nível
-- que /api/account/retention já exige. Sem isto, qualquer agente ou
-- viewer, de qualquer conta, podia ler os totais agregados do último
-- ciclo de limpeza direto do navegador — a rota HTTP já era mais
-- restritiva que a RLS por baixo dela.
CREATE POLICY message_retention_state_select ON message_retention_state
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM profiles
       WHERE profiles.user_id = auth.uid()
         AND profiles.account_role = 'owner'
    )
  );
-- Escrita nenhuma pelo cliente — só service_role (sweep.ts).

-- ============================================================
-- 4. Os dois índices que fazem a varredura ser viável (§3.6)
--
-- O predicado é conversations.account_id + channels.type +
-- messages.created_at, e nenhum índice cobre esse caminho hoje.
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_messages_conversation_created
  ON messages (conversation_id, created_at);

CREATE INDEX IF NOT EXISTS idx_conversations_account_channel
  ON conversations (account_id, channel_id);

-- ============================================================
-- 5. purge_channel_messages — a função que faz o trabalho (§4.1)
--
-- Uma chamada por par (conta × tipo de canal). Recebe os números JÁ
-- RESOLVIDOS — não consulta channel_retention_policies nem conhece o
-- .env. NULL nos parâmetros de limite = sem limite naquela dimensão
-- (a precedência já foi resolvida pelo chamador — src/lib/retention/policy.ts).
--
-- Três fases, nesta ordem: idade, contagem, favoritas-acima-do-teto
-- (rebaixa, D-1). A ordem importa: rodar a fase 3 por último é o que
-- cria o ciclo de carência entre "perdeu a estrela" e "sumiu" — rodá-la
-- primeiro apagaria a favorita rebaixada na MESMA execução.
--
-- p_dry_run: cada fase troca a sentença que modifica por um SELECT
-- count(*) sobre o MESMO predicado (mesma CTE reproduzida, nunca duas
-- consultas que podem divergir).
-- ============================================================
CREATE OR REPLACE FUNCTION purge_channel_messages(
  p_account_id     UUID,
  p_channel_type   TEXT,
  p_max_messages   INTEGER,               -- NULL = sem limite
  p_retention_days INTEGER,               -- NULL = sem limite
  p_max_favorites  INTEGER,               -- NULL = sem limite
  p_min_age_hours  INTEGER DEFAULT 72,
  p_batch_limit    INTEGER DEFAULT 5000,
  p_dry_run        BOOLEAN DEFAULT FALSE
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  -- Piso travado num mínimo absoluto de 24h dentro da PRÓPRIA função
  -- (achado de code review, SPEC 060). Antes, `p_min_age_hours` era
  -- obedecido sem questionar — um `.env` com
  -- `MESSAGE_RETENTION_MIN_AGE_HOURS=1` chegava intacto até aqui,
  -- apesar de o piso ser quem protege a reentrega, o fluxo esperando
  -- resposta, a atribuição de campanha e o contexto de IA (§4.3). Esta
  -- função é o último ponto de decisão — é ela que tem o REVOKE, é ela
  -- que decide o DELETE — então o mínimo tem que valer aqui, não só na
  -- chamada. 24h é bem menor que o padrão de 72h, mas cobre com folga
  -- a mais rápida das quatro proteções (reentrega da Evolution, ~2,5
  -- min) sem impedir um operador de configurar algo mais agressivo que
  -- 72h de propósito.
  v_min_age_hours      INTEGER := GREATEST(p_min_age_hours, 24);
  v_floor              TIMESTAMPTZ := NOW() - make_interval(hours => v_min_age_hours);
  v_cutoff             TIMESTAMPTZ;
  v_by_age             INTEGER := 0;
  v_by_count           INTEGER := 0;
  v_favorites_demoted  INTEGER := 0;
  v_favorites_total    INTEGER := 0;
  v_messages_total     INTEGER := 0;
  v_truncated          BOOLEAN := FALSE;
  v_more_exists        BOOLEAN;
BEGIN
  -- ── Fase 1 — por idade. Só quando retention_days > 0. ──────────────
  IF p_retention_days IS NOT NULL AND p_retention_days > 0 THEN
    v_cutoff := LEAST(NOW() - make_interval(days => p_retention_days), v_floor);

    IF p_dry_run THEN
      SELECT count(*) INTO v_by_age FROM (
        SELECT m.id
          FROM messages m
          JOIN conversations c  ON c.id  = m.conversation_id
          JOIN channels      ch ON ch.id = c.channel_id
         WHERE c.account_id  = p_account_id
           AND ch.type       = p_channel_type
           AND m.is_favorite = FALSE
           AND m.created_at  < v_cutoff
         ORDER BY m.created_at
         LIMIT p_batch_limit
      ) doomed;
    ELSE
      WITH doomed AS (
        SELECT m.id
          FROM messages m
          JOIN conversations c  ON c.id  = m.conversation_id
          JOIN channels      ch ON ch.id = c.channel_id
         WHERE c.account_id  = p_account_id
           AND ch.type       = p_channel_type
           AND m.is_favorite = FALSE
           AND m.created_at  < v_cutoff
         ORDER BY m.created_at
         LIMIT p_batch_limit
      )
      DELETE FROM messages WHERE id IN (SELECT id FROM doomed);
      GET DIAGNOSTICS v_by_age = ROW_COUNT;
    END IF;

    -- Achado de code review: `ROW_COUNT >= p_batch_limit` sozinho não
    -- distingue "bateu o teto e não sobrou nada" de "bateu o teto e
    -- ainda tem mais" — as duas produzem a mesma contagem, porque o
    -- `LIMIT` já cortou antes da contagem existir. Um EXISTS barato
    -- resolve: em dry_run, o mesmo predicado com OFFSET pulando o lote
    -- já contado; depois do DELETE de verdade, o próprio predicado
    -- sozinho já basta — as linhas do lote se foram, então "ainda
    -- existe alguma" já significa "sobrou mais depois do lote".
    IF v_by_age >= p_batch_limit THEN
      IF p_dry_run THEN
        SELECT EXISTS (
          SELECT 1
            FROM messages m
            JOIN conversations c  ON c.id  = m.conversation_id
            JOIN channels      ch ON ch.id = c.channel_id
           WHERE c.account_id  = p_account_id
             AND ch.type       = p_channel_type
             AND m.is_favorite = FALSE
             AND m.created_at  < v_cutoff
           ORDER BY m.created_at
           OFFSET p_batch_limit LIMIT 1
        ) INTO v_more_exists;
      ELSE
        SELECT EXISTS (
          SELECT 1
            FROM messages m
            JOIN conversations c  ON c.id  = m.conversation_id
            JOIN channels      ch ON ch.id = c.channel_id
           WHERE c.account_id  = p_account_id
             AND ch.type       = p_channel_type
             AND m.is_favorite = FALSE
             AND m.created_at  < v_cutoff
           LIMIT 1
        ) INTO v_more_exists;
      END IF;
      v_truncated := v_truncated OR v_more_exists;
    END IF;
  END IF;

  -- ── Fase 2 — por contagem. Só quando max_messages > 0. ─────────────
  -- Desempate por id DESC: created_at empata de verdade quando o
  -- webhook grava um lote, e sem desempate row_number() é
  -- não-determinístico entre execuções.
  IF p_max_messages IS NOT NULL AND p_max_messages > 0 THEN
    IF p_dry_run THEN
      SELECT count(*) INTO v_by_count FROM (
        WITH ranked AS (
          SELECT m.id, m.created_at,
                 row_number() OVER (ORDER BY m.created_at DESC, m.id DESC) AS rn
            FROM messages m
            JOIN conversations c  ON c.id  = m.conversation_id
            JOIN channels      ch ON ch.id = c.channel_id
           WHERE c.account_id  = p_account_id
             AND ch.type       = p_channel_type
             AND m.is_favorite = FALSE
        )
        SELECT id FROM ranked
         WHERE rn > p_max_messages
           AND created_at < v_floor
         ORDER BY rn DESC
         LIMIT p_batch_limit
      ) doomed;
    ELSE
      WITH ranked AS (
        SELECT m.id, m.created_at,
               row_number() OVER (ORDER BY m.created_at DESC, m.id DESC) AS rn
          FROM messages m
          JOIN conversations c  ON c.id  = m.conversation_id
          JOIN channels      ch ON ch.id = c.channel_id
         WHERE c.account_id  = p_account_id
           AND ch.type       = p_channel_type
           AND m.is_favorite = FALSE
      ),
      doomed AS (
        SELECT id FROM ranked
         WHERE rn > p_max_messages
           AND created_at < v_floor          -- o piso vale AQUI também
         ORDER BY rn DESC
         LIMIT p_batch_limit
      )
      DELETE FROM messages WHERE id IN (SELECT id FROM doomed);
      GET DIAGNOSTICS v_by_count = ROW_COUNT;
    END IF;

    IF v_by_count >= p_batch_limit THEN
      WITH ranked AS (
        SELECT m.id, m.created_at,
               row_number() OVER (ORDER BY m.created_at DESC, m.id DESC) AS rn
          FROM messages m
          JOIN conversations c  ON c.id  = m.conversation_id
          JOIN channels      ch ON ch.id = c.channel_id
         WHERE c.account_id  = p_account_id
           AND ch.type       = p_channel_type
           AND m.is_favorite = FALSE
      )
      SELECT EXISTS (
        SELECT 1 FROM ranked WHERE rn > p_max_messages AND created_at < v_floor LIMIT 1
      ) INTO v_more_exists;
      v_truncated := v_truncated OR v_more_exists;
    END IF;
  END IF;

  -- ── Fase 3 — favoritas acima do teto. UPDATE, não DELETE (D-1). ────
  -- As excedentes mais antigas perdem a estrela e voltam para o
  -- conjunto comum, onde as fases 1 e 2 as tratam no CICLO SEGUINTE.
  --
  -- O piso vale AQUI também agora (achado de code review, SPEC 060):
  -- uma favorita mais nova que o piso nunca é rebaixada, mesmo com o
  -- teto estourado — ela só entra na fila de rebaixamento quando
  -- envelhecer o bastante. Antes desta correção, uma favorita de
  -- minutos de idade podia perder a estrela na primeira varredura se o
  -- teto estivesse apertado; o aviso do painel ("mensagens mais novas
  -- que o piso nunca são removidas, não importa como os limites
  -- estejam configurados") já prometia essa proteção sem o SQL
  -- cumprir. O `ranked` continua enxergando TODAS as favoritas (é o
  -- que decide quais N são "as mais novas" a manter); só o `doomed`
  -- ganha o corte de idade, igual à fase 2.
  IF p_max_favorites IS NOT NULL AND p_max_favorites > 0 THEN
    IF p_dry_run THEN
      SELECT count(*) INTO v_favorites_demoted FROM (
        WITH ranked AS (
          SELECT m.id, m.created_at,
                 row_number() OVER (ORDER BY m.created_at DESC, m.id DESC) AS rn
            FROM messages m
            JOIN conversations c  ON c.id  = m.conversation_id
            JOIN channels      ch ON ch.id = c.channel_id
           WHERE c.account_id = p_account_id
             AND ch.type      = p_channel_type
             AND m.is_favorite
        )
        SELECT id FROM ranked
         WHERE rn > p_max_favorites
           AND created_at < v_floor
         ORDER BY rn DESC LIMIT p_batch_limit
      ) doomed;
    ELSE
      WITH ranked AS (
        SELECT m.id, m.created_at,
               row_number() OVER (ORDER BY m.created_at DESC, m.id DESC) AS rn
          FROM messages m
          JOIN conversations c  ON c.id  = m.conversation_id
          JOIN channels      ch ON ch.id = c.channel_id
         WHERE c.account_id = p_account_id
           AND ch.type      = p_channel_type
           AND m.is_favorite
      ),
      doomed AS (
        SELECT id FROM ranked
         WHERE rn > p_max_favorites
           AND created_at < v_floor
         ORDER BY rn DESC LIMIT p_batch_limit
      )
      UPDATE messages
         SET is_favorite = FALSE, favorited_at = NULL, favorited_by = NULL
       WHERE id IN (SELECT id FROM doomed);
      GET DIAGNOSTICS v_favorites_demoted = ROW_COUNT;
    END IF;

    IF v_favorites_demoted >= p_batch_limit THEN
      WITH ranked AS (
        SELECT m.id, m.created_at,
               row_number() OVER (ORDER BY m.created_at DESC, m.id DESC) AS rn
          FROM messages m
          JOIN conversations c  ON c.id  = m.conversation_id
          JOIN channels      ch ON ch.id = c.channel_id
         WHERE c.account_id = p_account_id
           AND ch.type      = p_channel_type
           AND m.is_favorite
      )
      SELECT EXISTS (
        SELECT 1 FROM ranked WHERE rn > p_max_favorites AND created_at < v_floor LIMIT 1
      ) INTO v_more_exists;
      v_truncated := v_truncated OR v_more_exists;
    END IF;
  END IF;

  -- ── Totais para a UI (§8.2 "12.480 de 50.000 mensagens"). ──────────
  -- Em dry_run nada mudou, então isto é o estado atual; num ciclo real,
  -- é o estado JÁ PÓS-limpeza.
  SELECT count(*) INTO v_messages_total
    FROM messages m
    JOIN conversations c  ON c.id  = m.conversation_id
    JOIN channels      ch ON ch.id = c.channel_id
   WHERE c.account_id = p_account_id AND ch.type = p_channel_type;

  SELECT count(*) INTO v_favorites_total
    FROM messages m
    JOIN conversations c  ON c.id  = m.conversation_id
    JOIN channels      ch ON ch.id = c.channel_id
   WHERE c.account_id = p_account_id AND ch.type = p_channel_type AND m.is_favorite;

  RETURN jsonb_build_object(
    'by_age', v_by_age,
    'by_count', v_by_count,
    'favorites_demoted', v_favorites_demoted,
    'favorites_total', v_favorites_total,
    'messages_total', v_messages_total,
    'truncated', v_truncated
  );
END;
$$;
ALTER FUNCTION purge_channel_messages(UUID, TEXT, INTEGER, INTEGER, INTEGER, INTEGER, INTEGER, BOOLEAN) OWNER TO postgres;

-- Só service_role executa (§4.2) — a prévia do painel passa por
-- /api/account/retention/preview, que resolve o chamador e injeta o
-- account_id dele; sem este REVOKE, um agente com o DevTools aberto
-- teria um rpc() capaz de apagar o histórico da conta.
REVOKE ALL ON FUNCTION purge_channel_messages(
  UUID, TEXT, INTEGER, INTEGER, INTEGER, INTEGER, INTEGER, BOOLEAN
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION purge_channel_messages(
  UUID, TEXT, INTEGER, INTEGER, INTEGER, INTEGER, INTEGER, BOOLEAN
) TO service_role;

-- ============================================================
-- 6. Asserções finais — falham alto de propósito (§3.5 + padrão da casa)
-- ============================================================
DO $$
DECLARE
  v_rule TEXT;
BEGIN
  -- O que o schema já resolve (§3.5): reações em cascata, resposta
  -- perde a citação, fluxo perde a âncora. A SPEC inteira depende
  -- destas três FKs estarem exatamente assim — um fork que rodou as
  -- migrações fora de ordem descobriria isso apagando dados.
  SELECT rc.delete_rule INTO v_rule
    FROM information_schema.referential_constraints rc
    JOIN information_schema.key_column_usage k ON k.constraint_name = rc.constraint_name
   WHERE k.table_name = 'message_reactions' AND k.column_name = 'message_id';
  IF v_rule IS DISTINCT FROM 'CASCADE' THEN
    RAISE EXCEPTION '068: message_reactions.message_id nao esta ON DELETE CASCADE (esta: %). A limpeza deixaria reacoes orfas.', v_rule;
  END IF;

  SELECT rc.delete_rule INTO v_rule
    FROM information_schema.referential_constraints rc
    JOIN information_schema.key_column_usage k ON k.constraint_name = rc.constraint_name
   WHERE k.table_name = 'messages' AND k.column_name = 'reply_to_message_id';
  IF v_rule IS DISTINCT FROM 'SET NULL' THEN
    RAISE EXCEPTION '068: messages.reply_to_message_id nao esta ON DELETE SET NULL (esta: %).', v_rule;
  END IF;

  -- Nota: a tabela chama-se `flow_runs` (migração 010) — a SPEC 060 a
  -- refere por engano como `flow_executions` em §2/§3.5/§4.3; o nome
  -- real é o que importa aqui.
  SELECT rc.delete_rule INTO v_rule
    FROM information_schema.referential_constraints rc
    JOIN information_schema.key_column_usage k ON k.constraint_name = rc.constraint_name
   WHERE k.table_name = 'flow_runs' AND k.column_name = 'last_prompt_message_id';
  IF v_rule IS DISTINCT FROM 'SET NULL' THEN
    RAISE EXCEPTION '068: flow_runs.last_prompt_message_id nao esta ON DELETE SET NULL (esta: %).', v_rule;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM message_retention_state WHERE id) THEN
    RAISE EXCEPTION '068: message_retention_state nao foi semeada.';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'channel_retention_policies'
      AND qual NOT LIKE '%owner%'
  ) THEN
    RAISE EXCEPTION '068: policy de channel_retention_policies sem restricao a owner encontrada.';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'message_retention_state' AND cmd <> 'SELECT'
  ) THEN
    RAISE EXCEPTION '068: policy de escrita pelo cliente encontrada em message_retention_state.';
  END IF;

  -- Achado de code review: a leitura de message_retention_state foi
  -- restrita a owner (revisão da §3.3 original) — confere que a policy
  -- de SELECT carrega essa restrição, no mesmo padrão da checagem de
  -- channel_retention_policies acima.
  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'message_retention_state'
      AND cmd = 'SELECT'
      AND qual NOT LIKE '%owner%'
  ) THEN
    RAISE EXCEPTION '068: policy de leitura de message_retention_state sem restricao a owner encontrada.';
  END IF;

  -- REVOKE de purge_channel_messages: nenhum privilégio de EXECUTE deve
  -- sobrar para anon/authenticated/PUBLIC.
  IF EXISTS (
    SELECT 1
      FROM information_schema.routine_privileges
     WHERE routine_name = 'purge_channel_messages'
       AND grantee IN ('anon', 'authenticated', 'PUBLIC')
  ) THEN
    RAISE EXCEPTION '068: purge_channel_messages ainda concede EXECUTE a anon/authenticated/PUBLIC.';
  END IF;

  -- Achado de code review: o piso tem que estar travado num mínimo
  -- absoluto DENTRO da função — não basta o TypeScript "sugerir" um
  -- valor sensato. Checagem heurística: o texto-fonte da função
  -- precisa conter o clamp.
  IF pg_get_functiondef(
       'purge_channel_messages(uuid, text, integer, integer, integer, integer, integer, boolean)'::regprocedure
     ) NOT LIKE '%GREATEST(p_min_age_hours%' THEN
    RAISE EXCEPTION '068: purge_channel_messages nao trava p_min_age_hours num minimo absoluto.';
  END IF;

  RAISE NOTICE '068: message_retention aplicada — nenhuma mensagem apagada por esta migracao.';
END $$;
