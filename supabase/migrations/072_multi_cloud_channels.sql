-- ============================================================
-- 072_multi_cloud_channels.sql — múltiplos números oficiais por conta
-- SPEC 064 §3 (F1)
--
-- O princípio, em uma linha:
--
--   A credencial oficial deixa de ser propriedade da CONTA e passa a
--   ser propriedade do CANAL.
--
-- O que isto derruba, conserta e cria
--
--   1. Derruba as restrições que impedem o segundo número oficial:
--      `whatsapp_config_account_id_key` (017) e
--      `idx_channels_one_cloud_per_account` (055).
--   2. Troca o padrão-por-conta por padrão-por-TIPO (D-11). Numa conta
--      com QRCode e dois oficiais, "o Cloud padrão" precisa existir.
--   3. Fecha o bug §1.1.E.1: toda `whatsapp_config` passa a ter canal
--      (`channel_id NOT NULL UNIQUE`), inclusive as órfãs que
--      `POST /api/whatsapp/config` criou depois do backfill da 055.
--   4. Conserta os DOIS pontos que falham em SILÊNCIO com dois números:
--      o cooldown de campanha (§1.1.C.1, seção 6 abaixo) e a cota de
--      24 h da Meta (§1.1.C.2, seção 9) — ambos resolviam por conta e
--      passariam a misturar os dois números sem erro nenhum.
--   5. Templates passam a ser por WABA (D-2) — é assim que a Meta os
--      guarda, e dois números do mesmo WABA veem a mesma lista.
--   6. Quota de canal vira trigger no banco (D-5), cobrindo Cloud e
--      QRCode: `channels_whatsapp_cloud` passa a valer N, não 0|1.
--   7. `set_default_channel` (§6.1) — a ÚNICA forma de escrever
--      `is_default` fora desta migração, e ela é por tipo.
--
-- A ORDEM DAS SEÇÕES IMPORTA
--
--   A seção 1 derruba as restrições ANTES do backfill da 2 (marcar o
--   padrão de um segundo tipo violaria o índice antigo), e a trigger de
--   quota da seção 7 nasce só DEPOIS de todo `INSERT INTO channels` —
--   senão a própria migração seria barrada pela quota numa conta cujo
--   plano já limite canais (§9, armadilha 8).
--
-- DESVIOS DELIBERADOS DO TEXTO DA SPEC — cada um comentado no lugar
-- onde acontece:
--   * seção 4    — índice de templates em colunas simples com
--                  `NULLS NOT DISTINCT`, não índice de expressão (o
--                  `on_conflict` do PostgREST não infere expressão);
--   * seção 2(b) — a eleição de padrão ignora canais `disabled`, e a
--                  7.1 acrescenta as triggers que impedem o padrão de
--                  ficar preso num canal desativado;
--   * seção 5    — o FK de `broadcasts.channel_id` é `ON DELETE SET
--                  NULL`, senão o DELETE de canal que o D-12 promete
--                  esbarra em campanhas antigas;
--   * seção 6    — o cooldown cai no Cloud da conta quando a campanha
--                  saiu por um canal QRCode, que não tem credencial
--                  própria (a versão da SPEC caía no default 7 mudo);
--   * seção 6    — nomes reais das três funções de triagem.
--
-- Idempotente — seguro rodar múltiplas vezes.
-- ============================================================


-- ============================================================
-- 1) DERRUBAR AS RESTRIÇÕES DE SINGLETON (§3.1)
--
-- O comentário que a 055 deixou no índice do Cloud dizia, literalmente,
-- que ele cairia junto com o UNIQUE(account_id) quando o produto
-- suportasse múltiplos números. É aqui.
-- ============================================================
ALTER TABLE whatsapp_config DROP CONSTRAINT IF EXISTS whatsapp_config_account_id_key;
DROP INDEX IF EXISTS idx_channels_one_cloud_per_account;

-- D-11: o padrão passa a ser por (conta, tipo). O DROP vem ANTES do
-- backfill de padrões (2b) — marcar o padrão de um segundo tipo
-- violaria o índice antigo, que é único por conta através de todos os
-- tipos.
DROP INDEX IF EXISTS idx_channels_one_default_per_account;
CREATE UNIQUE INDEX IF NOT EXISTS idx_channels_one_default_per_account_type
  ON channels (account_id, type) WHERE is_default;

COMMENT ON INDEX idx_channels_one_default_per_account_type IS
  'Um canal padrao por (conta, tipo) — SPEC 064 D-11. O padrao "da conta" e DERIVADO (Cloud vence QR), nao armazenado.';


-- ============================================================
-- 2) TODA CONFIG PASSA A TER CANAL (§3.2 — fecha o bug §1.1.E.1)
--
-- `POST /api/whatsapp/config` nunca criou linha em `channels`: todo
-- canal Cloud em produção veio do backfill da 055. Uma conta criada
-- DEPOIS dele que conecta o número oficial fica com
-- `whatsapp_config.channel_id = NULL` e sem canal — e
-- `resolveDefaultChannelId` lança `ChannelNotConfiguredError`. A F4
-- conserta a rota; esta seção conserta os dados que ela já deixou.
-- ============================================================

-- ------------------------------------------------------------
-- (a) Um canal por config órfã — em LAÇO, não em `INSERT … SELECT`.
--
-- O vínculo config→canal precisa ser 1:1 e determinístico. Um
-- `INSERT … SELECT` seguido de `UPDATE … FROM channels ON
-- (account_id, type)` casaria por chave ambígua assim que a conta
-- tivesse dois canais Cloud — duas configs poderiam apontar para o
-- mesmo canal e violar o UNIQUE(channel_id) da etapa (c). O laço
-- amarra cada config ao canal que ele acabou de criar, via RETURNING.
-- ------------------------------------------------------------
DO $$
DECLARE
  r            RECORD;
  v_channel_id UUID;
  v_seq        INT;
BEGIN
  FOR r IN SELECT id, account_id, user_id, phone_number_id, registered_at
             FROM whatsapp_config
            WHERE channel_id IS NULL
            ORDER BY created_at
  LOOP
    -- Rótulo distinto por número: o backfill da 055 nomeava tudo
    -- "WhatsApp Oficial", e dois itens homônimos na lista e no filtro
    -- do inbox são indistinguíveis para o operador.
    --
    -- Contador sequencial, e NÃO um sufixo derivado do
    -- phone_number_id: ele é um id opaco da Meta, e nada garante que
    -- dois números da mesma conta difiram nos últimos dígitos — o
    -- sufixo repetiria e recriaria a ambiguidade que existe para
    -- evitar. O operador renomeia na F7; aqui só precisa ser único e
    -- legível.
    SELECT count(*) INTO v_seq
      FROM channels
     WHERE account_id = r.account_id AND type = 'whatsapp_cloud';

    INSERT INTO channels (account_id, user_id, type, name, identifier,
                          status, is_default, connected_at)
    VALUES (r.account_id, r.user_id, 'whatsapp_cloud',
            CASE WHEN v_seq = 0 THEN 'WhatsApp Oficial'
                 ELSE 'WhatsApp Oficial ' || (v_seq + 1) END,
            r.phone_number_id,
            CASE WHEN r.registered_at IS NOT NULL THEN 'connected' ELSE 'disconnected' END,
            -- O padrão é decidido em (b), nunca aqui. A trigger
            -- `claim_default_on_insert_trg` faria isto sozinha, mas ela
            -- só nasce na seção 7.1 — depois deste laço, de propósito,
            -- pela mesma disciplina da trigger de quota.
            FALSE,
            r.registered_at)
    RETURNING id INTO v_channel_id;

    UPDATE whatsapp_config SET channel_id = v_channel_id WHERE id = r.id;
  END LOOP;
END $$;

-- ------------------------------------------------------------
-- (b) Um padrão por (conta, tipo), determinístico.
--
-- Mantém quem já é padrão e elege onde falta, preferindo canal
-- conectado e, no empate, o mais antigo.
--
-- ⚠️ DESVIO DELIBERADO DO §3.2(b): canais `disabled` NÃO entram na
-- eleição nem contam como "tipo que precisa de padrão". O texto da
-- SPEC não os filtra, mas D-12 diz que um canal desativado não ocupa
-- vaga e §6.1 faz `set_default_channel` RECUSAR promover um canal
-- `disabled` — eleger um aqui criaria, no dia da migração, um estado
-- que a própria RPC considera inválido e que nenhuma tela conseguiria
-- desfazer sem reativar o canal antes. Um tipo cujos canais estão
-- todos desativados fica sem padrão de propósito: não há por onde
-- enviar, e `resolveDefaultChannelId` lançar ali é a resposta certa.
-- A asserção da seção 10 usa exatamente o mesmo filtro, para que
-- verificação e eleição não divirjam.
--
-- Por isso o passo abaixo vem PRIMEIRO: um canal que já estava
-- `disabled` segurando `is_default` ocuparia a vaga única do seu tipo
-- (o índice é parcial `WHERE is_default`), e a eleição seguinte veria
-- "já tem padrão" e não elegeria ninguém — deixando o tipo com o padrão
-- pinado num canal que não pode enviar. A trigger da seção 7.1 mantém
-- essa invariante daqui pra frente; esta linha conserta o que já existe.
-- ------------------------------------------------------------
UPDATE channels SET is_default = FALSE
 WHERE is_default AND status = 'disabled';

WITH faltando AS (
  SELECT c.id,
         ROW_NUMBER() OVER (PARTITION BY c.account_id, c.type
                            ORDER BY (c.status = 'connected') DESC, c.created_at ASC) AS rn
    FROM channels c
   WHERE c.status <> 'disabled'
     AND NOT EXISTS (SELECT 1 FROM channels d
                      WHERE d.account_id = c.account_id
                        AND d.type = c.type
                        AND d.is_default)
)
UPDATE channels SET is_default = TRUE
  FROM faltando
 WHERE channels.id = faltando.id AND faltando.rn = 1;

-- ------------------------------------------------------------
-- (c) Apertar a coluna — com a guarda de idempotência do padrão
-- 017:320-327, porque `ADD CONSTRAINT` não aceita `IF NOT EXISTS`.
--
-- O FK `ON DELETE CASCADE` já existe desde a 055: apagar o canal apaga
-- a credencial junto (D-1).
-- ------------------------------------------------------------
ALTER TABLE whatsapp_config ALTER COLUMN channel_id SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'whatsapp_config_channel_id_key'
                    AND conrelid = 'public.whatsapp_config'::regclass) THEN
    ALTER TABLE whatsapp_config
      ADD CONSTRAINT whatsapp_config_channel_id_key UNIQUE (channel_id);
  END IF;
END $$;

COMMENT ON COLUMN whatsapp_config.channel_id IS
  'Canal Cloud dono desta credencial — 1:1 (SPEC 064 D-1). Deixou de haver "a config da conta": a pergunta certa e sempre por qual CANAL.';


-- ============================================================
-- 3) channels.identifier passa a guardar o TELEFONE (§3.3 / D-9)
--
-- O backfill da 055 gravou `identifier = phone_number_id`, e
-- `transfer-channel-dialog.tsx` já roda `formatPhoneForDisplay()` nesse
-- valor — o diálogo exibe hoje um id opaco da Meta formatado como se
-- fosse telefone (§1.1.E.2).
--
-- A migração NÃO troca o valor: converter exige falar com a Graph API,
-- e migração que precisa de token da Meta não é migração. A troca
-- acontece na F4, nos dois pontos que já chamam `verifyPhoneNumber` e
-- recebem `display_phone_number` — o POST de config e o GET de
-- diagnóstico, que passa a reconciliar. Aqui só se registra o contrato.
-- ============================================================
COMMENT ON COLUMN channels.identifier IS
  'Telefone E.164 de exibicao do canal. Canais Cloud criados ate a 072 podem ainda guardar o phone_number_id da Meta — a F4 reconcilia no POST/GET de config (SPEC 064 D-9). Nenhuma tela deve formatar este valor como telefone sem checar.';


-- ============================================================
-- 4) TEMPLATES POR WABA (§3.4 / D-2)
--
-- Na Meta, template pertence ao WABA, não ao número: dois números do
-- mesmo WABA enxergam exatamente os mesmos templates aprovados.
-- Guardar por `channel_id` duplicaria cada template na lista e faria a
-- sincronização criar duas linhas locais para uma única entidade
-- remota.
-- ============================================================
ALTER TABLE message_templates ADD COLUMN IF NOT EXISTS waba_id TEXT;

COMMENT ON COLUMN message_templates.waba_id IS
  'WABA dono do template (SPEC 064 D-2). NULL = linha legada, tratada como pertencente ao WABA do canal Cloud padrao ate a proxima sincronizacao preencher.';

-- Backfill determinístico: a config mais antiga da conta. Quando esta
-- migração roda, toda conta ainda tem no máximo uma; o DISTINCT ON
-- existe para a migração continuar reexecutável depois que a segunda
-- linha existir.
UPDATE message_templates t
   SET waba_id = src.waba_id
  FROM (SELECT DISTINCT ON (account_id) account_id, waba_id
          FROM whatsapp_config
         ORDER BY account_id, created_at) src
 WHERE src.account_id = t.account_id
   AND t.waba_id IS NULL;

-- ------------------------------------------------------------
-- Pré-checagem obrigatória antes de trocar o índice.
--
-- O índice antigo é por `user_id`; dois membros da MESMA conta podem
-- ter hoje, legalmente, um template com o mesmo `name` + `language`. O
-- índice novo é por conta e FALHARIA, abortando a migração inteira com
-- um erro do Postgres que não diz o que fazer. Mesmo padrão amigável
-- das 013/014.
-- ------------------------------------------------------------
DO $$
DECLARE v_dups TEXT;
BEGIN
  SELECT string_agg(format('%s | %s | %s (%s linhas)', d.account_id, d.name, d.language, d.n), E'\n  ')
    INTO v_dups
    FROM (SELECT account_id, COALESCE(waba_id, '') AS w, name, language, count(*) AS n
            FROM message_templates
           GROUP BY 1, 2, 3, 4
          HAVING count(*) > 1) d;

  IF v_dups IS NOT NULL THEN
    RAISE EXCEPTION
      E'072: nao e possivel criar UNIQUE(account_id, waba_id, name, language) — combinacoes duplicadas:\n  %\nApague as linhas que nao quer manter e rode a migracao de novo.',
      v_dups;
  END IF;
END $$;

DROP INDEX IF EXISTS message_templates_user_name_language_key;

-- ⚠️ DESVIO DELIBERADO DO §3.4: `NULLS NOT DISTINCT` em colunas
-- simples, em vez do índice de EXPRESSÃO `(account_id,
-- COALESCE(waba_id,''), name, language)` que a SPEC escreve.
--
-- A semântica é idêntica — duas linhas legadas (waba_id NULL) do mesmo
-- nome+idioma na mesma conta colidem em ambos. O que muda é quem
-- consegue apontar para o índice: o PostgREST monta `ON CONFLICT
-- (<colunas>)` a partir do parâmetro `on_conflict` e NÃO sabe emitir
-- uma expressão. Com o índice de expressão, `templates/submit`
-- continuaria devolvendo 42P10 depois da troca do `onConflict` —
-- exatamente a quebra que a F1 existe para evitar ("salvar template
-- continua funcionando no mesmo deploy"). `NULLS NOT DISTINCT` exige
-- Postgres 15+; este banco roda 17.
CREATE UNIQUE INDEX IF NOT EXISTS message_templates_account_waba_name_language_key
  ON message_templates (account_id, waba_id, name, language) NULLS NOT DISTINCT;

COMMENT ON INDEX message_templates_account_waba_name_language_key IS
  'Um template por (conta, WABA, nome, idioma) — SPEC 064 D-2. NULLS NOT DISTINCT trata as linhas legadas (waba_id NULL) como uma so e mantem o indice inferivel pelo on_conflict do PostgREST.';


-- ============================================================
-- 5) CAMPANHA POR CANAL (§3.5 / D-3)
--
-- Sem backfill e sem NOT NULL: `NULL` significa uma coisa só —
-- "campanha anterior à F6". Da F6 em diante, toda campanha nasce com o
-- canal RESOLVIDO NA CRIAÇÃO, o que evita o pior caso: uma campanha
-- agendada para daqui a três dias sair por um número diferente porque
-- alguém trocou o padrão da conta no meio do caminho.
-- ============================================================
-- `ON DELETE SET NULL`, e nao o NO ACTION implicito: o D-12 promete que
-- um canal SEM CONVERSAS e apagado de verdade (o caso de quem conectou
-- o numero errado e quer refazer), e um FK rigido aqui faria esse DELETE
-- voltar um 23503 cru para qualquer canal que ja tivesse UMA campanha —
-- inclusive uma campanha de teste que falhou em todos os destinatarios e
-- portanto nao criou conversa nenhuma. Com SET NULL a campanha sobrevive
-- ao canal e volta a ser tratada como campanha legada, que e exatamente
-- o que ela passa a ser: as funcoes de cooldown (secao 6) e de cota
-- (secao 9) ja lidam com `channel_id NULL`. Historico de campanha nao se
-- perde por causa de troca de numero.
ALTER TABLE broadcasts ADD COLUMN IF NOT EXISTS channel_id UUID;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'broadcasts_channel_id_fkey'
                AND conrelid = 'public.broadcasts'::regclass
                AND confdeltype <> 'n') THEN          -- 'n' = SET NULL
    ALTER TABLE broadcasts DROP CONSTRAINT broadcasts_channel_id_fkey;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'broadcasts_channel_id_fkey'
                    AND conrelid = 'public.broadcasts'::regclass) THEN
    ALTER TABLE broadcasts
      ADD CONSTRAINT broadcasts_channel_id_fkey
      FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_broadcasts_channel ON broadcasts(channel_id);

COMMENT ON COLUMN broadcasts.channel_id IS
  'Numero por onde a campanha sai, resolvido e GRAVADO na criacao (SPEC 064 D-3). NULL = campanha anterior a F6.';


-- ============================================================
-- 6) AS TRÊS FUNÇÕES DE TRIAGEM RESOLVEM O COOLDOWN POR CANAL
--    (§3.6 — conserta o §1.1.C.1, que falha em SILÊNCIO)
--
-- As três faziam `LEFT JOIN whatsapp_config wc ON wc.account_id =
-- b.account_id`. Com duas configs, pegam UMA LINHA ARBITRÁRIA e a
-- triagem aplica o cooldown de um número às campanhas do outro. Sem
-- erro, sem log — e nenhum teste automatizado pegaria, porque o número
-- exibido continua plausível.
--
-- Mesma assinatura, mesmo SECURITY INVOKER, mesmo `search_path`: muda
-- só POR ONDE SE LÊ. `broadcast_cooldown_days` continua morando na
-- linha de `whatsapp_config` — que agora é por canal (D-4, "sem coluna
-- nova").
--
-- ⚠️ Nomenclatura: a SPEC chama estas funções de `broadcast_audience_*`.
-- Os nomes reais, criados pela 046 e recriados pela 050, são
-- `triage_audience_page`, `audience_engagement_summary` e
-- `triage_set_selection`. As asserções da seção 10 checam os nomes
-- REAIS.
--
-- A resolução, idêntica nas três:
--
--   canal gravado na campanha (F6+)  →  senão o Cloud padrão da conta
--   →  senão o Cloud mais antigo  →  senão o DEFAULT 7.
--
-- O fallback existe só para campanhas legadas (`channel_id NULL`) e
-- ordena por `is_default DESC, created_at ASC` para nunca depender da
-- ordem física das linhas.
-- ============================================================

CREATE OR REPLACE FUNCTION public.triage_audience_page(
  p_draft_id UUID,
  p_search   TEXT DEFAULT NULL,
  p_filter   TEXT DEFAULT 'all',
  p_limit    INT  DEFAULT 50,
  p_offset   INT  DEFAULT 0
)
RETURNS TABLE (
  id                 UUID,
  phone              TEXT,
  name               TEXT,
  email              TEXT,
  company            TEXT,
  selected           BOOLEAN,
  invalid_reason     TEXT,
  source_row         INTEGER,
  is_new             BOOLEAN,
  existing_contact_id UUID,
  campaigns_received BIGINT,
  last_delivered_at  TIMESTAMPTZ,
  last_sent_at       TIMESTAMPTZ,
  has_read           BOOLEAN,
  has_replied        BOOLEAN,
  failure_count      BIGINT,
  tag_names          TEXT[],
  opt_in_status      TEXT,
  is_opted_out       BOOLEAN,
  total_count        BIGINT
)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_cooldown_days INT;
BEGIN
  PERFORM triage_assert_filter(p_filter);

  -- SPEC 064 §3.6: cooldown por CANAL, não por conta.
  SELECT COALESCE(wc.broadcast_cooldown_days, 7) INTO v_cooldown_days
    FROM broadcasts b
    LEFT JOIN whatsapp_config wc
      ON wc.channel_id = COALESCE(
           -- Canal gravado na campanha, MAS so se for Cloud: um canal
           -- QRCode nao tem linha em whatsapp_config, e usa-lo aqui
           -- faria o LEFT JOIN nao casar e o COALESCE(...,7) assumir em
           -- silencio — a campanha do QR ignoraria o cooldown que o
           -- operador configurou. Cai no Cloud da conta nesse caso.
           (SELECT c.id FROM channels c
             WHERE c.id = b.channel_id AND c.type = 'whatsapp_cloud'),
           (SELECT c.id FROM channels c
             WHERE c.account_id = b.account_id AND c.type = 'whatsapp_cloud'
             ORDER BY c.is_default DESC, c.created_at ASC LIMIT 1))
   WHERE b.id = p_draft_id;
  v_cooldown_days := COALESCE(v_cooldown_days, 7);

  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 200 THEN
    p_limit := 50;
  END IF;
  IF p_offset IS NULL OR p_offset < 0 THEN
    p_offset := 0;
  END IF;

  RETURN QUERY
  WITH filtered AS (
    SELECT v.*, count(*) OVER() AS total_count
    FROM broadcast_audience_triage v
    WHERE v.broadcast_id = p_draft_id
      AND triage_row_matches(
            p_filter, p_search,
            v.name, v.phone, v.selected, v.invalid_reason, v.is_new,
            v.campaigns_received, v.has_read, v.has_replied,
            v.failure_count, v.last_replied_at, v.last_sent_at,
            v.is_opted_out, v_cooldown_days
          )
  )
  SELECT
    f.id, f.phone, f.name, f.email, f.company,
    f.selected, f.invalid_reason, f.source_row,
    f.is_new, f.existing_contact_id,
    f.campaigns_received, f.last_delivered_at, f.last_sent_at,
    f.has_read, f.has_replied, f.failure_count,
    f.tag_names, f.opt_in_status, f.is_opted_out, f.total_count
  FROM filtered f
  ORDER BY f.source_row NULLS LAST, f.created_at, f.id
  LIMIT p_limit OFFSET p_offset;
END;
$$;

ALTER FUNCTION public.triage_audience_page(UUID, TEXT, TEXT, INT, INT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.triage_audience_page(UUID, TEXT, TEXT, INT, INT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.triage_audience_page(UUID, TEXT, TEXT, INT, INT) FROM anon;
GRANT EXECUTE ON FUNCTION public.triage_audience_page(UUID, TEXT, TEXT, INT, INT)
  TO authenticated, service_role;

COMMENT ON FUNCTION public.triage_audience_page(UUID, TEXT, TEXT, INT, INT) IS
  'Uma pagina da tabela de triagem. SECURITY INVOKER. Cooldown resolvido por CANAL na 072 (SPEC 064 §3.6).';


CREATE OR REPLACE FUNCTION public.audience_engagement_summary(
  p_draft_id UUID,
  p_search   TEXT DEFAULT NULL,
  p_filter   TEXT DEFAULT 'all'
)
RETURNS TABLE (
  total_rows          BIGINT,
  selected_rows       BIGINT,
  valid_rows          BIGINT,
  invalid_rows        BIGINT,
  new_contacts        BIGINT,
  existing_contacts   BIGINT,
  ever_contacted      BIGINT,
  ever_read           BIGINT,
  ever_replied        BIGINT,
  never_delivered     BIGINT,
  problematic         BIGINT,
  in_cooldown         BIGINT,
  opted_out_rows      BIGINT,
  selected_valid_rows BIGINT,
  sendable_rows       BIGINT
)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_cooldown_days INT;
BEGIN
  PERFORM triage_assert_filter(p_filter);

  -- SPEC 064 §3.6: cooldown por CANAL, não por conta.
  SELECT COALESCE(wc.broadcast_cooldown_days, 7) INTO v_cooldown_days
    FROM broadcasts b
    LEFT JOIN whatsapp_config wc
      ON wc.channel_id = COALESCE(
           -- Canal gravado na campanha, MAS so se for Cloud: um canal
           -- QRCode nao tem linha em whatsapp_config, e usa-lo aqui
           -- faria o LEFT JOIN nao casar e o COALESCE(...,7) assumir em
           -- silencio — a campanha do QR ignoraria o cooldown que o
           -- operador configurou. Cai no Cloud da conta nesse caso.
           (SELECT c.id FROM channels c
             WHERE c.id = b.channel_id AND c.type = 'whatsapp_cloud'),
           (SELECT c.id FROM channels c
             WHERE c.account_id = b.account_id AND c.type = 'whatsapp_cloud'
             ORDER BY c.is_default DESC, c.created_at ASC LIMIT 1))
   WHERE b.id = p_draft_id;
  v_cooldown_days := COALESCE(v_cooldown_days, 7);

  RETURN QUERY
  WITH filtered AS (
    SELECT v.*
    FROM broadcast_audience_triage v
    WHERE v.broadcast_id = p_draft_id
      AND triage_row_matches(
            p_filter, p_search,
            v.name, v.phone, v.selected, v.invalid_reason, v.is_new,
            v.campaigns_received, v.has_read, v.has_replied,
            v.failure_count, v.last_replied_at, v.last_sent_at,
            v.is_opted_out, v_cooldown_days
          )
  )
  SELECT
    count(*)                                                          AS total_rows,
    count(*) FILTER (WHERE f.selected)                                AS selected_rows,
    count(*) FILTER (WHERE f.invalid_reason IS NULL)                  AS valid_rows,
    count(*) FILTER (WHERE f.invalid_reason IS NOT NULL)              AS invalid_rows,
    count(*) FILTER (WHERE f.is_new AND f.invalid_reason IS NULL)      AS new_contacts,
    count(*) FILTER (WHERE NOT f.is_new AND f.invalid_reason IS NULL)  AS existing_contacts,
    count(*) FILTER (WHERE f.campaigns_received > 0)                  AS ever_contacted,
    count(*) FILTER (WHERE f.has_read)                                AS ever_read,
    count(*) FILTER (WHERE f.has_replied)                             AS ever_replied,
    count(*) FILTER (
      WHERE NOT f.is_new AND f.last_delivered_at IS NULL
    )                                                                 AS never_delivered,
    count(*) FILTER (WHERE f.failure_count >= 2)                      AS problematic,
    count(*) FILTER (
      WHERE v_cooldown_days > 0
        AND f.last_sent_at >= NOW() - make_interval(days => v_cooldown_days)
    )                                                                 AS in_cooldown,
    count(*) FILTER (WHERE f.is_opted_out)                            AS opted_out_rows,
    count(*) FILTER (
      WHERE f.selected AND f.invalid_reason IS NULL
    )                                                                 AS selected_valid_rows,
    count(*) FILTER (
      WHERE f.selected AND f.invalid_reason IS NULL AND NOT f.is_opted_out
    )                                                                 AS sendable_rows
  FROM filtered f;
END;
$$;

ALTER FUNCTION public.audience_engagement_summary(UUID, TEXT, TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.audience_engagement_summary(UUID, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.audience_engagement_summary(UUID, TEXT, TEXT) FROM anon;
GRANT EXECUTE ON FUNCTION public.audience_engagement_summary(UUID, TEXT, TEXT)
  TO authenticated, service_role;

COMMENT ON FUNCTION public.audience_engagement_summary(UUID, TEXT, TEXT) IS
  'Agregados da audiencia staged. Cooldown resolvido por CANAL na 072 (SPEC 064 §3.6).';


CREATE OR REPLACE FUNCTION public.triage_set_selection(
  p_draft_id UUID,
  p_selected BOOLEAN,
  p_search   TEXT DEFAULT NULL,
  p_filter   TEXT DEFAULT 'all'
)
RETURNS BIGINT
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_changed       BIGINT;
  v_cooldown_days INT;
BEGIN
  IF p_selected IS NULL THEN
    RAISE EXCEPTION 'p_selected is required'
      USING ERRCODE = '22023';
  END IF;

  PERFORM triage_assert_filter(p_filter);

  -- SPEC 064 §3.6: cooldown por CANAL, não por conta.
  SELECT COALESCE(wc.broadcast_cooldown_days, 7) INTO v_cooldown_days
    FROM broadcasts b
    LEFT JOIN whatsapp_config wc
      ON wc.channel_id = COALESCE(
           -- Canal gravado na campanha, MAS so se for Cloud: um canal
           -- QRCode nao tem linha em whatsapp_config, e usa-lo aqui
           -- faria o LEFT JOIN nao casar e o COALESCE(...,7) assumir em
           -- silencio — a campanha do QR ignoraria o cooldown que o
           -- operador configurou. Cai no Cloud da conta nesse caso.
           (SELECT c.id FROM channels c
             WHERE c.id = b.channel_id AND c.type = 'whatsapp_cloud'),
           (SELECT c.id FROM channels c
             WHERE c.account_id = b.account_id AND c.type = 'whatsapp_cloud'
             ORDER BY c.is_default DESC, c.created_at ASC LIMIT 1))
   WHERE b.id = p_draft_id;
  v_cooldown_days := COALESCE(v_cooldown_days, 7);

  WITH target AS (
    SELECT v.id
    FROM broadcast_audience_triage v
    WHERE v.broadcast_id = p_draft_id
      AND triage_row_matches(
            p_filter, p_search,
            v.name, v.phone, v.selected, v.invalid_reason, v.is_new,
            v.campaigns_received, v.has_read, v.has_replied,
            v.failure_count, v.last_replied_at, v.last_sent_at,
            v.is_opted_out, v_cooldown_days
          )
  ),
  updated AS (
    UPDATE broadcast_audience_staging s
       SET selected = p_selected
      FROM target
     WHERE s.id = target.id
       AND s.selected IS DISTINCT FROM p_selected
    RETURNING s.id
  )
  SELECT count(*) INTO v_changed FROM updated;

  RETURN COALESCE(v_changed, 0);
END;
$$;

ALTER FUNCTION public.triage_set_selection(UUID, BOOLEAN, TEXT, TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.triage_set_selection(UUID, BOOLEAN, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.triage_set_selection(UUID, BOOLEAN, TEXT, TEXT) FROM anon;
GRANT EXECUTE ON FUNCTION public.triage_set_selection(UUID, BOOLEAN, TEXT, TEXT)
  TO authenticated, service_role;

COMMENT ON FUNCTION public.triage_set_selection(UUID, BOOLEAN, TEXT, TEXT) IS
  'Marca/desmarca em massa (§5.3). Cooldown resolvido por CANAL na 072 (SPEC 064 §3.6).';


-- ============================================================
-- 7) TRIGGER DE QUOTA DE CANAL (§3.7 / D-5)
--
-- Hoje a quota de canal é checada em TypeScript, em dois lugares e de
-- duas formas diferentes: `config/route.ts` (só compara `=== 0`) e
-- `evolution/instances.ts`. O princípio da SPEC 059 §1 — o banco
-- decide, o app explica — pede uma trigger.
--
-- Três ganhos: `channels_whatsapp_cloud` passa a valer N, não 0|1; o
-- buraco do QRCode fecha junto (hoje um INSERT direto em `channels`
-- escapa da checagem de rota); enforcement e medidor passam a ler a
-- mesma fonte.
--
-- ⚠️ Esta seção é a ÚLTIMA que toca `channels`, DEPOIS de todo
-- `INSERT INTO channels` da seção 2. Backfill não pode ser barrado por
-- quota (§9, armadilha 8).
-- ============================================================
CREATE OR REPLACE FUNCTION enforce_channel_quota()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_limit INTEGER;
  v_used  INTEGER;
BEGIN
  -- `plan_limit` é SECURITY DEFINER de `postgres` com EXECUTE revogado
  -- de `authenticated` (067 §8). Esta trigger só a alcança porque
  -- também é SECURITY DEFINER **e** pertence a `postgres` — daí o
  -- ALTER FUNCTION … OWNER TO logo abaixo. Mesmo cabeçalho de
  -- `enforce_contact_quota()`.
  v_limit := plan_limit(NEW.account_id, 'channels_' || NEW.type);
  IF v_limit IS NULL THEN RETURN NEW; END IF;   -- quota desligada ou ilimitada

  -- Serializa por (conta, tipo): sem isto, dois admins conectando ao
  -- mesmo tempo leem o mesmo count() e ambos passam no limite.
  PERFORM pg_advisory_xact_lock(hashtext(NEW.account_id::text || ':' || NEW.type));

  -- `disabled` não ocupa vaga (D-12) — `src/lib/plans/usage.ts` precisa
  -- filtrar igual, senão o medidor diverge do enforcement.
  --
  -- O `id IS DISTINCT FROM NEW.id` é para a trigger de REATIVAÇÃO: no
  -- BEFORE UPDATE a própria linha ainda está na tabela, e contá-la
  -- somaria a vaga duas vezes.
  SELECT count(*) INTO v_used
    FROM channels
   WHERE account_id = NEW.account_id
     AND type = NEW.type
     AND status <> 'disabled'
     AND id IS DISTINCT FROM NEW.id;

  IF v_used + 1 > v_limit THEN
    -- Formato QUOTA_EXCEEDED:<metric>:<used>:<limit> é contrato com
    -- src/lib/plans/errors.ts — a UI traduz sem código novo.
    RAISE EXCEPTION 'QUOTA_EXCEEDED:channels_%:%:%', NEW.type, v_used + 1, v_limit
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END $$;

ALTER FUNCTION enforce_channel_quota() OWNER TO postgres;

-- REVOKE de PUBLIC **e de anon/authenticated**, pelo motivo que a
-- 044:129-135 documenta: o Supabase mantém ALTER DEFAULT PRIVILEGES
-- concedendo EXECUTE a `anon` e `authenticated` em toda função nova de
-- `public`, e essa concessão é nominal — o revoke de PUBLIC passa ao
-- largo dela. Sem isto, o linter aponta
-- `anon_security_definer_function_executable` para
-- `/rest/v1/rpc/enforce_channel_quota`.
--
-- Uma trigger function chamada por RPC erra ("trigger functions can
-- only be called as triggers"), então a superfície não é explorável —
-- mas ela é SECURITY DEFINER de `postgres` e alcança `plan_limit`, que
-- a 067 §8 fecha justamente para `authenticated`. Deixar a porta
-- fechada custa duas linhas.
REVOKE ALL ON FUNCTION enforce_channel_quota() FROM PUBLIC;
REVOKE ALL ON FUNCTION enforce_channel_quota() FROM anon, authenticated;

DROP TRIGGER IF EXISTS enforce_channel_quota_trg ON channels;
CREATE TRIGGER enforce_channel_quota_trg
  BEFORE INSERT ON channels
  FOR EACH ROW EXECUTE FUNCTION enforce_channel_quota();

-- Reativar um canal desativado ocupa vaga de novo — senão o D-12 vira
-- o caminho para furar a quota (desativa, cria, reativa).
DROP TRIGGER IF EXISTS enforce_channel_quota_reactivate_trg ON channels;
CREATE TRIGGER enforce_channel_quota_reactivate_trg
  BEFORE UPDATE ON channels
  FOR EACH ROW WHEN (OLD.status = 'disabled' AND NEW.status <> 'disabled')
  EXECUTE FUNCTION enforce_channel_quota();


-- ============================================================
-- 7.1) O PADRÃO NUNCA FICA NUM CANAL DESATIVADO
--
-- `set_default_channel` (seção 8) recusa PROMOVER um canal `disabled`, e
-- a eleição da seção 2(b) o ignora — mas nada impedia o caminho
-- inverso: DESATIVAR o canal que já era o padrão. O D-12 vai fazer
-- exatamente isso ("remover número" = desativar), e o resultado seria o
-- padrão do tipo pinado num canal que não pode enviar, ocupando a vaga
-- única do índice parcial. Sintomas: todo caminho genérico de saída
-- resolveria para um canal desativado, e a própria 072 — que se anuncia
-- reexecutável — passaria a abortar na asserção 10.3.
--
-- Duas triggers, de propósito separado: a BEFORE solta a marca na
-- própria linha (só ela pode reescrever NEW); a AFTER elege o
-- substituto, quando existe um canal ativo do mesmo tipo. Se não
-- existir, o tipo fica sem padrão — que é a resposta certa: não há por
-- onde enviar.
--
-- Sem recursão: o UPDATE da AFTER não mexe em `status`, então nenhuma
-- das duas triggers (nem a de reativação da seção 7) casa o WHEN de novo.
-- ============================================================
CREATE OR REPLACE FUNCTION release_default_on_disable()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  NEW.is_default := FALSE;
  RETURN NEW;
END $$;

ALTER FUNCTION release_default_on_disable() OWNER TO postgres;
REVOKE ALL ON FUNCTION release_default_on_disable() FROM PUBLIC;
REVOKE ALL ON FUNCTION release_default_on_disable() FROM anon, authenticated;

DROP TRIGGER IF EXISTS release_default_on_disable_trg ON channels;
CREATE TRIGGER release_default_on_disable_trg
  BEFORE UPDATE ON channels
  FOR EACH ROW WHEN (OLD.status <> 'disabled' AND NEW.status = 'disabled'
                     AND OLD.is_default)
  EXECUTE FUNCTION release_default_on_disable();

-- O espelho do caso acima: um canal que fica ATIVO num tipo que nao tem
-- padrao nenhum. Acontece em dois caminhos, e nenhum dos dois passava
-- por `set_default_channel`:
--
--   * INSERT do primeiro canal de um tipo (a F4 conectando o numero
--     oficial de uma conta nova) — sem isto a conta nasce com um canal
--     e nenhum padrao, e todo caminho generico de saida lanca;
--   * REATIVACAO de um canal desativado, quando ele era o unico do tipo
--     (o D-12 desativou, o operador reconectou).
--
-- Repare no WHEN de cada trigger: a de UPDATE cobre SO a transicao
-- `disabled -> ativo`. Um WHEN mais largo (qualquer update com
-- `NOT is_default`) quebraria `set_default_channel`, que desmarca o
-- padrao antigo antes de marcar o novo — a trigger veria "o tipo ficou
-- sem padrao" no meio da RPC e remarcaria justamente a linha que a RPC
-- acabou de soltar.
--
-- BEFORE, e nao AFTER: escrever em NEW nao dispara trigger nenhuma, entao
-- nao ha recursao a considerar.
CREATE OR REPLACE FUNCTION claim_default_when_type_has_none()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM channels d
                  WHERE d.account_id = NEW.account_id
                    AND d.type = NEW.type
                    AND d.is_default
                    AND d.id IS DISTINCT FROM NEW.id) THEN
    NEW.is_default := TRUE;
  END IF;
  RETURN NEW;
END $$;

ALTER FUNCTION claim_default_when_type_has_none() OWNER TO postgres;
REVOKE ALL ON FUNCTION claim_default_when_type_has_none() FROM PUBLIC;
REVOKE ALL ON FUNCTION claim_default_when_type_has_none() FROM anon, authenticated;

DROP TRIGGER IF EXISTS claim_default_on_insert_trg ON channels;
CREATE TRIGGER claim_default_on_insert_trg
  BEFORE INSERT ON channels
  FOR EACH ROW WHEN (NEW.status <> 'disabled' AND NOT NEW.is_default)
  EXECUTE FUNCTION claim_default_when_type_has_none();

DROP TRIGGER IF EXISTS claim_default_on_reactivate_trg ON channels;
CREATE TRIGGER claim_default_on_reactivate_trg
  BEFORE UPDATE ON channels
  FOR EACH ROW WHEN (OLD.status = 'disabled' AND NEW.status <> 'disabled'
                     AND NOT NEW.is_default)
  EXECUTE FUNCTION claim_default_when_type_has_none();

CREATE OR REPLACE FUNCTION elect_default_after_disable()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_next UUID;
BEGIN
  -- Mesmo critério da eleição do backfill (seção 2b): conectado
  -- primeiro, mais antigo no empate. Determinístico, nunca "o primeiro
  -- que aparecer".
  SELECT c.id INTO v_next
    FROM channels c
   WHERE c.account_id = NEW.account_id
     AND c.type = NEW.type
     AND c.status <> 'disabled'
     AND NOT c.is_default
   ORDER BY (c.status = 'connected') DESC, c.created_at ASC
   LIMIT 1;

  IF v_next IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM channels d
        WHERE d.account_id = NEW.account_id AND d.type = NEW.type AND d.is_default) THEN
    UPDATE channels SET is_default = TRUE WHERE id = v_next;
  END IF;

  RETURN NULL;
END $$;

ALTER FUNCTION elect_default_after_disable() OWNER TO postgres;
REVOKE ALL ON FUNCTION elect_default_after_disable() FROM PUBLIC;
REVOKE ALL ON FUNCTION elect_default_after_disable() FROM anon, authenticated;

DROP TRIGGER IF EXISTS elect_default_after_disable_trg ON channels;
CREATE TRIGGER elect_default_after_disable_trg
  AFTER UPDATE ON channels
  FOR EACH ROW WHEN (OLD.status <> 'disabled' AND NEW.status = 'disabled'
                     AND OLD.is_default)
  EXECUTE FUNCTION elect_default_after_disable();


-- ============================================================
-- 8) set_default_channel — a ÚNICA escrita de is_default (§6.1)
--
-- Hoje NADA no código escreve `is_default` (só o backfill da 055).
-- Desmarcar o anterior e marcar o novo sob um índice único parcial, sem
-- transação no cliente, quebra na ordem errada. As duas escritas aqui
-- correm na mesma transação implícita da função, que é o que o índice
-- parcial exige.
-- ============================================================
CREATE OR REPLACE FUNCTION set_default_channel(p_channel_id UUID)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_account UUID;
  v_type    TEXT;
  v_status  TEXT;
BEGIN
  SELECT account_id, type, status INTO v_account, v_type, v_status
    FROM channels WHERE id = p_channel_id;

  IF v_account IS NULL OR NOT is_account_member(v_account, 'admin') THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  IF v_status = 'disabled' THEN
    RAISE EXCEPTION 'Cannot make a disabled channel the default'
      USING ERRCODE = 'check_violation';
  END IF;

  -- ⚠️ O `AND type = v_type` é o coração desta função. Sem ele,
  -- promover um número oficial desmarca também o padrão do WhatsApp
  -- QRCode, e a conta fica sem padrão daquele tipo:
  -- `resolveDefaultChannelId(account,'whatsapp_qr')` passa a lançar e o
  -- desvio `fallback_channel` das automações (SPEC 049 §5.1) para de
  -- funcionar — com o log da automação como único sintoma.
  UPDATE channels SET is_default = FALSE
   WHERE account_id = v_account AND type = v_type AND is_default;

  UPDATE channels SET is_default = TRUE WHERE id = p_channel_id;
END $$;

ALTER FUNCTION set_default_channel(UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION set_default_channel(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION set_default_channel(UUID) FROM anon;
GRANT EXECUTE ON FUNCTION set_default_channel(UUID) TO authenticated, service_role;

COMMENT ON FUNCTION set_default_channel(UUID) IS
  'Promove um canal a padrao DO SEU TIPO (SPEC 064 D-11/§6.1). Unica forma de escrever is_default fora da migracao — nenhuma rota faz update direto nessa coluna.';


-- ============================================================
-- 9) COTA DE 24 h POR NÚMERO (§3.9 — conserta o §1.1.C.2)
--
-- `broadcast_quota_usage` contava `COUNT(DISTINCT br.contact_id)` sobre
-- TODAS as campanhas da conta. Mas o *tier* (`messaging_limit_tier`) é
-- da Meta e vale POR NÚMERO. Com dois números: o consumo dos dois é
-- somado contra o tier de um só (o painel alerta e o operador segura
-- audiência que caberia), e se os números estão em tiers diferentes —
-- o normal, porque cada um aquece sozinho — o valor exibido não
-- corresponde a nenhum dos dois.
--
-- `CREATE OR REPLACE` não muda lista de argumentos: precisa de DROP +
-- CREATE. E o DROP APAGA OS PRIVILÉGIOS, que têm de ser reaplicados —
-- o REVOKE de PUBLIC **e** de `anon` separadamente, pelo motivo que a
-- 044:129-135 documenta (o Supabase concede EXECUTE a `anon` por ALTER
-- DEFAULT PRIVILEGES, concessão nominal que o revoke de PUBLIC não
-- alcança).
--
-- `p_channel_id` tem DEFAULT NULL, então a chamada existente de
-- `messaging-limit-server.ts` (dois argumentos nomeados) continua
-- resolvendo assim que o cache de schema do PostgREST recarregar — é
-- por isso que o `NOTIFY pgrst` fecha este arquivo.
--
-- ⚠️ Campanhas legadas têm `channel_id NULL` e NÃO entram na contagem
-- de nenhum número específico. É subcontagem conhecida, some sozinha em
-- 24 h após o deploy da F6, e é melhor do que atribuí-las a um número
-- arbitrário.
-- ============================================================
DROP FUNCTION IF EXISTS public.broadcast_quota_usage(UUID, INT);

CREATE FUNCTION public.broadcast_quota_usage(
  p_account_id   UUID,
  p_window_hours INT  DEFAULT 24,
  p_channel_id   UUID DEFAULT NULL
)
RETURNS BIGINT
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count BIGINT;
BEGIN
  -- Guarda obrigatória: a função roda como `postgres` (RLS off).
  IF NOT is_account_member(p_account_id) THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  -- Janela sanitizada: um valor absurdo transformaria a consulta num
  -- full scan sem que o índice parcial ajudasse.
  IF p_window_hours IS NULL OR p_window_hours < 1 OR p_window_hours > 168 THEN
    p_window_hours := 24;
  END IF;

  -- Canal de outra conta nunca vira leitura.
  IF p_channel_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM channels WHERE id = p_channel_id AND account_id = p_account_id) THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  SELECT COUNT(DISTINCT br.contact_id)
    INTO v_count
    FROM broadcast_recipients br
    JOIN broadcasts b ON b.id = br.broadcast_id
   WHERE b.account_id = p_account_id
     AND (p_channel_id IS NULL OR b.channel_id = p_channel_id)
     AND br.contact_id IS NOT NULL
     AND br.sent_at >= NOW() - make_interval(hours => p_window_hours)
     -- 'pending' e 'failed' não consumiram conversa na Meta.
     AND br.status IN ('sent', 'delivered', 'read', 'replied');

  RETURN COALESCE(v_count, 0);
END;
$$;

ALTER FUNCTION public.broadcast_quota_usage(UUID, INT, UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.broadcast_quota_usage(UUID, INT, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.broadcast_quota_usage(UUID, INT, UUID) FROM anon;
GRANT EXECUTE ON FUNCTION public.broadcast_quota_usage(UUID, INT, UUID)
  TO authenticated, service_role;

COMMENT ON FUNCTION public.broadcast_quota_usage(UUID, INT, UUID) IS
  'Consumo da janela da Meta. p_channel_id NULL = conta inteira (compatibilidade); com canal, so as campanhas daquele numero (SPEC 064 D-4). Campanhas anteriores a F6 tem channel_id NULL e nao entram na contagem por canal.';


-- ============================================================
-- 10) ASSERÇÕES — falham alto de propósito (§3.8)
--
-- Padrão 042/044/045/050/055/067/071. O que esta migração troca é
-- estrutural e silencioso quando dá errado pela metade: uma restrição
-- que não caiu, um padrão que não foi eleito ou um privilégio que o
-- DROP FUNCTION levou junto só aparecem depois, em produção.
-- ============================================================
DO $$
DECLARE
  v_txt  TEXT;
  v_n    INTEGER;
  v_proc pg_proc%ROWTYPE;
BEGIN
  -- ── 10.1. As restrições de singleton caíram ──────────────────
  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'whatsapp_config_account_id_key'
                AND conrelid = 'public.whatsapp_config'::regclass) THEN
    RAISE EXCEPTION '072: whatsapp_config_account_id_key ainda existe — o segundo numero oficial continua impossivel.';
  END IF;

  IF EXISTS (SELECT 1 FROM pg_indexes
              WHERE schemaname = 'public' AND indexname = 'idx_channels_one_cloud_per_account') THEN
    RAISE EXCEPTION '072: idx_channels_one_cloud_per_account ainda existe.';
  END IF;

  IF EXISTS (SELECT 1 FROM pg_indexes
              WHERE schemaname = 'public' AND indexname = 'idx_channels_one_default_per_account') THEN
    RAISE EXCEPTION '072: idx_channels_one_default_per_account (padrao por CONTA) ainda existe — D-11 exige o padrao por TIPO.';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_indexes
                  WHERE schemaname = 'public' AND indexname = 'idx_channels_one_default_per_account_type') THEN
    RAISE EXCEPTION '072: idx_channels_one_default_per_account_type ausente.';
  END IF;

  -- ── 10.2. Toda config tem canal, e o vinculo e 1:1 ───────────
  SELECT count(*) INTO v_n FROM whatsapp_config WHERE channel_id IS NULL;
  IF v_n > 0 THEN
    RAISE EXCEPTION '072: % linha(s) de whatsapp_config continuam sem channel_id.', v_n;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'whatsapp_config_channel_id_key'
                    AND conrelid = 'public.whatsapp_config'::regclass) THEN
    RAISE EXCEPTION '072: falta a UNIQUE constraint whatsapp_config_channel_id_key.';
  END IF;

  -- ── 10.3. Todo tipo com canal ATIVO tem exatamente um padrao ──
  -- Mesmo filtro `status <> 'disabled'` da eleicao (secao 2b): um tipo
  -- cujos canais estao todos desativados fica sem padrao de proposito.
  SELECT string_agg(x.account_id::text || ' / ' || x.type, E'\n  ') INTO v_txt
    FROM (SELECT c.account_id, c.type
            FROM channels c
           WHERE c.status <> 'disabled'
           GROUP BY c.account_id, c.type
          HAVING count(*) FILTER (WHERE c.is_default) <> 1) x;
  IF v_txt IS NOT NULL THEN
    RAISE EXCEPTION E'072: estes pares (conta, tipo) tem canal ativo e nenhum (ou mais de um) padrao:\n  %', v_txt;
  END IF;

  -- ── 10.3b. Nenhum canal DESATIVADO segura is_default ─────────
  -- A vaga de padrao do tipo e unica (indice parcial): um canal
  -- desativado ocupando-a deixa o tipo sem padrao utilizavel e faz a
  -- 10.3 abortar numa reexecucao.
  SELECT string_agg(c.account_id::text || ' / ' || c.type || ' / ' || c.name, E'
  ')
    INTO v_txt
    FROM channels c WHERE c.is_default AND c.status = 'disabled';
  IF v_txt IS NOT NULL THEN
    RAISE EXCEPTION E'072: canais DESATIVADOS segurando is_default:
  %', v_txt;
  END IF;

  -- ── 10.3c. As duas triggers que mantem essa invariante ───────
  SELECT string_agg(t.nome, ', ') INTO v_txt
    FROM (VALUES ('release_default_on_disable_trg'),
                 ('elect_default_after_disable_trg'),
                 ('claim_default_on_insert_trg'),
                 ('claim_default_on_reactivate_trg')) AS t(nome)
   WHERE NOT EXISTS (SELECT 1 FROM pg_trigger g
                      WHERE g.tgrelid = 'public.channels'::regclass
                        AND g.tgname = t.nome AND NOT g.tgisinternal);
  IF v_txt IS NOT NULL THEN
    RAISE EXCEPTION '072: triggers de liberacao de padrao ausentes: %.', v_txt;
  END IF;

  -- ── 10.4. Templates por WABA ─────────────────────────────────
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'message_templates'
                    AND column_name = 'waba_id') THEN
    RAISE EXCEPTION '072: message_templates.waba_id nao foi criada.';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_indexes
                  WHERE schemaname = 'public'
                    AND indexname = 'message_templates_account_waba_name_language_key') THEN
    RAISE EXCEPTION '072: message_templates_account_waba_name_language_key ausente.';
  END IF;

  -- O onConflict de templates/submit/route.ts aponta para as colunas
  -- simples deste indice. Indice de EXPRESSAO aqui devolveria 42P10 no
  -- primeiro salvamento — a quebra que a F1 existe para evitar.
  IF EXISTS (SELECT 1 FROM pg_index i
              WHERE i.indexrelid = 'public.message_templates_account_waba_name_language_key'::regclass
                AND i.indexprs IS NOT NULL) THEN
    RAISE EXCEPTION '072: o indice de templates virou indice de EXPRESSAO — o on_conflict do PostgREST nao consegue inferi-lo.';
  END IF;

  -- ── 10.5. Campanha por canal ─────────────────────────────────
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'broadcasts'
                    AND column_name = 'channel_id') THEN
    RAISE EXCEPTION '072: broadcasts.channel_id nao foi criada.';
  END IF;

  -- ON DELETE SET NULL: sem isso o DELETE de canal que o D-12 promete
  -- volta um 23503 cru para qualquer canal que ja teve uma campanha.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'broadcasts_channel_id_fkey'
                    AND conrelid = 'public.broadcasts'::regclass
                    AND confdeltype = 'n') THEN
    RAISE EXCEPTION '072: broadcasts.channel_id precisa do FK com ON DELETE SET NULL.';
  END IF;

  -- ── 10.6. As tres funcoes de triagem continuam de pe ─────────
  SELECT string_agg(n.nome, ', ') INTO v_txt
    FROM (VALUES ('triage_audience_page'), ('audience_engagement_summary'),
                 ('triage_set_selection')) AS n(nome)
   WHERE NOT EXISTS (SELECT 1 FROM pg_proc p
                      WHERE p.pronamespace = 'public'::regnamespace
                        AND p.proname = n.nome);
  IF v_txt IS NOT NULL THEN
    RAISE EXCEPTION '072: sumiram funcoes de triagem: %.', v_txt;
  END IF;

  -- ── 10.7. As duas triggers de quota de canal ─────────────────
  SELECT string_agg(t.nome, ', ') INTO v_txt
    FROM (VALUES ('enforce_channel_quota_trg'),
                 ('enforce_channel_quota_reactivate_trg')) AS t(nome)
   WHERE NOT EXISTS (SELECT 1 FROM pg_trigger g
                      WHERE g.tgrelid = 'public.channels'::regclass
                        AND g.tgname = t.nome AND NOT g.tgisinternal);
  IF v_txt IS NOT NULL THEN
    RAISE EXCEPTION '072: triggers de quota de canal ausentes: %.', v_txt;
  END IF;

  SELECT p.* INTO v_proc FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'enforce_channel_quota';
  IF NOT v_proc.prosecdef
     OR (SELECT rolname FROM pg_roles WHERE oid = v_proc.proowner) IS DISTINCT FROM 'postgres' THEN
    RAISE EXCEPTION '072: enforce_channel_quota precisa ser SECURITY DEFINER e pertencer a postgres — sem isso nao alcanca plan_limit (067 §8).';
  END IF;

  -- ── 10.8. set_default_channel ────────────────────────────────
  SELECT p.* INTO v_proc FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'set_default_channel';
  IF v_proc.oid IS NULL THEN
    RAISE EXCEPTION '072: set_default_channel nao existe apos a migracao.';
  END IF;
  IF NOT v_proc.prosecdef
     OR (SELECT rolname FROM pg_roles WHERE oid = v_proc.proowner) IS DISTINCT FROM 'postgres' THEN
    RAISE EXCEPTION '072: set_default_channel precisa ser SECURITY DEFINER e pertencer a postgres.';
  END IF;

  -- ── 10.9. broadcast_quota_usage: assinatura NOVA, e so ela ───
  -- Duas versoes convivendo seria pior do que nenhuma: o PostgREST
  -- escolheria por nome de argumento e a chamada de dois argumentos
  -- cairia silenciosamente na versao POR CONTA.
  SELECT count(*) INTO v_n FROM pg_proc
   WHERE pronamespace = 'public'::regnamespace AND proname = 'broadcast_quota_usage';
  IF v_n <> 1 THEN
    RAISE EXCEPTION '072: existem % versoes de broadcast_quota_usage — o DROP da assinatura de 2 argumentos nao pegou.', v_n;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_proc
                  WHERE pronamespace = 'public'::regnamespace
                    AND proname = 'broadcast_quota_usage'
                    AND pg_get_function_identity_arguments(oid)
                        = 'p_account_id uuid, p_window_hours integer, p_channel_id uuid') THEN
    RAISE EXCEPTION '072: broadcast_quota_usage nao ficou com a assinatura de 3 argumentos (p_account_id, p_window_hours, p_channel_id).';
  END IF;

  -- ── 10.10. ACL: o DROP FUNCTION apaga privilegios (044:129-135)
  SELECT string_agg(p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')', ', ')
    INTO v_txt
    FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace
     AND p.proname IN ('broadcast_quota_usage', 'set_default_channel',
                       'enforce_channel_quota', 'release_default_on_disable',
                       'elect_default_after_disable', 'claim_default_when_type_has_none',
                       'triage_audience_page', 'audience_engagement_summary',
                       'triage_set_selection')
     AND has_function_privilege('anon', p.oid, 'EXECUTE');
  IF v_txt IS NOT NULL THEN
    RAISE EXCEPTION '072: estas funcoes continuam executaveis por anon: %. O REVOKE nao pegou.', v_txt;
  END IF;

  IF NOT has_function_privilege('authenticated',
        'public.broadcast_quota_usage(uuid, integer, uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION '072: authenticated perdeu o EXECUTE de broadcast_quota_usage — o medidor de cota do painel para de responder.';
  END IF;

  RAISE NOTICE '072: multiplos numeros oficiais liberados no schema. Falta o codigo (F2-F9) — mantenha channels_whatsapp_cloud em 1 nos planos ate a F7 validada (SPEC 064 §8.5).';
END $$;


-- ============================================================
-- 11) ÚLTIMO COMANDO: recarregar o cache do PostgREST
--
-- `broadcasts.channel_id` e `message_templates.waba_id` sao colunas
-- novas (embeds podem devolver PGRST200), e a troca de assinatura de
-- `broadcast_quota_usage` devolve PGRST202 ate o cache recarregar — e o
-- codigo atual trata falha de cota como ZERO (`Number(usedRaw ?? 0)`),
-- ou seja, a tela de disparo diria "0 de 1.000 usados" para uma conta
-- que ja disparou 900. A F3 conserta o lado do codigo
-- (`usageUnavailable`); este NOTIFY encurta a janela.
-- ============================================================
NOTIFY pgrst, 'reload schema';
